import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { Peer } from "./contracts.shared";
import { asDaemonCommand, remoteAsDaemon, sshArgs } from "./peers.server";
import type { Endpoint } from "./paths.server";
import { rewriteJson, rewriteText } from "./paths.server";

const run = promisify(execFile);

/**
 * Moving bytes and refs between two daemons.
 *
 * Everything here is done from Node rather than from a shell script, which
 * removes an entire failure class: a `while read … ssh …` loop has its stdin
 * consumed by ssh and silently processes only the first line. Where a shell is
 * unavoidable it is one non-interactive command, never a loop.
 */

export type Side = "local" | "remote";

/** Read a file from either side. */
export async function readFile(
  side: Side,
  peer: Peer,
  path: string,
): Promise<{ ok: true; content: Buffer } | { ok: false; error: string }> {
  if (side === "local") {
    try {
      return { ok: true, content: readFileSync(path) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const result = await remoteAsDaemon(peer, `base64 < ${shellQuote(path)}`, {
    timeoutMs: 300_000,
    maxBufferMb: 256,
  });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, content: Buffer.from(result.stdout.replace(/\s+/g, ""), "base64") };
}

/**
 * Write a file to either side, atomically.
 *
 * The remote write goes through the daemon user, so nothing lands root-owned in
 * a home the daemon then cannot read — the repair pass the one-way migration
 * needed is designed out rather than scripted afterwards.
 */
export async function writeFileTo(
  side: Side,
  peer: Peer,
  path: string,
  content: Buffer,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (side === "local") {
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp-sync-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, content);
      renameSync(tmp, path);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  const encoded = content.toString("base64");
  const quoted = shellQuote(path);
  const tmp = shellQuote(`${path}.tmp-sync-$$`);
  // Written in one command: mkdir, decode to a temp file, rename into place.
  const command = `mkdir -p ${shellQuote(dirname(path))} && base64 -d > ${tmp} && mv ${tmp} ${quoted}`;
  return writeRemoteStdin(peer, command, encoded);
}

/** Run a remote command feeding `stdin`, as the daemon user. */
async function writeRemoteStdin(
  peer: Peer,
  command: string,
  stdin: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Runs as the daemon user where the host allows it, and falls back to a plain
  // shell + chown where sudo is absent (correct only as root, which the peer
  // health check enforces before a plan is allowed to write).
  const { wrapped } = asDaemonCommand(peer, command, shellQuote);

  return new Promise((resolve) => {
    const child = execFile(
      "ssh",
      [...sshArgs(peer), wrapped],
      { timeout: 300_000, maxBuffer: 64 * 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (error) {
          const detail = (stderr || error.message).trim().split("\n")[0] ?? "write failed";
          resolve({ ok: false, error: detail });
          return;
        }
        resolve({ ok: true });
      },
    );
    child.stdin?.end(stdin);
  });
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Run git on either side. */
export async function git(
  side: Side,
  peer: Peer,
  repoPath: string,
  args: string[],
  options?: { timeoutMs?: number },
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  if (side === "local") {
    try {
      const { stdout } = await run("git", ["-C", repoPath, ...args], {
        timeout: options?.timeoutMs ?? 120_000,
        maxBuffer: 32 * 1024 * 1024,
      });
      return { ok: true, stdout };
    } catch (error) {
      const err = error as { stderr?: string; message?: string };
      return { ok: false, error: (err.stderr ?? err.message ?? String(error)).trim().split("\n")[0] ?? "git failed" };
    }
  }
  const command = `git -C ${shellQuote(repoPath)} ${args.map(shellQuote).join(" ")}`;
  const result = await remoteAsDaemon(peer, command, { timeoutMs: options?.timeoutMs ?? 120_000 });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, stdout: result.stdout };
}

/**
 * Fetch branches from the peer's checkout directly into the receiving one.
 *
 * Direct is chosen over the shared forge for two measured reasons: it is about
 * twice as fast warm (427ms vs 799ms on a real repo), and it can see refs that
 * were never pushed — which is exactly what paseo worktree branches are.
 *
 * It is always a FETCH. Pushing into a non-bare checkout is refused by git for
 * its checked-out branch, and only one side of a pair is usually reachable, so
 * "the reachable side fetches" is the only shape that works in both directions.
 */
export async function fetchFromPeer(input: {
  /** Where the fetch runs — the side that ends up holding the refs. */
  side: Side;
  peer: Peer;
  targetRepoPath: string;
  sourceRepoPath: string;
  refs: string[];
  /** How the fetching side addresses the other one over ssh. */
  remoteUrl: string;
  sshCommand: string | null;
}): Promise<{ ok: true; fetched: string[] } | { ok: false; error: string }> {
  // `paseo-sync` is the remote-tracking namespace, not the repository name. It
  // is written into users' repositories, and the checkout below resolves the
  // same path, so renaming it would orphan every ref a previous run created.
  const refspecs = input.refs.map(
    (ref) => `+refs/heads/${ref}:refs/remotes/paseo-sync/${ref}`,
  );
  const args = ["fetch", "--no-tags", "--prune", input.remoteUrl, ...refspecs];

  if (input.side === "local") {
    try {
      const env = { ...process.env };
      if (input.sshCommand) env.GIT_SSH_COMMAND = input.sshCommand;
      await run("git", ["-C", input.targetRepoPath, ...args], {
        timeout: 600_000,
        maxBuffer: 64 * 1024 * 1024,
        env,
      });
      return { ok: true, fetched: input.refs };
    } catch (error) {
      const err = error as { stderr?: string; message?: string };
      return {
        ok: false,
        error: (err.stderr ?? err.message ?? String(error)).trim().split("\n").slice(-1)[0] ?? "fetch failed",
      };
    }
  }

  const prefix = input.sshCommand ? `GIT_SSH_COMMAND=${shellQuote(input.sshCommand)} ` : "";
  const command = `${prefix}git -C ${shellQuote(input.targetRepoPath)} ${args.map(shellQuote).join(" ")}`;
  const result = await remoteAsDaemon(input.peer, command, { timeoutMs: 600_000 });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, fetched: input.refs };
}

/**
 * Carry uncommitted work as a stash.
 *
 * `git stash create` builds a commit without touching the working tree or the
 * stash list, so the source is left exactly as the user had it. The far side
 * receives it as a real stash entry via `stash store`, recoverable with the
 * ordinary `git stash` commands rather than anything Sync-specific.
 */
export async function carryStash(input: {
  sourceSide: Side;
  targetSide: Side;
  peer: Peer;
  sourceRepoPath: string;
  targetRepoPath: string;
  remoteUrl: string;
  sshCommand: string | null;
  label: string;
}): Promise<{ ok: true; sha: string | null } | { ok: false; error: string }> {
  const created = await git(input.sourceSide, input.peer, input.sourceRepoPath, [
    "stash",
    "create",
    input.label,
  ]);
  if (!created.ok) return { ok: false, error: created.error };
  const sha = created.stdout.trim();
  if (!sha) return { ok: true, sha: null };

  // The stash commit is dangling; a plain fetch of a sha needs the remote to
  // allow it, so it is fetched by explicit object id into a private ref first.
  const fetchArgs = ["fetch", "--no-tags", input.remoteUrl, sha];
  if (input.targetSide === "local") {
    try {
      const env = { ...process.env };
      if (input.sshCommand) env.GIT_SSH_COMMAND = input.sshCommand;
      await run("git", ["-C", input.targetRepoPath, ...fetchArgs], { timeout: 300_000, env });
    } catch (error) {
      const err = error as { stderr?: string; message?: string };
      return {
        ok: false,
        error: `Could not carry the stash: ${(err.stderr ?? err.message ?? String(error)).trim().split("\n").slice(-1)[0]}`,
      };
    }
  } else {
    const prefix = input.sshCommand ? `GIT_SSH_COMMAND=${shellQuote(input.sshCommand)} ` : "";
    const command = `${prefix}git -C ${shellQuote(input.targetRepoPath)} ${fetchArgs.map(shellQuote).join(" ")}`;
    const result = await remoteAsDaemon(input.peer, command, { timeoutMs: 300_000 });
    if (!result.ok) return { ok: false, error: `Could not carry the stash: ${result.error}` };
  }

  const stored = await git(input.targetSide, input.peer, input.targetRepoPath, [
    "stash",
    "store",
    "-m",
    input.label,
    sha,
  ]);
  if (!stored.ok) return { ok: false, error: stored.error };
  return { ok: true, sha };
}

/** Register a paseo-owned worktree on the receiving side at the recomputed path. */
export async function registerWorktree(input: {
  side: Side;
  peer: Peer;
  repoPath: string;
  worktreePath: string;
  branch: string;
}): Promise<{ ok: true; created: boolean } | { ok: false; error: string }> {
  const listed = await git(input.side, input.peer, input.repoPath, ["worktree", "list", "--porcelain"]);
  if (listed.ok && listed.stdout.includes(input.worktreePath)) {
    return { ok: true, created: false };
  }
  // Prefer the synced ref; fall back to the local branch if it already exists.
  const attempt = await git(input.side, input.peer, input.repoPath, [
    "worktree",
    "add",
    "--force",
    "-B",
    input.branch,
    input.worktreePath,
    `refs/remotes/paseo-sync/${input.branch}`,
  ]);
  if (attempt.ok) return { ok: true, created: true };

  const fallback = await git(input.side, input.peer, input.repoPath, [
    "worktree",
    "add",
    "--force",
    input.worktreePath,
    input.branch,
  ]);
  if (fallback.ok) return { ok: true, created: true };
  return { ok: false, error: fallback.error };
}

/**
 * Move one session's transcript, rewriting the paths inside it.
 *
 * Transcripts are treated as append-mostly rather than append-only: timestamps
 * are not strictly monotonic across `attachment` records, so a tail-diff would
 * be wrong. Size and mtime decide whether a transfer is needed; the file itself
 * is replaced whole.
 */
export async function transferTranscript(input: {
  sourceSide: Side;
  targetSide: Side;
  peer: Peer;
  sourcePath: string;
  targetPath: string;
  source: Endpoint;
  target: Endpoint;
  hashMap: ReadonlyMap<string, string>;
}): Promise<{ ok: true; bytes: number } | { ok: false; error: string }> {
  const read = await readFile(input.sourceSide, input.peer, input.sourcePath);
  if (!read.ok) return { ok: false, error: read.error };

  const rewritten = rewriteText(
    read.content.toString("utf8"),
    input.source,
    input.target,
    input.hashMap,
  );
  const buffer = Buffer.from(rewritten, "utf8");
  const written = await writeFileTo(input.targetSide, input.peer, input.targetPath, buffer);
  if (!written.ok) return { ok: false, error: written.error };
  return { ok: true, bytes: buffer.byteLength };
}

/**
 * Move one agent session record.
 *
 * Two things must change or the tab is broken on arrival:
 *  - `persistence.metadata.mcpServers` carries a bearer token and callerAgentId
 *    scoped to the ORIGIN daemon's MCP endpoint. Carried verbatim, the resumed
 *    agent talks to the wrong daemon. It is stripped; the receiving daemon
 *    reissues its own.
 *  - `workspaceId` must name a workspace that exists on the receiving side.
 */
export async function transferSessionRecord(input: {
  sourceSide: Side;
  targetSide: Side;
  peer: Peer;
  sourcePath: string;
  targetPath: string;
  source: Endpoint;
  target: Endpoint;
  hashMap: ReadonlyMap<string, string>;
  workspaceId: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const read = await readFile(input.sourceSide, input.peer, input.sourcePath);
  if (!read.ok) return { ok: false, error: read.error };

  let record: Record<string, unknown>;
  try {
    record = JSON.parse(read.content.toString("utf8")) as Record<string, unknown>;
  } catch (error) {
    return {
      ok: false,
      error: `Session record is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const rewritten = rewriteJson(record, input.source, input.target, input.hashMap);

  const persistence = rewritten.persistence as Record<string, unknown> | undefined;
  if (persistence && typeof persistence === "object") {
    const metadata = persistence.metadata as Record<string, unknown> | undefined;
    if (metadata && typeof metadata === "object") {
      delete metadata.mcpServers;
    }
  }
  if (input.workspaceId) rewritten.workspaceId = input.workspaceId;

  const buffer = Buffer.from(`${JSON.stringify(rewritten, null, 2)}\n`, "utf8");
  return writeFileTo(input.targetSide, input.peer, input.targetPath, buffer);
}

/**
 * Ask the peer's own daemon to adopt a carried session as a tab.
 *
 * `paseo import` is the sanctioned path: server-side it runs
 * `runInImportWorkspace`, which finds or creates the workspace for the cwd and
 * attaches the session in one transaction. Writing workspaces.json directly
 * would be both invisible to the running daemon and clobbered by its next
 * mutation, so this is the only way in that survives.
 *
 * The peer's CLI refuses to connect without its daemon password; without one
 * stored, history still lands and the caller reports the tab as pending rather
 * than pretending it appeared.
 */
export async function importSessionOnPeer(input: {
  peer: Peer;
  sessionId: string;
  provider: "claude" | "codex";
  cwd: string;
  daemonPassword: string | null;
}): Promise<{ ok: true; detail: string } | { ok: false; error: string }> {
  if (!input.daemonPassword) {
    return {
      ok: false,
      error:
        "No daemon password stored for this peer, so its daemon will not accept the import. Add one on the Peers tab; the history is already there and will attach on the next run.",
    };
  }
  const command =
    `PASEO_PASSWORD=${shellQuote(input.daemonPassword)} ` +
    `paseo import ${shellQuote(input.sessionId)} ` +
    `--provider ${shellQuote(input.provider)} --cwd ${shellQuote(input.cwd)} --json`;

  const result = await remoteAsDaemon(input.peer, command, { timeoutMs: 120_000 });
  if (!result.ok) return { ok: false, error: result.error };

  // Importing something the daemon already adopted is success, not failure.
  if (/already imported/i.test(result.stdout) || /already imported/i.test(result.stderr)) {
    return { ok: true, detail: "already a tab there" };
  }
  try {
    const parsed = JSON.parse(result.stdout) as { error?: { message?: string } };
    if (parsed.error) return { ok: false, error: parsed.error.message ?? "import failed" };
  } catch {
    // Non-JSON output from a zero-exit run is fine.
  }
  return { ok: true, detail: "tab created on the peer" };
}

/** Copy one untracked-but-wanted file (an .env and friends). */
export async function copyFile(input: {
  sourceSide: Side;
  targetSide: Side;
  peer: Peer;
  sourcePath: string;
  targetPath: string;
}): Promise<{ ok: true; bytes: number } | { ok: false; error: string }> {
  const read = await readFile(input.sourceSide, input.peer, input.sourcePath);
  if (!read.ok) return { ok: false, error: read.error };
  const written = await writeFileTo(input.targetSide, input.peer, input.targetPath, read.content);
  if (!written.ok) return { ok: false, error: written.error };
  return { ok: true, bytes: read.content.byteLength };
}
