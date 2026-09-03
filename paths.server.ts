import { createHash } from "node:crypto";
import { posix as posixPath } from "node:path";

/**
 * Path translation between two daemons.
 *
 * Every rule here derives from what the two peers report about themselves —
 * their paseo home, projects root and home directory. Nothing is hardcoded to a
 * particular machine, user or OS layout.
 *
 * The subtle part is worktrees. Paseo names a worktree's project directory by
 * hashing the repository's ABSOLUTE root path, so the same repository lands
 * under a different hash on every machine:
 *
 *   2bsdr8ws  <mac>/projects/acme-api
 *   2i9p34za  <linux>/projects/acme-api
 *
 * A prefix substitution — which is what a naive migration does — therefore
 * produces a path the far daemon will never look at. The hash has to be
 * recomputed from the target's own repo root.
 */

export type Endpoint = {
  /** e.g. /Users/alice/.paseo or /home/paseo/.paseo */
  paseoHome: string;
  /** Where this daemon's project checkouts live. */
  projectsRoot: string;
  /** The account home, used only as a last-resort fallback rule. */
  homeDir: string;
};

const WORKTREE_PROJECT_HASH_LENGTH = 8;

/**
 * Verbatim port of the daemon's `deriveShortAlphanumericHash`
 * (@getpaseo/server utils/worktree.js): sha256, first 8 bytes big-endian into a
 * BigInt, base36, left-padded to 13, sliced to 8.
 *
 * Verified against live directories on two machines before being relied on.
 */
export function shortHash(value: string): string {
  const digest = createHash("sha256").update(value).digest();
  let hashValue = 0n;
  for (let index = 0; index < 8; index += 1) {
    hashValue = (hashValue << 8n) | BigInt(digest[index] ?? 0);
  }
  return hashValue.toString(36).padStart(13, "0").slice(0, WORKTREE_PROJECT_HASH_LENGTH);
}

const CLAUDE_PROJECT_DIR_LENGTH_CAP = 200;

/**
 * Verbatim port of the Claude Agent SDK's project-directory encoding, as the
 * daemon reimplements it in providers/claude/project-dir.js. A wrong encoding
 * puts a transcript somewhere the far daemon will never list, so this must stay
 * byte-identical to theirs.
 */
export function claudeProjectDirName(cwd: string): string {
  const replaced = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (replaced.length <= CLAUDE_PROJECT_DIR_LENGTH_CAP) return replaced;
  let hash = 0;
  for (let i = 0; i < cwd.length; i += 1) {
    hash = ((hash << 5) - hash + cwd.charCodeAt(i)) | 0;
  }
  return `${replaced.slice(0, CLAUDE_PROJECT_DIR_LENGTH_CAP)}-${Math.abs(hash).toString(36)}`;
}

/** The slug Paseo uses for an agent-record directory: cwd with "/" → "-". */
export function agentDirName(cwd: string): string {
  return cwd.replace(/^\/+/, "").split("/").join("-");
}

function underRoot(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const normalizedRoot = root.endsWith("/") ? root : `${root}/`;
  return candidate.startsWith(normalizedRoot);
}

function relativeTo(candidate: string, root: string): string {
  if (candidate === root) return "";
  const normalizedRoot = root.endsWith("/") ? root : `${root}/`;
  return candidate.slice(normalizedRoot.length);
}

export type TranslateResult = {
  path: string;
  /** Which rule fired — surfaced in the preview so a wrong mapping is visible. */
  rule: "projects" | "worktree" | "paseo-home" | "home" | "unchanged";
  /** Set when a worktree hash had to be recomputed rather than substituted. */
  recomputedHash: { from: string; to: string; repo: string } | null;
};

/**
 * Translate one absolute path from `source` to `target`.
 *
 * Worktree paths are `<paseoHome>/worktrees/<hash>/<slug>[/deeper]`. The repo a
 * worktree belongs to cannot be read out of the path itself — the hash is one
 * way — so the caller passes `repoName` (known from the workspace's project) and
 * we recompute the hash against the target's own repo root.
 */
export function translatePath(
  input: string,
  source: Endpoint,
  target: Endpoint,
  repoName?: string | null,
): TranslateResult {
  const value = input.trim();
  if (!value.startsWith("/")) {
    return { path: value, rule: "unchanged", recomputedHash: null };
  }

  const sourceWorktrees = posixPath.join(source.paseoHome, "worktrees");
  if (underRoot(value, sourceWorktrees)) {
    const rest = relativeTo(value, sourceWorktrees);
    const parts = rest.split("/").filter(Boolean);
    const sourceHash = parts[0] ?? "";
    const remainder = parts.slice(1);
    const targetWorktrees = posixPath.join(target.paseoHome, "worktrees");
    if (repoName) {
      const targetRepoRoot = posixPath.join(target.projectsRoot, repoName);
      const targetHash = shortHash(targetRepoRoot);
      return {
        path: posixPath.join(targetWorktrees, targetHash, ...remainder),
        rule: "worktree",
        recomputedHash: { from: sourceHash, to: targetHash, repo: repoName },
      };
    }
    // Without a repo we cannot recompute. Keeping the source hash would be a
    // silent wrong answer, so the caller is told the hash is unresolved.
    return {
      path: posixPath.join(targetWorktrees, sourceHash, ...remainder),
      rule: "worktree",
      recomputedHash: null,
    };
  }

  if (underRoot(value, source.projectsRoot)) {
    return {
      path: posixPath.join(target.projectsRoot, relativeTo(value, source.projectsRoot)),
      rule: "projects",
      recomputedHash: null,
    };
  }

  if (underRoot(value, source.paseoHome)) {
    return {
      path: posixPath.join(target.paseoHome, relativeTo(value, source.paseoHome)),
      rule: "paseo-home",
      recomputedHash: null,
    };
  }

  if (underRoot(value, source.homeDir)) {
    return {
      path: posixPath.join(target.homeDir, relativeTo(value, source.homeDir)),
      rule: "home",
      recomputedHash: null,
    };
  }

  return { path: value, rule: "unchanged", recomputedHash: null };
}

/**
 * Rewrite every occurrence of the source's roots inside a blob of text
 * (a transcript, a session record). Order matters: the most specific root has to
 * be replaced first or a shorter prefix eats the longer one.
 *
 * Worktree paths inside transcripts carry hashes we cannot always attribute to a
 * repo, so `worktreeHashMap` supplies the recomputations the caller already
 * resolved from workspace records.
 */
export function rewriteText(
  text: string,
  source: Endpoint,
  target: Endpoint,
  worktreeHashMap: ReadonlyMap<string, string>,
): string {
  let output = text;

  const sourceWorktrees = posixPath.join(source.paseoHome, "worktrees");
  const targetWorktrees = posixPath.join(target.paseoHome, "worktrees");
  for (const [fromHash, toHash] of worktreeHashMap) {
    output = output.split(`${sourceWorktrees}/${fromHash}`).join(`${targetWorktrees}/${toHash}`);
  }

  // Anything under worktrees we could not attribute keeps its hash but still
  // moves to the target's paseo home, which is better than pointing at a
  // directory that does not exist on this machine at all.
  output = output.split(sourceWorktrees).join(targetWorktrees);
  output = output.split(source.projectsRoot).join(target.projectsRoot);
  output = output.split(source.paseoHome).join(target.paseoHome);
  output = output.split(source.homeDir).join(target.homeDir);

  return output;
}

/** Deep path rewrite for a parsed JSON record. */
export function rewriteJson<T>(
  value: T,
  source: Endpoint,
  target: Endpoint,
  worktreeHashMap: ReadonlyMap<string, string>,
): T {
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return rewriteText(node, source, target, worktreeHashMap);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        out[key] = walk(child);
      }
      return out;
    }
    return node;
  };
  return walk(value) as T;
}

/** Repo name for a workspace, from whichever field actually carries it. */
export function repoNameFor(input: {
  mainRepoRoot?: string | null;
  cwd?: string | null;
  projectRootPath?: string | null;
}): string | null {
  const root = input.mainRepoRoot ?? input.projectRootPath ?? null;
  if (root) {
    const base = root.split("/").filter(Boolean).pop();
    if (base) return base;
  }
  return null;
}
