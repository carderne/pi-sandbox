import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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

function pathsReferToSameLocation(first: string, second: string): boolean {
  return canonicalizePath(first) === canonicalizePath(second);
}

function pathIsWithin(path: string, parent: string): boolean {
  const relativePath = relative(canonicalizePath(parent), canonicalizePath(path));
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

/** Walk ancestors to see if cwd is under a worktree/submodule (.git file) vs a regular clone. */
export function ancestorHasGitMetadataFile(cwd: string): boolean {
  try {
    let current = canonicalizePath(cwd);
    while (true) {
      const gitPath = join(current, ".git");
      if (existsSync(gitPath)) {
        const stat = lstatSync(gitPath);
        if (stat.isFile()) return true;
        return false;
      }
      const parent = dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  } catch {
    return false;
  }
}

export interface GitMetadataDiscovery {
  /** Metadata paths that have been verified as belonging to this checkout. */
  verifiedPaths: string[];
  /** A separate-git-dir candidate that requires explicit user approval. */
  separateGitDirPath: string | null;
}

const gitWorktreePathCache = new Map<string, GitMetadataDiscovery>();

function readGitDirPointer(worktreeRoot: string): string | null {
  try {
    const gitFilePath = join(worktreeRoot, ".git");
    if (!lstatSync(gitFilePath).isFile()) return null;
    const content = readFileSync(gitFilePath, "utf-8");
    const match = content.match(/^gitdir:\s*(.+)$/m);
    return match ? resolve(worktreeRoot, match[1]!.trim()) : null;
  } catch {
    return null;
  }
}

type GitMetadataValidation = "verified" | "separate-git-dir" | "invalid";

function gitMetadataBelongsToWorktree(
  worktreeRoot: string,
  worktreeGitDir: string,
  commonGitDir: string,
): GitMetadataValidation {
  try {
    const gitFilePath = join(worktreeRoot, ".git");
    const pointedGitDir = readGitDirPointer(worktreeRoot);
    if (pointedGitDir === null || !pathsReferToSameLocation(pointedGitDir, worktreeGitDir)) {
      return "invalid";
    }

    // Linked worktree: git-dir differs from common-git-dir; validate gitdir back-pointer.
    if (!pathsReferToSameLocation(worktreeGitDir, commonGitDir)) {
      if (!pathsReferToSameLocation(dirname(worktreeGitDir), join(commonGitDir, "worktrees"))) {
        return "invalid";
      }
      const backPointerPath = join(worktreeGitDir, "gitdir");
      if (!lstatSync(backPointerPath).isFile()) return "invalid";
      const backPointer = readFileSync(backPointerPath, "utf-8").replace(/\r?\n$/, "");
      return backPointer.length > 0 &&
        pathsReferToSameLocation(resolve(worktreeGitDir, backPointer), gitFilePath)
        ? "verified"
        : "invalid";
    }

    const configPath = join(worktreeGitDir, "config");
    if (!lstatSync(configPath).isFile()) return "invalid";

    let worktreeOutput: string;
    try {
      worktreeOutput = execFileSync(
        "git",
        ["config", "--file", configPath, "--path", "--null", "--get", "core.worktree"],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
      );
    } catch (error) {
      // A valid `git init --separate-git-dir` checkout has no core.worktree entry.
      // It is not reciprocally authenticated, so return it as a candidate for prompting.
      return (error as { status?: number }).status === 1 ? "separate-git-dir" : "invalid";
    }

    if (
      !worktreeOutput.endsWith("\0") ||
      worktreeOutput.indexOf("\0") !== worktreeOutput.length - 1
    ) {
      return "invalid";
    }
    const configuredWorktree = worktreeOutput.slice(0, -1);
    return configuredWorktree.length > 0 &&
      pathsReferToSameLocation(resolve(worktreeGitDir, configuredWorktree), worktreeRoot)
      ? "verified"
      : "invalid";
  } catch {
    return "invalid";
  }
}

function discoverGitMetadataViaGit(cwd: string): GitMetadataDiscovery {
  try {
    const gitEnvironment = { ...process.env };
    delete gitEnvironment.GIT_DIR;
    delete gitEnvironment.GIT_WORK_TREE;
    delete gitEnvironment.GIT_COMMON_DIR;

    const output = execFileSync(
      "git",
      ["-C", cwd, "rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"],
      {
        encoding: "utf-8",
        env: gitEnvironment,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const lines = output.replace(/\r?\n$/, "").split(/\r?\n/);
    if (lines.length !== 3 || lines.some((line) => line.length === 0)) {
      return { verifiedPaths: [], separateGitDirPath: null };
    }

    const [worktreeRoot, worktreeGitDir, commonGitDirOutput] = lines;
    if (!isAbsolute(worktreeRoot) || !isAbsolute(worktreeGitDir)) {
      return { verifiedPaths: [], separateGitDirPath: null };
    }
    if (!pathIsWithin(cwd, worktreeRoot)) {
      return { verifiedPaths: [], separateGitDirPath: null };
    }

    const commonGitDir = resolve(cwd, commonGitDirOutput);
    if (!statSync(worktreeGitDir).isDirectory() || !statSync(commonGitDir).isDirectory()) {
      return { verifiedPaths: [], separateGitDirPath: null };
    }

    const validation = gitMetadataBelongsToWorktree(worktreeRoot, worktreeGitDir, commonGitDir);
    if (validation === "verified") {
      return {
        verifiedPaths: unique([worktreeGitDir, commonGitDir]),
        separateGitDirPath: null,
      };
    }
    if (validation === "separate-git-dir") {
      return { verifiedPaths: [], separateGitDirPath: worktreeGitDir };
    }
  } catch {
    // Fall through to an empty result when git is unavailable or rejects the checkout.
  }
  return { verifiedPaths: [], separateGitDirPath: null };
}

function cloneGitMetadataDiscovery(discovery: GitMetadataDiscovery): GitMetadataDiscovery {
  return {
    verifiedPaths: [...discovery.verifiedPaths],
    separateGitDirPath: discovery.separateGitDirPath,
  };
}

export function clearGitWorktreePathCache(): void {
  gitWorktreePathCache.clear();
}

export function discoverGitMetadata(cwd: string): GitMetadataDiscovery {
  const cacheKey = canonicalizePath(cwd);
  const cached = gitWorktreePathCache.get(cacheKey);
  if (cached !== undefined) return cloneGitMetadataDiscovery(cached);

  const result = ancestorHasGitMetadataFile(cwd)
    ? discoverGitMetadataViaGit(cwd)
    : { verifiedPaths: [], separateGitDirPath: null };
  gitWorktreePathCache.set(cacheKey, result);
  return cloneGitMetadataDiscovery(result);
}

/** Discover verified metadata directories for linked worktrees and submodules (.git is a file). */
export function discoverGitWorktreePaths(cwd: string): string[] {
  return discoverGitMetadata(cwd).verifiedPaths;
}

export function discoverSeparateGitDirPath(cwd: string): string | null {
  return discoverGitMetadata(cwd).separateGitDirPath;
}

export function resolveAllowances(
  config: SandboxConfig,
  allowances?: SessionAllowances,
  cwd: string = process.cwd(),
): EffectiveAllowances {
  const gitPaths = config.autoAllowGitMetadata === false ? [] : discoverGitWorktreePaths(cwd);
  const writePaths = unique([
    ...(config.filesystem?.allowWrite ?? []),
    ...(allowances?.writePaths ?? []),
    ...gitPaths,
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
  cwd: string = process.cwd(),
): SandboxRuntimeConfig {
  const effective = resolveAllowances(config, allowances, cwd);

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
  cwd: string = process.cwd(),
): Promise<void> {
  clearGitWorktreePathCache();
  const runtimeConfig = buildRuntimeConfig(config, allowances, cwd);
  await SandboxManager.initialize(
    runtimeConfig,
    createNetworkAskCallback(runtimeConfig.network?.allowedDomains ?? []),
  );
}

export async function reinitializeSandbox(
  config: SandboxConfig,
  allowances: SessionAllowances,
  cwd: string = process.cwd(),
): Promise<void> {
  await SandboxManager.reset();
  await initializeSandbox(config, allowances, cwd);
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
