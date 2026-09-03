import type { PluginTheme } from "@getpaseo/plugin";
import React from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";

/**
 * Panel primitives.
 *
 * Two rules: one filled button per view, and nothing non-interactive gets a
 * border. Every colour comes from `theme.colors` so the panel follows whichever
 * theme the app is in — unstyled text is black and disappears in dark mode.
 *
 * Self-contained on purpose. Sync depends on nothing but Paseo's own SDK, so it
 * installs on any daemon without requiring another plugin to be present.
 */

export type Theme = PluginTheme;
export type Tone = "neutral" | "success" | "warning" | "danger";

export function toneColor(theme: Theme, tone: Tone): string {
  if (tone === "success") return theme.colors.statusSuccess;
  if (tone === "warning") return theme.colors.statusWarning;
  if (tone === "danger") return theme.colors.statusDanger;
  return theme.colors.foregroundMuted;
}

export function Card({
  theme,
  children,
  compact,
}: {
  theme: Theme;
  children: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <View
      style={{
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 10,
        padding: compact ? 12 : 14,
        gap: compact ? 8 : 10,
        marginBottom: 12,
      }}
    >
      {children}
    </View>
  );
}

export function SectionTitle({ theme, title, hint }: { theme: Theme; title: string; hint?: string }) {
  return (
    <View style={{ gap: 2 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>{title}</Text>
      {hint ? <Note theme={theme}>{hint}</Note> : null}
    </View>
  );
}

export function Chip({ theme, label, tone = "neutral" }: { theme: Theme; label: string; tone?: Tone }) {
  const color = toneColor(theme, tone);
  return (
    <View style={{ borderColor: color, borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
      <Text style={{ color, fontSize: 11, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}

export function Button({
  theme,
  label,
  onPress,
  tone = "default",
  busy,
  disabled,
}: {
  theme: Theme;
  label: string;
  onPress: () => void;
  tone?: "default" | "primary" | "danger";
  busy?: boolean;
  disabled?: boolean;
}) {
  const inactive = disabled || busy;
  const background = tone === "primary" ? theme.colors.accent : theme.colors.surface2;
  const color =
    tone === "primary"
      ? theme.colors.accentForeground
      : tone === "danger"
        ? theme.colors.statusDanger
        : theme.colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={inactive ? undefined : onPress}
      style={{
        backgroundColor: background,
        borderColor: theme.colors.border,
        borderWidth: tone === "primary" ? 0 : 1,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 7,
        opacity: inactive ? 0.5 : 1,
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
      }}
    >
      {busy ? <ActivityIndicator size="small" color={color} /> : null}
      <Text style={{ color, fontSize: 13, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

export function Field({
  theme,
  value,
  onChangeText,
  placeholder,
  keyboardNumeric,
  secure,
}: {
  theme: Theme;
  value: string;
  onChangeText: (next: string) => void;
  placeholder: string;
  keyboardNumeric?: boolean;
  secure?: boolean;
}) {
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={theme.colors.foregroundMuted}
      autoCapitalize="none"
      autoCorrect={false}
      secureTextEntry={secure}
      keyboardType={keyboardNumeric ? "number-pad" : "default"}
      style={{
        backgroundColor: theme.colors.surface0,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 7,
        color: theme.colors.foreground,
        fontSize: 13,
        minWidth: 140,
        flexGrow: 1,
      }}
    />
  );
}

export function Note({
  theme,
  children,
  tone = "muted",
}: {
  theme: Theme;
  children: React.ReactNode;
  tone?: "muted" | "warning" | "danger";
}) {
  const color =
    tone === "warning"
      ? theme.colors.statusWarning
      : tone === "danger"
        ? theme.colors.statusDanger
        : theme.colors.foregroundMuted;
  return <Text style={{ color, fontSize: 12, lineHeight: 17 }}>{children}</Text>;
}

export function Row({
  theme,
  label,
  value,
  tone = "neutral",
}: {
  theme: Theme;
  label: string;
  value: string;
  tone?: Tone;
}) {
  const color = tone === "neutral" ? theme.colors.foreground : toneColor(theme, tone);
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{label}</Text>
      <Text style={{ color, fontSize: 12, fontWeight: "600", flexShrink: 1, textAlign: "right" }}>
        {value}
      </Text>
    </View>
  );
}

export function Tabs<T extends string>({
  theme,
  tabs,
  active,
  onSelect,
  badge,
}: {
  theme: Theme;
  tabs: ReadonlyArray<{ id: T; label: string }>;
  active: T;
  onSelect: (id: T) => void;
  badge?: Partial<Record<T, string>>;
}) {
  return (
    <View style={{ flexDirection: "row", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
      {tabs.map((tab) => {
        const selected = tab.id === active;
        const count = badge?.[tab.id];
        return (
          <Pressable
            key={tab.id}
            accessibilityRole="button"
            accessibilityLabel={tab.label}
            onPress={() => onSelect(tab.id)}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 6,
              borderRadius: 999,
              backgroundColor: selected ? theme.colors.accent : theme.colors.surface1,
              borderColor: theme.colors.border,
              borderWidth: selected ? 0 : 1,
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
            }}
          >
            <Text
              style={{
                color: selected ? theme.colors.accentForeground : theme.colors.foregroundMuted,
                fontSize: 13,
                fontWeight: "600",
              }}
            >
              {tab.label}
            </Text>
            {count ? (
              <View
                style={{
                  backgroundColor: selected ? theme.colors.accentForeground : theme.colors.surface2,
                  borderRadius: 999,
                  paddingHorizontal: 6,
                }}
              >
                <Text
                  style={{
                    color: selected ? theme.colors.accent : theme.colors.foregroundMuted,
                    fontSize: 10,
                    fontWeight: "700",
                  }}
                >
                  {count}
                </Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Two-state direction control. Deliberately a pair of labelled buttons rather
 * than a switch: "which way is this about to move my work" is the one question
 * the panel must never leave ambiguous.
 */
export function Segmented<T extends string>({
  theme,
  options,
  value,
  onChange,
}: {
  theme: Theme;
  options: ReadonlyArray<{ id: T; label: string }>;
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        borderRadius: 8,
        borderColor: theme.colors.border,
        borderWidth: 1,
        overflow: "hidden",
      }}
    >
      {options.map((option) => {
        const selected = option.id === value;
        return (
          <Pressable
            key={option.id}
            accessibilityRole="button"
            accessibilityLabel={option.label}
            onPress={() => onChange(option.id)}
            style={{
              paddingHorizontal: 14,
              paddingVertical: 7,
              backgroundColor: selected ? theme.colors.accent : "transparent",
            }}
          >
            <Text
              style={{
                color: selected ? theme.colors.accentForeground : theme.colors.foregroundMuted,
                fontSize: 13,
                fontWeight: "600",
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Checkbox({
  theme,
  checked,
  onToggle,
  label,
  hint,
  disabled,
}: {
  theme: Theme;
  checked: boolean;
  onToggle: () => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      accessibilityLabel={label}
      onPress={disabled ? undefined : onToggle}
      style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, opacity: disabled ? 0.45 : 1 }}
    >
      <View
        style={{
          width: 18,
          height: 18,
          borderRadius: 4,
          marginTop: 1,
          borderWidth: checked ? 0 : 1,
          borderColor: theme.colors.border,
          backgroundColor: checked ? theme.colors.accent : theme.colors.surface0,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {checked ? (
          <Text style={{ color: theme.colors.accentForeground, fontSize: 12, fontWeight: "700" }}>✓</Text>
        ) : null}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{label}</Text>
        {hint ? <Note theme={theme}>{hint}</Note> : null}
      </View>
    </Pressable>
  );
}

export function ProgressBar({ theme, fraction, tone = "neutral" }: { theme: Theme; fraction: number; tone?: Tone }) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const color = tone === "neutral" ? theme.colors.accent : toneColor(theme, tone);
  return (
    <View style={{ height: 4, borderRadius: 2, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
      <View style={{ width: `${Math.max(2, clamped * 100)}%`, height: 4, backgroundColor: color }} />
    </View>
  );
}

export function EmptyState({ theme, title, hint }: { theme: Theme; title: string; hint: string }) {
  return (
    <View style={{ paddingVertical: 28, gap: 6, alignItems: "center" }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>{title}</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, textAlign: "center", maxWidth: 380 }}>
        {hint}
      </Text>
    </View>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatWhen(iso: string | null): string {
  if (!iso) return "never";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
