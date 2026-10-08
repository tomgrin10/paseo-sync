import { promises as fs } from "node:fs";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  DaemonClient,
  type WaitForFinishResult,
} from "@getpaseo/client/internal/daemon-client";
import { sshFixture } from "./ssh-fixture";
import { snapshot } from "../server/worker";
import { invoke } from "../server/transport";
import type { TransferResult } from "../shared/types";
import assert from "node:assert/strict";

const exec = promisify(execFile);
const root = await fs.mkdtemp(path.join(tmpdir(), "sync-live-"));
const repo = path.join(root, "repo"),
  sourceHome = path.join(root, "source"),
  targetHome = path.join(root, "target");
const sourceClaude = path.join(root, "source-claude"),
  targetClaude = path.join(root, "target-claude");
const sourceCodex = path.join(root, "source-codex"),
  targetCodex = path.join(root, "target-codex");
const daemons: ReturnType<typeof spawn>[] = [];
let fixture: Awaited<ReturnType<typeof sshFixture>> | undefined;
let client: DaemonClient | undefined;
let targetClient: DaemonClient | undefined;
async function cli(home: string, ...args: string[]) {
  return JSON.parse(
    (
      await exec("paseo", ["--home", home, "--json", ...args], {
        timeout: 180000,
        maxBuffer: 8 * 1024 * 1024,
      })
    ).stdout,
  );
}
const cleanEnv = { ...process.env };
for (const key of [
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "CODEX_CI",
  "PASEO_AGENT_ID",
  "PASEO_AGENT_CWD",
  "PASEO_PASSWORD",
])
  delete cleanEnv[key];
const sourceEnv = {
  ...cleanEnv,
  CLAUDE_CONFIG_DIR: sourceClaude,
  CODEX_HOME: sourceCodex,
};
const targetEnv = {
  ...cleanEnv,
  CLAUDE_CONFIG_DIR: targetClaude,
  CODEX_HOME: targetCodex,
};
const marker = `SYNC-${randomUUID()}`;
try {
  for (const dir of [
    repo,
    sourceHome,
    targetHome,
    sourceClaude,
    targetClaude,
    sourceCodex,
    targetCodex,
  ])
    await fs.mkdir(dir, { recursive: true });
  for (const dir of [sourceClaude, targetClaude])
    await fs.copyFile(
      path.join(homedir(), ".claude", ".credentials.json"),
      path.join(dir, ".credentials.json"),
    );
  for (const dir of [sourceCodex, targetCodex])
    await fs.copyFile(
      path.join(homedir(), ".codex", "auth.json"),
      path.join(dir, "auth.json"),
    );
  await exec("git", ["init", "-b", "main", repo]);
  await exec("git", ["-C", repo, "config", "user.name", "Sync Live"]);
  await exec("git", ["-C", repo, "config", "user.email", "sync@example.test"]);
  await fs.writeFile(path.join(repo, "test.txt"), "live transfer");
  await exec("git", ["-C", repo, "add", "."]);
  await exec("git", ["-C", repo, "commit", "-m", "live fixture"]);
  for (const [home, env] of [
    [sourceHome, sourceEnv],
    [targetHome, targetEnv],
  ] as const) {
    await fs.writeFile(
      path.join(home, "config.json"),
      JSON.stringify({
        pluginsEnabled: true,
        daemon: {
          listen: "127.0.0.1:0",
          relay: { enabled: false },
          mcp: { enabled: false },
          browserTools: { enabled: false },
        },
      }),
    );
    const log = await fs.open(path.join(home, "launch.log"), "w");
    const child = spawn("paseo", ["daemon", "run", "--home", home], {
      env: { ...env, PASEO_HOME: home, PASEO_RELAY_ENABLED: "false" },
      stdio: ["ignore", log.fd, log.fd],
    });
    daemons.push(child);
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        await cli(home, "workspace", "ls");
        ready = true;
        break;
      } catch {
        if (child.exitCode !== null) throw new Error("Isolated daemon exited");
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    assert.ok(ready);
    await log.close();
  }
  console.log("Two isolated Paseo 0.11 daemons ready.");
  await cli(sourceHome, "plugin", "install", process.cwd());
  const plugins = await cli(sourceHome, "plugin", "ls");
  assert.ok(
    plugins.some((p: any) => p.id === "sync" && p.status === "running"),
    JSON.stringify(plugins),
  );
  const sourceStatus = await cli(sourceHome, "status");
  const cred = (
    await fs.readFile(path.join(sourceHome, "local-credential"), "utf8")
  ).trim();
  client = new DaemonClient({
    url: `ws://${sourceStatus.listen}/ws`,
    localCredential: () => cred,
    clientId: randomUUID(),
    clientType: "cli",
    reconnect: { enabled: false },
    appVersion: "0.11.1",
  });
  await client.connect();
  await client.fetchAgents();
  const catalog = await client.getPluginCatalog();
  assert.ok(catalog.find((p) => p.id === "sync")?.clientBundle);
  const hostResult = await client.invokePluginRpc("sync", "sync.hosts", {});
  assert.ok(hostResult);
  console.log(
    "Plugin server loaded, client bundle compiled, and RPC round-trip passed.",
  );
  const workspace = await cli(
    sourceHome,
    "workspace",
    "create",
    "--isolation",
    "local",
    "--path",
    repo,
    "--title",
    "Sync live conversations",
  );
  console.log("Creating short real Claude and Codex conversations.");
  const claude = await exec(
    "claude",
    [
      "-p",
      `Remember this exact marker for later: ${marker}. Reply only READY. Do not use tools.`,
      "--session-id",
      randomUUID(),
      "--output-format",
      "json",
      "--model",
      "claude-sonnet-5",
      "--settings",
      '{"hooks":{}}',
    ],
    { env: sourceEnv, cwd: repo, timeout: 180000, maxBuffer: 8 * 1024 * 1024 },
  );
  const claudeData = JSON.parse(claude.stdout);
  assert.ok(claudeData.session_id);
  assert.equal(claudeData.is_error, false);
  await cli(
    sourceHome,
    "import",
    claudeData.session_id,
    "--provider",
    "claude",
    "--cwd",
    repo,
    "--label",
    "sync-test=claude",
  );
  console.log("Claude source conversation imported.");
  const codexAgent = await client.createAgent({
    provider: "codex",
    model: "gpt-6.1-sol",
    cwd: repo,
    workspaceId: workspace.workspaceId,
    title: "Sync Codex live test",
    labels: { "sync-test": "codex" },
    initialPrompt: `Remember this exact marker for later: ${marker}. Reply only READY. Do not use tools.`,
  });
  const sourceFinished = await client.waitForFinish(codexAgent.id, 180000);
  assert.equal(
    sourceFinished.status,
    "idle",
    sourceFinished.error ?? "Codex source did not finish",
  );
  assert.ok(
    sourceFinished.lastMessage?.includes("READY"),
    "Codex source replied READY",
  );
  console.log("Codex source conversation saved through Paseo.");
  const previousClaude = process.env.CLAUDE_CONFIG_DIR,
    previousCodex = process.env.CODEX_HOME;
  process.env.CLAUDE_CONFIG_DIR = sourceClaude;
  process.env.CODEX_HOME = sourceCodex;
  let snap;
  try {
    snap = await snapshot(sourceHome, workspace.workspaceId);
  } finally {
    if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaude;
    if (previousCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodex;
  }
  assert.equal(snap.sessions.length, 2);
  fixture = await sshFixture(root, targetEnv);
  const target = path.join(root, "received");
  const endpoint = {
    target: "127.0.0.1",
    port: fixture.port,
    identityFile: fixture.key,
    knownHostsFile: fixture.known,
    home: targetHome,
  };
  const plan = (await client.invokePluginRpc("sync", "sync.preview", {
    source: { target: "", home: sourceHome },
    target: endpoint,
    workspaceId: workspace.workspaceId,
    destination: target,
    mode: "copy",
  })) as { id: string };
  const run = (await client.invokePluginRpc("sync", "sync.run", {
    planId: plan.id,
  })) as { runId: string };
  let progress: {
    state: string;
    message: string;
    result: TransferResult | null;
  };
  do {
    await new Promise((r) => setTimeout(r, 500));
    progress = (await client.invokePluginRpc("sync", "sync.status", {
      runId: run.runId,
    })) as typeof progress;
  } while (progress.state === "running");
  assert.equal(progress.state, "done", progress.message);
  const result = progress.result!;
  assert.equal(result.verified, true);
  assert.equal(result.agents.length, 2);
  console.log("Both conversations imported into target over encrypted SSH.");
  const targetStatus = await cli(targetHome, "status");
  const targetCredential = (
    await fs.readFile(path.join(targetHome, "local-credential"), "utf8")
  ).trim();
  targetClient = new DaemonClient({
    url: `ws://${targetStatus.listen}/ws`,
    clientId: randomUUID(),
    clientType: "cli",
    localCredential: () => targetCredential,
    appVersion: "0.11.1",
    reconnect: { enabled: false },
  });
  await targetClient.connect();
  await targetClient.fetchAgents();
  for (let i = 0; i < result.agents.length; i++) {
    await targetClient.sendMessage(
      result.agents[i],
      "What exact marker did I ask you to remember? Reply only the marker. Do not use tools.",
    );
    const finished: WaitForFinishResult = await targetClient.waitForFinish(
      result.agents[i],
      180000,
    );
    assert.equal(
      finished.status,
      "idle",
      finished.error ?? "Target provider did not finish",
    );
    assert.ok(
      finished.lastMessage?.includes(marker),
      `${snap.sessions[i].provider} recalled the source conversation`,
    );
    console.log(
      `${snap.sessions[i].provider} resumed through target Paseo and recalled the original marker.`,
    );
  }
  console.log(
    "PASS: Claude and Codex resumed on the target and recalled the original marker.",
  );
  console.log(
    JSON.stringify({
      paseo: sourceStatus.daemonVersion,
      plugin: "sync",
      transport: "SSH",
      providers: ["claude", "codex"],
      verified: true,
    }),
  );
} finally {
  await client?.close().catch(() => {});
  await targetClient?.close().catch(() => {});
  await fixture?.close();
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
  await fs.rm(root, { recursive: true, force: true });
}
