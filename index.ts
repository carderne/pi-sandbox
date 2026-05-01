/**
 * Based on https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/sandbox/index.ts
 * by Mario Zechner, used under the MIT License.
 *
 * Sandbox Extension - OS-level sandboxing for pi with interactive permission prompts.
 *
 * Uses @carderne/sandbox-runtime to enforce filesystem and network
 * restrictions on bash commands at the OS level (sandbox-exec on macOS,
 * bubblewrap on Linux). Also intercepts the read, write, and edit tools to
 * apply the same denyRead/denyWrite/allowWrite filesystem rules, which OS-level
 * sandboxing cannot cover (those tools run directly in Node.js, not in a
 * subprocess).
 *
 * When a block is triggered, the user is prompted to:
 *   (a) Abort (keep blocked)
 *   (b) Allow for this session only  — stored in memory, agent cannot access
 *   (c) Allow for this project       — written to .pi/sandbox.json
 *   (d) Allow for all projects       — written to ~/.pi/agent/sandbox.json
 *
 * What gets prompted vs. hard-blocked:
 *   - domains: prompted if not whitelisted nor explicitly denied
 *   - write: prompted if not whitelisted nor explicitly denied
 *   - read: always prompted (because denyRead is used for broad block, may want to punch holes)
 *
 * IMPORTANT — precedence for read:
 *   Read:  allowRead OVERRIDES denyRead (prompt grant adds to allowRead)
 *   Write: denyWrite OVERRIDES allowWrite (most-specific deny wins)
 *
 * Config files (merged, project takes precedence):
 * - ~/.pi/agent/sandbox.json (global)
 * - <cwd>/.pi/sandbox.json  (project-local)
 *
 * Example .pi/sandbox.json:
 * ```json
 * {
 *   "enabled": true,
 *   "network": {
 *     "allowedDomains": ["github.com", "*.github.com"],
 *     "deniedDomains": []
 *   },
 *   "filesystem": {
 *     "denyRead": ["/Users", "/home"],
 *     "allowRead": [".", "~/.config", "~/.local", "Library"],
 *     "allowWrite": [".", "/tmp"],
 *     "denyWrite": [".env"]
 *   }
 * }
 * ```
 *
 * Usage:
 * - `pi -e ./sandbox` - sandbox enabled with default/config settings
 * - `pi -e ./sandbox --no-sandbox` - disable sandboxing
 * - `/sandbox` - show current sandbox configuration
 *
 * Setup:
 * 1. Copy sandbox/ directory to ~/.pi/agent/extensions/
 * 2. Run `npm install` in ~/.pi/agent/extensions/sandbox/
 *
 * Linux also requires: bubblewrap, socat, ripgrep
 */

import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  SandboxManager,
  type SandboxAskCallback,
  type SandboxRuntimeConfig,
} from "@carderne/sandbox-runtime";
import {
  type BashOperations,
  createBashTool,
  createLocalBashOperations,
  getAgentDir,
  isToolCallEventType,
} from "@mariozechner/pi-coding-agent";
import { matchesKey, Key, truncateToWidth } from "@mariozechner/pi-tui";

interface SandboxConfig extends SandboxRuntimeConfig {
  enabled?: boolean;
  /**
   * Commands that always run unsandboxed (e.g. ["gh", "security"]).
   * Matched by first word; persists across sessions.
   */
  unsandboxedCommands?: string[];
  /**
   * Patterns that trigger the reactive bypass prompt when found in
   * sandboxed command output. Case-insensitive substring match.
   */
  sandboxFailurePatterns?: string[];
}

const DEFAULT_CONFIG: SandboxConfig = {
  enabled: true,
  unsandboxedCommands: [],
  network: {
    allowedDomains: [
      "npmjs.org",
      "*.npmjs.org",
      "registry.npmjs.org",
      "registry.yarnpkg.com",
      "pypi.org",
      "*.pypi.org",
      "github.com",
      "*.github.com",
      "api.github.com",
      "raw.githubusercontent.com",
    ],
    deniedDomains: [],
  },
  filesystem: {
    denyRead: ["/Users", "/home"],
    allowRead: [".", "~/.config", "~/.local", "Library"],
    allowWrite: [".", "/tmp"],
    denyWrite: [".env", ".env.*", "*.pem", "*.key", ".pi/sandbox.json", "~/.pi/agent/sandbox.json"],
  },
};

const AUDIT_LOG = join(homedir(), ".pi", "sandbox", "audit.log");
function auditLog(entry: {
  timestamp: string;
  command: string;
  type: "predictive" | "reactive";
  choice: "once" | "session" | "project" | "global" | "project-level" | "system-level" | "declined";
  unsandboxed: boolean;
}): void {
  try {
    mkdirSync(dirname(AUDIT_LOG), { recursive: true });
    const line = `${JSON.stringify(entry)}\n`;
    writeFileSync(AUDIT_LOG, line, { flag: "a" });
  } catch {
    /* ignore */
  }
}

/**
 * Determine the config level for an unsandboxed command.
 * Returns "project-level", "system-level", or "session" based on which config
 * contains the command.
 */
function getUnsandboxedCommandLevel(
  command: string,
  cwd: string,
  sessionCommands: string[],
): "project-level" | "system-level" | "session" {
  const normalized = command.trimStart().split(/\s+/).join(" ");

  // Check session first
  if (sessionCommands.includes(normalized)) {
    return "session";
  }

  // Check project config
  const projectConfigPath = join(cwd, ".pi", "sandbox.json");
  if (existsSync(projectConfigPath)) {
    try {
      const projectConfig = JSON.parse(readFileSync(projectConfigPath, "utf-8"));
      if (projectConfig.unsandboxedCommands?.includes(normalized)) {
        return "project-level";
      }
    } catch {
      /* ignore */
    }
  }

  // Check global config
  const globalConfigPath = join(getAgentDir(), "sandbox.json");
  if (existsSync(globalConfigPath)) {
    try {
      const globalConfig = JSON.parse(readFileSync(globalConfigPath, "utf-8"));
      if (globalConfig.unsandboxedCommands?.includes(normalized)) {
        return "system-level";
      }
    } catch {
      /* ignore */
    }
  }

  // Fallback — shouldn't happen if commandIsUnsandboxed matched
  return "project-level";
}

function loadConfig(cwd: string): SandboxConfig {
  const projectConfigPath = join(cwd, ".pi", "sandbox.json");
  const globalConfigPath = join(getAgentDir(), "sandbox.json");

  let globalConfig: Partial<SandboxConfig> = {};
  let projectConfig: Partial<SandboxConfig> = {};

  if (existsSync(globalConfigPath)) {
    try {
      globalConfig = JSON.parse(readFileSync(globalConfigPath, "utf-8"));
    } catch (e) {
      console.error(`Warning: Could not parse ${globalConfigPath}: ${e}`);
    }
  }

  if (existsSync(projectConfigPath)) {
    try {
      projectConfig = JSON.parse(readFileSync(projectConfigPath, "utf-8"));
    } catch (e) {
      console.error(`Warning: Could not parse ${projectConfigPath}: ${e}`);
    }
  }

  return deepMerge(deepMerge(DEFAULT_CONFIG, globalConfig), projectConfig);
}

function deepMerge(base: SandboxConfig, overrides: Partial<SandboxConfig>): SandboxConfig {
  const result: SandboxConfig = { ...base };

  if (overrides.enabled !== undefined) result.enabled = overrides.enabled;
  if (overrides.network) {
    result.network = { ...base.network, ...overrides.network };
  }
  if (overrides.filesystem) {
    result.filesystem = { ...base.filesystem, ...overrides.filesystem };
  }

  const extOverrides = overrides as {
    ignoreViolations?: Record<string, string[]>;
    enableWeakerNestedSandbox?: boolean;
    allowBrowserProcess?: boolean;
  };
  const extResult = result as {
    ignoreViolations?: Record<string, string[]>;
    enableWeakerNestedSandbox?: boolean;
    allowBrowserProcess?: boolean;
  };

  if (extOverrides.ignoreViolations) {
    extResult.ignoreViolations = extOverrides.ignoreViolations;
  }
  if (extOverrides.enableWeakerNestedSandbox !== undefined) {
    extResult.enableWeakerNestedSandbox = extOverrides.enableWeakerNestedSandbox;
  }
  if (extOverrides.allowBrowserProcess !== undefined) {
    extResult.allowBrowserProcess = extOverrides.allowBrowserProcess;
  }
  if (overrides.unsandboxedCommands !== undefined) {
    const baseSet = new Set(result.unsandboxedCommands ?? []);
    for (const cmd of overrides.unsandboxedCommands) baseSet.add(cmd);
    result.unsandboxedCommands = [...baseSet];
  }
  if (overrides.sandboxFailurePatterns !== undefined) {
    const baseSet = new Set(result.sandboxFailurePatterns ?? []);
    for (const pat of overrides.sandboxFailurePatterns) baseSet.add(pat);
    result.sandboxFailurePatterns = [...baseSet];
  }

  return result;
}

// ── Domain helpers ────────────────────────────────────────────────────────────

export function shouldPromptForWrite(
  path: string,
  allowWrite: string[],
  matchesPattern: (path: string, patterns: string[]) => boolean,
): boolean {
  // Secure default: empty allowWrite means deny-all writes (prompt every path).
  return allowWrite.length === 0 || !matchesPattern(path, allowWrite);
}

function extractDomainsFromCommand(command: string): string[] {
  const urlRegex = /https?:\/\/([a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  const domains = new Set<string>();
  let match;
  while ((match = urlRegex.exec(command)) !== null) {
    domains.add(match[1]);
  }
  return [...domains];
}

function domainMatchesPattern(domain: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) {
    const base = pattern.slice(2);
    return domain === base || domain.endsWith("." + base);
  }
  return domain === pattern;
}

function allowsAllDomains(allowedDomains: string[] | undefined): boolean {
  return allowedDomains?.includes("*") ?? false;
}

function domainIsAllowed(domain: string, allowedDomains: string[]): boolean {
  return allowedDomains.some((p) => domainMatchesPattern(domain, p));
}

function createNetworkAskCallback(allowedDomains: string[]): SandboxAskCallback {
  return async ({ host }) => domainIsAllowed(host, allowedDomains);
}

// ── Sandbox failure detection ───────────────────────────────────────────────

/**
 * Default patterns that indicate a sandbox/auth/keychain failure.
 * Users can override/extend these in their sandbox.json config.
 */
const DEFAULT_FAILURE_PATTERNS: string[] = [
  "operation not permitted",
  "no oauth token",
  "authentication failed",
  "user interaction is not allowed",
  "errsecinteractionnotallowed",
  "terminal prompts disabled",
  "could not read username",
  "permission denied",
  "requires authentication",
];

/**
 * Check if a command starts with any of the unsandboxed patterns.
 */
function commandIsUnsandboxed(command: string, patterns: string[]): boolean {
  const normalized = command.trimStart().split(/\s+/).join(" ");
  return patterns.some((p) => normalized === p);
}

/**
 * Detect if a command failed due to OS sandbox restrictions.
 * This is reactive: we run sandboxed first, then check the output.
 */
function isSandboxFailure(output: string, patterns: string[]): boolean {
  const lower = output.toLowerCase();
  return patterns.some((p) => lower.includes(p.toLowerCase()));
}

// ── Output analysis ───────────────────────────────────────────────────────────

/** Extract a path from a bash "Operation not permitted" OS sandbox error. */
function extractBlockedWritePath(output: string): string | null {
  const match = output.match(
    /(?:\/bin\/bash|bash|sh): (?:line \d: )?(\/[^:]+): Operation not permitted/,
  );
  return match ? match[1] : null;
}

// ── Path pattern matching ─────────────────────────────────────────────────────

function matchesPattern(filePath: string, patterns: string[]): boolean {
  const expanded = filePath.replace(/^~/, homedir());
  const abs = resolve(expanded);
  return patterns.some((p) => {
    const expandedP = p.replace(/^~/, homedir());
    const absP = resolve(expandedP);
    if (p.includes("*")) {
      const escaped = absP.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      return new RegExp(`^${escaped}$`).test(abs);
    }
    const sep = absP.endsWith("/") ? "" : "/";
    return abs === absP || abs.startsWith(absP + sep);
  });
}

// ── Config file updaters (Node.js process — not OS-sandboxed) ─────────────────

function getConfigPaths(cwd: string): {
  globalPath: string;
  projectPath: string;
} {
  return {
    globalPath: join(homedir(), ".pi", "agent", "sandbox.json"),
    projectPath: join(cwd, ".pi", "sandbox.json"),
  };
}

function readOrEmptyConfig(configPath: string): Partial<SandboxConfig> {
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
}

function writeConfigFile(configPath: string, config: Partial<SandboxConfig>): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function addDomainToConfig(configPath: string, domain: string): void {
  const config = readOrEmptyConfig(configPath);
  const existing = config.network?.allowedDomains ?? [];
  if (!existing.includes(domain)) {
    config.network = {
      ...config.network,
      allowedDomains: [...existing, domain],
      deniedDomains: config.network?.deniedDomains ?? [],
    };
    writeConfigFile(configPath, config);
  }
}

function addReadPathToConfig(configPath: string, pathToAdd: string): void {
  const config = readOrEmptyConfig(configPath);
  const existing = config.filesystem?.allowRead ?? [];
  if (!existing.includes(pathToAdd)) {
    config.filesystem = {
      ...config.filesystem,
      allowRead: [...existing, pathToAdd],
      denyRead: config.filesystem?.denyRead ?? [],
      allowWrite: config.filesystem?.allowWrite ?? [],
      denyWrite: config.filesystem?.denyWrite ?? [],
    };
    writeConfigFile(configPath, config);
  }
}

function addWritePathToConfig(configPath: string, pathToAdd: string): void {
  const config = readOrEmptyConfig(configPath);
  const existing = config.filesystem?.allowWrite ?? [];
  if (!existing.includes(pathToAdd)) {
    config.filesystem = {
      ...config.filesystem,
      allowWrite: [...existing, pathToAdd],
      denyRead: config.filesystem?.denyRead ?? [],
      denyWrite: config.filesystem?.denyWrite ?? [],
    };
    writeConfigFile(configPath, config);
  }
}

function addUnsandboxedCommandToConfig(configPath: string, command: string): void {
  const config = readOrEmptyConfig(configPath);
  const existing = config.unsandboxedCommands ?? [];
  const normalized = command.trimStart().split(/\s+/).join(" ");
  if (normalized && !existing.includes(normalized)) {
    config.unsandboxedCommands = [...existing, normalized];
    writeConfigFile(configPath, config);
  }
}

// ── Sandboxed bash ops ────────────────────────────────────────────────────────

function createSandboxedBashOps(): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (!existsSync(cwd)) {
        throw new Error(`Working directory does not exist: ${cwd}`);
      }

      const wrappedCommand = await SandboxManager.wrapWithSandbox("set -o pipefail && " + command);

      return new Promise((resolve, reject) => {
        const child = spawn("bash", ["-c", wrappedCommand], {
          cwd,
          env: {
            ...env,
            GIT_TERMINAL_PROMPT: "0",
            SSH_ASKPASS_REQUIRE: "never",
          },
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;

        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            if (child.pid) {
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch {
                child.kill("SIGKILL");
              }
            }
          }, timeout * 1000);
        }

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);

        child.on("error", (err) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          reject(err);
        });

        const onAbort = () => {
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
        };

        signal?.addEventListener("abort", onAbort, { once: true });

        child.on("close", (code) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);

          if (signal?.aborted) {
            reject(new Error("aborted"));
          } else if (timedOut) {
            reject(new Error(`timeout:${timeout}`));
          } else {
            resolve({ exitCode: code });
          }
        });
      });
    },
  };
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerFlag("no-sandbox", {
    description: "Disable OS-level sandboxing for bash commands",
    type: "boolean",
    default: false,
  });

  const localCwd = process.cwd();
  const localBash = createBashTool(localCwd);

  let sandboxEnabled = false;
  let sandboxInitialized = false;

  // Session-temporary allowances — held in JS memory, not accessible by the agent.
  // These are added on top of whatever is in the config files.
  const sessionAllowedDomains: string[] = [];
  const sessionAllowedReadPaths: string[] = [];
  const sessionAllowedWritePaths: string[] = [];

  // ── Effective config helpers ────────────────────────────────────────────────

  function getEffectiveAllowedDomains(cwd: string): string[] {
    const config = loadConfig(cwd);
    return [...(config.network?.allowedDomains ?? []), ...sessionAllowedDomains];
  }

  function getEffectiveAllowRead(cwd: string): string[] {
    const config = loadConfig(cwd);
    return [...(config.filesystem?.allowRead ?? []), ...sessionAllowedReadPaths];
  }

  function getEffectiveAllowWrite(cwd: string): string[] {
    const config = loadConfig(cwd);
    return [...(config.filesystem?.allowWrite ?? []), ...sessionAllowedWritePaths];
  }

  // Session-only unsandboxed command patterns — JS memory only, agent cannot access.
  const sessionUnsandboxedCommands: string[] = [];

  function getEffectiveUnsandboxedCommands(cwd: string): string[] {
    const config = loadConfig(cwd);
    return [...(config.unsandboxedCommands ?? []), ...sessionUnsandboxedCommands];
  }

  // ── Sandbox reinitialize ────────────────────────────────────────────────────
  // Called after granting a session/permanent allowance so the OS-level sandbox
  // picks up the new rules before the next bash subprocess starts.

  async function reinitializeSandbox(cwd: string): Promise<void> {
    if (!sandboxInitialized) return;
    const config = loadConfig(cwd);
    const configExt = config as unknown as { allowBrowserProcess?: boolean };
    try {
      const network = {
        ...config.network,
        allowedDomains: [...(config.network?.allowedDomains ?? []), ...sessionAllowedDomains],
        deniedDomains: config.network?.deniedDomains ?? [],
      };
      await SandboxManager.reset();
      await SandboxManager.initialize(
        {
          network,
          filesystem: {
            ...config.filesystem,
            denyRead: config.filesystem?.denyRead ?? [],
            allowRead: config.filesystem?.allowRead ?? [],
            allowWrite: [...(config.filesystem?.allowWrite ?? []), ...sessionAllowedWritePaths],
            denyWrite: config.filesystem?.denyWrite ?? [],
          },
          allowBrowserProcess: configExt.allowBrowserProcess,
          enableWeakerNetworkIsolation: true,
        },
        createNetworkAskCallback(network.allowedDomains),
      );
    } catch (e) {
      console.error(`Warning: Failed to reinitialize sandbox: ${e}`);
    }
  }

  // ── UI prompts ──────────────────────────────────────────────────────────────

  interface PromptOption {
    label: string;
    key: string;
    action: "abort" | "session" | "project" | "global" | "once";
    confirm?: boolean;
    hint?: string;
  }

  const PERMISSION_OPTIONS: PromptOption[] = [
    { label: "Allow once", key: "o", action: "once" },
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

  const BYPASS_OPTIONS: PromptOption[] = [
    { label: "Retry without sandbox (once)", key: "o", action: "once" },
    { label: "Retry without sandbox in this session", key: "s", action: "session" },
    { label: "Abort (keep failed result)", key: "esc", action: "abort" },
    {
      label: "Retry without sandbox for this project",
      key: "P",
      action: "project",
      confirm: true,
      hint: "→ .pi/sandbox.json",
    },
    {
      label: "Retry without sandbox for all projects",
      key: "A",
      action: "global",
      confirm: true,
      hint: "→ ~/.pi/agent/sandbox.json",
    },
  ];

  async function showPermissionPrompt(
    ctx: ExtensionContext,
    title: string,
    options: PromptOption[],
  ): Promise<"abort" | "session" | "project" | "global" | "once"> {
    if (!ctx.hasUI) return "abort";

    const result = await ctx.ui.custom<"abort" | "session" | "project" | "global" | "once">(
      (tui, theme, _kb, done) => {
        let selectedIndex = 0;
        let pendingAction: "abort" | "session" | "project" | "global" | "once" | null = null;

        function resolve(action: "abort" | "session" | "project" | "global" | "once") {
          done(action);
        }

        return {
          render(width: number): string[] {
            const lines: string[] = [];
            lines.push(truncateToWidth(theme.fg("warning", title), width));
            lines.push("");

            for (let i = 0; i < options.length; i++) {
              const opt = options[i];
              const isSelected = i === selectedIndex;
              const isPending = pendingAction === opt.action;

              const prefix = isSelected ? " → " : "   ";
              const keyHint = theme.fg("accent", `[${opt.key}]`);
              let label = opt.label;

              if (opt.hint) {
                label += `  ${theme.fg("dim", opt.hint)}`;
              }

              if (isPending) {
                label += `  ${theme.fg("warning", "→ press Enter to confirm")}`;
              }

              const line = `${prefix}${keyHint} ${label}`;
              lines.push(truncateToWidth(line, width));
            }

            lines.push("");
            const hasEsc = options.some((o) => o.key === "esc");
            const abortKeys = hasEsc ? "esc/ctrl+c" : "q/ctrl+c";
            const footer = pendingAction
              ? `↑↓ navigate  enter confirm  ${abortKeys.split("/")[0]} abort`
              : `↑↓ navigate  enter select  ${abortKeys} abort`;
            lines.push(truncateToWidth(theme.fg("dim", footer), width));

            return lines;
          },

          handleInput(data: string): void {
            // NOTE: pi routes ALL keyboard input to this component when focused.
            // App-level keys like Ctrl+O (expand) are NOT processed. Workaround:
            // esc to dismiss, expand tool output, then re-trigger the prompt.

            if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
              resolve("abort");
              return;
            }

            if (matchesKey(data, Key.enter)) {
              if (pendingAction) {
                resolve(pendingAction);
              } else {
                resolve(options[selectedIndex]?.action ?? "abort");
              }
              return;
            }

            if (matchesKey(data, Key.up)) {
              selectedIndex = Math.max(0, selectedIndex - 1);
              pendingAction = null;
              tui.requestRender();
              return;
            }
            if (matchesKey(data, Key.down)) {
              selectedIndex = Math.min(options.length - 1, selectedIndex + 1);
              pendingAction = null;
              tui.requestRender();
              return;
            }

            for (let i = 0; i < options.length; i++) {
              const opt = options[i];
              if (data === opt.key) {
                // Exact case match → immediate
                resolve(opt.action);
                return;
              }
              if (data.toLowerCase() === opt.key.toLowerCase()) {
                // Lowercase match → confirmation required for P/A
                if (opt.confirm) {
                  pendingAction = opt.action;
                  selectedIndex = i;
                } else {
                  resolve(opt.action);
                }
                tui.requestRender();
                return;
              }
            }
          },

          invalidate(): void {
            // no-op
          },
        };
      },
    );

    return result ?? "abort";
  }

  async function promptDomainBlock(
    ctx: ExtensionContext,
    domain: string,
  ): Promise<"abort" | "once" | "session" | "project" | "global"> {
    return showPermissionPrompt(
      ctx,
      `🌐 Network blocked: "${domain}" is not in allowedDomains`,
      PERMISSION_OPTIONS,
    ) as Promise<"abort" | "once" | "session" | "project" | "global">;
  }

  async function promptReadBlock(
    ctx: ExtensionContext,
    filePath: string,
  ): Promise<"abort" | "once" | "session" | "project" | "global"> {
    return showPermissionPrompt(
      ctx,
      `📖 Read blocked: "${filePath}" is not in allowRead`,
      PERMISSION_OPTIONS,
    ) as Promise<"abort" | "once" | "session" | "project" | "global">;
  }

  async function promptWriteBlock(
    ctx: ExtensionContext,
    filePath: string,
  ): Promise<"abort" | "once" | "session" | "project" | "global"> {
    return showPermissionPrompt(
      ctx,
      `📝 Write blocked: "${filePath}" is not in allowWrite`,
      PERMISSION_OPTIONS,
    ) as Promise<"abort" | "once" | "session" | "project" | "global">;
  }

  async function promptBypassBlock(
    ctx: ExtensionContext,
    command: string,
    errorOutput: string,
  ): Promise<"abort" | "once" | "session" | "project" | "global"> {
    const fullCmd = command.trimStart();
    const shortCmd = fullCmd.split(/\s+/).slice(0, 3).join(" ");
    const title =
      `🔓 Sandbox blocked "${shortCmd}${fullCmd.length > shortCmd.length ? "…" : ""}"\n` +
      `Error: ${truncateToWidth(errorOutput, 120)}\n` +
      `Retry unsandboxed?`;
    return showPermissionPrompt(ctx, title, BYPASS_OPTIONS) as Promise<
      "abort" | "once" | "session" | "project" | "global"
    >;
  }

  function warnIfAllDomainsAllowed(ctx: ExtensionContext, config: SandboxConfig): void {
    if (!allowsAllDomains(config.network?.allowedDomains)) return;
    ctx.ui.notify(
      '⚠️ Network sandbox allows all domains because network.allowedDomains contains "*". ' +
        'Only use this intentionally; remove "*" to restore per-domain prompts.',
      "warning",
    );
  }

  // ── Apply allowance choices ─────────────────────────────────────────────────

  async function applyDomainChoice(
    choice: "once" | "session" | "project" | "global",
    domain: string,
    cwd: string,
  ): Promise<void> {
    const { globalPath, projectPath } = getConfigPaths(cwd);
    if (choice !== "once" && !sessionAllowedDomains.includes(domain))
      sessionAllowedDomains.push(domain);
    if (choice === "project") addDomainToConfig(projectPath, domain);
    if (choice === "global") addDomainToConfig(globalPath, domain);
    if (choice === "once") sessionAllowedDomains.push(domain);
    await reinitializeSandbox(cwd);
    if (choice === "once") sessionAllowedDomains.pop();
  }

  async function applyReadChoice(
    choice: "once" | "session" | "project" | "global",
    filePath: string,
    cwd: string,
  ): Promise<void> {
    const { globalPath, projectPath } = getConfigPaths(cwd);
    if (choice !== "once" && !sessionAllowedReadPaths.includes(filePath))
      sessionAllowedReadPaths.push(filePath);
    if (choice === "project") addReadPathToConfig(projectPath, filePath);
    if (choice === "global") addReadPathToConfig(globalPath, filePath);
    if (choice === "once") sessionAllowedReadPaths.push(filePath);
    await reinitializeSandbox(cwd);
    if (choice === "once") sessionAllowedReadPaths.pop();
  }

  async function applyWriteChoice(
    choice: "once" | "session" | "project" | "global",
    filePath: string,
    cwd: string,
  ): Promise<void> {
    const { globalPath, projectPath } = getConfigPaths(cwd);
    if (choice !== "once" && !sessionAllowedWritePaths.includes(filePath))
      sessionAllowedWritePaths.push(filePath);
    if (choice === "project") addWritePathToConfig(projectPath, filePath);
    if (choice === "global") addWritePathToConfig(globalPath, filePath);
    if (choice === "once") sessionAllowedWritePaths.push(filePath);
    await reinitializeSandbox(cwd);
    if (choice === "once") sessionAllowedWritePaths.pop();
  }

  /**
   * Extract a concise error snippet from command output for the bypass prompt.
   */
  function extractErrorSnippet(output: string, maxLen = 80): string {
    const firstLine = output.split(/\r?\n/)[0]?.trim() ?? "";
    if (firstLine.length <= maxLen) return firstLine;
    return firstLine.slice(0, maxLen) + "…";
  }

  // ── Bash tool — reactive bypass, write-block detection and retry ───────────

  pi.registerTool({
    ...localBash,
    label: "bash (sandboxed)",
    async execute(id, params, signal, onUpdate, ctx) {
      const command = (params as { command?: string }).command ?? "";

      const runSandboxed = () => {
        const sandboxedBash = createBashTool(localCwd, {
          operations: createSandboxedBashOps(),
        });
        return sandboxedBash.execute(id, params, signal, onUpdate);
      };

      const runUnsandboxed = () => localBash.execute(id, params, signal, onUpdate);

      // Check user-configured unsandboxed patterns first
      const unsandboxedPatterns = getEffectiveUnsandboxedCommands(ctx.cwd);
      let wasSandboxed = false;
      let result: AgentToolResult<any>;
      if (
        sandboxEnabled &&
        sandboxInitialized &&
        commandIsUnsandboxed(command, unsandboxedPatterns)
      ) {
        const displayCmd =
          command.trimStart().length > 80
            ? command.trimStart().slice(0, 80) + "…"
            : command.trimStart();
        const level = getUnsandboxedCommandLevel(command, ctx.cwd, sessionUnsandboxedCommands);
        ctx.ui.notify(`🔓 Sandbox disabled: "${displayCmd}" (${level} config)`, "warning");
        auditLog({
          timestamp: new Date().toISOString(),
          command: command.trimStart().split(/\s+/).join(" "),
          type: "predictive",
          choice: level,
          unsandboxed: true,
        });
        pi.sendMessage(
          {
            customType: "sandbox-bypass",
            content: `User pre-configured unsandboxed execution of exact command "${displayCmd}" (${level})`,
            display: false,
          },
          {
            deliverAs: "steer",
            triggerTurn: false,
          },
        );
        result = await runUnsandboxed();
      } else if (!sandboxEnabled || !sandboxInitialized) {
        result = await runUnsandboxed();
      } else {
        wasSandboxed = true;
        try {
          result = await runSandboxed();
        } catch (e) {
          if (!(e instanceof Error)) throw e;
          result = {
            content: [
              {
                type: "text",
                text: `Error: Command failed: ${e.message}`,
              },
            ],
            details: { exitCode: 1 },
          };
        }
      }

      // Check for sandbox failure and offer bypass (only if we actually sandboxed)
      if (wasSandboxed && sandboxEnabled && sandboxInitialized && ctx?.hasUI) {
        const outputText = result.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n");
        const exitCode = (result.details as any)?.exitCode ?? 0;
        let bypassAccepted = false;
        const failurePatterns =
          loadConfig(ctx.cwd).sandboxFailurePatterns ?? DEFAULT_FAILURE_PATTERNS;
        if (isSandboxFailure(outputText, failurePatterns) && exitCode !== 0) {
          const choice = await promptBypassBlock(ctx, command, extractErrorSnippet(outputText));

          if (choice === "abort") {
            const displayCmd =
              command.trimStart().length > 80
                ? command.trimStart().slice(0, 80) + "…"
                : command.trimStart();
            ctx.ui.notify(`🛡️  Kept sandboxed: "${displayCmd}"`, "info");
            pi.sendMessage(
              {
                customType: "sandbox-bypass",
                content: `User declined unsandboxed retry of "${displayCmd}"`,
                display: false,
              },
              {
                deliverAs: "steer",
                triggerTurn: false,
              },
            );
            auditLog({
              timestamp: new Date().toISOString(),
              command: command.trimStart().split(/\s+/).join(" "),
              type: "reactive",
              choice: "declined",
              unsandboxed: false,
            });
          } else {
            const displayCmd =
              command.trimStart().length > 80
                ? command.trimStart().slice(0, 80) + "…"
                : command.trimStart();
            const normalized = command.trimStart().split(/\s+/).join(" ");

            if (choice === "session") {
              if (normalized && !sessionUnsandboxedCommands.includes(normalized)) {
                sessionUnsandboxedCommands.push(normalized);
              }
            } else if (choice === "project") {
              addUnsandboxedCommandToConfig(getConfigPaths(ctx.cwd).projectPath, command);
            } else if (choice === "global") {
              addUnsandboxedCommandToConfig(getConfigPaths(ctx.cwd).globalPath, command);
            }

            const bypassLabel =
              choice === "once"
                ? "once"
                : choice === "session"
                  ? "session"
                  : choice === "project"
                    ? "project"
                    : "global";

            ctx.ui.notify(
              `🔓 Retried without sandbox: "${displayCmd}" (exact match, ${bypassLabel})`,
              "warning",
            );

            pi.sendMessage(
              {
                customType: "sandbox-bypass",
                content: `User retried "${displayCmd}" without sandbox (exact match, ${bypassLabel})`,
                display: false,
              },
              {
                deliverAs: "steer",
                triggerTurn: false,
              },
            );
            auditLog({
              timestamp: new Date().toISOString(),
              command: normalized,
              type: "reactive",
              choice: choice,
              unsandboxed: true,
            });

            result = await runUnsandboxed();
            bypassAccepted = true;
          }
        }

        // Also check for OS-level write block (separate from sandbox failure)
        // Skip if bypass was accepted — the unsandboxed retry already handled the write.
        const blockedPath = extractBlockedWritePath(outputText);
        if (blockedPath && !bypassAccepted) {
          const choice = await promptWriteBlock(ctx, blockedPath);
          if (choice !== "abort") {
            await applyWriteChoice(choice, blockedPath, ctx.cwd);
            const level =
              choice === "once"
                ? "once"
                : choice === "session"
                  ? "session"
                  : choice === "project"
                    ? "project"
                    : "global";
            ctx.ui.notify(`📝 Write path "${blockedPath}" allowed (${level})`, "info");
            pi.sendMessage(
              {
                customType: "sandbox-permission",
                content: `User allowed write path "${blockedPath}" (${level})`,
                display: false,
              },
              { deliverAs: "steer", triggerTurn: false },
            );
            auditLog({
              timestamp: new Date().toISOString(),
              command: blockedPath,
              type: "predictive",
              choice: level,
              unsandboxed: false,
            });

            const config = loadConfig(ctx.cwd);
            const { projectPath, globalPath } = getConfigPaths(ctx.cwd);
            if (matchesPattern(blockedPath, config.filesystem?.denyWrite ?? [])) {
              ctx.ui.notify(
                `⚠️ "${blockedPath}" was added to allowWrite, but it is also in denyWrite and will remain blocked.\n` +
                  `Check denyWrite in:\n  ${projectPath}\n  ${globalPath}`,
                "warning",
              );
              return result;
            }

            onUpdate?.({
              content: [
                {
                  type: "text",
                  text: `\n--- Write access granted for "${blockedPath}", retrying ---\n`,
                },
              ],
              details: {},
            });
            result = await runSandboxed();
          }
        }
      }

      return result;
    },
  });

  // ── user_bash — network pre-check + reactive bypass ───────────────────────

  pi.on("user_bash", async (event, ctx) => {
    if (!sandboxEnabled || !sandboxInitialized) return;

    // Network pre-check
    const domains = extractDomainsFromCommand(event.command);
    const effectiveDomains = getEffectiveAllowedDomains(ctx.cwd);
    for (const domain of domains) {
      if (!domainIsAllowed(domain, effectiveDomains)) {
        const choice = await promptDomainBlock(ctx, domain);
        if (choice === "abort") {
          return {
            result: {
              output: `Blocked: "${domain}" is not in allowedDomains. Use /sandbox to review your config.`,
              exitCode: 1,
              cancelled: false,
              truncated: false,
            },
          };
        }
        await applyDomainChoice(choice, domain, ctx.cwd);
        const level =
          choice === "once"
            ? "once"
            : choice === "session"
              ? "session"
              : choice === "project"
                ? "project"
                : "global";
        ctx.ui.notify(`🌐 Domain "${domain}" allowed (${level})`, "info");
        pi.sendMessage(
          {
            customType: "sandbox-permission",
            content: `User allowed domain "${domain}" (${level})`,
            display: false,
          },
          { deliverAs: "steer", triggerTurn: false },
        );
        auditLog({
          timestamp: new Date().toISOString(),
          command: domain,
          type: "predictive",
          choice: level,
          unsandboxed: false,
        });
      }
    }

    // Predictive bypass: user-configured unsandboxed commands
    const unsandboxedPatterns = getEffectiveUnsandboxedCommands(ctx.cwd);
    if (commandIsUnsandboxed(event.command, unsandboxedPatterns)) {
      const displayCmd =
        event.command.trimStart().length > 80
          ? event.command.trimStart().slice(0, 80) + "…"
          : event.command.trimStart();
      const level = getUnsandboxedCommandLevel(event.command, ctx.cwd, sessionUnsandboxedCommands);
      ctx.ui.notify(`🔓 Sandbox disabled: "${displayCmd}" (${level} config)`, "warning");
      auditLog({
        timestamp: new Date().toISOString(),
        command: event.command.trimStart().split(/\s+/).join(" "),
        type: "predictive",
        choice: level,
        unsandboxed: true,
      });
      pi.sendMessage(
        {
          customType: "sandbox-bypass",
          content: `User pre-configured unsandboxed execution of exact command "${displayCmd}" (${level})`,
          display: false,
        },
        {
          deliverAs: "steer",
          triggerTurn: false,
        },
      );
      return; // Let default (unsandboxed) bash run
    }

    // Reactive bypass: run sandboxed first, prompt on failure
    if (!ctx.hasUI) {
      return { operations: createSandboxedBashOps() };
    }

    const sandboxedOps = createSandboxedBashOps();
    let output = "";
    let exitCode = 0;
    let wasSandboxed = true;
    try {
      const execResult = await sandboxedOps.exec(event.command, event.cwd, {
        onData: (chunk) => {
          output += chunk;
        },
      });
      exitCode = execResult.exitCode ?? 1;
    } catch (e) {
      output = e instanceof Error ? e.message : String(e);
      exitCode = 1;
    }

    const failurePatterns = loadConfig(ctx.cwd).sandboxFailurePatterns ?? DEFAULT_FAILURE_PATTERNS;
    if (wasSandboxed && exitCode !== 0 && isSandboxFailure(output, failurePatterns)) {
      const choice = await promptBypassBlock(ctx, event.command, extractErrorSnippet(output));

      if (choice === "abort") {
        const displayCmd =
          event.command.trimStart().length > 80
            ? event.command.trimStart().slice(0, 80) + "…"
            : event.command.trimStart();
        ctx.ui.notify(`🛡️  Kept sandboxed: "${displayCmd}"`, "info");
        pi.sendMessage(
          {
            customType: "sandbox-bypass",
            content: `User declined unsandboxed retry of "${displayCmd}"`,
            display: false,
          },
          {
            deliverAs: "steer",
            triggerTurn: false,
          },
        );
        auditLog({
          timestamp: new Date().toISOString(),
          command: event.command.trimStart().split(/\s+/).join(" "),
          type: "reactive",
          choice: "declined",
          unsandboxed: false,
        });
      } else {
        const normalized = event.command.trimStart().split(/\s+/).join(" ");
        if (
          choice === "session" &&
          normalized &&
          !sessionUnsandboxedCommands.includes(normalized)
        ) {
          sessionUnsandboxedCommands.push(normalized);
        } else if (choice === "project") {
          addUnsandboxedCommandToConfig(getConfigPaths(ctx.cwd).projectPath, event.command);
        } else if (choice === "global") {
          addUnsandboxedCommandToConfig(getConfigPaths(ctx.cwd).globalPath, event.command);
        }

        const bypassLabel =
          choice === "once"
            ? "once"
            : choice === "session"
              ? "session"
              : choice === "project"
                ? "project"
                : "global";
        const displayCmd =
          event.command.trimStart().length > 80
            ? event.command.trimStart().slice(0, 80) + "…"
            : event.command.trimStart();

        ctx.ui.notify(
          `🔓 Retried without sandbox: "${displayCmd}" (exact match, ${bypassLabel})`,
          "warning",
        );

        pi.sendMessage(
          {
            customType: "sandbox-bypass",
            content: `User retried "${displayCmd}" without sandbox (exact match, ${bypassLabel})`,
            display: false,
          },
          {
            deliverAs: "steer",
            triggerTurn: false,
          },
        );
        auditLog({
          timestamp: new Date().toISOString(),
          command: normalized,
          type: "reactive",
          choice: choice,
          unsandboxed: true,
        });

        // Rerun unsandboxed
        const localOps = createLocalBashOperations();
        output = "";
        try {
          const execResult = await localOps.exec(event.command, event.cwd, {
            onData: (chunk) => {
              output += chunk;
            },
          });
          exitCode = execResult.exitCode ?? 1;
        } catch (e) {
          output = e instanceof Error ? e.message : String(e);
          exitCode = 1;
        }
      }
    }

    return {
      result: {
        output,
        exitCode,
        cancelled: false,
        truncated: false,
      },
    };
  });

  // ── tool_call — network pre-check for bash, path policy for read/write/edit

  pi.on("tool_call", async (event, ctx) => {
    if (!sandboxEnabled) return;

    const config = loadConfig(ctx.cwd);
    if (!config.enabled) return;

    const { projectPath, globalPath } = getConfigPaths(ctx.cwd);

    // Network pre-check for bash tool calls.
    if (sandboxInitialized && isToolCallEventType("bash", event)) {
      const domains = extractDomainsFromCommand(event.input.command);
      const effectiveDomains = getEffectiveAllowedDomains(ctx.cwd);
      for (const domain of domains) {
        if (!domainIsAllowed(domain, effectiveDomains)) {
          const choice = await promptDomainBlock(ctx, domain);
          if (choice === "abort") {
            return {
              block: true,
              reason: `Network access to "${domain}" is blocked (not in allowedDomains).`,
            };
          }
          await applyDomainChoice(choice, domain, ctx.cwd);
          const level =
            choice === "once"
              ? "once"
              : choice === "session"
                ? "session"
                : choice === "project"
                  ? "project"
                  : "global";
          ctx.ui.notify(`🌐 Domain "${domain}" allowed (${level})`, "info");
          pi.sendMessage(
            {
              customType: "sandbox-permission",
              content: `User allowed domain "${domain}" (${level})`,
              display: false,
            },
            { deliverAs: "steer", triggerTurn: false },
          );
          auditLog({
            timestamp: new Date().toISOString(),
            command: domain,
            type: "predictive",
            choice: level,
            unsandboxed: false,
          });
        }
      }
    }

    // Path policy: read tool.
    //   - If the path is already in effectiveAllowRead, allow silently.
    //   - Otherwise always prompt, regardless of denyRead.
    //   - Granting (session or permanent) adds to allowRead, which overrides denyRead.
    //   - denyRead is never a hard-block on its own — it just sets the default
    //     denied state that the prompt can override.
    if (isToolCallEventType("read", event)) {
      const filePath = event.input.path;
      const effectiveAllowRead = getEffectiveAllowRead(ctx.cwd);

      if (!matchesPattern(filePath, effectiveAllowRead)) {
        const choice = await promptReadBlock(ctx, filePath);
        if (choice === "abort") {
          return {
            block: true,
            reason: `Sandbox: read access denied for "${filePath}"`,
          };
        }
        await applyReadChoice(choice, filePath, ctx.cwd);
        const level =
          choice === "once"
            ? "once"
            : choice === "session"
              ? "session"
              : choice === "project"
                ? "project"
                : "global";
        ctx.ui.notify(`📖 Read path "${filePath}" allowed (${level})`, "info");
        pi.sendMessage(
          {
            customType: "sandbox-permission",
            content: `User allowed read path "${filePath}" (${level})`,
            display: false,
          },
          { deliverAs: "steer", triggerTurn: false },
        );
        auditLog({
          timestamp: new Date().toISOString(),
          command: filePath,
          type: "predictive",
          choice: level,
          unsandboxed: false,
        });
        // Allowed — fall through, tool runs.
        return;
      }
    }

    // Path policy: write/edit — prompt for allowWrite, hard-block for denyWrite.
    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      const path = (event.input as { path: string }).path;
      const allowWrite = getEffectiveAllowWrite(ctx.cwd);
      const denyWrite = config.filesystem?.denyWrite ?? [];

      if (shouldPromptForWrite(path, allowWrite, matchesPattern)) {
        const choice = await promptWriteBlock(ctx, path);
        if (choice === "abort") {
          return {
            block: true,
            reason: `Sandbox: write access denied for "${path}" (not in allowWrite)`,
          };
        }
        await applyWriteChoice(choice, path, ctx.cwd);
        const level =
          choice === "once"
            ? "once"
            : choice === "session"
              ? "session"
              : choice === "project"
                ? "project"
                : "global";
        ctx.ui.notify(`📝 Write path "${path}" allowed (${level})`, "info");
        pi.sendMessage(
          {
            customType: "sandbox-permission",
            content: `User allowed write path "${path}" (${level})`,
            display: false,
          },
          { deliverAs: "steer", triggerTurn: false },
        );
        auditLog({
          timestamp: new Date().toISOString(),
          command: path,
          type: "predictive",
          choice: level,
          unsandboxed: false,
        });

        // denyWrite takes precedence — warn if it would still block.
        if (matchesPattern(path, denyWrite)) {
          ctx.ui.notify(
            `⚠️ "${path}" was added to allowWrite, but it is also in denyWrite and will remain blocked.\n` +
              `Check denyWrite in:\n  ${projectPath}\n  ${globalPath}`,
            "warning",
          );
          return {
            block: true,
            reason: `Sandbox: write access denied for "${path}" (also in denyWrite)`,
          };
        }

        // Allowed — fall through, tool runs.
        return;
      }

      if (matchesPattern(path, denyWrite)) {
        return {
          block: true,
          reason:
            `Sandbox: write access denied for "${path}" (in denyWrite). ` +
            `To change this, edit denyWrite in:\n  ${projectPath}\n  ${globalPath}`,
        };
      }
    }
  });

  // ── session_start — restore persisted state, then init sandbox ────────────

  pi.on("session_start", async (_event, ctx) => {
    // Restore session allowances from previous execution (survives reload)
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "sandbox-session") {
        const data = entry.data as {
          sessionAllowedDomains?: string[];
          sessionAllowedReadPaths?: string[];
          sessionAllowedWritePaths?: string[];
          sessionUnsandboxedCommands?: string[];
        };
        if (data.sessionAllowedDomains) {
          sessionAllowedDomains.length = 0;
          sessionAllowedDomains.push(...data.sessionAllowedDomains);
        }
        if (data.sessionAllowedReadPaths) {
          sessionAllowedReadPaths.length = 0;
          sessionAllowedReadPaths.push(...data.sessionAllowedReadPaths);
        }
        if (data.sessionAllowedWritePaths) {
          sessionAllowedWritePaths.length = 0;
          sessionAllowedWritePaths.push(...data.sessionAllowedWritePaths);
        }
        if (data.sessionUnsandboxedCommands) {
          sessionUnsandboxedCommands.length = 0;
          sessionUnsandboxedCommands.push(...data.sessionUnsandboxedCommands);
        }
      }
    }

    const noSandbox = pi.getFlag("no-sandbox") as boolean;

    if (noSandbox) {
      sandboxEnabled = false;
      ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
      return;
    }

    const config = loadConfig(ctx.cwd);

    if (!config.enabled) {
      sandboxEnabled = false;
      ctx.ui.notify("Sandbox disabled via config", "info");
      return;
    }

    const platform = process.platform;
    if (platform !== "darwin" && platform !== "linux") {
      sandboxEnabled = false;
      ctx.ui.notify(`Sandbox not supported on ${platform}`, "warning");
      return;
    }

    try {
      const configExt = config as unknown as {
        ignoreViolations?: Record<string, string[]>;
        enableWeakerNestedSandbox?: boolean;
        allowBrowserProcess?: boolean;
      };

      await SandboxManager.initialize(
        {
          network: config.network,
          filesystem: config.filesystem,
          ignoreViolations: configExt.ignoreViolations,
          enableWeakerNestedSandbox: configExt.enableWeakerNestedSandbox,
          allowBrowserProcess: configExt.allowBrowserProcess,
          enableWeakerNetworkIsolation: true,
        },
        createNetworkAskCallback(config.network?.allowedDomains ?? []),
      );

      // Make Node's built-in fetch() honour HTTP_PROXY / HTTPS_PROXY in this
      // process and any child processes that inherit the environment.
      // NODE_USE_ENV_PROXY avoids NODE_OPTIONS allowlisting issues on older Node
      // versions while still propagating naturally to child `node` processes.
      // fetch() supports this on Node 22.21.0+ and 24.0.0+.
      const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
      const supportsEnvProxy = (nodeMajor === 22 && nodeMinor >= 21) || nodeMajor >= 24;
      if (supportsEnvProxy) {
        process.env.NODE_USE_ENV_PROXY ??= "1";
      }

      sandboxEnabled = true;
      sandboxInitialized = true;

      warnIfAllDomainsAllowed(ctx, config);

      const networkLabel = allowsAllDomains(config.network?.allowedDomains)
        ? "all domains"
        : `${config.network?.allowedDomains?.length ?? 0} domains`;
      const writeCount = config.filesystem?.allowWrite?.length ?? 0;
      ctx.ui.setStatus(
        "sandbox",
        ctx.ui.theme.fg("accent", `🔒 Sandbox: ${networkLabel}, ${writeCount} write paths`),
      );
    } catch (err) {
      sandboxEnabled = false;
      ctx.ui.notify(
        `Sandbox initialization failed: ${err instanceof Error ? err.message : err}`,
        "error",
      );
    }
  });

  // ── session_shutdown — persist + cleanup ────────────────────────────────────

  pi.on("session_shutdown", async () => {
    // Save session allowances so they survive reload
    if (
      sessionAllowedDomains.length > 0 ||
      sessionAllowedReadPaths.length > 0 ||
      sessionAllowedWritePaths.length > 0 ||
      sessionUnsandboxedCommands.length > 0
    ) {
      await pi.appendEntry("sandbox-session", {
        sessionAllowedDomains: [...sessionAllowedDomains],
        sessionAllowedReadPaths: [...sessionAllowedReadPaths],
        sessionAllowedWritePaths: [...sessionAllowedWritePaths],
        sessionUnsandboxedCommands: [...sessionUnsandboxedCommands],
      });
    }
    sessionAllowedDomains.length = 0;
    sessionAllowedReadPaths.length = 0;
    sessionAllowedWritePaths.length = 0;
    sessionUnsandboxedCommands.length = 0;
    if (sandboxInitialized) {
      try {
        await SandboxManager.reset();
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  // ── /sandbox command ────────────────────────────────────────────────────────

  pi.registerCommand("sandbox-enable", {
    description: "Enable the sandbox for this session",
    handler: async (_args, ctx) => {
      if (sandboxEnabled) {
        ctx.ui.notify("Sandbox is already enabled", "info");
        return;
      }

      const config = loadConfig(ctx.cwd);
      const platform = process.platform;
      if (platform !== "darwin" && platform !== "linux") {
        ctx.ui.notify(`Sandbox not supported on ${platform}`, "warning");
        return;
      }

      try {
        const configExt = config as unknown as {
          ignoreViolations?: Record<string, string[]>;
          enableWeakerNestedSandbox?: boolean;
          allowBrowserProcess?: boolean;
        };

        await SandboxManager.initialize(
          {
            network: config.network,
            filesystem: config.filesystem,
            ignoreViolations: configExt.ignoreViolations,
            enableWeakerNestedSandbox: configExt.enableWeakerNestedSandbox,
            allowBrowserProcess: configExt.allowBrowserProcess,
            enableWeakerNetworkIsolation: true,
          },
          createNetworkAskCallback(config.network?.allowedDomains ?? []),
        );

        sandboxEnabled = true;
        sandboxInitialized = true;

        warnIfAllDomainsAllowed(ctx, config);

        const networkLabel = allowsAllDomains(config.network?.allowedDomains)
          ? "all domains"
          : `${config.network?.allowedDomains?.length ?? 0} domains`;
        const writeCount = config.filesystem?.allowWrite?.length ?? 0;
        ctx.ui.setStatus(
          "sandbox",
          ctx.ui.theme.fg("accent", `🔒 Sandbox: ${networkLabel}, ${writeCount} write paths`),
        );
        ctx.ui.notify("Sandbox enabled", "info");
      } catch (err) {
        ctx.ui.notify(
          `Sandbox initialization failed: ${err instanceof Error ? err.message : err}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("sandbox-disable", {
    description: "Disable the sandbox for this session",
    handler: async (_args, ctx) => {
      if (!sandboxEnabled) {
        ctx.ui.notify("Sandbox is already disabled", "info");
        return;
      }

      if (sandboxInitialized) {
        try {
          await SandboxManager.reset();
        } catch {
          // Ignore cleanup errors
        }
      }

      sessionAllowedDomains.length = 0;
      sessionAllowedReadPaths.length = 0;
      sessionAllowedWritePaths.length = 0;
      sessionUnsandboxedCommands.length = 0;
      sandboxEnabled = false;
      sandboxInitialized = false;
      ctx.ui.setStatus("sandbox", "");
      ctx.ui.notify("Sandbox disabled", "info");
    },
  });

  pi.registerCommand("sandbox", {
    description: "Show sandbox configuration",
    handler: async (_args, ctx) => {
      if (!sandboxEnabled) {
        ctx.ui.notify("Sandbox is disabled", "info");
        return;
      }

      const config = loadConfig(ctx.cwd);
      const { globalPath, projectPath } = getConfigPaths(ctx.cwd);

      const lines = [
        "Sandbox Configuration",
        `  Project config: ${projectPath}`,
        `  Global config:  ${globalPath}`,
        "",
        "Network (bash + !cmd):",
        `  Allowed domains: ${config.network?.allowedDomains?.join(", ") || "(none)"}`,
        ...(allowsAllDomains(config.network?.allowedDomains)
          ? ['  ⚠️ "*" allows all domains and disables per-domain prompts.']
          : []),
        `  Denied domains:  ${config.network?.deniedDomains?.join(", ") || "(none)"}`,
        ...(sessionAllowedDomains.length > 0
          ? [`  Session allowed: ${sessionAllowedDomains.join(", ")}`]
          : []),
        "",
        "Filesystem (bash + read/write/edit tools):",
        `  Deny Read:   ${config.filesystem?.denyRead?.join(", ") || "(none)"}`,
        `  Allow Read:  ${config.filesystem?.allowRead?.join(", ") || "(none)"}`,
        `  Allow Write: ${config.filesystem?.allowWrite?.join(", ") || "(none)"}`,
        `  Deny Write:  ${config.filesystem?.denyWrite?.join(", ") || "(none)"}`,
        ...(sessionAllowedReadPaths.length > 0
          ? [`  Session read:  ${sessionAllowedReadPaths.join(", ")}`]
          : []),
        ...(sessionAllowedWritePaths.length > 0
          ? [`  Session write: ${sessionAllowedWritePaths.join(", ")}`]
          : []),
        ...(sessionUnsandboxedCommands.length > 0
          ? [`  Session unsandboxed: ${sessionUnsandboxedCommands.join(", ")}`]
          : []),
        `  Unsandboxed:   ${config.unsandboxedCommands?.join(", ") || "(none)"}`,
        `  Failure patterns: ${(config.sandboxFailurePatterns ?? DEFAULT_FAILURE_PATTERNS).join(", ")}`,

        "",
        "Note: ALL reads are prompted unless the path is already in allowRead.",
        "Note: denyRead is not a hard-block — granting a prompt adds to allowRead, overriding denyRead.",
        "Note: denyWrite takes PRECEDENCE over allowWrite and is never prompted.",
        "Note: Reactive bypass detects sandbox/auth failures in output. Add custom patterns via sandboxFailurePatterns config.",
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("sandbox-debug", {
    description: "Debug sandbox config loading",
    handler: async (_args, ctx) => {
      const config = loadConfig(ctx.cwd);
      const { globalPath, projectPath } = getConfigPaths(ctx.cwd);

      const lines = [
        "Sandbox Debug",
        `  cwd: ${ctx.cwd}`,
        `  projectPath: ${projectPath}`,
        `  globalPath: ${globalPath}`,
        `  project exists: ${existsSync(projectPath)}`,
        `  global exists: ${existsSync(globalPath)}`,
        "",
        "Loaded config:",
        `  enabled: ${config.enabled}`,
        `  unsandboxedCommands: ${JSON.stringify(config.unsandboxedCommands)}`,
        `  sandboxFailurePatterns: ${JSON.stringify(config.sandboxFailurePatterns)}`,
        "",
        "Session state:",
        `  sessionUnsandboxedCommands: ${JSON.stringify(sessionUnsandboxedCommands)}`,
        "",
        "Test match:",
      ];

      const testCmd = 'security find-generic-password -s "test" 2>&1 | head -3';
      const normalized = testCmd.trimStart().split(/\s+/).join(" ");
      const patterns = getEffectiveUnsandboxedCommands(ctx.cwd);
      lines.push(`  test command: ${testCmd}`);
      lines.push(`  normalized: ${normalized}`);
      lines.push(`  patterns: ${JSON.stringify(patterns)}`);
      lines.push(`  match: ${commandIsUnsandboxed(testCmd, patterns)}`);

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
