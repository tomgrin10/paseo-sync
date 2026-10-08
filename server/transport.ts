import { execFile } from "node:child_process";
import { workerSource } from "../shared/worker-source";
import { dispatch } from "./worker";
import type { Endpoint, WorkerRequest } from "../shared/types";

export function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
export function sshArgs(endpoint: Endpoint) {
  if (
    !/^(?:[a-zA-Z0-9_.-]+@)?[a-zA-Z0-9_.:[\]-]+$/.test(endpoint.target) ||
    endpoint.target.startsWith("-")
  )
    throw new Error("Enter an SSH host or user@host.");
  const args = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
  ];
  // Honor ssh_config and ssh-agent defaults; pin only an explicitly selected key.
  if (endpoint.identityFile)
    args.push("-o", "IdentitiesOnly=yes", "-i", endpoint.identityFile);
  if (endpoint.knownHostsFile)
    args.push("-o", `UserKnownHostsFile=${endpoint.knownHostsFile}`);
  if (endpoint.port) args.push("-p", String(endpoint.port));
  return [...args, "--", endpoint.target];
}
const RUNNER = `let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);process.stdin.on('end',async()=>{try{const p=JSON.parse(s);const m={exports:{}};new Function('require','module','exports',p.source)(require,m,m.exports);const result=await m.exports.dispatch(p.request);process.stdout.write(JSON.stringify({result}));}catch(e){process.stdout.write(JSON.stringify({error:e.message}));process.exitCode=1;}});`;
const active = new Set<ReturnType<typeof execFile>>();
export async function invoke<T>(
  endpoint: Endpoint,
  request: WorkerRequest,
): Promise<T> {
  const payload = { ...request, home: endpoint.home };
  if (!endpoint.target) return (await dispatch(payload)) as T;
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof execFile>;
    child = execFile(
      "ssh",
      [
        ...sshArgs(endpoint),
        `bash -lc ${shellQuote(`node -e ${shellQuote(RUNNER)}`)}`,
      ],
      { timeout: 600_000, maxBuffer: 256 * 1024 * 1024 },
      (error, stdout, stderr) => {
        active.delete(child);
        try {
          const envelope = JSON.parse(String(stdout));
          if (envelope.error) throw new Error(envelope.error);
          if (error) throw new Error(String(stderr).trim() || error.message);
          resolve(envelope.result);
        } catch (e) {
          reject(
            new Error(
              String(stdout).trim()
                ? (e as Error).message
                : String(stderr).trim() ||
                    error?.message ||
                    "Host did not return a transfer response.",
            ),
          );
        }
      },
    );
    active.add(child);
    child.stdin?.on("error", () => {});
    child.stdin?.end(
      JSON.stringify({ source: workerSource, request: payload }),
    );
  });
}
export function disposeTransport() {
  for (const child of active) child.kill("SIGTERM");
  active.clear();
}
