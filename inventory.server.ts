import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Peer } from "./contracts.shared";
import { remoteAsDaemon } from "./peers.server";
import type { Endpoint } from "./paths.server";
import { agentDirName, claudeProjectDirName } from "./paths.server";

/**
 * A snapshot of one daemon: its projects, workspaces, agent session records and
 * the transcripts backing them.
 *
 * Both sides are read the same way — the local one directly, the remote one via
 * a single python program over ssh — so the two inventories are directly
 * comparable and a sync run costs one round trip per side rather than one per
 * workspace.
 */

export type ProjectRecord = {
  projectId: string;
  rootPath: string;
  projectKey: string | null;
  displayName: string;
  customName: string | null;
  kind: string;
  archivedAt: string | null;
};

export type WorkspaceRecord = {
  workspaceId: string;
  projectId: string;
  cwd: string;
  kind: string;
  displayName: string;
  title: string | null;
  branch: string | null;
  worktreeRoot: string | null;
  baseBranch: string | null;
  isPaseoOwnedWorktree: boolean;
  mainRepoRoot: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  pinnedAt: string | null;
};

export type SessionRecord = {
  agentId: string;
  path: string;
  provider: string;
  cwd: string;
  workspaceId: string | null;
  title: string | null;
  lastActivityAt: string | null;
  updatedAt: string | null;
  archivedAt: string | null;
  sessionId: string | null;
  persistenceProvider: string | null;
  /** Transcript backing this session, when one exists on that machine. */
  transcriptPath: string | null;
  transcriptBytes: number;
  transcriptMtimeMs: number;
};

export type Inventory = {
  endpoint: Endpoint;
  projects: ProjectRecord[];
  workspaces: WorkspaceRecord[];
  sessions: SessionRecord[];
  /** Every rollout/transcript on the machine, keyed by session id. */
  transcripts: Record<string, { path: string; bytes: number; mtimeMs: number; provider: string }>;
};

/**
 * The inventory program, run identically on both sides.
 *
 * It is emitted as a single python heredoc so a remote read is one ssh round
 * trip. Python is used rather than a shell loop precisely because the shell
 * version of this — `while read … ssh …` — has its stdin eaten by ssh; keeping
 * all iteration inside one process removes that class of bug entirely.
 */
function inventoryProgram(paseoHome: string, homeDir: string): string {
  return `
import json, os, sys

PASEO_HOME = ${JSON.stringify(paseoHome)}
HOME = ${JSON.stringify(homeDir)}

def load(path, fallback):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return fallback

projects = load(os.path.join(PASEO_HOME, "projects", "projects.json"), [])
workspaces = load(os.path.join(PASEO_HOME, "projects", "workspaces.json"), [])

sessions = []
agents_root = os.path.join(PASEO_HOME, "agents")
if os.path.isdir(agents_root):
    for entry in os.listdir(agents_root):
        directory = os.path.join(agents_root, entry)
        if not os.path.isdir(directory):
            continue
        for name in os.listdir(directory):
            if not name.endswith(".json"):
                continue
            full = os.path.join(directory, name)
            record = load(full, None)
            if not isinstance(record, dict):
                continue
            persistence = record.get("persistence") or {}
            sessions.append({
                "agentId": record.get("id"),
                "path": full,
                "provider": record.get("provider"),
                "cwd": record.get("cwd"),
                "workspaceId": record.get("workspaceId"),
                "title": record.get("title"),
                "lastActivityAt": record.get("lastActivityAt"),
                "updatedAt": record.get("updatedAt"),
                "archivedAt": record.get("archivedAt"),
                "sessionId": persistence.get("sessionId"),
                "persistenceProvider": persistence.get("provider"),
            })

transcripts = {}

claude_root = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(HOME, ".claude")
claude_projects = os.path.join(claude_root, "projects")
if os.path.isdir(claude_projects):
    for folder in os.listdir(claude_projects):
        directory = os.path.join(claude_projects, folder)
        if not os.path.isdir(directory):
            continue
        for name in os.listdir(directory):
            if not name.endswith(".jsonl"):
                continue
            full = os.path.join(directory, name)
            try:
                info = os.stat(full)
            except OSError:
                continue
            transcripts[name[:-6]] = {
                "path": full,
                "bytes": info.st_size,
                "mtimeMs": int(info.st_mtime * 1000),
                "provider": "claude",
            }

codex_root = os.environ.get("CODEX_HOME") or os.path.join(HOME, ".codex")
codex_sessions = os.path.join(codex_root, "sessions")
if os.path.isdir(codex_sessions):
    for root, _dirs, files in os.walk(codex_sessions):
        for name in files:
            if not name.endswith(".jsonl"):
                continue
            full = os.path.join(root, name)
            try:
                info = os.stat(full)
            except OSError:
                continue
            # rollout-<timestamp>-<uuid>.jsonl — the uuid is the thread id.
            transcripts[name[:-6][-36:]] = {
                "path": full,
                "bytes": info.st_size,
                "mtimeMs": int(info.st_mtime * 1000),
                "provider": "codex",
            }

json.dump({
    "projects": projects,
    "workspaces": workspaces,
    "sessions": sessions,
    "transcripts": transcripts,
}, sys.stdout)
`;
}

function attachTranscripts(
  sessions: SessionRecord[],
  transcripts: Inventory["transcripts"],
): SessionRecord[] {
  return sessions.map((session) => {
    const found = session.sessionId ? transcripts[session.sessionId] : undefined;
    return {
      ...session,
      transcriptPath: found?.path ?? null,
      transcriptBytes: found?.bytes ?? 0,
      transcriptMtimeMs: found?.mtimeMs ?? 0,
    };
  });
}

function coerceInventory(raw: unknown, endpoint: Endpoint): Inventory {
  const shape = raw as {
    projects?: ProjectRecord[];
    workspaces?: WorkspaceRecord[];
    sessions?: SessionRecord[];
    transcripts?: Inventory["transcripts"];
  };
  const transcripts = shape.transcripts ?? {};
  const sessions = attachTranscripts(shape.sessions ?? [], transcripts);
  return {
    endpoint,
    projects: shape.projects ?? [],
    workspaces: shape.workspaces ?? [],
    sessions,
    transcripts,
  };
}

/** Read the local daemon by running the same program in-process. */
export function readLocalInventory(endpoint: Endpoint): Inventory {
  const projectsPath = join(endpoint.paseoHome, "projects", "projects.json");
  const workspacesPath = join(endpoint.paseoHome, "projects", "workspaces.json");

  const readJson = <T>(path: string, fallback: T): T => {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch {
      return fallback;
    }
  };

  const projects = readJson<ProjectRecord[]>(projectsPath, []);
  const workspaces = readJson<WorkspaceRecord[]>(workspacesPath, []);

  const sessions: SessionRecord[] = [];
  const agentsRoot = join(endpoint.paseoHome, "agents");
  if (existsSync(agentsRoot)) {
    for (const entry of readdirSync(agentsRoot)) {
      const directory = join(agentsRoot, entry);
      let names: string[];
      try {
        if (!statSync(directory).isDirectory()) continue;
        names = readdirSync(directory);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const full = join(directory, name);
        const record = readJson<Record<string, unknown> | null>(full, null);
        if (!record || typeof record !== "object") continue;
        const persistence = (record.persistence ?? {}) as Record<string, unknown>;
        sessions.push({
          agentId: String(record.id ?? ""),
          path: full,
          provider: String(record.provider ?? ""),
          cwd: String(record.cwd ?? ""),
          workspaceId: (record.workspaceId as string | null) ?? null,
          title: (record.title as string | null) ?? null,
          lastActivityAt: (record.lastActivityAt as string | null) ?? null,
          updatedAt: (record.updatedAt as string | null) ?? null,
          archivedAt: (record.archivedAt as string | null) ?? null,
          sessionId: (persistence.sessionId as string | null) ?? null,
          persistenceProvider: (persistence.provider as string | null) ?? null,
          transcriptPath: null,
          transcriptBytes: 0,
          transcriptMtimeMs: 0,
        });
      }
    }
  }

  const transcripts: Inventory["transcripts"] = {};

  const claudeProjects = join(
    process.env.CLAUDE_CONFIG_DIR ?? join(endpoint.homeDir, ".claude"),
    "projects",
  );
  if (existsSync(claudeProjects)) {
    for (const folder of readdirSync(claudeProjects)) {
      const directory = join(claudeProjects, folder);
      let names: string[];
      try {
        if (!statSync(directory).isDirectory()) continue;
        names = readdirSync(directory);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const full = join(directory, name);
        try {
          const info = statSync(full);
          transcripts[name.slice(0, -6)] = {
            path: full,
            bytes: info.size,
            mtimeMs: info.mtimeMs,
            provider: "claude",
          };
        } catch {
          continue;
        }
      }
    }
  }

  const codexSessions = join(
    process.env.CODEX_HOME ?? join(endpoint.homeDir, ".codex"),
    "sessions",
  );
  const walk = (directory: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(directory, entry);
      let info;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".jsonl")) continue;
      transcripts[entry.slice(0, -6).slice(-36)] = {
        path: full,
        bytes: info.size,
        mtimeMs: info.mtimeMs,
        provider: "codex",
      };
    }
  };
  if (existsSync(codexSessions)) walk(codexSessions);

  return {
    endpoint,
    projects,
    workspaces,
    sessions: attachTranscripts(sessions, transcripts),
    transcripts,
  };
}

/** Read a peer in one round trip, as its daemon user. */
export async function readRemoteInventory(
  peer: Peer,
  endpoint: Endpoint,
): Promise<{ ok: true; inventory: Inventory } | { ok: false; error: string }> {
  const program = inventoryProgram(endpoint.paseoHome, endpoint.homeDir);
  const encoded = Buffer.from(program, "utf8").toString("base64");
  // Piping the program in base64 avoids every quoting hazard in the ssh command
  // line, and keeps it a single invocation.
  const command = `echo ${encoded} | base64 -d | python3 -`;
  const result = await remoteAsDaemon(peer, command, { timeoutMs: 120_000, maxBufferMb: 256 });
  if (!result.ok) return { ok: false, error: result.error };
  try {
    return { ok: true, inventory: coerceInventory(JSON.parse(result.stdout), endpoint) };
  } catch (error) {
    return {
      ok: false,
      error: `Could not read the peer's inventory: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * Stable identity for a project across machines.
 *
 * `projectKey` is a remote URL for git projects, which is machine-independent
 * and therefore the right key. Non-git projects fall back to their directory
 * name — the only portable thing about them.
 */
export function projectKeyOf(project: ProjectRecord): string {
  if (project.projectKey) return project.projectKey;
  const base = project.rootPath.split("/").filter(Boolean).pop();
  return `dir:${base ?? project.projectId}`;
}

export function projectDisplayName(project: ProjectRecord): string {
  return project.customName ?? project.displayName;
}

/** Where a transcript for `sessionId` belongs on `endpoint`. */
export function transcriptTargetPath(
  endpoint: Endpoint,
  provider: string,
  sessionId: string,
  cwd: string,
  sourcePath: string | null,
): string {
  if (provider === "codex") {
    // Codex indexes by thread id; the dated directory is cosmetic. Preserving
    // the source's own dated path keeps both machines' layouts identical.
    const marker = "/sessions/";
    if (sourcePath && sourcePath.includes(marker)) {
      const tail = sourcePath.slice(sourcePath.indexOf(marker) + marker.length);
      return join(endpoint.homeDir, ".codex", "sessions", tail);
    }
    return join(endpoint.homeDir, ".codex", "sessions", `rollout-${sessionId}.jsonl`);
  }
  return join(
    endpoint.homeDir,
    ".claude",
    "projects",
    claudeProjectDirName(cwd),
    `${sessionId}.jsonl`,
  );
}

/** Where an agent record for `cwd` belongs on `endpoint`. */
export function agentRecordTargetPath(
  endpoint: Endpoint,
  cwd: string,
  agentId: string,
): string {
  return join(endpoint.paseoHome, "agents", agentDirName(cwd), `${agentId}.json`);
}
