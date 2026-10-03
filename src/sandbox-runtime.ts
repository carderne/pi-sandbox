import type { ISandboxManager, SandboxRuntimeConfig } from "@carderne/sandbox-runtime";

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type BashOperations, getShellConfig } from "@earendil-works/pi-coding-agent";

import { type SandboxConfig } from "./config.ts";
import { canonicalizePath } from "./policy.ts";

export interface SessionAllowances {
  domains: string[];
  readPaths: string[];
  writePaths: string[];
}

export interface EffectiveAllowances {
  domains: string[];
  readPaths: string[];
  writePaths: string[];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

const canonicalizeFilesystemPattern = (path: string) =>
  path.includes("*") ? path : canonicalizePath(path);

const canonicalizeFilesystemPatterns = (paths: string[]) =>
  unique(paths.map(canonicalizeFilesystemPattern));

function sandboxRuntimeReadPaths(platform: NodeJS.Platform): string[] {
  if (platform !== "linux") return [];

  // apply-seccomp executes inside the Bubblewrap namespace, so broad rules
  // such as denyRead: ["/home"] must not hide the runtime's bundled helper.
  const runtimeEntryUrl = import.meta.resolve("@carderne/sandbox-runtime");
  return [fileURLToPath(new URL("../vendor/seccomp", runtimeEntryUrl))];
}

export function resolveAllowances(
  config: SandboxConfig,
  allowances?: SessionAllowances,
): EffectiveAllowances {
  const writePaths = unique([
    ...(config.filesystem?.allowWrite ?? []),
    ...(allowances?.writePaths ?? []),
  ]);

  return {
    domains: unique([...(config.network?.allowedDomains ?? []), ...(allowances?.domains ?? [])]),
    readPaths: unique([
      ...(config.filesystem?.allowRead ?? []),
      ...(allowances?.readPaths ?? []),
      ...writePaths,
    ]),
    writePaths,
  };
}

export function buildRuntimeConfig(
  config: SandboxConfig,
  allowances?: SessionAllowances,
  platform: NodeJS.Platform = process.platform,
): SandboxRuntimeConfig {
  const effective = resolveAllowances(config, allowances);

  return {
    network: {
      ...config.network,
      allowedDomains: effective.domains,
      deniedDomains: config.network?.deniedDomains ?? [],
    },
    filesystem: {
      disabled: config.filesystem?.disabled,
      denyRead: canonicalizeFilesystemPatterns(config.filesystem?.denyRead ?? []),
      allowRead: canonicalizeFilesystemPatterns([
        ...effective.readPaths,
        ...sandboxRuntimeReadPaths(platform),
      ]),
      allowWrite: canonicalizeFilesystemPatterns(effective.writePaths),
      denyWrite: canonicalizeFilesystemPatterns(config.filesystem?.denyWrite ?? []),
    },
    ignoreViolations: config.ignoreViolations,
    enableWeakerNestedSandbox: config.enableWeakerNestedSandbox,
    allowBrowserProcess: config.allowBrowserProcess,
    allowPty: config.allowPty,
    enableWeakerNetworkIsolation: true,
  };
}

export async function initializeSandbox(
  manager: ISandboxManager,
  config: SandboxConfig,
  allowances?: SessionAllowances,
): Promise<void> {
  const runtimeConfig = buildRuntimeConfig(config, allowances);
  // The runtime checks its live allowlist. Permission prompts happen before
  // execution; a callback capturing this initial list could re-allow removed domains.
  await manager.initialize(runtimeConfig);
}

export function updateSandboxConfig(
  manager: ISandboxManager,
  config: SandboxConfig,
  allowances: SessionAllowances,
): void {
  // Permission updates must not tear down the proxy used by concurrent commands.
  // Network rules apply immediately; new commands pick up filesystem rules when wrapped.
  manager.updateConfig(buildRuntimeConfig(config, allowances));
}

export function supportsNodeEnvProxy(version: string): boolean {
  const [major, minor] = version.split(".").map(Number);
  return (major === 22 && minor >= 21) || major >= 24;
}

export const SANDBOX_WRITE_DENY_RE = /Operation not permitted|Read-only file system/;

// Some locales (e.g. en_US.UTF-8 coreutils mkdir) print Unicode curly quotes;
// others print ASCII. Strip both.
const QUOTES_RE = /^[\u2018\u2019\u201c\u201d'"`]+|[\u2018\u2019\u201c\u201d'"`]+$/g;

function stripQuotes(token: string): string {
  return token.replace(QUOTES_RE, "");
}

function looksLikePath(token: string): boolean {
  return token.includes("/") || token.startsWith("~") || token.startsWith(".");
}

function extractPathFromDenyLine(line: string): string | null {
  const deny = line.match(SANDBOX_WRITE_DENY_RE);
  if (!deny) return null;
  const prefix = line
    .slice(0, deny.index)
    .replace(/[\s:]+$/, "")
    .trim();
  // Last quoted span first — it may contain spaces that token splitting would break.
  const quoted = [
    ...prefix.matchAll(/[\u2018\u201c'"`]([^\u2019\u201d'"`]+)[\u2019\u201d'"`]/g),
  ].at(-1);
  if (quoted) return quoted[1];
  const last = prefix.split(/\s+/).pop() ?? "";
  const token = stripQuotes(last);
  return token && looksLikePath(token) ? token : null;
}

function findLastDenyLine(output: string): string | null {
  const lines = output.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (SANDBOX_WRITE_DENY_RE.test(lines[i])) return lines[i];
  }
  return null;
}

/** Last path token (quoted, absolute, or relative) on the final write-deny line. */
export function extractBlockedWritePath(output: string): string | null {
  const line = findLastDenyLine(output);
  return line ? extractPathFromDenyLine(line) : null;
}

const GIT_DIAGNOSTIC_RE = /^\s*(?:fatal|error|git):/;

/** True when the final write-deny line is a Git diagnostic, not the shell's. */
export function blockedWriteIsFromGit(output: string): boolean {
  const line = findLastDenyLine(output);
  return line !== null && GIT_DIAGNOSTIC_RE.test(line);
}

/**
 * Cwd a blocked relative path resolves against. `cd` folds persistently; `git -C`
 * (when applyGitC) applies only to the last command segment. Heuristic: skipped
 * branches, subshells, and shell redirects are not modeled.
 */
export function effectiveCommandCwd(command: string, baseCwd: string, applyGitC = true): string {
  let cwd = baseCwd;
  for (const match of command.matchAll(/(?:^|[;&|(]\s*|\s+)cd\s+("[^"]*"|'[^']*'|[^\s;&|)]+)/g)) {
    cwd = foldTarget(match[1], cwd);
  }
  const lastSegment = command.split(/\s*(?:&&|\|\||[;&|])\s*/).pop() ?? "";
  const gitC = [
    ...lastSegment.matchAll(
      /\bgit\s+(?:-[A-Za-z0-9]+(?:\s+\S+)?\s+)*-C\s+("[^"]*"|'[^']*'|[^\s;&|)]+)/g,
    ),
  ].at(-1);
  if (applyGitC && gitC) cwd = foldTarget(gitC[1], cwd);
  return cwd;
}

function foldTarget(raw: string, cwd: string): string {
  const target = stripQuotes(raw);
  const expanded = target.replace(/^~(?=$|\/)/, homedir());
  if (target && (isAbsolute(expanded) || expanded === "-")) {
    return expanded === "-" ? cwd : expanded;
  }
  if (target) return resolve(cwd, expanded);
  return cwd;
}

/** Resolve a blocked path (possibly relative or ~-prefixed) against the command's cwd. */
export function resolveBlockedPath(path: string, commandCwd: string): string {
  const expanded = path.replace(/^~(?=$|\/)/, homedir());
  return isAbsolute(expanded) ? expanded : resolve(commandCwd, expanded);
}

const EXIT_STDIO_GRACE_MS = 100;

/**
 * Wait for a child process to exit without hanging on inherited stdio handles.
 *
 * After exit, keep reading while output is active. If a detached descendant
 * holds the pipes open but leaves them idle, release them after a short grace.
 */
function waitForChildProcess(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let postExitTimer: NodeJS.Timeout | undefined;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;

    const cleanup = () => {
      if (postExitTimer) {
        clearTimeout(postExitTimer);
        postExitTimer = undefined;
      }
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
    };

    const finalize = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(code);
    };

    const maybeFinalizeAfterExit = () => {
      if (!exited || settled) return;
      if (stdoutEnded && stderrEnded) finalize(exitCode);
    };

    const armIdleTimer = () => {
      if (postExitTimer) clearTimeout(postExitTimer);
      postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
    };

    const onData = () => {
      if (exited && !settled) armIdleTimer();
    };

    const onStdoutEnd = () => {
      stdoutEnded = true;
      maybeFinalizeAfterExit();
    };

    const onStderrEnd = () => {
      stderrEnded = true;
      maybeFinalizeAfterExit();
    };

    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onExit = (code: number | null) => {
      exited = true;
      exitCode = code;
      maybeFinalizeAfterExit();
      if (!settled) armIdleTimer();
    };

    const onClose = (code: number | null) => {
      finalize(code);
    };

    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

export function createSandboxedBashOps(
  manager: ISandboxManager,
  shellPath?: string,
  sshProxy = true,
): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);

      const { shell, args } = getShellConfig(shellPath);

      // OpenSSH does not honor ALL_PROXY, unlike most of the tools that use
      // the sandbox network proxy. Install a shell function so ordinary
      // `ssh host` commands use the runtime's local SOCKS proxy too. This is
      // deliberately opt-in at the config layer, but enabled by default.
      const socksProxyPort = sshProxy ? manager.getSocksProxyPort() : undefined;
      const sshProxyCommand =
        process.platform === "darwin" && socksProxyPort !== undefined
          ? `ssh() { /usr/bin/ssh -o 'ProxyCommand=/usr/bin/nc -X 5 -x localhost:${socksProxyPort} %h %p' "$@"; }; `
          : "";
      const wrappedCommand = await manager.wrapWithSandbox(`${sshProxyCommand}${command}`, shell);

      const child = spawn(shell, [...args, wrappedCommand], {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;

      const killProcessGroup = () => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };

      if (timeout !== undefined && timeout > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          killProcessGroup();
        }, timeout * 1000);
      }

      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      signal?.addEventListener("abort", killProcessGroup, { once: true });

      try {
        const exitCode = await waitForChildProcess(child);
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        return { exitCode };
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        signal?.removeEventListener("abort", killProcessGroup);
        manager.cleanupAfterCommand();
      }
    },
  };
}
