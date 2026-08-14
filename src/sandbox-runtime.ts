import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import {
  SandboxManager,
  type SandboxAskCallback,
  type SandboxRuntimeConfig,
} from "@carderne/sandbox-runtime";
import { type BashOperations, getShellConfig } from "@earendil-works/pi-coding-agent";

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

export function createNetworkAskCallback(allowedDomains: string[]): SandboxAskCallback {
  return async ({ host }) => domainIsAllowed(host, allowedDomains);
}

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
    enableWeakerNetworkIsolation: true,
  };
}

export async function initializeSandbox(
  config: SandboxConfig,
  allowances?: SessionAllowances,
): Promise<void> {
  const runtimeConfig = buildRuntimeConfig(config, allowances);
  await SandboxManager.initialize(
    runtimeConfig,
    createNetworkAskCallback(runtimeConfig.network?.allowedDomains ?? []),
  );
}

export async function reinitializeSandbox(
  config: SandboxConfig,
  allowances: SessionAllowances,
): Promise<void> {
  await SandboxManager.reset();
  await initializeSandbox(config, allowances);
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

export function createSandboxedBashOps(shellPath?: string, sshProxy = true): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);

      const { shell, args } = getShellConfig(shellPath);

      // OpenSSH does not honor ALL_PROXY, unlike most of the tools that use
      // the sandbox network proxy. Install a shell function so ordinary
      // `ssh host` commands use the runtime's local SOCKS proxy too. This is
      // deliberately opt-in at the config layer, but enabled by default.
      const socksProxyPort = sshProxy ? SandboxManager.getSocksProxyPort() : undefined;
      const sshProxyCommand =
        process.platform === "darwin" && socksProxyPort !== undefined
          ? `ssh() { /usr/bin/ssh -o 'ProxyCommand=/usr/bin/nc -X 5 -x localhost:${socksProxyPort} %h %p' "$@"; }; `
          : "";
      const wrappedCommand = await SandboxManager.wrapWithSandbox(
        `${sshProxyCommand}${command}`,
        shell,
      );

      return new Promise((resolve, reject) => {
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
        child.on("error", (error) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          reject(error);
        });

        signal?.addEventListener("abort", killProcessGroup, { once: true });
        child.on("close", (code) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", killProcessGroup);
          SandboxManager.cleanupAfterCommand();

          if (signal?.aborted) reject(new Error("aborted"));
          else if (timedOut) reject(new Error(`timeout:${timeout}`));
          else resolve({ exitCode: code });
        });
      });
    },
  };
}
