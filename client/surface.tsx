import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  hostsRpc,
  listRpc,
  previewRpc,
  runRpc,
  statusRpc,
} from "../shared/rpc";
import type { Plan } from "../shared/types";

export function SyncSurface({
  theme,
  layout,
  host,
  navigation,
}: PluginSurfaceProps) {
  const colors = theme.colors;
  const hosts = useRpc(hostsRpc),
    list = useRpc(listRpc),
    preview = useRpc(previewRpc),
    run = useRpc(runRpc),
    status = useRpc(statusRpc);
  const [remote, setRemote] = useState("");
  const [home, setHome] = useState("");
  const [identityFile, setIdentityFile] = useState("");
  const [direction, setDirection] = useState<"push" | "pull">("push");
  const [workspaceId, setWorkspaceId] = useState("");
  const [destination, setDestination] = useState("");
  const [mode, setMode] = useState<"copy" | "move">("copy");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [runId, setRunId] = useState("");
  const endpoint = {
    target: remote.trim(),
    ...(home.trim() ? { home: home.trim() } : {}),
    ...(identityFile.trim() ? { identityFile: identityFile.trim() } : {}),
  };
  const source = direction === "push" ? { target: "" } : endpoint,
    target = direction === "push" ? endpoint : { target: "" };
  const suggestions = useQuery({
    queryKey: ["sync", host.id, "hosts"],
    queryFn: () => hosts({}),
    staleTime: 60_000,
  });
  const workspaces = useQuery({
    queryKey: ["sync", host.id, "workspaces", source],
    queryFn: () => list({ endpoint: source }),
    enabled: direction === "push" || !!remote.trim(),
  });
  const makePreview = useMutation({
    mutationFn: () =>
      preview({ source, target, workspaceId, destination, mode }),
    onSuccess: setPlan,
  });
  const transfer = useMutation({
    mutationFn: () => run({ planId: plan!.id }),
    onSuccess: (data) => {
      setRunId(data.runId);
      setPlan(null);
    },
  });
  const progress = useQuery({
    queryKey: ["sync", host.id, "run", runId],
    queryFn: () => status({ runId }),
    enabled: !!runId,
    refetchInterval: (q) => (q.state.data?.state === "running" ? 1000 : false),
  });
  const running =
    !!runId && (!progress.data || progress.data.state === "running");
  const locked = running || transfer.isPending || makePreview.isPending;
  useEffect(() => {
    setPlan(null);
    makePreview.reset();
    transfer.reset();
  }, [remote, home, identityFile, direction, workspaceId, destination, mode]);
  useEffect(() => {
    setWorkspaceId("");
    setPlan(null);
    setRunId("");
  }, [host.id, direction, remote, home]);
  const error =
    makePreview.error ??
    transfer.error ??
    progress.error ??
    workspaces.error ??
    suggestions.error;
  const label = (text: string) => (
    <Text
      style={{
        color: colors.foreground,
        fontSize: 14,
        fontWeight: "600",
        marginBottom: 8,
      }}
    >
      {text}
    </Text>
  );
  const input = (
    value: string,
    change: (s: string) => void,
    placeholder: string,
    title: string,
  ) => (
    <TextInput
      accessibilityLabel={title}
      value={value}
      onChangeText={change}
      placeholder={placeholder}
      placeholderTextColor={colors.foregroundMuted}
      editable={!locked}
      autoCapitalize="none"
      autoCorrect={false}
      style={{
        color: colors.foreground,
        backgroundColor: colors.surface1,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: 6,
        paddingHorizontal: 12,
        paddingVertical: 11,
        fontSize: 14,
        minHeight: 44,
      }}
    />
  );
  const button = (
    text: string,
    action: () => void,
    disabled = false,
    selected = false,
  ) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={text}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={action}
      style={({ pressed }) => ({
        minHeight: 44,
        justifyContent: "center",
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: selected ? colors.accent : colors.border,
        backgroundColor: selected ? colors.accent : colors.surface1,
        opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
      })}
    >
      <Text
        style={{
          fontSize: 14,
          fontWeight: "600",
          color: selected ? colors.accentForeground : colors.foreground,
        }}
      >
        {text}
      </Text>
    </Pressable>
  );
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.surface0 }}
      contentContainerStyle={{
        padding: layout.compact ? 16 : 28,
        paddingBottom: 56,
      }}
    >
      <View
        style={{ maxWidth: 760, width: "100%", alignSelf: "center", gap: 24 }}
      >
        <View style={{ gap: 8 }}>
          <Text
            accessibilityRole="header"
            style={{
              color: colors.foreground,
              fontSize: 26,
              fontWeight: "700",
            }}
          >
            Continue on another host
          </Text>
          <Text
            style={{
              color: colors.foregroundMuted,
              fontSize: 14,
              lineHeight: 21,
            }}
          >
            Bring a workspace’s Git history, local changes, and conversations
            with you.
          </Text>
        </View>
        <View style={{ gap: 12 }}>
          {label("Transfer direction")}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {button(
              `From ${host.label}`,
              () => setDirection("push"),
              locked,
              direction === "push",
            )}
            {button(
              `To ${host.label}`,
              () => setDirection("pull"),
              locked,
              direction === "pull",
            )}
          </View>
        </View>
        <View style={{ gap: 10 }}>
          {label(direction === "push" ? "Target host" : "Source host")}
          {input(remote, setRemote, "SSH alias or user@host", "SSH host")}
          {!!suggestions.data?.hosts.length && (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {suggestions.data.hosts.map((item) => (
                <View key={item.target}>
                  {button(
                    item.label,
                    () => setRemote(item.target),
                    locked,
                    remote === item.target,
                  )}
                </View>
              ))}
            </View>
          )}
          <Text
            style={{
              color: colors.foregroundMuted,
              fontSize: 12,
              lineHeight: 18,
            }}
          >
            Uses your SSH config and keys. Suggestions come from SSH config and
            online Tailscale peers.
          </Text>
          <View
            style={{
              flexDirection: layout.compact ? "column" : "row",
              gap: 12,
            }}
          >
            <View style={{ flex: 1 }}>
              {label("Paseo home (optional)")}
              {input(
                home,
                setHome,
                "Default on the other host",
                "Remote Paseo home",
              )}
            </View>
            <View style={{ flex: 1 }}>
              {label("SSH key (optional)")}
              {input(
                identityFile,
                setIdentityFile,
                "Use SSH config",
                "SSH identity file",
              )}
            </View>
          </View>
        </View>
        <View style={{ gap: 8 }}>
          {label("Workspace")}
          {direction === "pull" && !remote.trim() ? (
            <Text style={{ color: colors.foregroundMuted }}>
              Choose a source host to load its workspaces.
            </Text>
          ) : workspaces.isPending ? (
            <Text style={{ color: colors.foregroundMuted }}>
              Loading workspaces…
            </Text>
          ) : !workspaces.data?.workspaces.length ? (
            <Text style={{ color: colors.foregroundMuted }}>
              No open workspaces. Choose a reachable source host and refresh.
            </Text>
          ) : (
            <View
              style={{
                maxHeight: 280,
                borderColor: colors.border,
                borderWidth: 1,
                borderRadius: 6,
              }}
            >
              <ScrollView nestedScrollEnabled>
                {workspaces.data.workspaces.map((item) => (
                  <Pressable
                    key={item.workspaceId}
                    accessibilityRole="radio"
                    accessibilityState={{
                      selected: item.workspaceId === workspaceId,
                      disabled: locked,
                    }}
                    disabled={locked}
                    onPress={() => {
                      setWorkspaceId(item.workspaceId);
                      setDestination(
                        `~/Projects/${item.cwd.split("/").filter(Boolean).pop()}-transfer`,
                      );
                    }}
                    style={({ pressed }) => ({
                      padding: 12,
                      gap: 4,
                      backgroundColor:
                        item.workspaceId === workspaceId
                          ? colors.surface2
                          : pressed
                            ? colors.surface1
                            : colors.surface0,
                      borderBottomWidth: 1,
                      borderBottomColor: colors.border,
                    })}
                  >
                    <Text
                      style={{
                        color:
                          item.workspaceId === workspaceId
                            ? colors.accent
                            : colors.foreground,
                        fontSize: 14,
                        fontWeight: "600",
                      }}
                    >
                      {item.name}
                    </Text>
                    <Text
                      numberOfLines={1}
                      style={{ color: colors.foregroundMuted, fontSize: 12 }}
                    >
                      {item.cwd}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          )}
          <View style={{ alignSelf: "flex-start" }}>
            {button(
              "Refresh workspaces",
              () => {
                void workspaces.refetch();
              },
              locked || (direction === "pull" && !remote.trim()),
            )}
          </View>
        </View>
        <View>
          {label("New directory on the target host")}
          {input(
            destination,
            setDestination,
            "~/Projects/my-workspace",
            "Destination directory",
          )}
          <Text
            style={{
              color: colors.foregroundMuted,
              fontSize: 12,
              lineHeight: 18,
              marginTop: 8,
            }}
          >
            Choose a directory that does not exist. The transferred checkout is
            independent. Git-ignored files stay on the source.
          </Text>
        </View>
        <View style={{ gap: 12 }}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {button("Copy", () => setMode("copy"), locked, mode === "copy")}
            {button("Move", () => setMode("move"), locked, mode === "move")}
          </View>
          <Text
            style={{
              color: colors.foregroundMuted,
              fontSize: 14,
              lineHeight: 21,
            }}
          >
            {mode === "move"
              ? "Archive the source workspace after the destination is verified. Paseo may remove a managed source worktree."
              : "Keep the source workspace open."}
          </Text>
        </View>
        {error && (
          <Text
            accessibilityRole="alert"
            style={{ color: colors.statusDanger, fontSize: 14, lineHeight: 21 }}
          >
            {error.message}
          </Text>
        )}
        <View style={{ alignSelf: "flex-start" }}>
          {button(
            makePreview.isPending ? "Preparing preview…" : "Preview transfer",
            () => makePreview.mutate(),
            locked || !remote.trim() || !workspaceId || !destination.trim(),
            !plan,
          )}
        </View>
        {plan && (
          <View
            style={{
              borderTopWidth: 1,
              borderTopColor: colors.border,
              paddingTop: 20,
              gap: 12,
            }}
          >
            <Text
              accessibilityRole="header"
              style={{
                color: colors.foreground,
                fontSize: 18,
                fontWeight: "600",
              }}
            >
              Ready to {plan.mode}
            </Text>
            <Text
              selectable
              style={{ color: colors.foreground, fontSize: 14, lineHeight: 21 }}
            >
              {plan.workspace.name}
              {"\n"}
              {plan.destination}
            </Text>
            <Text
              style={{
                color: colors.foregroundMuted,
                fontSize: 14,
                lineHeight: 21,
              }}
            >
              {plan.files} files · {plan.sessions} conversations ·{" "}
              {(plan.bytes / 1024 / 1024).toFixed(1)} MiB
              {plan.branch ? ` · ${plan.branch}` : ""}
            </Text>
            <View style={{ alignSelf: "flex-start" }}>
              {button(
                `${plan.mode === "move" ? "Move" : "Copy"} workspace`,
                () => transfer.mutate(),
                locked,
                true,
              )}
            </View>
          </View>
        )}
        {!!runId && (
          <View
            style={{
              borderTopWidth: 1,
              borderTopColor: colors.border,
              paddingTop: 20,
              gap: 12,
            }}
          >
            <Text
              accessibilityLiveRegion="polite"
              style={{
                color:
                  progress.data?.state === "failed"
                    ? colors.statusDanger
                    : colors.foreground,
                fontSize: 14,
                lineHeight: 21,
              }}
            >
              {progress.data?.message ?? "Starting transfer…"}
            </Text>
            {progress.data?.result && (
              <Text
                selectable
                style={{ color: colors.foregroundMuted, fontSize: 13 }}
              >
                {progress.data.result.cwd}
              </Text>
            )}
            {progress.data?.state === "done" &&
              direction === "pull" &&
              navigation &&
              progress.data.result && (
                <View style={{ alignSelf: "flex-start" }}>
                  {button("Open workspace", () =>
                    navigation.openWorkspace({
                      workspaceId: progress.data!.result!.workspaceId,
                    }),
                  )}
                </View>
              )}
          </View>
        )}
      </View>
    </ScrollView>
  );
}
