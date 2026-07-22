import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { type SandboxRuntimeConfig } from "@carderne/sandbox-runtime";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type SandboxConfig = Omit<SandboxRuntimeConfig, "network"> & {
  enabled?: boolean;
  network?: NonNullable<SandboxRuntimeConfig["network"]> & {
    allowUnauthenticatedSocksProxy?: boolean;
  };
};

export const DEFAULT_CONFIG: SandboxConfig = {
  enabled: true,
  network: {
    allowUnauthenticatedSocksProxy: process.platform === "darwin",
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
    denyWrite: [".env", ".env.*", "*.pem", "*.key"],
  },
};

export function deepMerge(base: SandboxConfig, overrides: Partial<SandboxConfig>): SandboxConfig {
  const result: SandboxConfig = { ...base };

  if (overrides.enabled !== undefined) result.enabled = overrides.enabled;
  if (overrides.network) result.network = { ...base.network, ...overrides.network };
  if (overrides.filesystem) result.filesystem = { ...base.filesystem, ...overrides.filesystem };

  if (overrides.ignoreViolations) result.ignoreViolations = overrides.ignoreViolations;
  if (overrides.enableWeakerNestedSandbox !== undefined) {
    result.enableWeakerNestedSandbox = overrides.enableWeakerNestedSandbox;
  }
  if (overrides.allowBrowserProcess !== undefined) {
    result.allowBrowserProcess = overrides.allowBrowserProcess;
  }

  return result;
}

function readJsonConfig(configPath: string, warn: boolean): Partial<SandboxConfig> {
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (error) {
    if (warn) console.error(`Warning: Could not parse ${configPath}: ${error}`);
    return {};
  }
}

export function getConfigPaths(cwd: string): { globalPath: string; projectPath: string } {
  return {
    globalPath: join(homedir(), ".pi", "agent", "sandbox.json"),
    projectPath: join(cwd, ".pi", "sandbox.json"),
  };
}

export function loadConfig(cwd: string): SandboxConfig {
  const projectConfigPath = join(cwd, ".pi", "sandbox.json");
  const globalConfigPath = join(getAgentDir(), "sandbox.json");
  const globalConfig = readJsonConfig(globalConfigPath, true);
  const projectConfig = readJsonConfig(projectConfigPath, true);
  return deepMerge(deepMerge(DEFAULT_CONFIG, globalConfig), projectConfig);
}

function writeConfigFile(configPath: string, config: Partial<SandboxConfig>): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function addDomainToConfig(configPath: string, domain: string): void {
  const config = readJsonConfig(configPath, false);
  const existing = config.network?.allowedDomains ?? [];
  if (existing.includes(domain)) return;

  config.network = {
    ...config.network,
    allowedDomains: [...existing, domain],
    deniedDomains: config.network?.deniedDomains ?? [],
  };
  writeConfigFile(configPath, config);
}

export function addReadPathToConfig(configPath: string, pathToAdd: string): void {
  const config = readJsonConfig(configPath, false);
  const existing = config.filesystem?.allowRead ?? [];
  if (existing.includes(pathToAdd)) return;

  config.filesystem = {
    ...config.filesystem,
    allowRead: [...existing, pathToAdd],
    denyRead: config.filesystem?.denyRead ?? [],
    allowWrite: config.filesystem?.allowWrite ?? [],
    denyWrite: config.filesystem?.denyWrite ?? [],
  };
  writeConfigFile(configPath, config);
}

export function addWritePathToConfig(configPath: string, pathToAdd: string): void {
  const config = readJsonConfig(configPath, false);
  const existing = config.filesystem?.allowWrite ?? [];
  if (existing.includes(pathToAdd)) return;

  config.filesystem = {
    ...config.filesystem,
    allowWrite: [...existing, pathToAdd],
    denyRead: config.filesystem?.denyRead ?? [],
    denyWrite: config.filesystem?.denyWrite ?? [],
  };
  writeConfigFile(configPath, config);
}
