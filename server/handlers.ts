import { randomUUID } from "node:crypto";
import type { RpcInput } from "@getpaseo/plugin";
import { listRpc, previewRpc, runRpc, statusRpc } from "../shared/rpc";
import type {
  Plan,
  Snapshot,
  TransferResult,
  WorkerRequest,
} from "../shared/types";
import { discover } from "./discovery";
import { invoke, disposeTransport } from "./transport";

export const hosts = async () => ({ hosts: await discover() });
export const list = async (input: RpcInput<typeof listRpc>) =>
  invoke<{ workspaces: Plan["workspace"][] }>(input.endpoint, {
    action: "list",
  });
type Cached = {
  plan: Plan;
  input: RpcInput<typeof previewRpc>;
  fingerprint: string;
  expires: number;
};
const plans = new Map<string, Cached>();
const runs = new Map<
  string,
  {
    state: "running" | "done" | "failed";
    message: string;
    result: TransferResult | null;
  }
>();
let disposed = false;
let busy = false;
export async function preview(input: RpcInput<typeof previewRpc>) {
  if (
    input.source.target === input.target.target &&
    input.source.home === input.target.home
  )
    throw new Error("Choose different source and target hosts.");
  const snap = await invoke<Snapshot>(input.source, {
    action: "snapshot",
    workspaceId: input.workspaceId,
  });
  if (
    input.mode === "move" &&
    snap.workspace.isolation === "worktree" &&
    snap.hasIgnored
  )
    throw new Error(
      "This worktree contains Git-ignored files that will not be copied. Choose Copy to keep those files on the source.",
    );
  if (snap.skipped.length)
    throw new Error(
      `Transfer cannot include every conversation: ${snap.skipped.join("; ")}`,
    );
  const checked = await invoke<{ destination: string }>(input.target, {
    action: "check",
    destination: input.destination,
    sessions: snap.sessions,
  });
  for (const [id, p] of plans) if (p.expires < Date.now()) plans.delete(id);
  if (plans.size >= 4) plans.delete(plans.keys().next().value!);
  const plan: Plan = {
    id: randomUUID(),
    workspace: snap.workspace,
    destination: checked.destination,
    files: snap.files.length,
    sessions: snap.sessions.length,
    bytes: snap.bytes,
    branch: snap.branch,
    skipped: snap.skipped,
    mode: input.mode,
  };
  plans.set(plan.id, {
    plan,
    input,
    fingerprint: snap.fingerprint,
    expires: Date.now() + 10 * 60_000,
  });
  return plan;
}
export function start({ planId }: RpcInput<typeof runRpc>) {
  if (disposed) throw new Error("Sync is shutting down.");
  if (busy)
    throw new Error("A transfer is already running. Wait for it to finish.");
  const cached = plans.get(planId);
  if (!cached || cached.expires < Date.now())
    throw new Error("Preview expired. Preview this transfer again.");
  plans.delete(planId);
  busy = true;
  const runId = randomUUID();
  const run: {
    state: "running" | "done" | "failed";
    message: string;
    result: TransferResult | null;
  } = { state: "running", message: "Checking source…", result: null };
  runs.set(runId, run);
  for (const [id, old] of runs)
    if (runs.size > 8 && old.state !== "running") runs.delete(id);
  void (async () => {
    try {
      const fresh = await invoke<Snapshot>(cached.input.source, {
        action: "snapshot",
        workspaceId: cached.input.workspaceId,
      });
      if (fresh.fingerprint !== cached.fingerprint)
        throw new Error(
          "Source changed since preview. Preview it again before transferring.",
        );
      if (disposed) throw new Error("Sync is shutting down.");
      run.message = "Copying and verifying workspace…";
      const result = await invoke<TransferResult>(cached.input.target, {
        action: "receive",
        destination: cached.plan.destination,
        snapshot: fresh,
      });
      if (!result.verified)
        throw new Error(
          "Target did not verify the transfer; source has been kept open.",
        );
      run.result = result;
      if (cached.plan.mode === "move") {
        if (disposed)
          throw new Error(
            "Sync was reloaded; target is copied but source was kept open.",
          );
        run.message = "Destination verified. Archiving source…";
        await invoke(cached.input.source, {
          action: "archive",
          workspaceId: cached.input.workspaceId,
          fingerprint: fresh.fingerprint,
        } satisfies WorkerRequest);
        result.sourceArchived = true;
      }
      run.state = "done";
      run.message =
        cached.plan.mode === "move"
          ? "Workspace moved and verified."
          : "Workspace copied and verified.";
    } catch (error) {
      run.state = "failed";
      run.message = (error as Error).message;
    } finally {
      busy = false;
    }
  })();
  return { runId };
}
export function status({ runId }: RpcInput<typeof statusRpc>) {
  const run = runs.get(runId);
  if (!run)
    throw new Error(
      "Transfer status is unavailable after a plugin reload. Check the target workspace.",
    );
  return run;
}
export function dispose() {
  disposed = true;
  plans.clear();
  disposeTransport();
}
