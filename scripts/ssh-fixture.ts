import ssh2 from "ssh2";
const { Server } = ssh2;
import { promises as fs } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
const exec = promisify(execFile);
/** A real encrypted SSH transport to a process with the target daemon's environment. */
export async function sshFixture(root: string, env: NodeJS.ProcessEnv) {
  const key = path.join(root, "ssh-key");
  await exec("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", key]);
  const hostKey = path.join(root, "host-key");
  await exec("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", hostKey]);
  const publicKey = (await fs.readFile(`${key}.pub`, "utf8")).split(" ")[1];
  const server = new Server(
    { hostKeys: [await fs.readFile(hostKey)] },
    (client) => {
      client
        .on("authentication", (ctx) => {
          if (
            ctx.method === "publickey" &&
            ctx.key.data.toString("base64") === publicKey
          )
            ctx.accept();
          else ctx.reject();
        })
        .on("ready", () =>
          client.on("session", (accept) => {
            const session = accept();
            session.on("exec", (accept, _reject, info) => {
              const stream = accept();
              const child = spawn("bash", ["-c", info.command], { env });
              stream.pipe(child.stdin);
              child.stdout.pipe(stream, { end: false });
              child.stderr.pipe(stream.stderr, { end: false });
              stream.on("error", () => child.kill());
              child.once("close", (code) => {
                stream.exit(code ?? 1);
                stream.end();
              });
            });
          }),
        )
        .on("error", () => {});
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  // Pin the temporary server key rather than weakening host-key checks.
  const pub = (await fs.readFile(`${hostKey}.pub`, "utf8"))
    .split(" ")
    .slice(0, 2)
    .join(" ");
  const known = path.join(root, "known-hosts");
  await fs.writeFile(known, `[127.0.0.1]:${address.port} ${pub}\n`);
  return {
    server,
    key,
    port: address.port,
    known,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
