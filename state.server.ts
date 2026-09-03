import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { localPaseoHome } from "./peers.server";
import type { Direction } from "./contracts.shared";

/**
 * Sync's own durable state: which projects are selected, how workspace ids map
 * between daemons, what was already transferred, and what past runs did.
 *
 * The id map exists because the daemon's workspace API cannot preserve an id —
 * `workspace.create.request` always mints a fresh `wks_…`. Rather than editing
 * workspaces.json underneath a running daemon, Sync keeps its own correspondence
 * and lets each side own its ids.
 */

export type SyncCursor = {
  /** sessionId → the transferred transcript's size+mtime, so a re-run is cheap. */
  sessions: Record<string, { bytes: number; mtimeMs: number; lastActivityAt: string | null }>;
  /** ref name → sha last fetched. */
  refs: Record<string, string>;
  /** relative path → size+mtime of the last copied untracked file. */
  files: Record<string, { bytes: number; mtimeMs: number }>;
  lastSyncedAt: string | null;
};

export type PeerState = {
  /** Project keys the user explicitly selected. Nothing else is ever read. */
  selectedProjects: string[];
  /** localWorkspaceId → remoteWorkspaceId */
  workspaceIdMap: Record<string, string>;
  /** projectKey → cursor, per direction. */
  cursors: Record<string, SyncCursor>;
};

export type JournalEntry = {
  runId: string;
  peerId: string;
  direction: Direction;
  finishedAt: string;
  state: string;
  summary: string;
  bytesMoved: number;
};

export type SyncState = {
  version: 1;
  peers: Record<string, PeerState>;
  journal: JournalEntry[];
};

const STATE_PATH = join(localPaseoHome(), "sync", "state.json");
const MAX_JOURNAL = 30;

const EMPTY_STATE: SyncState = { version: 1, peers: {}, journal: [] };

/** See peers.server.ts — missing is fine, unparseable must never be overwritten. */
export function readState(): SyncState {
  if (!existsSync(STATE_PATH)) return structuredClone(EMPTY_STATE);
  const raw = readFileSync(STATE_PATH, "utf8");
  try {
    const parsed = JSON.parse(raw) as SyncState;
    return { ...structuredClone(EMPTY_STATE), ...parsed };
  } catch (error) {
    throw new Error(
      `${STATE_PATH} exists but could not be parsed; refusing to overwrite it. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function writeState(state: SyncState): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  const tmp = `${STATE_PATH}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(tmp, STATE_PATH);
}

export function peerState(state: SyncState, peerId: string): PeerState {
  const existing = state.peers[peerId];
  if (existing) {
    return {
      selectedProjects: existing.selectedProjects ?? [],
      workspaceIdMap: existing.workspaceIdMap ?? {},
      cursors: existing.cursors ?? {},
    };
  }
  return { selectedProjects: [], workspaceIdMap: {}, cursors: {} };
}

export function setPeerState(state: SyncState, peerId: string, next: PeerState): SyncState {
  return { ...state, peers: { ...state.peers, [peerId]: next } };
}

export function emptyCursor(): SyncCursor {
  return { sessions: {}, refs: {}, files: {}, lastSyncedAt: null };
}

export function cursorFor(peer: PeerState, projectKey: string): SyncCursor {
  return peer.cursors[projectKey] ?? emptyCursor();
}

export function appendJournal(state: SyncState, entry: JournalEntry): SyncState {
  return { ...state, journal: [entry, ...state.journal].slice(0, MAX_JOURNAL) };
}
