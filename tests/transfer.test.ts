import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  dispatch,
  snapshot,
  receive,
  claudeProjectDir,
} from "../server/worker";
import { invoke, sshArgs, shellQuote } from "../server/transport";
import { sshHosts, tailscaleHosts } from "../server/discovery";
import { sshFixture } from "../scripts/ssh-fixture";
import { preview, start, status } from "../server/handlers";
const exec = promisify(execFile);
let root: string, sourceHome: string, targetHome: string, repo: string;
const daemons: ReturnType<typeof spawn>[] = [];
async function cli(home: string, ...args: string[]) {
  return JSON.parse(
    (
      await exec("paseo", ["--home", home, "--json", ...args], {
        timeout: 120000,
      })
    ).stdout,
  );
}
async function git(cwd: string, ...args: string[]) {
  return (await exec("git", args, { cwd })).stdout;
}
before(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "sync-test-"));
  sourceHome = path.join(root, "source-home");
  targetHome = path.join(root, "target-home");
  repo = path.join(root, "repo");
  for (const home of [sourceHome, targetHome]) {
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.json"),
      JSON.stringify({
        daemon: {
          listen: "127.0.0.1:0",
          relay: { enabled: false },
          mcp: { enabled: false },
          browserTools: { enabled: false },
        },
      }),
    );
    const child = spawn("paseo", ["daemon", "run", "--home", home], {
      env: { ...process.env, PASEO_HOME: home, PASEO_RELAY_ENABLED: "false" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let log = "";
    child.stderr?.on("data", (s) => (log += s));
    daemons.push(child);
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        await cli(home, "workspace", "ls");
        ready = true;
        break;
      } catch {
        if (child.exitCode !== null) throw new Error(log);
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    assert.ok(ready, "test daemon ready");
  }
  await fs.mkdir(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.email", "sync@example.test");
  await git(repo, "config", "user.name", "Sync Test");
  await fs.writeFile(path.join(repo, "tracked.txt"), "original\n");
  await fs.writeFile(path.join(repo, "deleted.txt"), "delete me\n");
  await fs.writeFile(path.join(repo, ".gitignore"), ".env\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "initial");
  await git(repo, "branch", "unpushed");
  await fs.writeFile(path.join(repo, "tracked.txt"), "staged\n");
  await git(repo, "add", "tracked.txt");
  await fs.writeFile(path.join(repo, "tracked.txt"), "unstaged\n");
  await git(repo, "rm", "deleted.txt");
  await fs.writeFile(path.join(repo, "untracked.txt"), "unsaved\n");
  await fs.writeFile(path.join(repo, ".env"), "private\n");
  await fs.writeFile(path.join(repo, "executable"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  await fs.symlink("tracked.txt", path.join(repo, "link"));
});
after(async () => {
  for (const d of daemons) {
    d.kill("SIGTERM");
    await new Promise<void>((r) => {
      if (d.exitCode !== null) r();
      else {
        d.once("exit", () => r());
        setTimeout(() => {
          d.kill("SIGKILL");
          r();
        }, 3000);
      }
    });
  }
  if (root) await fs.rm(root, { recursive: true, force: true });
});

test("discovery respects SSH patterns and online Tailscale peers", () => {
  assert.deepEqual(
    sshHosts(
      "Host laptop work\n Host *.invalid !blocked\nHost final # note",
    ).map((h) => h.target),
    ["laptop", "work", "final"],
  );
  assert.equal(
    tailscaleHosts({
      Peer: {
        a: { DNSName: "laptop.tail.test.", HostName: "Laptop", Online: true },
        b: { DNSName: "offline.test", Online: false },
      },
    })[0].target,
    "laptop.tail.test",
  );
});
test("SSH argv blocks option injection and quotes shell values", () => {
  assert.throws(() => sshArgs({ target: "-oProxyCommand=bad" }));
  assert.throws(() => sshArgs({ target: "host; touch nope" }));
  assert.deepEqual(sshArgs({ target: "work" }).slice(-2), ["--", "work"]);
  assert.ok(shellQuote("a'b").includes("'\\''"));
  assert.ok(
    sshArgs({ target: "work", identityFile: "/tmp/key" }).includes(
      "IdentitiesOnly=yes",
    ),
  );
});
test("copies a repository with all branches, staged and unstaged changes, modes, symlinks and untracked files", async () => {
  const w = await cli(
    sourceHome,
    "workspace",
    "create",
    "--isolation",
    "local",
    "--path",
    repo,
    "--title",
    "Transfer fixture",
  );
  const original = await git(repo, "status", "--porcelain");
  const snap = await snapshot(sourceHome, w.workspaceId);
  assert.equal(snap.sessions.length, 0);
  const target = path.join(root, "copied");
  const result = await receive(targetHome, target, snap);
  assert.equal(result.verified, true);
  assert.equal(result.sourceArchived, false);
  assert.equal(await git(target, "status", "--porcelain"), original);
  assert.equal(
    await git(target, "rev-parse", "unpushed"),
    await git(repo, "rev-parse", "unpushed"),
  );
  assert.equal(
    await fs.readFile(path.join(target, "tracked.txt"), "utf8"),
    "unstaged\n",
  );
  assert.equal(await fs.readlink(path.join(target, "link")), "tracked.txt");
  await assert.rejects(fs.access(path.join(target, ".env")));
  await assert.rejects(fs.access(path.join(target, "deleted.txt")));
  assert.equal(await git(repo, "status", "--porcelain"), original);
  await assert.rejects(receive(targetHome, target, snap), /already exists/);
  assert.equal(
    (await snapshot(sourceHome, w.workspaceId)).fingerprint,
    snap.fingerprint,
  );
});
test("worktree copy becomes an independent checkout without copying the source .git pointer", async () => {
  const worktree = path.join(root, "worktree");
  await git(repo, "worktree", "add", "-b", "feature", worktree, "HEAD");
  await fs.writeFile(path.join(worktree, "local.txt"), "worktree data");
  const w = await cli(
    sourceHome,
    "workspace",
    "create",
    "--isolation",
    "local",
    "--path",
    worktree,
    "--title",
    "Worktree fixture",
  );
  const snap = await snapshot(sourceHome, w.workspaceId);
  const target = path.join(root, "copied-worktree");
  await receive(targetHome, target, snap);
  assert.ok((await fs.stat(path.join(target, ".git"))).isDirectory());
  assert.equal(await git(target, "branch", "--show-current"), "feature\n");
  assert.equal(
    await fs.readFile(path.join(target, "local.txt"), "utf8"),
    "worktree data",
  );
});
test("directory workspace copies plain files and skips dependency directories", async () => {
  const dir = path.join(root, "plain");
  await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });
  await fs.writeFile(path.join(dir, "note"), "hello");
  await fs.writeFile(path.join(dir, "node_modules", "dep"), "skip");
  const w = await cli(
    sourceHome,
    "workspace",
    "create",
    "--isolation",
    "local",
    "--path",
    dir,
  );
  const snap = await snapshot(sourceHome, w.workspaceId);
  assert.equal(snap.bundle, null);
  assert.equal(snap.files.length, 1);
  await receive(targetHome, path.join(root, "plain-copy"), snap);
});
test("source change invalidates a preview and move never archives it", async () => {
  const w = (await cli(sourceHome, "workspace", "ls")).find(
    (w: any) => w.cwd === repo,
  );
  const p = await preview({
    source: { target: "", home: sourceHome },
    target: { target: "", home: targetHome },
    workspaceId: w.workspaceId,
    destination: path.join(root, "stale"),
    mode: "move",
  });
  await fs.writeFile(path.join(repo, "untracked.txt"), "changed after preview");
  const { runId } = start({ planId: p.id });
  while (status({ runId }).state === "running")
    await new Promise((r) => setTimeout(r, 50));
  assert.equal(status({ runId }).state, "failed");
  assert.match(status({ runId }).message, /changed since preview/);
  assert.ok(
    (await cli(sourceHome, "workspace", "ls")).some(
      (x: any) => x.workspaceId === w.workspaceId,
    ),
  );
  await assert.rejects(fs.access(path.join(root, "stale")));
});
test("move verifies target and archives source through Paseo", async () => {
  const w = (await cli(sourceHome, "workspace", "ls")).find(
    (w: any) => w.cwd === repo,
  );
  const p = await preview({
    source: { target: "", home: sourceHome },
    target: { target: "", home: targetHome },
    workspaceId: w.workspaceId,
    destination: path.join(root, "moved"),
    mode: "move",
  });
  const { runId } = start({ planId: p.id });
  while (status({ runId }).state === "running")
    await new Promise((r) => setTimeout(r, 50));
  assert.equal(status({ runId }).state, "done", status({ runId }).message);
  assert.equal(status({ runId }).result?.sourceArchived, true);
  assert.ok(
    !(await cli(sourceHome, "workspace", "ls")).some(
      (x: any) => x.workspaceId === w.workspaceId,
    ),
  );
  assert.ok(await fs.stat(repo));
});
test("path traversal, symlink escape and altered snapshots are refused", async () => {
  const dir = path.join(root, "bad");
  await fs.mkdir(dir);
  await fs.symlink("/etc/passwd", path.join(dir, "escape"));
  const w = await cli(
    sourceHome,
    "workspace",
    "create",
    "--isolation",
    "local",
    "--path",
    dir,
  );
  await assert.rejects(snapshot(sourceHome, w.workspaceId), /Symlink leaves/);
  const plain = (await cli(sourceHome, "workspace", "ls")).find(
    (w: any) => w.cwd === path.join(root, "plain"),
  );
  const snap = await snapshot(sourceHome, plain.workspaceId);
  snap.files[0].path = "../escape";
  await assert.rejects(
    receive(targetHome, path.join(root, "tampered"), snap),
    /checksum/,
  );
  await assert.rejects(
    dispatch({
      action: "check",
      home: targetHome,
      destination: "relative",
      sessions: [],
    }),
    /absolute path/,
  );
});
test("moving a managed worktree with ignored files is refused before copy", async () => {
  const w = await cli(
    sourceHome,
    "workspace",
    "create",
    "--isolation",
    "worktree",
    "--path",
    repo,
    "--new-branch",
    "managed-transfer",
    "--worktree-slug",
    "sync-managed",
  );
  await fs.writeFile(path.join(w.cwd, ".env"), "keep local");
  await assert.rejects(
    preview({
      source: { target: "", home: sourceHome },
      target: { target: "", home: targetHome },
      workspaceId: w.workspaceId,
      destination: path.join(root, "ignored-move"),
      mode: "move",
    }),
    /Git-ignored/,
  );
  assert.equal(
    await fs.readFile(path.join(w.cwd, ".env"), "utf8"),
    "keep local",
  );
});

test("failed pre-registration writes roll back a reserved destination", async () => {
  const plain = (await cli(sourceHome, "workspace", "ls")).find(
    (w: any) => w.cwd === path.join(root, "plain"),
  );
  const snap = await snapshot(sourceHome, plain.workspaceId);
  snap.files[0].path = "../outside";
  const { fingerprint: old, bytes, ...base } = snap;
  snap.fingerprint = createHash("sha256")
    .update(JSON.stringify(base))
    .digest("hex");
  const destination = path.join(root, "rollback");
  await assert.rejects(
    receive(targetHome, destination, snap),
    /Unsafe snapshot path/,
  );
  await assert.rejects(fs.access(destination));
  await assert.rejects(fs.access(path.join(root, "outside")));
});

test("Claude long directory names use the provider encoder", () => {
  assert.equal(claudeProjectDir("/tmp/a.b"), "-tmp-a-b");
  assert.ok(claudeProjectDir("/tmp/" + "long".repeat(100)).length > 200);
});

test("encrypted SSH transports push and pull between separate daemon homes", async () => {
  const fixture = await sshFixture(root, { ...process.env });
  const remote = {
    target: "127.0.0.1",
    port: fixture.port,
    identityFile: fixture.key,
    knownHostsFile: fixture.known,
    home: targetHome,
  };
  try {
    const info = await invoke<{ version: string }>(remote, { action: "info" });
    assert.match(info.version, /^0\.11\./);
    const sshSource = path.join(root, "ssh-source");
    await fs.mkdir(sshSource);
    await fs.writeFile(path.join(sshSource, "note"), "hello");
    const plain = await cli(
      sourceHome,
      "workspace",
      "create",
      "--isolation",
      "local",
      "--path",
      sshSource,
    );
    const snap = await snapshot(sourceHome, plain.workspaceId);
    const target = path.join(root, "ssh-push");
    const pushed = await invoke<{ verified: boolean }>(remote, {
      action: "receive",
      destination: target,
      snapshot: snap,
    });
    assert.equal(pushed.verified, true);
    const remoteWorkspaces = await invoke<{ workspaces: any[] }>(remote, {
      action: "list",
    });
    const row = remoteWorkspaces.workspaces.find((w) => w.cwd === target);
    const pulled = await invoke<any>(remote, {
      action: "snapshot",
      workspaceId: row.workspaceId,
    });
    const result = await receive(
      sourceHome,
      path.join(root, "ssh-pull"),
      pulled,
    );
    assert.equal(result.verified, true);
    assert.equal(
      await fs.readFile(path.join(root, "ssh-pull", "note"), "utf8"),
      "hello",
    );
  } finally {
    await fixture.close();
  }
});
