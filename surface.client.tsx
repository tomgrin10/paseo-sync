import type { PluginSurfaceProps } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import type { Direction, Peer } from "./contracts.shared";
import {
  peerProbe,
  peerRemove,
  peerSave,
  peersList,
  planBuild,
  projectsList,
  projectsSelect,
  runCancel,
  runStart,
  runStatus,
  settingsGet,
  settingsSave,
} from "./contracts.shared";
import {
  Button,
  Card,
  Checkbox,
  Chip,
  EmptyState,
  Field,
  Note,
  ProgressBar,
  Row,
  SectionTitle,
  Segmented,
  Tabs,
  formatBytes,
  formatWhen,
  type Theme,
} from "./ui.client";

type TabId = "peers" | "projects" | "preview" | "run" | "settings";

const TABS = [
  { id: "peers" as const, label: "Peers" },
  { id: "projects" as const, label: "Projects" },
  { id: "preview" as const, label: "Preview" },
  { id: "run" as const, label: "Run" },
  { id: "settings" as const, label: "Settings" },
];

export function SyncSurface({ theme, layout }: PluginSurfaceProps) {
  const [tab, setTab] = useState<TabId>("peers");
  const [peerId, setPeerId] = useState<string | null>(null);
  const [direction, setDirection] = useState<Direction>("push");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, "source" | "target" | "skip">>({});

  const client = useQueryClient();
  const callPeers = useRpc(peersList);

  const peers = useQuery({
    queryKey: ["sync", "peers"],
    queryFn: () => callPeers({}),
    refetchInterval: 30_000,
  });

  const activePeerId = peerId ?? peers.data?.peers[0]?.id ?? null;
  const activePeer = peers.data?.peers.find((peer) => peer.id === activePeerId) ?? null;

  const padding = layout.compact ? 14 : 20;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding }}>
      <View style={{ gap: 4, marginBottom: 14 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: layout.compact ? 20 : 24, fontWeight: "700" }}>
          Sync
        </Text>
        <Note theme={theme}>
          Move selected projects between two Paseo daemons — workspaces, git history and chat history together, so a
          tab can be picked up on either side.
        </Note>
      </View>

      <Tabs theme={theme} tabs={TABS} active={tab} onSelect={setTab} />

      {tab === "peers" ? (
        <PeersTab
          theme={theme}
          peers={peers.data?.peers ?? []}
          local={peers.data?.local ?? null}
          activePeerId={activePeerId}
          onSelectPeer={setPeerId}
          onChanged={() => client.invalidateQueries({ queryKey: ["sync"] })}
          loading={peers.isLoading}
        />
      ) : null}

      {tab === "projects" ? (
        <ProjectsTab theme={theme} peer={activePeer} onChanged={() => client.invalidateQueries({ queryKey: ["sync"] })} />
      ) : null}

      {tab === "preview" ? (
        <PreviewTab
          theme={theme}
          peer={activePeer}
          direction={direction}
          setDirection={setDirection}
          includeArchived={includeArchived}
          setIncludeArchived={setIncludeArchived}
          resolutions={resolutions}
          setResolutions={setResolutions}
          onStarted={(id) => {
            setRunId(id);
            setTab("run");
          }}
        />
      ) : null}

      {tab === "run" ? <RunTab theme={theme} runId={runId} /> : null}

      {tab === "settings" ? <SettingsTab theme={theme} /> : null}
    </ScrollView>
  );
}

// ------------------------------------------------------------------ peers

function PeersTab({
  theme,
  peers,
  local,
  activePeerId,
  onSelectPeer,
  onChanged,
  loading,
}: {
  theme: Theme;
  peers: Peer[];
  local: { paseoHome: string; projectsRoot: string; homeDir: string; hostname: string } | null;
  activePeerId: string | null;
  onSelectPeer: (id: string) => void;
  onChanged: () => void;
  loading: boolean;
}) {
  const [label, setLabel] = useState("");
  const [target, setTarget] = useState("");
  const [identity, setIdentity] = useState("");
  const [port, setPort] = useState("");
  const [projectsRoot, setProjectsRoot] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const callSave = useRpc(peerSave);
  const callRemove = useRpc(peerRemove);
  const callProbe = useRpc(peerProbe);

  const save = useMutation({
    mutationFn: () =>
      callSave({
        id: null,
        label,
        sshTarget: target,
        sshPort: port.trim() ? Number(port.trim()) : null,
        identityFile: identity.trim() || null,
        projectsRoot: projectsRoot.trim() || null,
        daemonPassword: password.trim() || null,
      }),
    onSuccess: (result) => {
      setMessage(
        result.health.reachable
          ? `Connected. ${result.health.detail}`
          : `Could not reach it: ${result.health.detail}`,
      );
      if (result.health.reachable) {
        setLabel("");
        setTarget("");
        setIdentity("");
        setPort("");
        setProjectsRoot("");
        setPassword("");
      }
      onChanged();
    },
    onError: (error) => setMessage(error instanceof Error ? error.message : String(error)),
  });

  const probe = useMutation({
    mutationFn: (id: string) => callProbe({ id }),
    onSuccess: (result) =>
      setMessage(result.health.reachable ? `Reachable. ${result.health.detail}` : result.health.detail),
    onError: (error) => setMessage(error instanceof Error ? error.message : String(error)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => callRemove({ id }),
    onSuccess: onChanged,
  });

  return (
    <View>
      {local ? (
        <Card theme={theme}>
          <SectionTitle theme={theme} title={`This daemon · ${local.hostname}`} />
          <Row theme={theme} label="paseo home" value={local.paseoHome} />
          <Row theme={theme} label="projects root" value={local.projectsRoot} />
          <Note theme={theme}>
            Every path Sync translates is derived from these two roots and the peer's own, so nothing is hardcoded to a
            particular machine.
          </Note>
        </Card>
      ) : null}

      {loading ? <Note theme={theme}>Loading peers…</Note> : null}

      {peers.map((peer) => (
        <Card key={peer.id} theme={theme}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600", flex: 1 }}>
              {peer.label}
            </Text>
            {peer.id === activePeerId ? <Chip theme={theme} label="active" tone="success" /> : null}
          </View>
          <Row theme={theme} label="ssh" value={peer.sshTarget + (peer.sshPort ? `:${peer.sshPort}` : "")} />
          <Row theme={theme} label="paseo home" value={peer.paseoHome ?? "not probed"} />
          <Row theme={theme} label="projects root" value={peer.projectsRoot ?? "not probed"} />
          <Row theme={theme} label="daemon user" value={peer.daemonUser ?? "unknown"} />
          <Row
            theme={theme}
            label="daemon password"
            value={peer.hasDaemonPassword ? "stored" : "not set — tabs cannot be created there"}
            tone={peer.hasDaemonPassword ? "success" : "warning"}
          />
          <Row theme={theme} label="last probed" value={formatWhen(peer.lastProbedAt)} />
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            {peer.id === activePeerId ? null : (
              <Button theme={theme} label="Use this peer" onPress={() => onSelectPeer(peer.id)} />
            )}
            <Button
              theme={theme}
              label="Probe"
              busy={probe.isPending}
              onPress={() => probe.mutate(peer.id)}
            />
            <Button theme={theme} label="Remove" tone="danger" onPress={() => remove.mutate(peer.id)} />
          </View>
        </Card>
      ))}

      <Card theme={theme}>
        <SectionTitle
          theme={theme}
          title="Add a peer"
          hint="Any machine running a Paseo daemon that this one can reach over SSH."
        />
        <Field theme={theme} value={label} onChangeText={setLabel} placeholder="Name (e.g. workstation)" />
        <Field theme={theme} value={target} onChangeText={setTarget} placeholder="user@host" />
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          <Field theme={theme} value={port} onChangeText={setPort} placeholder="SSH port (optional)" keyboardNumeric />
          <Field theme={theme} value={identity} onChangeText={setIdentity} placeholder="Key path (recommended)" />
        </View>
        <Field
          theme={theme}
          value={projectsRoot}
          onChangeText={setProjectsRoot}
          placeholder="Projects root (leave blank to discover)"
        />
        <Field
          theme={theme}
          value={password}
          onChangeText={setPassword}
          placeholder="Peer's daemon password (needed to create tabs there)"
          secure
        />
        <Note theme={theme}>
          Naming a key is strongly recommended. Without one, SSH offers every key it holds and a host that refuses too
          many will lock this machine out for its ban window.
        </Note>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Button
            theme={theme}
            label="Add and probe"
            tone="primary"
            busy={save.isPending}
            disabled={!target.trim()}
            onPress={() => save.mutate()}
          />
        </View>
        {message ? <Note theme={theme}>{message}</Note> : null}
      </Card>
    </View>
  );
}

// --------------------------------------------------------------- projects

function ProjectsTab({ theme, peer, onChanged }: { theme: Theme; peer: Peer | null; onChanged: () => void }) {
  const callProjects = useRpc(projectsList);
  const callSelect = useRpc(projectsSelect);
  const client = useQueryClient();

  const projects = useQuery({
    queryKey: ["sync", "projects", peer?.id],
    queryFn: () => callProjects({ peerId: peer?.id ?? "" }),
    enabled: Boolean(peer),
  });

  const select = useMutation({
    mutationFn: (input: { projectKey: string; selected: boolean }) =>
      callSelect({ peerId: peer?.id ?? "", ...input }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["sync", "projects"] });
      onChanged();
    },
  });

  if (!peer) {
    return <EmptyState theme={theme} title="No peer selected" hint="Add a peer on the Peers tab first." />;
  }

  if (projects.data?.warning) {
    return (
      <Card theme={theme}>
        <SectionTitle theme={theme} title="Could not read the peer" />
        <Note theme={theme} tone="warning">
          {projects.data.warning}
        </Note>
      </Card>
    );
  }

  const rows = projects.data?.projects ?? [];

  return (
    <View>
      <Card theme={theme}>
        <SectionTitle
          theme={theme}
          title="Choose what Sync may touch"
          hint="Only selected projects are ever read, compared or moved. Everything else is left alone entirely."
        />
      </Card>

      {projects.isLoading ? <Note theme={theme}>Reading both daemons…</Note> : null}

      {rows.length === 0 && !projects.isLoading ? (
        <EmptyState
          theme={theme}
          title="No projects in common"
          hint="Sync moves history between existing checkouts. Clone the repository on both machines first."
        />
      ) : null}

      {rows.map((project) => (
        <Card key={project.projectKey} theme={theme} compact>
          <Checkbox
            theme={theme}
            checked={project.selected}
            disabled={!project.presentBothSides || select.isPending}
            label={project.displayName}
            hint={
              project.presentBothSides
                ? `here ${project.localOpenTabs}/${project.localTotalTabs} open · there ${project.remoteOpenTabs}/${project.remoteTotalTabs} open · last synced ${formatWhen(project.lastSyncedAt)}`
                : project.localRootPath
                  ? "Not checked out on the peer — clone it there to enable syncing."
                  : "Not checked out here — clone it locally to enable syncing."
            }
            onToggle={() => select.mutate({ projectKey: project.projectKey, selected: !project.selected })}
          />
        </Card>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------- preview

function PreviewTab({
  theme,
  peer,
  direction,
  setDirection,
  includeArchived,
  setIncludeArchived,
  resolutions,
  setResolutions,
  onStarted,
}: {
  theme: Theme;
  peer: Peer | null;
  direction: Direction;
  setDirection: (next: Direction) => void;
  includeArchived: boolean;
  setIncludeArchived: (next: boolean) => void;
  resolutions: Record<string, "source" | "target" | "skip">;
  setResolutions: (next: Record<string, "source" | "target" | "skip">) => void;
  onStarted: (runId: string) => void;
}) {
  const callPlan = useRpc(planBuild);
  const callRun = useRpc(runStart);
  const [error, setError] = useState<string | null>(null);

  const plan = useQuery({
    queryKey: ["sync", "plan", peer?.id, direction, includeArchived],
    queryFn: () => callPlan({ peerId: peer?.id ?? "", direction, includeArchived }),
    enabled: Boolean(peer),
    retry: false,
  });

  const start = useMutation({
    mutationFn: () =>
      callRun({
        peerId: peer?.id ?? "",
        direction,
        includeArchived,
        skipStepIds: [],
        conflictResolutions: Object.entries(resolutions).map(([id, choice]) => ({ id, choice })),
      }),
    onSuccess: (result) => {
      if (!result.accepted) {
        setError(result.error ?? "Could not start.");
        return;
      }
      setError(null);
      onStarted(result.runId);
    },
    onError: (mutationError) =>
      setError(mutationError instanceof Error ? mutationError.message : String(mutationError)),
  });

  const data = plan.data?.plan;

  // Every hook runs before the early return below: React identifies hooks by
  // call order, so a `return` above a `useMemo` changes that order between
  // renders and throws.
  const grouped = useMemo(() => {
    const map = new Map<string, NonNullable<typeof data>["steps"]>();
    for (const step of data?.steps ?? []) {
      const list = map.get(step.projectKey) ?? [];
      list.push(step);
      map.set(step.projectKey, list);
    }
    return map;
  }, [data]);

  if (!peer) {
    return <EmptyState theme={theme} title="No peer selected" hint="Add a peer on the Peers tab first." />;
  }

  const unresolved = (data?.conflicts ?? []).filter((conflict) => !resolutions[conflict.id]);

  return (
    <View>
      <Card theme={theme}>
        <SectionTitle theme={theme} title="Direction" />
        <Segmented
          theme={theme}
          value={direction}
          onChange={setDirection}
          options={[
            { id: "push" as const, label: `Push → ${peer.label}` },
            { id: "pull" as const, label: `Pull ← ${peer.label}` },
          ]}
        />
        <Checkbox
          theme={theme}
          checked={includeArchived}
          label="Include closed tabs"
          hint="Closed tabs carry their full history and can be reopened on the other side."
          onToggle={() => setIncludeArchived(!includeArchived)}
        />
      </Card>

      {plan.isLoading ? <Note theme={theme}>Comparing both daemons…</Note> : null}
      {plan.error ? (
        <Card theme={theme}>
          <Note theme={theme} tone="danger">
            {plan.error instanceof Error ? plan.error.message : String(plan.error)}
          </Note>
        </Card>
      ) : null}

      {data?.notes.map((note, index) => (
        <Card key={`note-${index}`} theme={theme} compact>
          <Note theme={theme} tone="warning">
            {note}
          </Note>
        </Card>
      ))}

      {data && data.conflicts.length > 0 ? (
        <Card theme={theme}>
          <SectionTitle
            theme={theme}
            title={`${data.conflicts.length} conflict${data.conflicts.length === 1 ? "" : "s"}`}
            hint="Both sides changed these. Sync will not choose for you."
          />
          {data.conflicts.map((conflict) => (
            <View key={conflict.id} style={{ gap: 6, marginTop: 8 }}>
              <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
                {conflict.label}
              </Text>
              <Note theme={theme}>
                {conflict.detail} Sending side {formatWhen(conflict.sourceUpdatedAt)}, receiving side{" "}
                {formatWhen(conflict.targetUpdatedAt)}.
              </Note>
              <Segmented
                theme={theme}
                value={resolutions[conflict.id] ?? "skip"}
                onChange={(choice) => setResolutions({ ...resolutions, [conflict.id]: choice })}
                options={[
                  { id: "skip" as const, label: "Leave both" },
                  { id: "source" as const, label: "Send anyway" },
                  { id: "target" as const, label: "Keep theirs" },
                ]}
              />
            </View>
          ))}
        </Card>
      ) : null}

      {data ? (
        <Card theme={theme}>
          <SectionTitle theme={theme} title="What would move" />
          {data.steps.length === 0 ? (
            <Note theme={theme}>Nothing — both sides already match for the projects you selected.</Note>
          ) : (
            <>
              <Row theme={theme} label="items" value={String(data.steps.length)} />
              <Row theme={theme} label="bytes" value={formatBytes(data.totalBytes)} />
              {Array.from(grouped.entries()).map(([projectKey, steps]) => (
                <View key={projectKey} style={{ gap: 4, marginTop: 8 }}>
                  <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
                    {projectKey}
                  </Text>
                  {steps.map((step) => (
                    <Row
                      key={step.id}
                      theme={theme}
                      label={`${step.kind} · ${step.label}`}
                      value={step.bytes ? formatBytes(step.bytes) : step.detail}
                    />
                  ))}
                </View>
              ))}
            </>
          )}
        </Card>
      ) : null}

      {data && data.skipped.length > 0 ? (
        <Card theme={theme}>
          <SectionTitle theme={theme} title={`Skipped (${data.skipped.length})`} hint="Nothing here is moved silently." />
          {data.skipped.map((item, index) => (
            <Row key={`${item.label}-${index}`} theme={theme} label={item.label} value={item.reason} />
          ))}
        </Card>
      ) : null}

      {data ? (
        <Card theme={theme}>
          {error ? <Note theme={theme} tone="danger">{error}</Note> : null}
          {unresolved.length > 0 ? (
            <Note theme={theme} tone="warning">
              Resolve {unresolved.length} conflict{unresolved.length === 1 ? "" : "s"} before running.
            </Note>
          ) : null}
          <Button
            theme={theme}
            label={direction === "push" ? `Push to ${peer.label}` : `Pull from ${peer.label}`}
            tone="primary"
            busy={start.isPending}
            disabled={data.steps.length === 0 || unresolved.length > 0}
            onPress={() => start.mutate()}
          />
        </Card>
      ) : null}
    </View>
  );
}

// -------------------------------------------------------------------- run

function RunTab({ theme, runId }: { theme: Theme; runId: string | null }) {
  const callStatus = useRpc(runStatus);
  const callCancel = useRpc(runCancel);

  const status = useQuery({
    queryKey: ["sync", "run", runId],
    queryFn: () => callStatus({ runId }),
    refetchInterval: (query) => (query.state.data?.run?.state === "running" ? 700 : 5_000),
  });

  const cancel = useMutation({ mutationFn: (id: string) => callCancel({ runId: id }) });

  const run = status.data?.run ?? null;
  const journal = status.data?.journal ?? [];

  return (
    <View>
      {run ? (
        <Card theme={theme}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600", flex: 1 }}>
              {run.direction === "push" ? "Pushing" : "Pulling"}
            </Text>
            <Chip
              theme={theme}
              label={run.state}
              tone={
                run.state === "done"
                  ? "success"
                  : run.state === "failed"
                    ? "danger"
                    : run.state === "cancelled"
                      ? "warning"
                      : "neutral"
              }
            />
          </View>
          <Note theme={theme}>{run.message}</Note>
          {run.totalBytes > 0 ? (
            <>
              <ProgressBar theme={theme} fraction={run.bytesMoved / run.totalBytes} />
              <Row
                theme={theme}
                label="moved"
                value={`${formatBytes(run.bytesMoved)} of ${formatBytes(run.totalBytes)}`}
              />
            </>
          ) : null}
          {run.error ? <Note theme={theme} tone="danger">{run.error}</Note> : null}
          {run.state === "running" ? (
            <Button theme={theme} label="Stop" tone="danger" onPress={() => cancel.mutate(run.runId)} />
          ) : null}
        </Card>
      ) : (
        <EmptyState theme={theme} title="No run yet" hint="Build a preview, then start a push or pull." />
      )}

      {run ? (
        <Card theme={theme}>
          <SectionTitle theme={theme} title="Steps" />
          {run.steps.map((step) => (
            <Row
              key={step.id}
              theme={theme}
              label={step.label}
              value={step.state === "done" ? step.detail : step.state}
              tone={
                step.state === "done"
                  ? "success"
                  : step.state === "failed"
                    ? "danger"
                    : step.state === "skipped"
                      ? "warning"
                      : "neutral"
              }
            />
          ))}
        </Card>
      ) : null}

      {journal.length > 0 ? (
        <Card theme={theme}>
          <SectionTitle theme={theme} title="Recent runs" />
          {journal.map((entry) => (
            <Row
              key={entry.runId}
              theme={theme}
              label={`${entry.direction} · ${formatWhen(entry.finishedAt)}`}
              value={`${entry.summary} (${formatBytes(entry.bytesMoved)})`}
              tone={entry.state === "done" ? "success" : entry.state === "failed" ? "danger" : "warning"}
            />
          ))}
        </Card>
      ) : null}
    </View>
  );
}

// --------------------------------------------------------------- settings

function SettingsTab({ theme }: { theme: Theme }) {
  const callGet = useRpc(settingsGet);
  const callSave = useRpc(settingsSave);
  const client = useQueryClient();

  const settings = useQuery({ queryKey: ["sync", "settings"], queryFn: () => callGet({}) });
  const [allowlist, setAllowlist] = useState<string | null>(null);
  const [maxMb, setMaxMb] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      callSave({
        untrackedAllowlist: (allowlist ?? settings.data?.settings.untrackedAllowlist.join(", ") ?? "")
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
        maxTranscriptMb: Number(maxMb ?? settings.data?.settings.maxTranscriptMb ?? 64),
        carryStashes: settings.data?.settings.carryStashes ?? true,
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["sync", "settings"] }),
  });

  const current = settings.data?.settings;

  return (
    <View>
      <Card theme={theme}>
        <SectionTitle
          theme={theme}
          title="Untracked files to carry"
          hint="Comma separated globs. Kept explicit so syncing never drags node_modules or build output."
        />
        <Field
          theme={theme}
          value={allowlist ?? current?.untrackedAllowlist.join(", ") ?? ""}
          onChangeText={setAllowlist}
          placeholder=".env, .env.*"
        />
      </Card>

      <Card theme={theme}>
        <SectionTitle
          theme={theme}
          title="Transcript size limit (MB)"
          hint="Larger conversations are listed as skipped rather than moved. Some rollouts reach hundreds of megabytes."
        />
        <Field
          theme={theme}
          value={maxMb ?? String(current?.maxTranscriptMb ?? 64)}
          onChangeText={setMaxMb}
          placeholder="64"
          keyboardNumeric
        />
      </Card>

      <Card theme={theme}>
        <SectionTitle
          theme={theme}
          title="Uncommitted work"
          hint="Dirty worktrees are carried as a stash: git stash create builds a commit without touching your working tree, and the far side receives it as a normal stash entry."
        />
        <Row theme={theme} label="carry stashes" value={current?.carryStashes ? "on" : "off"} />
      </Card>

      <Button theme={theme} label="Save settings" tone="primary" busy={save.isPending} onPress={() => save.mutate()} />
    </View>
  );
}
