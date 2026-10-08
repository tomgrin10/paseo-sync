import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import path from "node:path";
import type { Host } from "../shared/types";
const exec = promisify(execFile);
export function sshHosts(config: string): Host[] {
  return config.split(/\r?\n/).flatMap((raw) => {
    const line = raw.split("#")[0];
    const match = line.match(/^\s*Host\s+(.+)$/i);
    return match
      ? match[1]
          .split(/\s+/)
          .filter(
            (name) => name && !/[!*?]/.test(name) && !name.startsWith("#"),
          )
          .map((target) => ({ target, label: target, source: "ssh" as const }))
      : [];
  });
}
export function tailscaleHosts(status: {
  Peer?: Record<
    string,
    { DNSName?: string; HostName?: string; Online?: boolean }
  >;
}): Host[] {
  return Object.values(status.Peer ?? {})
    .filter((peer) => peer.Online && peer.DNSName)
    .map((peer) => ({
      target: peer.DNSName!.replace(/\.$/, ""),
      label: peer.HostName ?? peer.DNSName!,
      source: "tailscale",
    }));
}
export async function discover(): Promise<Host[]> {
  const found = await Promise.allSettled([
    fs.readFile(path.join(homedir(), ".ssh", "config"), "utf8").then(sshHosts),
    exec("tailscale", ["status", "--json"], {
      timeout: 5000,
      maxBuffer: 2 * 1024 * 1024,
    }).then((r) => tailscaleHosts(JSON.parse(r.stdout))),
  ]);
  const hosts = new Map<string, Host>();
  for (const result of found)
    if (result.status === "fulfilled")
      for (const host of result.value) hosts.set(host.target, host);
  return [...hosts.values()].sort((a, b) => a.label.localeCompare(b.label));
}
