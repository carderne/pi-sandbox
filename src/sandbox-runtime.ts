import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

import {
  SandboxManager,
  type SandboxAskCallback,
  type SandboxAttemptDescriptor,
  type SandboxRuntimeConfig,
} from "@carderne/sandbox-runtime";
import { type BashOperations, getShellConfig } from "@earendil-works/pi-coding-agent";

import {
  type FinishedSandboxProcessAttempt,
  type SandboxAttemptObservation,
} from "./bash-sandbox-denials.ts";
import { type SandboxConfig } from "./config.ts";
import { canonicalizePath, domainIsAllowed } from "./policy.ts";

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

let currentAllowedDomains: readonly string[] = [];

const networkAskCallback: SandboxAskCallback = async ({ host }) =>
  domainIsAllowed(host, currentAllowedDomains);

export function buildRuntimeConfig(
  config: SandboxConfig,
  allowances?: SessionAllowances,
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
      allowRead: canonicalizeFilesystemPatterns(effective.readPaths),
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
  config: SandboxConfig,
  allowances?: SessionAllowances,
): Promise<void> {
  const runtimeConfig = buildRuntimeConfig(config, allowances);
  currentAllowedDomains = [...(runtimeConfig.network?.allowedDomains ?? [])];
  await SandboxManager.initialize(runtimeConfig, networkAskCallback, true);
}

export function updateSandboxConfig(config: SandboxConfig, allowances?: SessionAllowances): void {
  const nextRuntimeConfig = buildRuntimeConfig(config, allowances);
  SandboxManager.updateConfig(nextRuntimeConfig);
  currentAllowedDomains = [...(nextRuntimeConfig.network?.allowedDomains ?? [])];
}

export function supportsNodeEnvProxy(version: string): boolean {
  const [major, minor] = version.split(".").map(Number);
  return (major === 22 && minor >= 21) || major >= 24;
}

export function extractBlockedWritePath(output: string): string | null {
  const match = output.match(
    /(?:\/bin\/bash|bash|sh): (?:line \d: )?(\/[^\s:]+): Operation not permitted/,
  );
  return match ? match[1] : null;
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

function createSshProxyCommand(sshProxy: boolean): string {
  const socksProxyPort = sshProxy ? SandboxManager.getSocksProxyPort() : undefined;
  return process.platform === "darwin" && socksProxyPort !== undefined
    ? `ssh() { /usr/bin/ssh -o 'ProxyCommand=/usr/bin/nc -X 5 -x localhost:${socksProxyPort} %h %p' "$@"; }; `
    : "";
}

function killProcessGroup(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

export function createSandboxedBashOps(shellPath?: string, sshProxy = true): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);

      const { shell, args } = getShellConfig(shellPath);

      const wrappedCommand = await SandboxManager.wrapWithSandbox(
        `${createSshProxyCommand(sshProxy)}${command}`,
        shell,
      );

      const child = spawn(shell, [...args, wrappedCommand], {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;

      const kill = () => killProcessGroup(child);

      if (timeout !== undefined && timeout > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          kill();
        }, timeout * 1000);
      }

      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      signal?.addEventListener("abort", kill, { once: true });

      try {
        const exitCode = await waitForChildProcess(child);
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        return { exitCode };
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        signal?.removeEventListener("abort", kill);
        SandboxManager.cleanupAfterCommand();
      }
    },
  };
}

export interface AttributedSandboxedBashOps {
  operations: BashOperations;
  finished: Promise<FinishedSandboxProcessAttempt>;
}

export function createAttributedSandboxedBashOps(
  shellPath?: string,
  sshProxy = true,
): AttributedSandboxedBashOps {
  let resolveFinished!: (value: FinishedSandboxProcessAttempt) => void;
  let rejectFinished!: (reason: unknown) => void;
  const finished = new Promise<FinishedSandboxProcessAttempt>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });
  void finished.catch(() => {});

  const operations: BashOperations = {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      let descriptor: SandboxAttemptDescriptor;
      try {
        if (!existsSync(cwd)) {
          throw new Error(`Working directory does not exist: ${cwd}`);
        }
        const { shell } = getShellConfig(shellPath);
        descriptor = await SandboxManager.prepareSandboxAttempt({
          command: `${createSshProxyCommand(sshProxy)}${command}`,
          binShell: shell,
          abortSignal: signal,
          cwd,
          env,
        });
      } catch (error) {
        rejectFinished(error);
        throw error;
      }

      const finalize = async (observation: SandboxAttemptObservation) => {
        SandboxManager.cleanupAfterCommand();
        try {
          const result = await SandboxManager.finishSandboxAttempt(descriptor.attempt);
          const value = { observation, denials: result.denials };
          resolveFinished(value);
          return value;
        } catch (error) {
          rejectFinished(error);
          throw error;
        }
      };

      if (signal?.aborted) {
        await finalize({
          sandboxBackend: descriptor.sandboxBackend,
          exitCode: null,
          signal: null,
          termination: "aborted",
        });
        throw new Error("aborted");
      }

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(descriptor.argv[0], descriptor.argv.slice(1), {
          cwd,
          env: descriptor.env,
          shell: false,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        await finalize({
          sandboxBackend: descriptor.sandboxBackend,
          exitCode: null,
          signal: null,
          termination: "spawn-error",
        });
        throw error;
      }

      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      let closeSignal: NodeJS.Signals | null = null;
      const kill = () => killProcessGroup(child);
      const recordSignal = (_exitCode: number | null, signal: NodeJS.Signals | null) => {
        closeSignal = signal;
      };

      if (timeout !== undefined && timeout > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          kill();
        }, timeout * 1000);
      }
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.once("exit", recordSignal);
      signal?.addEventListener("abort", kill, { once: true });

      let exitCode: number | null = null;
      let spawnError: unknown;
      try {
        exitCode = await waitForChildProcess(child);
      } catch (error) {
        spawnError = error;
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        child.removeListener("exit", recordSignal);
        signal?.removeEventListener("abort", kill);
      }

      const commandAborted = signal?.aborted ?? false;
      const commandTimedOut = timedOut;
      const commandSignal = closeSignal;
      const termination: SandboxAttemptObservation["termination"] = commandAborted
        ? "aborted"
        : commandTimedOut
          ? "timeout"
          : spawnError
            ? "spawn-error"
            : commandSignal
              ? "signal"
              : "exit";
      await finalize({
        sandboxBackend: descriptor.sandboxBackend,
        exitCode,
        signal: commandSignal,
        termination,
      });
      if (commandAborted) throw new Error("aborted");
      if (commandTimedOut) throw new Error(`timeout:${timeout}`);
      if (spawnError) throw spawnError;
      return { exitCode };
    },
  };
  return { operations, finished };
}
