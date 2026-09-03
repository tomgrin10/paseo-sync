import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

/**
 * Every RPC lives under `sync.*`. Paseo requires plugin RPC names to be
 * lowercase with dots and hyphens only — a camelCase name fails install with
 * "Invalid plugin RPC method".
 *
 * Nothing machine-specific crosses this boundary. A peer is described by what
 * its own daemon reports about itself, so the same contracts work between any
 * two Paseo daemons.
 */

// ---------------------------------------------------------------- peers

export const PeerSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** ssh target, e.g. "user@host" — the same form `paseo --host ssh://…` takes. */
  sshTarget: z.string(),
  sshPort: z.number().nullable(),
  /** Explicit key path. Strongly recommended: it pins IdentitiesOnly. */
  identityFile: z.string().nullable(),
  /** Read back from the peer itself, never typed by hand. */
  paseoHome: z.string().nullable(),
  projectsRoot: z.string().nullable(),
  homeDir: z.string().nullable(),
  daemonUser: z.string().nullable(),
  lastProbedAt: z.string().nullable(),
  /**
   * Whether a daemon password is stored for this peer. The value itself never
   * crosses this boundary — only whether one exists. Without it, a push can
   * carry history but cannot ask the peer's daemon to create the tab, because
   * its CLI refuses to connect unauthenticated.
   */
  hasDaemonPassword: z.boolean(),
});
export type Peer = z.infer<typeof PeerSchema>;

export const PeerHealthSchema = z.object({
  reachable: z.boolean(),
  detail: z.string(),
  paseoVersion: z.string().nullable(),
  daemonActive: z.boolean().nullable(),
  hasClaude: z.boolean(),
  hasCodex: z.boolean(),
  hasGit: z.boolean(),
  /**
   * False when a paseo/claude/codex state directory is not writable by the
   * daemon user. The daemon writes records atomically (temp file + rename), so
   * a non-writable directory fails every write with EACCES on a .tmp path even
   * though the existing files read fine.
   */
  agentDirsWritable: z.boolean(),
  /**
   * False when this login cannot produce files the peer's daemon will own: it
   * is neither the daemon user, nor root, nor able to use sudo. `sudo` is
   * absent on plenty of minimal hosts, so this is a real configuration rather
   * than an error — but a sync must not write into such a peer.
   */
  canWriteAsDaemon: z.boolean(),
});
export type PeerHealth = z.infer<typeof PeerHealthSchema>;

export const peersList = defineRpc({
  name: "sync.peers-list",
  input: z.object({}),
  output: z.object({
    peers: z.array(PeerSchema),
    local: z.object({
      paseoHome: z.string(),
      projectsRoot: z.string(),
      homeDir: z.string(),
      hostname: z.string(),
    }),
  }),
});

export const peerSave = defineRpc({
  name: "sync.peer-save",
  input: z.object({
    id: z.string().nullable(),
    label: z.string(),
    sshTarget: z.string(),
    sshPort: z.number().nullable(),
    identityFile: z.string().nullable(),
    projectsRoot: z.string().nullable(),
    /** Write-only. Stored beside the peer, never returned by any read. */
    daemonPassword: z.string().nullable(),
  }),
  output: z.object({ peer: PeerSchema, health: PeerHealthSchema }),
});

export const peerRemove = defineRpc({
  name: "sync.peer-remove",
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

export const peerProbe = defineRpc({
  name: "sync.peer-probe",
  input: z.object({ id: z.string() }),
  output: z.object({ peer: PeerSchema, health: PeerHealthSchema }),
});

// ------------------------------------------------------------- projects

export const ProjectRowSchema = z.object({
  projectKey: z.string(),
  displayName: z.string(),
  localRootPath: z.string().nullable(),
  remoteRootPath: z.string().nullable(),
  localOpenTabs: z.number(),
  localTotalTabs: z.number(),
  remoteOpenTabs: z.number(),
  remoteTotalTabs: z.number(),
  selected: z.boolean(),
  lastSyncedAt: z.string().nullable(),
  presentBothSides: z.boolean(),
});
export type ProjectRow = z.infer<typeof ProjectRowSchema>;

export const projectsList = defineRpc({
  name: "sync.projects-list",
  input: z.object({ peerId: z.string() }),
  output: z.object({
    projects: z.array(ProjectRowSchema),
    warning: z.string().nullable(),
  }),
});

export const projectsSelect = defineRpc({
  name: "sync.projects-select",
  input: z.object({
    peerId: z.string(),
    projectKey: z.string(),
    selected: z.boolean(),
  }),
  output: z.object({ ok: z.boolean() }),
});

// ----------------------------------------------------------------- plan

export const DirectionSchema = z.enum(["push", "pull"]);
export type Direction = z.infer<typeof DirectionSchema>;

export const StepSchema = z.object({
  id: z.string(),
  projectKey: z.string(),
  kind: z.enum([
    "git-fetch",
    "git-branch",
    "worktree-register",
    "carry-stash",
    "file-copy",
    "transcript",
    "session-record",
    "create-workspace",
    "update-workspace-title",
  ]),
  label: z.string(),
  detail: z.string(),
  bytes: z.number().nullable(),
});
export type Step = z.infer<typeof StepSchema>;

export const SkippedSchema = z.object({
  projectKey: z.string(),
  label: z.string(),
  reason: z.string(),
});

export const ConflictSchema = z.object({
  id: z.string(),
  projectKey: z.string(),
  label: z.string(),
  detail: z.string(),
  /** ISO timestamps so the panel can say which side is newer, in words. */
  sourceUpdatedAt: z.string().nullable(),
  targetUpdatedAt: z.string().nullable(),
});
export type Conflict = z.infer<typeof ConflictSchema>;

export const SyncPlanSchema = z.object({
  planId: z.string(),
  peerId: z.string(),
  direction: DirectionSchema,
  createdAt: z.string(),
  steps: z.array(StepSchema),
  skipped: z.array(SkippedSchema),
  conflicts: z.array(ConflictSchema),
  totalBytes: z.number(),
  /** Projects the plan covers — never anything the user did not select. */
  projectKeys: z.array(z.string()),
  notes: z.array(z.string()),
});
export type SyncPlan = z.infer<typeof SyncPlanSchema>;

export const planBuild = defineRpc({
  name: "sync.plan-build",
  input: z.object({
    peerId: z.string(),
    direction: DirectionSchema,
    includeArchived: z.boolean(),
  }),
  output: z.object({ plan: SyncPlanSchema }),
});

// ------------------------------------------------------------------ run

export const RunStepStateSchema = z.object({
  id: z.string(),
  label: z.string(),
  state: z.enum(["pending", "running", "done", "failed", "skipped"]),
  detail: z.string(),
});

export const RunStateSchema = z.object({
  runId: z.string(),
  planId: z.string(),
  peerId: z.string(),
  direction: DirectionSchema,
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  state: z.enum(["running", "done", "failed", "cancelled"]),
  message: z.string(),
  bytesMoved: z.number(),
  totalBytes: z.number(),
  steps: z.array(RunStepStateSchema),
  error: z.string().nullable(),
});
export type RunState = z.infer<typeof RunStateSchema>;

export const runStart = defineRpc({
  name: "sync.run-start",
  input: z.object({
    peerId: z.string(),
    direction: DirectionSchema,
    includeArchived: z.boolean(),
    /** Steps the user deselected in the preview. */
    skipStepIds: z.array(z.string()),
    /** Every conflict must be resolved or the run refuses to start. */
    conflictResolutions: z.array(
      z.object({ id: z.string(), choice: z.enum(["source", "target", "skip"]) }),
    ),
  }),
  output: z.object({ runId: z.string(), accepted: z.boolean(), error: z.string().nullable() }),
});

export const runStatus = defineRpc({
  name: "sync.run-status",
  input: z.object({ runId: z.string().nullable() }),
  output: z.object({
    run: RunStateSchema.nullable(),
    journal: z.array(
      z.object({
        runId: z.string(),
        peerId: z.string(),
        direction: DirectionSchema,
        finishedAt: z.string(),
        state: z.string(),
        summary: z.string(),
        bytesMoved: z.number(),
      }),
    ),
  }),
});

export const runCancel = defineRpc({
  name: "sync.run-cancel",
  input: z.object({ runId: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

// -------------------------------------------------------------- settings

export const SettingsSchema = z.object({
  /** Ignored files carried alongside git. Explicit so this never drags node_modules. */
  untrackedAllowlist: z.array(z.string()),
  /** Rollouts larger than this are listed as skipped rather than moved. */
  maxTranscriptMb: z.number(),
  carryStashes: z.boolean(),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const settingsGet = defineRpc({
  name: "sync.settings-get",
  input: z.object({}),
  output: z.object({ settings: SettingsSchema }),
});

export const settingsSave = defineRpc({
  name: "sync.settings-save",
  input: SettingsSchema,
  output: z.object({ settings: SettingsSchema }),
});
