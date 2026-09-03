import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import type { Direction, Peer, RunState, SyncPlan } from "./contracts.shared";
import type { StepDetail } from "./plan.server";
import type { Endpoint } from "./paths.server";
import { shortHash } from "./paths.server";
import { agentRecordTargetPath } from "./inventory.server";
import {
  carryStash,
  copyFile,
  fetchFromPeer,
  importSessionOnPeer,
  registerWorktree,
  transferSessionRecord,
  transferTranscript,
  type Side,
} from "./transfer.server";
import { daemonPasswordFor, sshArgs } from "./peers.server";
import {
  appendJournal,
  cursorFor,
  peerState,
  readState,
  setPeerState,
  writeState,
} from "./state.server";

/**
 * Executing a plan.
 *
 * Runs live in a module-level map because a Paseo plugin handler that streamed
 * progress would hold an RPC open for minutes; the panel polls instead. The
 * plugin subprocess outlives individual handler calls, so this state persists
 * for as long as the panel needs it.
 */

type ActiveRun = {
  state: RunState;
  cancelled: boolean;
};

const runs = new Map<string, ActiveRun>();
const MAX_RETAINED_RUNS = 8;

export function getRun(runId: string): RunState | null {
  return runs.get(runId)?.state ?? null;
}

export function latestRun(): RunState | null {
  let newest: RunState | null = null;
  for (const { state } of runs.values()) {
    if (!newest || state.startedAt > newest.startedAt) newest = state;
  }
  return newest;
}

export function cancelRun(runId: string): boolean {
  const run = runs.get(runId);
  if (!run || run.state.state !== "running") return false;
  run.cancelled = true;
  run.state.message = "Stopping after the current step…";
  return true;
}

function prune(): void {
  if (runs.size <= MAX_RETAINED_RUNS) return;
  const ordered = Array.from(runs.entries()).sort(
    (a, b) => Date.parse(a[1].state.startedAt) - Date.parse(b[1].state.startedAt),
  );
  for (const [id] of ordered.slice(0, runs.size - MAX_RETAINED_RUNS)) runs.delete(id);
}

export type ApplyInput = {
  paseo: PaseoApi;
  peer: Peer;
  plan: SyncPlan;
  detail: Map<string, StepDetail>;
  direction: Direction;
  localEndpoint: Endpoint;
  remoteEndpoint: Endpoint;
  skipStepIds: Set<string>;
  /** Repo root per project on each side, for the git steps. */
  repoRoots: Map<string, { source: string; target: string }>;
};

/**
 * Start a run and return immediately. The ordering is deliberate: git refs,
 * worktrees, files, transcripts, session records, then the workspace itself.
 * The workspace is created LAST so a failure part-way never leaves a visible tab
 * whose history or checkout is missing.
 */
export function startRun(input: ApplyInput): string {
  const runId = `run_${randomUUID().slice(0, 8)}`;
  const steps = input.plan.steps.filter((step) => !input.skipStepIds.has(step.id));

  const state: RunState = {
    runId,
    planId: input.plan.planId,
    peerId: input.peer.id,
    direction: input.direction,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    state: "running",
    message: "Starting…",
    bytesMoved: 0,
    totalBytes: steps.reduce((sum, step) => sum + (step.bytes ?? 0), 0),
    steps: steps.map((step) => ({
      id: step.id,
      label: step.label,
      state: "pending" as const,
      detail: step.detail,
    })),
    error: null,
  };

  const active: ActiveRun = { state, cancelled: false };
  runs.set(runId, active);
  prune();

  void execute(active, input, steps).catch((error) => {
    active.state.state = "failed";
    active.state.error = error instanceof Error ? error.message : String(error);
    active.state.finishedAt = new Date().toISOString();
    active.state.message = "Run failed.";
  });

  return runId;
}

const ORDER: Record<StepDetail["kind"], number> = {
  "git-fetch": 0,
  "worktree-register": 1,
  "carry-stash": 2,
  "file-copy": 3,
  transcript: 4,
  "session-record": 5,
  "create-workspace": 6,
};

async function execute(
  active: ActiveRun,
  input: ApplyInput,
  steps: SyncPlan["steps"],
): Promise<void> {
  const { peer, direction, detail } = input;
  const sourceSide: Side = direction === "push" ? "local" : "remote";
  const targetSide: Side = direction === "push" ? "remote" : "local";
  const source = direction === "push" ? input.localEndpoint : input.remoteEndpoint;
  const target = direction === "push" ? input.remoteEndpoint : input.localEndpoint;

  // The receiving side addresses the sending side over ssh. Only one side of a
  // pair is usually reachable, so a pull fetches directly while a push asks the
  // peer to fetch back over the same connection.
  const sshCommand = `ssh ${sshArgs(peer).slice(0, -1).join(" ")}`;
  const remoteUrlFor = (repoPath: string): string =>
    targetSide === "local" ? `ssh://${peer.sshTarget}${repoPath}` : repoPath;

  const ordered = [...steps].sort((a, b) => {
    const da = detail.get(a.id);
    const db = detail.get(b.id);
    return (da ? ORDER[da.kind] : 99) - (db ? ORDER[db.kind] : 99);
  });

  // Worktree hash remapping, per project, so transcript text can be rewritten
  // with the recomputed hash rather than the source's.
  const hashMap = new Map<string, string>();
  for (const [, roots] of input.repoRoots) {
    hashMap.set(shortHash(roots.source), shortHash(roots.target));
  }

  const idMapAdditions = new Map<string, string>();

  // Which sessions land in which cwd. create-workspace runs last, so by then
  // every transcript and record it needs is already on the far side.
  const sessionsForCwd = new Map<string, Array<{ sessionId: string; provider: "claude" | "codex" }>>();
  for (const step of steps) {
    const info = detail.get(step.id);
    if (info?.kind !== "session-record") continue;
    const sessionId = info.session.sessionId;
    if (!sessionId) continue;
    const raw = (info.session.persistenceProvider ?? info.session.provider ?? "").toLowerCase();
    const provider = raw.startsWith("codex") ? ("codex" as const) : ("claude" as const);
    const list = sessionsForCwd.get(info.targetCwd) ?? [];
    if (!list.some((entry) => entry.sessionId === sessionId)) list.push({ sessionId, provider });
    sessionsForCwd.set(info.targetCwd, list);
  }
  const daemonPassword = daemonPasswordFor(peer.id);

  let completed = 0;

  for (const step of ordered) {
    if (active.cancelled) {
      active.state.state = "cancelled";
      active.state.message = `Stopped after ${completed} step${completed === 1 ? "" : "s"}.`;
      active.state.finishedAt = new Date().toISOString();
      persistJournal(active, input, "cancelled");
      return;
    }

    const entry = active.state.steps.find((s) => s.id === step.id);
    if (entry) entry.state = "running";
    active.state.message = step.label;

    const info = detail.get(step.id);
    if (!info) {
      if (entry) {
        entry.state = "skipped";
        entry.detail = "No detail recorded for this step.";
      }
      continue;
    }

    const outcome = await runStep({
      info,
      peer,
      sourceSide,
      targetSide,
      source,
      target,
      hashMap,
      remoteUrlFor,
      sshCommand,
      paseo: input.paseo,
      idMapAdditions,
      sessionsForCwd,
      daemonPassword,
    });

    if (entry) {
      entry.state = outcome.ok ? "done" : "failed";
      if (outcome.detail) entry.detail = outcome.detail;
    }
    if (outcome.ok) {
      completed += 1;
      if (outcome.bytes) active.state.bytesMoved += outcome.bytes;
    } else {
      active.state.state = "failed";
      active.state.error = outcome.error ?? "Step failed.";
      active.state.message = `Stopped at "${step.label}".`;
      active.state.finishedAt = new Date().toISOString();
      persistJournal(active, input, "failed");
      return;
    }
  }

  commitState(input, idMapAdditions);

  active.state.state = "done";
  active.state.finishedAt = new Date().toISOString();
  active.state.message =
    completed === 0
      ? "Nothing to move — both sides already match."
      : `Moved ${completed} item${completed === 1 ? "" : "s"}.`;
  persistJournal(active, input, "done");
}

type StepOutcome = { ok: boolean; bytes?: number; detail?: string; error?: string };

async function runStep(context: {
  info: StepDetail;
  peer: Peer;
  sourceSide: Side;
  targetSide: Side;
  source: Endpoint;
  target: Endpoint;
  hashMap: ReadonlyMap<string, string>;
  remoteUrlFor: (repoPath: string) => string;
  sshCommand: string;
  paseo: PaseoApi;
  idMapAdditions: Map<string, string>;
  /** Sessions carried to each target cwd, so the peer can be told what to adopt. */
  sessionsForCwd: Map<string, Array<{ sessionId: string; provider: "claude" | "codex" }>>;
  daemonPassword: string | null;
}): Promise<StepOutcome> {
  const { info, peer, sourceSide, targetSide, source, target, hashMap } = context;

  switch (info.kind) {
    case "git-fetch": {
      const result = await fetchFromPeer({
        side: targetSide,
        peer,
        targetRepoPath: info.targetRepoPath,
        sourceRepoPath: info.sourceRepoPath,
        refs: info.refs,
        remoteUrl: context.remoteUrlFor(info.sourceRepoPath),
        sshCommand: targetSide === "local" ? context.sshCommand : null,
      });
      return result.ok
        ? { ok: true, detail: `fetched ${result.fetched.length} ref(s)` }
        : { ok: false, error: result.error };
    }

    case "worktree-register": {
      const result = await registerWorktree({
        side: targetSide,
        peer,
        repoPath: info.targetRepoPath,
        worktreePath: info.worktreePath,
        branch: info.branch,
      });
      return result.ok
        ? { ok: true, detail: result.created ? "worktree created" : "already present" }
        : { ok: false, error: result.error };
    }

    case "carry-stash": {
      const result = await carryStash({
        sourceSide,
        targetSide,
        peer,
        sourceRepoPath: info.sourceRepoPath,
        targetRepoPath: info.targetRepoPath,
        remoteUrl: context.remoteUrlFor(info.sourceRepoPath),
        sshCommand: targetSide === "local" ? context.sshCommand : null,
        label: `paseo-sync: ${info.repoName} (${info.files} file${info.files === 1 ? "" : "s"})`,
      });
      if (!result.ok) return { ok: false, error: result.error };
      return {
        ok: true,
        detail: result.sha ? `stashed as ${result.sha.slice(0, 8)}` : "nothing to stash",
      };
    }

    case "file-copy": {
      const result = await copyFile({
        sourceSide,
        targetSide,
        peer,
        sourcePath: info.sourcePath,
        targetPath: info.targetPath,
      });
      return result.ok
        ? { ok: true, bytes: result.bytes, detail: `${(result.bytes / 1024).toFixed(1)}KB` }
        : { ok: false, error: result.error };
    }

    case "transcript": {
      if (!info.session.transcriptPath) return { ok: true, detail: "no transcript on disk" };
      const result = await transferTranscript({
        sourceSide,
        targetSide,
        peer,
        sourcePath: info.session.transcriptPath,
        targetPath: info.targetPath,
        source,
        target,
        hashMap,
      });
      return result.ok
        ? { ok: true, bytes: result.bytes, detail: `${(result.bytes / 1024).toFixed(0)}KB` }
        : { ok: false, error: result.error };
    }

    case "session-record": {
      const mapped = context.idMapAdditions.get(info.session.workspaceId ?? "") ?? null;
      const targetPath = agentRecordTargetPath(target, info.targetCwd, info.session.agentId);
      const result = await transferSessionRecord({
        sourceSide,
        targetSide,
        peer,
        sourcePath: info.session.path,
        targetPath,
        source,
        target,
        hashMap,
        workspaceId: mapped,
      });
      return result.ok ? { ok: true, detail: "tab record written" } : { ok: false, error: result.error };
    }

    case "create-workspace": {
      // Created through the daemon's own API rather than by editing
      // workspaces.json: the registry is loaded once at startup and rewritten
      // wholesale on every mutation, so a file edit would be invisible to a live
      // daemon and clobbered by its next write.
      if (targetSide !== "local") {
        // The peer's own daemon must adopt it: `paseo import` finds or creates
        // the workspace for the cwd and attaches the session in one transaction.
        // A carried session record alone resumes but never becomes a visible
        // tab, so this step is what makes the work actually pickup-able there.
        const carried = context.sessionsForCwd.get(info.targetCwd) ?? [];
        if (carried.length === 0) {
          return { ok: true, detail: "no session to attach; nothing to adopt" };
        }
        const failures: string[] = [];
        let adopted = 0;
        for (const carriedSession of carried) {
          const outcome = await importSessionOnPeer({
            peer,
            sessionId: carriedSession.sessionId,
            provider: carriedSession.provider,
            cwd: info.targetCwd,
            daemonPassword: context.daemonPassword,
          });
          if (outcome.ok) adopted += 1;
          else failures.push(outcome.error);
        }
        if (adopted === 0 && failures.length > 0) {
          return { ok: false, error: failures[0] };
        }
        return {
          ok: true,
          detail: `${adopted} tab${adopted === 1 ? "" : "s"} adopted by the peer's daemon`,
        };
      }
      try {
        const workspace = await context.paseo.workspaces.create({
          title: info.workspace.title ?? info.workspace.displayName,
          source: { kind: "directory", path: info.targetCwd },
        });
        context.idMapAdditions.set(info.workspace.workspaceId, workspace.id);
        return { ok: true, detail: `workspace ${workspace.id}` };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    default:
      return { ok: true };
  }
}

function commitState(input: ApplyInput, additions: Map<string, string>): void {
  try {
    let state = readState();
    const peer = peerState(state, input.peer.id);
    const workspaceIdMap = { ...peer.workspaceIdMap };
    for (const [localId, remoteId] of additions) {
      workspaceIdMap[input.direction === "push" ? localId : remoteId] =
        input.direction === "push" ? remoteId : localId;
    }

    const cursors = { ...peer.cursors };
    const now = new Date().toISOString();
    for (const step of input.plan.steps) {
      const info = input.detail.get(step.id);
      if (!info) continue;
      const cursor = { ...cursorFor(peer, step.projectKey) };
      cursor.sessions = { ...cursor.sessions };
      if (info.kind === "transcript" && info.session.sessionId) {
        cursor.sessions[info.session.sessionId] = {
          bytes: info.session.transcriptBytes,
          mtimeMs: info.session.transcriptMtimeMs,
          lastActivityAt: info.session.lastActivityAt,
        };
      }
      cursor.lastSyncedAt = now;
      cursors[step.projectKey] = cursor;
    }

    state = setPeerState(state, input.peer.id, { ...peer, workspaceIdMap, cursors });
    writeState(state);
  } catch {
    // A state write failure must never fail an otherwise-good run; the next run
    // simply re-diffs from scratch and moves the same bytes again.
  }
}

function persistJournal(active: ActiveRun, input: ApplyInput, outcome: string): void {
  try {
    const state = readState();
    writeState(
      appendJournal(state, {
        runId: active.state.runId,
        peerId: input.peer.id,
        direction: input.direction,
        finishedAt: active.state.finishedAt ?? new Date().toISOString(),
        state: outcome,
        summary: active.state.message,
        bytesMoved: active.state.bytesMoved,
      }),
    );
  } catch {
    // Journal is a convenience, never a correctness requirement.
  }
}
