import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { Peer, PeerHealth, Settings } from "./contracts.shared";
import type { Endpoint } from "./paths.server";

const run = promisify(execFile);

/** Resolve this daemon's own paseo home the way the daemon itself does. */
export function localPaseoHome(): string {
  return process.env.PASEO_HOME ?? join(homedir(), ".paseo");
}

const STATE_DIR = join(localPaseoHome(), "sync");
const PEERS_PATH = join(STATE_DIR, "peers.json");
const SETTINGS_PATH = join(STATE_DIR, "settings.json");
const SECRETS_PATH = join(STATE_DIR, "secrets.json");

export const DEFAULT_SETTINGS: Settings = {
  untrackedAllowlist: [".env", ".env.*", "*.env.local"],
  maxTranscriptMb: 64,
  carryStashes: true,
};

/**
 * Reading config before writing it is where plugins destroy real user data. A
 * MISSING file is fine (create fresh); a file that EXISTS but will not parse is
 * not — that is a transient read of something being rewritten, and treating it
 * as empty would erase it. Throw instead, and write nothing.
 */
function readJsonStrict<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(
      `${path} exists but could not be parsed; refusing to overwrite it. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

/**
 * Peer secrets live in a separate 0600 file, never in peers.json.
 *
 * peers.json is read by every list call and its contents reach the panel; a
 * daemon password in there would be one careless log line from disclosure. The
 * split keeps the value on disk only, readable by this process alone.
 */
type SecretStore = Record<string, { daemonPassword?: string }>;

function readSecrets(): SecretStore {
  return readJsonStrict<SecretStore>(SECRETS_PATH, {});
}

export function daemonPasswordFor(peerId: string): string | null {
  try {
    return readSecrets()[peerId]?.daemonPassword ?? null;
  } catch {
    return null;
  }
}

export function setDaemonPassword(peerId: string, password: string | null): void {
  const secrets = readSecrets();
  if (password) secrets[peerId] = { ...secrets[peerId], daemonPassword: password };
  else delete secrets[peerId];
  mkdirSync(dirname(SECRETS_PATH), { recursive: true });
  const tmp = `${SECRETS_PATH}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(secrets, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, SECRETS_PATH);
}

export function readPeers(): Peer[] {
  const stored = readJsonStrict<Peer[]>(PEERS_PATH, []);
  let secrets: SecretStore = {};
  try {
    secrets = readSecrets();
  } catch {
    // A damaged secret store must not hide the peers themselves.
  }
  return stored.map((peer) => ({
    ...peer,
    hasDaemonPassword: Boolean(secrets[peer.id]?.daemonPassword),
  }));
}

export function writePeers(peers: Peer[]): void {
  // hasDaemonPassword is derived on read; persisting it would let the two files
  // disagree the moment a secret is removed.
  writeJsonAtomic(
    PEERS_PATH,
    peers.map(({ hasDaemonPassword: _derived, ...rest }) => rest),
  );
}

export function readSettings(): Settings {
  const stored = readJsonStrict<Partial<Settings>>(SETTINGS_PATH, {});
  return { ...DEFAULT_SETTINGS, ...stored };
}

export function writeSettings(settings: Settings): void {
  writeJsonAtomic(SETTINGS_PATH, settings);
}

/**
 * SSH arguments shared by every remote call.
 *
 * `IdentitiesOnly=yes` is not optional. Without it ssh offers every key the
 * agent holds; a host with several keys loaded answers "Too many authentication
 * failures", closes the connection, and — where fail2ban is watching — bans the
 * client for the ban window. That is a real failure this plugin has already
 * caused once, so the flag stays even when an identity file is not configured.
 */
export function sshArgs(peer: Pick<Peer, "sshTarget" | "sshPort" | "identityFile">): string[] {
  const args = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "LogLevel=ERROR",
  ];
  if (peer.identityFile) args.push("-i", peer.identityFile);
  if (peer.sshPort) args.push("-p", String(peer.sshPort));
  args.push(peer.sshTarget);
  return args;
}

export type RemoteResult = { ok: true; stdout: string; stderr: string } | { ok: false; error: string };

/**
 * Run a command on the peer. Stdin is closed explicitly: an ssh child that
 * inherits an open stdin will consume its parent's input, which is the classic
 * `while read … ssh …` corruption. Node's default here is safe, but being
 * explicit keeps it that way if the call site ever changes.
 */
export async function remote(
  peer: Pick<Peer, "sshTarget" | "sshPort" | "identityFile">,
  command: string,
  options?: { timeoutMs?: number; maxBufferMb?: number },
): Promise<RemoteResult> {
  try {
    const { stdout, stderr } = await run("ssh", [...sshArgs(peer), command], {
      timeout: options?.timeoutMs ?? 30_000,
      maxBuffer: (options?.maxBufferMb ?? 32) * 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    const detail = (err.stderr ?? err.message ?? String(error)).trim().split("\n")[0] ?? "";
    return { ok: false, error: detail || "ssh failed" };
  }
}

/**
 * Run a command on the peer AS the daemon user.
 *
 * Anything written into the daemon's home by root is left root-owned and the
 * daemon then cannot read it — the migration hit this and needed a repair pass.
 * Writing as the daemon user in the first place removes the failure mode
 * instead of patching it afterwards.
 */
export async function remoteAsDaemon(
  peer: Peer,
  command: string,
  options?: { timeoutMs?: number; maxBufferMb?: number },
): Promise<RemoteResult> {
  const user = peer.daemonUser;
  const loginUser = peer.sshTarget.includes("@") ? peer.sshTarget.split("@")[0] : null;
  if (!user || user === loginUser) return remote(peer, command, options);
  // `sudo -n` so a password prompt fails fast rather than hanging the RPC.
  const quoted = command.replace(/'/g, `'\\''`);
  return remote(peer, `sudo -n -u ${user} bash -lc '${quoted}'`, options);
}

function firstLine(value: string): string {
  return value.trim().split("\n")[0]?.trim() ?? "";
}

/**
 * Ask the peer what it is, rather than being told. Every path rule downstream is
 * derived from these answers, so a peer that cannot describe itself is not
 * usable and says so.
 */
export async function probePeer(
  peer: Peer,
  projectsRootOverride?: string | null,
): Promise<{ peer: Peer; health: PeerHealth }> {
  // Who the daemon actually runs as, which is frequently NOT the login user.
  // Logging in as root and reading $HOME yields /root/.paseo while the daemon
  // lives in /home/<user>/.paseo — every path rule downstream would then derive
  // from the wrong home and quietly target directories the daemon never reads.
  const discovered = await discoverDaemonUser(peer);
  const probeTarget: Peer = { ...peer, daemonUser: discovered ?? peer.daemonUser };

  const script = [
    'echo "HOME=$HOME"',
    'echo "USER=$(id -un)"',
    'echo "PASEO_HOME=${PASEO_HOME:-$HOME/.paseo}"',
    'command -v paseo >/dev/null 2>&1 && echo "PASEO=$(paseo --version 2>/dev/null | head -1)" || echo "PASEO="',
    'command -v claude >/dev/null 2>&1 && echo "CLAUDE=yes" || echo "CLAUDE=no"',
    'command -v codex >/dev/null 2>&1 && echo "CODEX=yes" || echo "CODEX=no"',
    'command -v git >/dev/null 2>&1 && echo "GIT=yes" || echo "GIT=no"',
    'systemctl is-active paseo.service 2>/dev/null | head -1 | sed "s/^/DAEMON=/" || true',
  ].join("; ");

  const result = await remoteAsDaemon(probeTarget, script, { timeoutMs: 20_000 });
  if (!result.ok) {
    return {
      peer: { ...probeTarget, lastProbedAt: new Date().toISOString() },
      health: {
        reachable: false,
        detail: result.error,
        paseoVersion: null,
        daemonActive: null,
        hasClaude: false,
        hasCodex: false,
        hasGit: false,
      },
    };
  }

  const fields = new Map<string, string>();
  for (const line of result.stdout.split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) fields.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }

  const homeDir = fields.get("HOME") ?? null;
  const paseoHome = fields.get("PASEO_HOME") ?? (homeDir ? `${homeDir}/.paseo` : null);
  const daemonUser = fields.get("USER") ?? discovered ?? null;

  // The projects root is a convention rather than something the daemon reports,
  // so it is discovered: whatever directory the peer's own workspaces sit under.
  let projectsRoot = projectsRootOverride ?? peer.projectsRoot ?? null;
  if (!projectsRoot && paseoHome) {
    projectsRoot = await discoverProjectsRoot(
      { ...probeTarget, daemonUser },
      paseoHome,
      homeDir,
    );
  }

  const paseoVersion = fields.get("PASEO") || null;
  const daemonRaw = fields.get("DAEMON");

  const updated: Peer = {
    ...probeTarget,
    homeDir,
    paseoHome,
    projectsRoot,
    daemonUser,
    lastProbedAt: new Date().toISOString(),
  };

  return {
    peer: updated,
    health: {
      reachable: true,
      detail: paseoHome ? `paseo home ${paseoHome}` : "reachable, but no paseo home found",
      paseoVersion: paseoVersion ? firstLine(paseoVersion) : null,
      daemonActive: daemonRaw ? daemonRaw === "active" : null,
      hasClaude: fields.get("CLAUDE") === "yes",
      hasCodex: fields.get("CODEX") === "yes",
      hasGit: fields.get("GIT") === "yes",
    },
  };
}

/**
 * Ask the peer which user its daemon runs as.
 *
 * systemd is authoritative where it manages the daemon; otherwise the owner of
 * the running process answers it. Both are read-only questions, and a peer that
 * answers neither simply keeps whatever the user configured.
 */
async function discoverDaemonUser(peer: Peer): Promise<string | null> {
  const script = [
    'u=$(systemctl show paseo.service -p User --value 2>/dev/null)',
    '[ -z "$u" ] && u=$(ps -o user= -p "$(pgrep -f "[P]aseo Daemon" | head -1)" 2>/dev/null | tr -d " ")',
    'echo "DAEMON_USER=${u}"',
  ].join("; ");
  const result = await remote(peer, script, { timeoutMs: 15_000 });
  if (!result.ok) return null;
  const match = result.stdout.match(/DAEMON_USER=(\S+)/);
  const user = match?.[1]?.trim();
  return user && user !== "root" ? user : null;
}

/**
 * Find where the peer keeps its checkouts by asking its own workspace registry,
 * then falling back to common layouts. Reading the registry means the answer is
 * whatever that daemon actually uses, not a guess about its OS.
 */
async function discoverProjectsRoot(
  peer: Peer,
  paseoHome: string,
  homeDir: string | null,
): Promise<string | null> {
  const script =
    `python3 -c "` +
    `import json,os,collections;` +
    `p=os.path.join('${paseoHome}','projects','projects.json');` +
    `d=json.load(open(p)) if os.path.exists(p) else [];` +
    `c=collections.Counter(os.path.dirname(x.get('rootPath','')) for x in d if x.get('rootPath'));` +
    `print(c.most_common(1)[0][0] if c else '')" 2>/dev/null`;
  const result = await remote(peer, script, { timeoutMs: 15_000 });
  if (result.ok) {
    const found = firstLine(result.stdout);
    if (found.startsWith("/")) return found;
  }
  if (!homeDir) return null;
  for (const candidate of [`${homeDir}/projects`, `${homeDir}/.superset/projects`]) {
    const probe = await remote(peer, `test -d '${candidate}' && echo yes || echo no`, {
      timeoutMs: 10_000,
    });
    if (probe.ok && firstLine(probe.stdout) === "yes") return candidate;
  }
  return null;
}

/** This daemon, described the same way a peer is. */
export function localEndpoint(): Endpoint & { hostname: string } {
  const paseoHome = localPaseoHome();
  const home = homedir();
  let projectsRoot = `${home}/projects`;
  try {
    const projects = readJsonStrict<Array<{ rootPath?: string }>>(
      join(paseoHome, "projects", "projects.json"),
      [],
    );
    const counts = new Map<string, number>();
    for (const project of projects) {
      const root = project.rootPath;
      if (!root) continue;
      const parent = root.slice(0, root.lastIndexOf("/"));
      if (parent) counts.set(parent, (counts.get(parent) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestCount = 0;
    for (const [parent, count] of counts) {
      if (count > bestCount) {
        best = parent;
        bestCount = count;
      }
    }
    if (best) projectsRoot = best;
  } catch {
    // Fall back to the default layout; a bad registry read must not break probing.
  }
  return { paseoHome, projectsRoot, homeDir: home, hostname: hostname() };
}

export function peerEndpoint(peer: Peer): Endpoint | null {
  if (!peer.paseoHome || !peer.projectsRoot || !peer.homeDir) return null;
  return { paseoHome: peer.paseoHome, projectsRoot: peer.projectsRoot, homeDir: peer.homeDir };
}

export function newPeerId(): string {
  return `peer_${randomUUID().slice(0, 8)}`;
}
