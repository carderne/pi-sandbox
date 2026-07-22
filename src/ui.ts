import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

import { type SandboxConfig } from "./config.ts";
import { allowsAllDomains } from "./policy.ts";
import { type SessionAllowances } from "./sandbox-runtime.ts";

export type PermissionChoice = "abort" | "session" | "project" | "global";

interface PromptOption {
  label: string;
  key: string;
  action: PermissionChoice;
  confirm?: boolean;
  hint?: string;
}

const PERMISSION_OPTIONS: PromptOption[] = [
  { label: "Allow for this session only", key: "s", action: "session" },
  { label: "Abort (keep blocked)", key: "esc", action: "abort" },
  {
    label: "Allow for this project",
    key: "P",
    action: "project",
    confirm: true,
    hint: "→ .pi/sandbox.json",
  },
  {
    label: "Allow for all projects",
    key: "A",
    action: "global",
    confirm: true,
    hint: "→ ~/.pi/agent/sandbox.json",
  },
];

export async function showPermissionPrompt(
  ctx: ExtensionContext,
  title: string,
): Promise<PermissionChoice> {
  if (!ctx.hasUI) return "abort";

  const result = await ctx.ui.custom<PermissionChoice>((tui, theme, _kb, done) => {
    let selectedIndex = 0;
    let pendingAction: PermissionChoice | null = null;
    const resolve = (action: PermissionChoice) => done(action);

    return {
      render(width: number): string[] {
        const lines = [truncateToWidth(theme.fg("warning", title), width), ""];
        for (let i = 0; i < PERMISSION_OPTIONS.length; i++) {
          const option = PERMISSION_OPTIONS[i];
          const prefix = i === selectedIndex ? " → " : "   ";
          const keyHint = theme.fg("accent", `[${option.key}]`);
          let label = option.label;
          if (option.hint) label += `  ${theme.fg("dim", option.hint)}`;
          if (pendingAction === option.action) {
            label += `  ${theme.fg("warning", "→ press Enter to confirm")}`;
          }
          lines.push(truncateToWidth(`${prefix}${keyHint} ${label}`, width));
        }
        lines.push("");
        const footer = pendingAction
          ? "↑↓ navigate  enter confirm  esc cancel"
          : "↑↓ navigate  enter select  esc/ctrl+c cancel";
        lines.push(truncateToWidth(theme.fg("dim", footer), width));
        return lines;
      },
      handleInput(data: string): void {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
          resolve("abort");
          return;
        }
        if (matchesKey(data, Key.enter)) {
          resolve(pendingAction ?? PERMISSION_OPTIONS[selectedIndex]?.action ?? "abort");
          return;
        }
        if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
          const delta = matchesKey(data, Key.up) ? -1 : 1;
          selectedIndex = Math.max(
            0,
            Math.min(PERMISSION_OPTIONS.length - 1, selectedIndex + delta),
          );
          pendingAction = null;
          tui.requestRender();
          return;
        }
        for (let i = 0; i < PERMISSION_OPTIONS.length; i++) {
          const option = PERMISSION_OPTIONS[i];
          if (data === option.key) {
            resolve(option.action);
            return;
          }
          if (data.toLowerCase() === option.key.toLowerCase()) {
            if (option.confirm) {
              pendingAction = option.action;
              selectedIndex = i;
            } else {
              resolve(option.action);
            }
            tui.requestRender();
            return;
          }
        }
      },
      invalidate(): void {},
    };
  });

  return result ?? "abort";
}

export function promptDomainBlock(
  ctx: ExtensionContext,
  domain: string,
): Promise<PermissionChoice> {
  return showPermissionPrompt(ctx, `🌐 Network blocked: "${domain}" is not in allowedDomains`);
}

export function promptReadBlock(ctx: ExtensionContext, path: string): Promise<PermissionChoice> {
  return showPermissionPrompt(ctx, `📖 Read blocked: "${path}" is not in allowRead`);
}

export function promptWriteBlock(ctx: ExtensionContext, path: string): Promise<PermissionChoice> {
  return showPermissionPrompt(ctx, `📝 Write blocked: "${path}" is not in allowWrite`);
}

export function warnIfAllDomainsAllowed(ctx: ExtensionContext, config: SandboxConfig): void {
  if (!allowsAllDomains(config.network?.allowedDomains)) return;
  ctx.ui.notify(
    '⚠️ Network sandbox allows all domains because network.allowedDomains contains "*". ' +
      'Only use this intentionally; remove "*" to restore per-domain prompts.',
    "warning",
  );
}

export function formatSandboxStatus(config: SandboxConfig): string {
  const networkLabel = allowsAllDomains(config.network?.allowedDomains)
    ? "all domains"
    : `${config.network?.allowedDomains?.length ?? 0} domains`;
  return `🔒 Sandbox: ${networkLabel}, ${config.filesystem?.allowWrite?.length ?? 0} write paths`;
}

export function formatSandboxConfiguration(
  config: SandboxConfig,
  paths: { globalPath: string; projectPath: string },
  allowances: SessionAllowances,
): string {
  return [
    "Sandbox Configuration",
    `  Project config: ${paths.projectPath}`,
    `  Global config:  ${paths.globalPath}`,
    "",
    "Network (bash + !cmd):",
    `  Allowed domains: ${config.network?.allowedDomains?.join(", ") || "(none)"}`,
    ...(allowsAllDomains(config.network?.allowedDomains)
      ? ['  ⚠️ "*" allows all domains and disables per-domain prompts.']
      : []),
    `  Denied domains:  ${config.network?.deniedDomains?.join(", ") || "(none)"}`,
    ...(allowances.domains.length ? [`  Session allowed: ${allowances.domains.join(", ")}`] : []),
    "",
    "Filesystem (bash + read/write/edit tools):",
    `  Deny Read:   ${config.filesystem?.denyRead?.join(", ") || "(none)"}`,
    `  Allow Read:  ${config.filesystem?.allowRead?.join(", ") || "(none)"}`,
    `  Allow Write: ${config.filesystem?.allowWrite?.join(", ") || "(none)"}`,
    `  Deny Write:  ${config.filesystem?.denyWrite?.join(", ") || "(none)"}`,
    ...(allowances.readPaths.length ? [`  Session read:  ${allowances.readPaths.join(", ")}`] : []),
    ...(allowances.writePaths.length
      ? [`  Session write: ${allowances.writePaths.join(", ")}`]
      : []),
    "",
    "Note: ALL reads are prompted unless the path is in allowRead or allowWrite.",
    "Note: allowWrite also grants read access to the same path.",
    "Note: denyRead is not a hard-block — granting a prompt adds to allowRead, overriding denyRead.",
    "Note: denyWrite takes PRECEDENCE over allowWrite and is never prompted.",
  ].join("\n");
}
