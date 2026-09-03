import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type {
  Direction,
  Peer,
  ProjectRow,
  Scope,
  Settings,
  Tab,
  SyncPlan,
} from "./contracts.shared";
import {
  DEFAULT_SETTINGS,
  localEndpoint,
  newPeerId,
  peerEndpoint,
  probePeer,
  readPeers,
  readSettings,
  setDaemonPassword,
  writePeers,
  writeSettings,
} from "./peers.server";
import {
  projectDisplayName,
  projectKeyOf,
  readLocalInventory,
  readRemoteInventory,
  type Inventory,
} from "./inventory.server";
import { buildPlan, type StepDetail } from "./plan.server";
import { cancelRun, getRun, latestRun, startRun } from "./apply.server";
import { cursorFor, peerState, readState, setPeerState, writeState } from "./state.server";

/**
 * RPC handlers. These stay thin: they resolve peers, gather inventories, and
 * hand off to the plan or apply engines. Nothing decides policy here.
 */

/** The last plan built per peer, so a run executes exactly what was previewed. */
const planCache = new Map<string, { plan: SyncPlan; detail: Map<string, StepDetail>; direction: Direction }>();

function requirePeer(id: string): Peer {
  const peer = readPeers().find((candidate) => candidate.id === id);
  if (!peer) throw new Error(`No peer with id ${id}. It may have been removed.`);
  return peer;
}

export async function handlePeersList() {
  const local = localEndpoint();
  return {
    peers: readPeers(),
    local: {
      paseoHome: local.paseoHome,
      projectsRoot: local.projectsRoot,
      homeDir: local.homeDir,
      hostname: local.hostname,
    },
  };
}

export async function handlePeerSave(input: {
  id: string | null;
  label: string;
  sshTarget: string;
  sshPort: number | null;
  identityFile: string | null;
  projectsRoot: string | null;
  daemonPassword: string | null;
}) {
  const peers = readPeers();
  const existing = input.id ? peers.find((peer) => peer.id === input.id) : undefined;

  const draft: Peer = {
    id: existing?.id ?? newPeerId(),
    label: input.label.trim() || input.sshTarget,
    sshTarget: input.sshTarget.trim(),
    sshPort: input.sshPort,
    identityFile: input.identityFile?.trim() || null,
    paseoHome: existing?.paseoHome ?? null,
    projectsRoot: input.projectsRoot?.trim() || existing?.projectsRoot || null,
    homeDir: existing?.homeDir ?? null,
    daemonUser: existing?.daemonUser ?? null,
    lastProbedAt: existing?.lastProbedAt ?? null,
    hasDaemonPassword: existing?.hasDaemonPassword ?? false,
  };

  // Stored before probing so the very first save can already authenticate.
  // A blank field on an edit leaves any existing secret alone rather than
  // silently clearing it.
  if (input.daemonPassword) setDaemonPassword(draft.id, input.daemonPassword);

  const { peer, health } = await probePeer(draft, input.projectsRoot ?? null);
  const next = existing
    ? peers.map((candidate) => (candidate.id === peer.id ? peer : candidate))
    : [...peers, peer];
  writePeers(next);
  // Re-read so hasDaemonPassword reflects the secret store rather than the draft.
  const saved = readPeers().find((candidate) => candidate.id === peer.id) ?? peer;
  return { peer: saved, health };
}

export async function handlePeerRemove(input: { id: string }) {
  setDaemonPassword(input.id, null);
  writePeers(readPeers().filter((peer) => peer.id !== input.id));
  const state = readState();
  const { [input.id]: _removed, ...rest } = state.peers;
  writeState({ ...state, peers: rest });
  planCache.delete(input.id);
  return { ok: true };
}

export async function handlePeerProbe(input: { id: string }) {
  const peer = requirePeer(input.id);
  const { peer: probed, health } = await probePeer(peer);
  writePeers(readPeers().map((candidate) => (candidate.id === probed.id ? probed : candidate)));
  return { peer: probed, health };
}

/** Both inventories, or a readable reason why not. */
async function gatherInventories(
  peer: Peer,
): Promise<{ ok: true; local: Inventory; remote: Inventory } | { ok: false; error: string }> {
  const local = localEndpoint();
  const remoteEndpoint = peerEndpoint(peer);
  if (!remoteEndpoint) {
    return {
      ok: false,
      error: "This peer has not been probed yet, so Sync does not know its paseo home or projects root. Probe it first.",
    };
  }
  const remote = await readRemoteInventory(peer, remoteEndpoint);
  if (!remote.ok) return { ok: false, error: remote.error };
  return { ok: true, local: readLocalInventory(local), remote: remote.inventory };
}

export async function handleProjectsList(input: { peerId: string }) {
  const peer = requirePeer(input.peerId);
  const gathered = await gatherInventories(peer);
  if (!gathered.ok) return { projects: [], warning: gathered.error };

  const state = peerState(readState(), peer.id);
  const selected = new Set(state.selectedProjects);

  const rows = new Map<string, ProjectRow>();

  const account = (inventory: Inventory, side: "local" | "remote"): void => {
    for (const project of inventory.projects) {
      if (project.archivedAt) continue;
      const key = projectKeyOf(project);
      const workspaces = inventory.workspaces.filter((w) => w.projectId === project.projectId);
      const open = workspaces.filter((w) => !w.archivedAt).length;

      const current =
        rows.get(key) ??
        ({
          projectKey: key,
          displayName: projectDisplayName(project),
          localRootPath: null,
          remoteRootPath: null,
          localOpenTabs: 0,
          localTotalTabs: 0,
          remoteOpenTabs: 0,
          remoteTotalTabs: 0,
          selected: selected.has(key),
          lastSyncedAt: cursorFor(state, key).lastSyncedAt,
          presentBothSides: false,
        } satisfies ProjectRow);

      if (side === "local") {
        current.localRootPath = project.rootPath;
        current.localOpenTabs = open;
        current.localTotalTabs = workspaces.length;
      } else {
        current.remoteRootPath = project.rootPath;
        current.remoteOpenTabs = open;
        current.remoteTotalTabs = workspaces.length;
      }
      current.presentBothSides = Boolean(current.localRootPath && current.remoteRootPath);
      rows.set(key, current);
    }
  };

  account(gathered.local, "local");
  account(gathered.remote, "remote");

  const projects = Array.from(rows.values()).sort((a, b) => {
    if (a.presentBothSides !== b.presentBothSides) return a.presentBothSides ? -1 : 1;
    return a.displayName.localeCompare(b.displayName);
  });

  return { projects, warning: null };
}

export async function handleProjectsSelect(input: {
  peerId: string;
  projectKey: string;
  selected: boolean;
}) {
  const state = readState();
  const peer = peerState(state, input.peerId);
  const set = new Set(peer.selectedProjects);
  if (input.selected) set.add(input.projectKey);
  else set.delete(input.projectKey);
  writeState(setPeerState(state, input.peerId, { ...peer, selectedProjects: Array.from(set) }));
  planCache.delete(input.peerId);
  return { ok: true };
}

export async function handlePlanBuild(input: {
  peerId: string;
  direction: Direction;
  includeArchived: boolean;
  scope?: Scope | null;
  agentIds?: string[] | null;
}) {
  const peer = requirePeer(input.peerId);
  const gathered = await gatherInventories(peer);
  if (!gathered.ok) throw new Error(gathered.error);

  const settings = readSettings();
  const state = peerState(readState(), peer.id);

  // Whether the RECEIVING side can actually resume what it is about to be given.
  const receiving = input.direction === "push" ? "remote" : "local";
  const targetProviders =
    receiving === "remote"
      ? await remoteProviders(peer)
      : { claude: true, codex: true };

  const { plan, detail } = buildPlan({
    peer,
    direction: input.direction,
    includeArchived: input.includeArchived,
    scope: input.scope ?? null,
    agentIds: input.agentIds ?? null,
    settings,
    state,
    local: gathered.local,
    remote: gathered.remote,
    targetProviders,
  });

  planCache.set(peer.id, { plan, detail, direction: input.direction });
  return { plan };
}

/**
 * Whether the peer has usable providers. Presence of the binary is necessary but
 * not sufficient — an installed CLI with no credentials fails at resume time,
 * which is exactly the surprise the preview exists to prevent.
 */
async function remoteProviders(peer: Peer): Promise<{ claude: boolean; codex: boolean }> {
  const { remoteAsDaemon } = await import("./peers.server");
  const script = [
    'command -v claude >/dev/null 2>&1 && echo "claude=yes" || echo "claude=no"',
    '{ [ -f "$HOME/.codex/auth.json" ] || grep -q "base_url" "$HOME/.codex/config.toml" 2>/dev/null; } && echo "codex=yes" || echo "codex=no"',
  ].join("; ");
  const result = await remoteAsDaemon(peer, script, { timeoutMs: 20_000 });
  if (!result.ok) return { claude: false, codex: false };
  return {
    claude: result.stdout.includes("claude=yes"),
    codex: result.stdout.includes("codex=yes"),
  };
}

export async function handleRunStart(
  input: {
    peerId: string;
    direction: Direction;
    includeArchived: boolean;
    // Carried for signature parity with plan-build; a run always executes the
    // cached plan the user actually previewed, never a freshly built one.
    scope?: Scope | null;
    agentIds?: string[] | null;
    skipStepIds: string[];
    conflictResolutions: Array<{ id: string; choice: "source" | "target" | "skip" }>;
  },
  { paseo }: PluginHandlerContext,
) {
  const peer = requirePeer(input.peerId);
  const cached = planCache.get(peer.id);
  if (!cached || cached.direction !== input.direction) {
    return { runId: "", accepted: false, error: "Build a preview first — a run only ever executes a plan you have seen." };
  }

  const unresolved = cached.plan.conflicts.filter(
    (conflict) => !input.conflictResolutions.some((resolution) => resolution.id === conflict.id),
  );
  if (unresolved.length > 0) {
    return {
      runId: "",
      accepted: false,
      error: `${unresolved.length} conflict${unresolved.length === 1 ? "" : "s"} still need a decision.`,
    };
  }

  const remoteEnd = peerEndpoint(peer);
  if (!remoteEnd) return { runId: "", accepted: false, error: "Peer has not been probed." };

  const gathered = await gatherInventories(peer);
  if (!gathered.ok) return { runId: "", accepted: false, error: gathered.error };

  const repoRoots = new Map<string, { source: string; target: string }>();
  for (const key of cached.plan.projectKeys) {
    const localProject = gathered.local.projects.find((p) => projectKeyOf(p) === key);
    const remoteProject = gathered.remote.projects.find((p) => projectKeyOf(p) === key);
    if (!localProject || !remoteProject) continue;
    repoRoots.set(
      key,
      input.direction === "push"
        ? { source: localProject.rootPath, target: remoteProject.rootPath }
        : { source: remoteProject.rootPath, target: localProject.rootPath },
    );
  }

  // Conflicts resolved "target" or "skip" drop their workspace's steps.
  const dropped = new Set(
    input.conflictResolutions
      .filter((resolution) => resolution.choice !== "source")
      .map((resolution) => resolution.id.replace(/^conflict_/, "")),
  );
  const skipStepIds = new Set(input.skipStepIds);
  for (const step of cached.plan.steps) {
    for (const workspaceId of dropped) {
      if (step.id.includes(workspaceId)) skipStepIds.add(step.id);
    }
  }

  const runId = startRun({
    paseo,
    peer,
    plan: cached.plan,
    detail: cached.detail,
    direction: input.direction,
    localEndpoint: localEndpoint(),
    remoteEndpoint: remoteEnd,
    skipStepIds,
    repoRoots,
  });

  return { runId, accepted: true, error: null };
}

export async function handleRunStatus(input: { runId: string | null }) {
  const run = input.runId ? getRun(input.runId) : latestRun();
  const state = readState();
  return { run, journal: state.journal };
}

export async function handleRunCancel(input: { runId: string }) {
  return { ok: cancelRun(input.runId) };
}

export async function handleSettingsGet() {
  return { settings: readSettings() };
}

export async function handleSettingsSave(input: Settings) {
  const settings: Settings = {
    untrackedAllowlist: input.untrackedAllowlist.length
      ? input.untrackedAllowlist
      : DEFAULT_SETTINGS.untrackedAllowlist,
    maxTranscriptMb: Math.max(1, Math.min(1024, input.maxTranscriptMb)),
    carryStashes: input.carryStashes,
  };
  writeSettings(settings);
  return { settings };
}

/**
 * Every agent tab on the sending side, with what the receiving side holds.
 *
 * This is the selection surface for chat sync. A tab is picked by its title and
 * how recently it was touched — which is how anyone actually thinks about "the
 * conversation I had yesterday" — rather than by the project that contains it.
 */
export async function handleTabList(input: {
  peerId: string;
  direction: Direction;
  includeArchived: boolean;
  query: string | null;
}) {
  const peer = requirePeer(input.peerId);
  const gathered = await gatherInventories(peer);
  if (!gathered.ok) return { tabs: [], message: gathered.error };

  const source = input.direction === "push" ? gathered.local : gathered.remote;
  const target = input.direction === "push" ? gathered.remote : gathered.local;

  const workspaceTitle = new Map(
    source.workspaces.map((workspace) => [workspace.workspaceId, workspace.title]),
  );
  const projectOf = new Map<string, string>();
  for (const workspace of source.workspaces) {
    const project = source.projects.find((entry) => entry.projectId === workspace.projectId);
    if (project) projectOf.set(workspace.workspaceId, projectKeyOf(project));
  }

  const needle = (input.query ?? "").trim().toLowerCase();

  const tabs: Tab[] = source.sessions
    .filter((session) => Boolean(session.sessionId))
    .filter((session) => input.includeArchived || !session.archivedAt)
    .map((session) => {
      const workspace = source.workspaces.find((entry) =>
        session.workspaceId ? entry.workspaceId === session.workspaceId : entry.cwd === session.cwd,
      );
      const projectKey = workspace ? (projectOf.get(workspace.workspaceId) ?? "") : "";
      const existing = session.sessionId ? target.transcripts[session.sessionId] : undefined;

      // What the receiving side already holds. Resuming a carried session
      // APPENDS, so a larger copy over there is the normal steady state after a
      // sync — not a reason to send it again.
      let state: Tab["state"];
      let detail: string;
      if (!session.transcriptPath || session.transcriptBytes === 0) {
        state = "no-transcript";
        detail = "No transcript on this machine — the tab carries, the conversation does not.";
      } else if (!existing) {
        state = "missing";
        detail = `Not on the other machine · ${(session.transcriptBytes / 1024).toFixed(0)}KB`;
      } else if (existing.bytes >= session.transcriptBytes) {
        state = "current";
        detail = "Already there, and at least as complete.";
      } else {
        state = "older";
        detail = `Older there by ${((session.transcriptBytes - existing.bytes) / 1024).toFixed(0)}KB`;
      }

      return {
        agentId: session.agentId,
        projectKey,
        title: session.title ?? session.sessionId?.slice(0, 8) ?? session.agentId.slice(0, 8),
        provider: (session.persistenceProvider ?? session.provider ?? "unknown").toLowerCase(),
        cwd: session.cwd,
        workspaceTitle: workspace ? (workspaceTitle.get(workspace.workspaceId) ?? null) : null,
        lastActivityAt: session.lastActivityAt,
        archived: Boolean(session.archivedAt),
        bytes: session.transcriptBytes,
        state,
        detail,
      };
    })
    .filter((tab) => {
      if (!needle) return true;
      return (
        tab.title.toLowerCase().includes(needle) ||
        tab.projectKey.toLowerCase().includes(needle) ||
        (tab.workspaceTitle ?? "").toLowerCase().includes(needle)
      );
    })
    // Most recent first: the tab you want is nearly always the one you just left.
    .sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));

  return { tabs, message: null };
}
