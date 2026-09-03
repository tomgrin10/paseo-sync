import { randomUUID } from "node:crypto";
import type {
  Conflict,
  Direction,
  Peer,
  Settings,
  Step,
  SyncPlan,
} from "./contracts.shared";
import type { Inventory, SessionRecord, WorkspaceRecord } from "./inventory.server";
import { projectKeyOf, transcriptTargetPath } from "./inventory.server";
import type { Endpoint } from "./paths.server";
import { repoNameFor, shortHash, translatePath } from "./paths.server";
import type { PeerState } from "./state.server";
import { cursorFor } from "./state.server";

/**
 * The diff engine. It reads both inventories and produces a SyncPlan — and it
 * moves nothing.
 *
 * Preview and apply consume the same object, so what the panel shows cannot
 * drift from what a run does. That is the whole point of building the plan as a
 * value rather than as a sequence of side effects.
 */

export type PlanInput = {
  peer: Peer;
  direction: Direction;
  includeArchived: boolean;
  settings: Settings;
  state: PeerState;
  local: Inventory;
  remote: Inventory;
  /** Providers the receiving side can actually resume with. */
  targetProviders: { claude: boolean; codex: boolean };
};

export type ResolvedPlan = {
  plan: SyncPlan;
  /** Everything apply needs, keyed by step id — never crosses the RPC boundary. */
  detail: Map<string, StepDetail>;
};

export type StepDetail =
  | { kind: "transcript"; session: SessionRecord; targetPath: string; provider: string; cwd: string }
  | { kind: "session-record"; session: SessionRecord; targetPath: string; targetCwd: string }
  | { kind: "create-workspace"; workspace: WorkspaceRecord; targetCwd: string; repoName: string | null }
  | { kind: "git-fetch"; repoName: string; sourceRepoPath: string; targetRepoPath: string; refs: string[] }
  | { kind: "carry-stash"; repoName: string; sourceRepoPath: string; targetRepoPath: string; files: number }
  | { kind: "file-copy"; sourcePath: string; targetPath: string; bytes: number }
  | { kind: "worktree-register"; repoName: string; targetRepoPath: string; worktreePath: string; branch: string };

function isNewer(a: string | null, b: string | null): boolean {
  if (!a) return false;
  if (!b) return true;
  return Date.parse(a) > Date.parse(b);
}

/** Workspaces belonging to one project key, on one side. */
function workspacesForProject(inventory: Inventory, projectKey: string): WorkspaceRecord[] {
  const projectIds = new Set(
    inventory.projects.filter((p) => projectKeyOf(p) === projectKey).map((p) => p.projectId),
  );
  return inventory.workspaces.filter((w) => projectIds.has(w.projectId));
}

function repoRootFor(inventory: Inventory, projectKey: string): string | null {
  const project = inventory.projects.find((p) => projectKeyOf(p) === projectKey);
  return project?.rootPath ?? null;
}

/**
 * Sessions belonging to a workspace. Matching is by workspaceId where the record
 * has one, and by cwd otherwise — legacy records predate workspace ids.
 */
function sessionsForWorkspace(
  inventory: Inventory,
  workspace: WorkspaceRecord,
): SessionRecord[] {
  return inventory.sessions.filter((session) => {
    if (session.workspaceId) return session.workspaceId === workspace.workspaceId;
    return session.cwd === workspace.cwd;
  });
}

function providerFamily(session: SessionRecord): "claude" | "codex" | "other" {
  const provider = (session.persistenceProvider ?? session.provider ?? "").toLowerCase();
  if (provider.startsWith("claude")) return "claude";
  if (provider.startsWith("codex")) return "codex";
  return "other";
}

export function buildPlan(input: PlanInput): ResolvedPlan {
  const { peer, direction, includeArchived, settings, state, targetProviders } = input;
  const source = direction === "push" ? input.local : input.remote;
  const target = direction === "push" ? input.remote : input.local;
  const sourceEndpoint: Endpoint = source.endpoint;
  const targetEndpoint: Endpoint = target.endpoint;

  const steps: Step[] = [];
  const skipped: SyncPlan["skipped"] = [];
  const conflicts: Conflict[] = [];
  const notes: string[] = [];
  const detail = new Map<string, StepDetail>();
  let totalBytes = 0;

  const maxBytes = Math.max(1, settings.maxTranscriptMb) * 1024 * 1024;
  const selected = state.selectedProjects;

  if (selected.length === 0) {
    notes.push("No projects selected. Pick projects on the Projects tab — Sync never touches anything you have not selected.");
  }

  // Provider availability on the receiving side. A carried session that cannot
  // resume there is worth knowing about before the transfer, not after.
  if (!targetProviders.claude) {
    notes.push("The receiving daemon has no working Claude provider, so carried Claude tabs will appear but not resume until it does.");
  }
  if (!targetProviders.codex) {
    notes.push("The receiving daemon has no working Codex provider, so carried Codex tabs will appear but not resume until it does.");
  }

  for (const projectKey of selected) {
    const sourceWorkspaces = workspacesForProject(source, projectKey);
    if (sourceWorkspaces.length === 0) continue;

    const sourceRepoRoot = repoRootFor(source, projectKey);
    const targetRepoRoot = repoRootFor(target, projectKey);
    const repoName =
      sourceRepoRoot?.split("/").filter(Boolean).pop() ??
      targetRepoRoot?.split("/").filter(Boolean).pop() ??
      null;

    if (!targetRepoRoot) {
      skipped.push({
        projectKey,
        label: repoName ?? projectKey,
        reason: "The receiving daemon has no checkout of this project. Clone it there first — Sync moves history, not repositories.",
      });
      continue;
    }

    const cursor = cursorFor(state, projectKey);
    const targetByCwd = new Map(target.workspaces.map((w) => [w.cwd, w]));
    const targetById = new Map(target.workspaces.map((w) => [w.workspaceId, w]));

    // Which worktree hashes this project remaps, so transcript text can be
    // rewritten with the recomputed values rather than the source's.
    const hashMap = new Map<string, string>();
    if (repoName && sourceRepoRoot) {
      hashMap.set(shortHash(sourceRepoRoot), shortHash(targetRepoRoot));
    }

    const branchesWanted = new Set<string>();

    for (const workspace of sourceWorkspaces) {
      if (workspace.archivedAt && !includeArchived) continue;

      const translated = translatePath(workspace.cwd, sourceEndpoint, targetEndpoint, repoName);
      const targetCwd = translated.path;

      const mappedId =
        direction === "push"
          ? state.workspaceIdMap[workspace.workspaceId]
          : Object.entries(state.workspaceIdMap).find(([, remoteId]) => remoteId === workspace.workspaceId)?.[0];
      const counterpart =
        (mappedId ? targetById.get(mappedId) : undefined) ?? targetByCwd.get(targetCwd);

      // Never overwrite newer state: if the receiving side moved more recently,
      // stop and ask rather than choosing.
      if (counterpart && isNewer(counterpart.updatedAt, workspace.updatedAt)) {
        conflicts.push({
          id: `conflict_${workspace.workspaceId}`,
          projectKey,
          label: workspace.title ?? workspace.displayName,
          detail: `Both sides changed this tab. The receiving daemon's copy is newer.`,
          sourceUpdatedAt: workspace.updatedAt,
          targetUpdatedAt: counterpart.updatedAt,
        });
        continue;
      }

      if (workspace.branch) branchesWanted.add(workspace.branch);

      if (!counterpart) {
        const id = `ws_${workspace.workspaceId}`;
        steps.push({
          id,
          projectKey,
          kind: "create-workspace",
          label: workspace.title ?? workspace.displayName,
          detail:
            translated.recomputedHash && translated.rule === "worktree"
              ? `worktree at ${targetCwd} (hash recomputed ${translated.recomputedHash.from} → ${translated.recomputedHash.to})`
              : targetCwd,
          bytes: null,
        });
        detail.set(id, { kind: "create-workspace", workspace, targetCwd, repoName });

        if (workspace.isPaseoOwnedWorktree && workspace.branch) {
          const wtId = `wt_${workspace.workspaceId}`;
          steps.push({
            id: wtId,
            projectKey,
            kind: "worktree-register",
            label: `git worktree ${workspace.branch}`,
            detail: targetCwd,
            bytes: null,
          });
          detail.set(wtId, {
            kind: "worktree-register",
            repoName: repoName ?? projectKey,
            targetRepoPath: targetRepoRoot,
            worktreePath: targetCwd,
            branch: workspace.branch,
          });
        }
      }

      for (const session of sessionsForWorkspace(source, workspace)) {
        if (!session.sessionId) continue;
        const family = providerFamily(session);
        const label = session.title ?? session.sessionId.slice(0, 8);

        const existing = target.transcripts[session.sessionId];
        const seen = cursor.sessions[session.sessionId];
        const unchanged =
          seen &&
          seen.bytes === session.transcriptBytes &&
          seen.mtimeMs === session.transcriptMtimeMs;

        if (session.transcriptPath && !unchanged) {
          if (session.transcriptBytes > maxBytes) {
            skipped.push({
              projectKey,
              label,
              reason: `Transcript is ${(session.transcriptBytes / 1024 / 1024).toFixed(0)}MB, over the ${settings.maxTranscriptMb}MB limit.`,
            });
          } else if (existing && existing.bytes >= session.transcriptBytes) {
            // The receiving side already holds at least as much of this
            // conversation as the sending side has. Resuming a carried session
            // APPENDS to the transcript, so the far copy legitimately grows past
            // the original — meaning "bigger over there" is the normal steady
            // state, not a reason to keep re-sending it.
            skipped.push({ projectKey, label, reason: "Already present on the receiving side." });
          } else {
            const id = `tx_${session.sessionId}`;
            const targetPath = transcriptTarget(targetEndpoint, family, session, targetCwd);
            steps.push({
              id,
              projectKey,
              kind: "transcript",
              label,
              detail: `${family} · ${(session.transcriptBytes / 1024).toFixed(0)}KB`,
              bytes: session.transcriptBytes,
            });
            detail.set(id, {
              kind: "transcript",
              session,
              targetPath,
              provider: family,
              cwd: targetCwd,
            });
            totalBytes += session.transcriptBytes;
          }
        }

        const id = `rec_${session.agentId}`;
        steps.push({
          id,
          projectKey,
          kind: "session-record",
          label,
          detail: `tab record · ${family}`,
          bytes: null,
        });
        detail.set(id, {
          kind: "session-record",
          session,
          targetPath: "",
          targetCwd,
        });
      }
    }

    if (branchesWanted.size > 0 && sourceRepoRoot) {
      const id = `git_${projectKey}`;
      const refs = Array.from(branchesWanted).sort();
      steps.push({
        id,
        projectKey,
        kind: "git-fetch",
        label: repoName ?? projectKey,
        detail: `${refs.length} branch${refs.length === 1 ? "" : "es"} over the direct remote`,
        bytes: null,
      });
      detail.set(id, {
        kind: "git-fetch",
        repoName: repoName ?? projectKey,
        sourceRepoPath: sourceRepoRoot,
        targetRepoPath: targetRepoRoot,
        refs,
      });
    }
  }

  const plan: SyncPlan = {
    planId: `plan_${randomUUID().slice(0, 8)}`,
    peerId: peer.id,
    direction,
    createdAt: new Date().toISOString(),
    steps,
    skipped,
    conflicts,
    totalBytes,
    projectKeys: selected,
    notes,
  };

  return { plan, detail };
}

function transcriptTarget(
  endpoint: Endpoint,
  family: "claude" | "codex" | "other",
  session: SessionRecord,
  targetCwd: string,
): string {
  const provider = family === "other" ? "claude" : family;
  return transcriptTargetPath(endpoint, provider, session.sessionId ?? "", targetCwd, session.transcriptPath);
}

export { repoNameFor };
