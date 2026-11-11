import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { type SandboxRuntimeConfig } from "@carderne/sandbox-runtime";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export type SandboxConfig = Omit<SandboxRuntimeConfig, "network" | "filesystem"> & {
  /**
   * `denyMandatoryCwdFiles` is added to @carderne/sandbox-runtime by PR #21.
   * Drop it from this type once a released runtime type carries the field.
   *
   * When false, the runtime does not deny the built-in mandatory filenames
   * (.gitconfig, .bashrc, .mcp.json, ...) at the working directory root, which
   * avoids them appearing in the working tree as zero-length character devices.
   */
  filesystem?: NonNullable<SandboxRuntimeConfig["filesystem"]> & {
    denyMandatoryCwdFiles?: boolean;
  };
  enabled?: boolean;
  sandboxUserShell?: boolean;
  enableAccessRequestTool?: boolean;
  permissionPromptTimeoutSeconds?: number;
  network?: NonNullable<SandboxRuntimeConfig["network"]> & {
    allowUnauthenticatedSocksProxy?: boolean;
    /** Route ordinary `ssh` commands through the sandbox SOCKS proxy. */
    sshProxy?: boolean;
    /**
     * Disable network sandboxing entirely (no `--unshare-net`, no proxy) while
     * keeping filesystem sandboxing. The sandboxed process gets direct network
     * access via the host's routing/DNS/VPN. Opt-in; reduces protection.
     */
    disabled?: boolean;
    /**
     * Allow the current SSH agent socket (`SSH_AUTH_SOCK`) inside the sandbox.
     * Disabled by default. When enabled, the resolved existing socket path is
     * added to `allowUnixSockets` at sandbox-build time so macOS `/var` →
     * `/private/var` and the per-boot launchd directory are handled without a
     * broad allowlist. Non-sockets and unresolved paths are ignored.
     */
    allowSSHAgentSocket?: boolean;
  };
};

type NetworkConfig = NonNullable<SandboxConfig["network"]>;
type FilesystemConfig = NonNullable<SandboxConfig["filesystem"]>;

export type SandboxConfigFile = Omit<Partial<SandboxConfig>, "network" | "filesystem"> & {
  network?: Partial<NetworkConfig>;
  filesystem?: Partial<FilesystemConfig>;
};

export const DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS = 10 * 60;

export const DEFAULT_CONFIG: SandboxConfig = {
  enabled: true,
  sandboxUserShell: true,
  enableAccessRequestTool: false,
  permissionPromptTimeoutSeconds: DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS,
  network: {
    allowUnauthenticatedSocksProxy: process.platform === "darwin",
    sshProxy: true,
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

function mergeObjects(base: SandboxConfig, overrides: SandboxConfigFile): SandboxConfig {
  return {
    ...base,
    ...overrides,
    network: overrides.network
      ? ({ ...base.network, ...overrides.network } as NetworkConfig)
      : base.network,
    filesystem: overrides.filesystem
      ? ({ ...base.filesystem, ...overrides.filesystem } as FilesystemConfig)
      : base.filesystem,
  };
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
  return value;
}

function mergeConfiguredArray(
  fallback: string[] | undefined,
  globalValue: unknown,
  projectValue: unknown,
): string[] | undefined {
  const globalEntries = stringArray(globalValue);
  const projectEntries = stringArray(projectValue);
  if (globalEntries === undefined && projectEntries === undefined) return fallback;
  return [...new Set([...(globalEntries ?? []), ...(projectEntries ?? [])])];
}

export function mergeConfigLayers(
  defaults: SandboxConfig,
  globalConfig: SandboxConfigFile,
  projectConfig: SandboxConfigFile,
): SandboxConfig {
  const merged = mergeObjects(mergeObjects(defaults, globalConfig), projectConfig);

  return {
    ...merged,
    // Cross-sandbox signals can affect unrelated host processes; only global config may grant them.
    allowProcessSignals: globalConfig.allowProcessSignals === true,
    network: {
      ...merged.network,
      allowedDomains:
        mergeConfiguredArray(
          defaults.network?.allowedDomains,
          globalConfig.network?.allowedDomains,
          projectConfig.network?.allowedDomains,
        ) ?? [],
      deniedDomains:
        mergeConfiguredArray(
          defaults.network?.deniedDomains,
          globalConfig.network?.deniedDomains,
          projectConfig.network?.deniedDomains,
        ) ?? [],
      allowUnixSockets: mergeConfiguredArray(
        defaults.network?.allowUnixSockets,
        globalConfig.network?.allowUnixSockets,
        projectConfig.network?.allowUnixSockets,
      ),
      allowMachLookup: mergeConfiguredArray(
        defaults.network?.allowMachLookup,
        globalConfig.network?.allowMachLookup,
        projectConfig.network?.allowMachLookup,
      ),
    },
    filesystem: {
      ...merged.filesystem,
      denyRead:
        mergeConfiguredArray(
          defaults.filesystem?.denyRead,
          globalConfig.filesystem?.denyRead,
          projectConfig.filesystem?.denyRead,
        ) ?? [],
      allowRead: mergeConfiguredArray(
        defaults.filesystem?.allowRead,
        globalConfig.filesystem?.allowRead,
        projectConfig.filesystem?.allowRead,
      ),
      allowWrite:
        mergeConfiguredArray(
          defaults.filesystem?.allowWrite,
          globalConfig.filesystem?.allowWrite,
          projectConfig.filesystem?.allowWrite,
        ) ?? [],
      denyWrite:
        mergeConfiguredArray(
          defaults.filesystem?.denyWrite,
          globalConfig.filesystem?.denyWrite,
          projectConfig.filesystem?.denyWrite,
        ) ?? [],
    },
  };
}

/**
 * Strip `//` line and `/* *\/` block comments while preserving them inside
 * strings, so the JSONC examples in the README parse as written.
 */
export function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && input[i + 1] === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      if (i < input.length) out += "\n";
      continue;
    }
    if (ch === "/" && input[i + 1] === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

function parseConfig(configPath: string): SandboxConfigFile {
  const parsed: unknown = JSON.parse(stripJsonComments(readFileSync(configPath, "utf-8")));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("configuration must be a JSON object");
  }
  return parsed as SandboxConfigFile;
}

function readJsonConfig(configPath: string, warn: boolean): SandboxConfigFile {
  if (!existsSync(configPath)) return {};
  try {
    return parseConfig(configPath);
  } catch (error) {
    if (warn) console.error(`Warning: Could not parse ${configPath}: ${error}`);
    return {};
  }
}

/**
 * Read a config for the purpose of writing it back. If the file exists but
 * cannot be parsed, throw instead of returning `{}` — otherwise a permission
 * grant would silently overwrite (and destroy) the user's existing config.
 */
function readConfigForWrite(configPath: string): SandboxConfigFile {
  if (!existsSync(configPath)) return {};
  try {
    return parseConfig(configPath);
  } catch (error) {
    throw new Error(
      `Refusing to overwrite ${configPath}: existing file could not be parsed (${error}). ` +
        `Fix the file manually, then retry.`,
    );
  }
}

export function getConfigPaths(cwd: string): { globalPath: string; projectPath: string } {
  return {
    globalPath: join(getAgentDir(), "sandbox.json"),
    projectPath: join(cwd, CONFIG_DIR_NAME, "sandbox.json"),
  };
}

export function loadConfig(cwd: string, projectTrusted = true): SandboxConfig {
  const { globalPath, projectPath } = getConfigPaths(cwd);
  const globalConfig = readJsonConfig(globalPath, true);
  const projectConfig = projectTrusted ? readJsonConfig(projectPath, true) : {};
  return mergeConfigLayers(DEFAULT_CONFIG, globalConfig, projectConfig);
}

function writeConfigFile(configPath: string, config: SandboxConfigFile): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/**
 * Read the JSON string starting at `i` (which must point at a `"`). Returns
 * the decoded value and the index just past the closing quote, or `null` for
 * malformed input.
 */
function readJsonString(text: string, i: number): { value: string; end: number } | null {
  if (text[i] !== '"') return null;
  let out = "";
  let j = i + 1;
  for (;;) {
    if (j >= text.length) return null;
    const ch = text[j] as string;
    if (ch === '"') return { value: out, end: j + 1 };
    if (ch === "\\") {
      const esc = text[j + 1];
      if (esc === undefined) return null;
      if (esc === "u") {
        const hex = text.slice(j + 2, j + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
        out += String.fromCharCode(parseInt(hex, 16));
        j += 6;
        continue;
      }
      const simple: Record<string, string> = {
        n: "\n",
        t: "\t",
        r: "\r",
        b: "\b",
        f: "\f",
        '"': '"',
        "\\": "\\",
        "/": "/",
      };
      if (esc in simple) {
        out += simple[esc];
        j += 2;
        continue;
      }
      return null;
    }
    out += ch;
    j++;
  }
}

/** Index just past a line or block comment starting at `i` (outside strings). */
function skipComment(text: string, i: number): number {
  if (text[i + 1] === "/") {
    const end = text.indexOf("\n", i + 2);
    return end === -1 ? text.length : end;
  }
  const end = text.indexOf("*/", i + 2);
  return end === -1 ? text.length : end + 2;
}

/** Index past whitespace and comments starting at `i`. */
function skipSeparators(text: string, i: number): number {
  let j = i;
  while (j < text.length) {
    const ch = text[j] as string;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      j++;
      continue;
    }
    if (ch === "/" && (text[j + 1] === "/" || text[j + 1] === "*")) {
      j = skipComment(text, j);
      continue;
    }
    break;
  }
  return j;
}

/** Index just past the JSON value starting at `i` (string, object, array, or scalar). Returns -1 on malformed input. */
function skipValue(text: string, i: number): number {
  const ch = text[i];
  if (ch === undefined) return -1;
  if (ch === '"') {
    const str = readJsonString(text, i);
    return str !== null ? str.end : -1;
  }
  if (ch === "{" || ch === "[") {
    let objDepth = 0;
    let arrDepth = 0;
    if (ch === "{") objDepth = 1;
    else arrDepth = 1;
    let j = i + 1;
    while (j < text.length) {
      const c = text[j] as string;
      if (c === '"') {
        const str = readJsonString(text, j);
        if (str === null) return -1;
        j = str.end;
        continue;
      }
      if (c === "/" && (text[j + 1] === "/" || text[j + 1] === "*")) {
        j = skipComment(text, j);
        continue;
      }
      if (c === "{") objDepth++;
      else if (c === "[") arrDepth++;
      else if (c === "}") {
        objDepth--;
        if (objDepth === 0 && arrDepth === 0) return j + 1;
      } else if (c === "]") {
        arrDepth--;
        if (objDepth === 0 && arrDepth === 0) return j + 1;
      }
      j++;
    }
    return -1;
  }
  let j = i;
  while (j < text.length) {
    const c = text[j] as string;
    if (c === "{" || c === "[" || c === "}" || c === "]" || c === ",") return j;
    j++;
  }
  return j;
}

/** The whitespace-only prefix of the line containing `pos`. */
function lineIndent(text: string, pos: number): string {
  let lineStart = 0;
  for (let i = pos - 1; i >= 0 && text[i] !== "\n"; i--) lineStart = i;
  const prefix = text.slice(lineStart, pos);
  return /^\s*$/.test(prefix) ? prefix : "";
}

/**
 * Scan the string elements of the array opening at `arrStart` (its `[`).
 *
 * Returns the element count, the index just past the last element's closing
 * quote, the column of the last element's opening quote (for indentation),
 * and whether the array spans multiple lines. Returns `null` when an element
 * is not a plain string literal, so the caller falls back to a full rewrite.
 */
function scanArrayTail(
  text: string,
  arrStart: number,
): {
  count: number;
  lastQuoteEnd: number;
  lastItemCol: number;
  multiline: boolean;
} | null {
  try {
    let j = skipSeparators(text, arrStart + 1);
    let count = 0;
    let lastQuoteEnd = arrStart + 1;
    let lastItemCol = -1;
    if (text[j] !== "]") {
      for (;;) {
        const s = readJsonString(text, j);
        if (s === null) return null;
        count++;
        lastQuoteEnd = s.end;
        lastItemCol = j;
        j = skipSeparators(text, s.end);
        if (text[j] === ",") j = skipSeparators(text, j + 1);
        if (text[j] === "]") break;
        if (text[j] !== '"') return null;
      }
    }
    return {
      count,
      lastQuoteEnd,
      lastItemCol,
      multiline: text.indexOf("\n", arrStart) >= 0 && text.indexOf("\n", arrStart) < j,
    };
  } catch {
    return null;
  }
}

type MemberScan =
  | { state: "found"; valueStart: number; valueEnd: number }
  | { state: "after-comma"; afterComma: number }
  | { state: "before-close"; close: number; empty: boolean };

/**
 * Scan the members of the object opening at `open` (its `{`) for a
 * `"fieldKey"` member whose value is an array. All returned indices refer to
 * the raw text (comments included), so results splice the original file
 * directly. Throws on malformed input, or when the field exists but is not
 * an array — the caller turns that into the fallback full rewrite.
 */
function scanObjectMembers(text: string, open: number, fieldKey: string): MemberScan {
  let i = skipSeparators(text, open + 1);
  let hasMembers = false;
  let lastAfterComma = -1;
  for (;;) {
    const ch = text[i];
    if (ch === undefined) throw new Error("unterminated object");
    if (ch === "}") {
      if (!hasMembers) return { state: "before-close", close: i, empty: true };
      return lastAfterComma !== -1
        ? { state: "after-comma", afterComma: lastAfterComma }
        : { state: "before-close", close: i, empty: false };
    }
    if (ch === ",") {
      if (!hasMembers) throw new Error("unexpected leading comma");
      lastAfterComma = i + 1;
      i = skipSeparators(text, i + 1);
      continue;
    }
    const key = readJsonString(text, i);
    if (key === null) throw new Error("malformed member key");
    hasMembers = true;
    let k = skipSeparators(text, key.end);
    if (text[k] !== ":") throw new Error('expected ":"');
    k = skipSeparators(text, k + 1);
    if (key.value === fieldKey) {
      if (text[k] !== "[") throw new Error("field value is not an array");
      const valueEnd = skipValue(text, k);
      if (valueEnd === -1) throw new Error("malformed array");
      return { state: "found", valueStart: k, valueEnd };
    }
    const valueEnd = skipValue(text, k);
    if (valueEnd === -1) throw new Error("malformed value");
    i = skipSeparators(text, valueEnd);
    if (text[i] !== "," && text[i] !== "}") throw new Error('expected "," or "}"');
  }
}

type LocatedArray =
  /** The array exists: `valueStart` is `[`, `valueEnd` is just past `]`. */
  | { kind: "exists"; valueStart: number; valueEnd: number }
  /** The insertion point is right after the last member's comma. */
  | { kind: "after-comma"; afterComma: number; parentMissing: boolean }
  /** The object closes at `close`; `parentEmpty` means it has no members. */
  | {
      kind: "before-close";
      open: number;
      close: number;
      parentEmpty: boolean;
      parentMissing: boolean;
    };

/**
 * Locate the `"fieldKey"` array member of the top-level `"parentKey"` object
 * in raw JSONC text, returning indices into the raw text (comments
 * included). Returns `null` when the structure cannot be located textually,
 * so the caller can fall back to a full rewrite.
 */
function locateConfigArray(raw: string, parentKey: string, fieldKey: string): LocatedArray | null {
  try {
    let i = skipSeparators(raw, 0);
    if (raw[i] !== "{") throw new Error("root is not an object");
    const rootOpen = i;
    i = skipSeparators(raw, rootOpen + 1);
    let hasMembers = false;
    let lastAfterComma = -1;
    for (;;) {
      const ch = raw[i];
      if (ch === undefined) throw new Error("unterminated root object");
      if (ch === "}") {
        if (!hasMembers)
          return {
            kind: "before-close",
            open: rootOpen,
            close: i,
            parentEmpty: true,
            parentMissing: true,
          };
        return lastAfterComma !== -1
          ? { kind: "after-comma", afterComma: lastAfterComma, parentMissing: true }
          : {
              kind: "before-close",
              open: rootOpen,
              close: i,
              parentEmpty: false,
              parentMissing: true,
            };
      }
      if (ch === ",") {
        if (!hasMembers) throw new Error("unexpected leading comma");
        lastAfterComma = i + 1;
        i = skipSeparators(raw, i + 1);
        continue;
      }
      const key = readJsonString(raw, i);
      if (key === null) throw new Error("malformed member key");
      hasMembers = true;
      let k = skipSeparators(raw, key.end);
      if (raw[k] !== ":") throw new Error('expected ":"');
      k = skipSeparators(raw, k + 1);
      if (key.value === parentKey) {
        if (raw[k] !== "{") throw new Error("parent value is not an object");
        const member = scanObjectMembers(raw, k, fieldKey);
        if (member.state === "found") {
          return { kind: "exists", valueStart: member.valueStart, valueEnd: member.valueEnd };
        }
        if (member.state === "after-comma") {
          return { kind: "after-comma", afterComma: member.afterComma, parentMissing: false };
        }
        return {
          kind: "before-close",
          open: k,
          close: member.close,
          parentEmpty: member.empty,
          parentMissing: false,
        };
      }
      const valueEnd = skipValue(raw, k);
      if (valueEnd === -1) throw new Error("malformed value");
      i = skipSeparators(raw, valueEnd);
      if (raw[i] !== "," && raw[i] !== "}") throw new Error('expected "," or "}"');
    }
  } catch {
    return null;
  }
}

/**
 * Write `config`, preserving comments and unrelated formatting where
 * possible.
 *
 * The `parentKey.fieldKey` array is spliced into the original file text: an
 * existing array has its contents replaced in place, a missing member is
 * inserted into the parent object, and a missing parent object is spliced
 * into the root. Every textual mismatch falls back to a full rewrite via
 * `writeConfigFile`, so data safety never depends on the text surgery —
 * worst case the comments are lost, exactly as before.
 */
function writeConfigFilePreservingText(
  configPath: string,
  config: SandboxConfigFile,
  parentKey: "network" | "filesystem",
  fieldKey: string,
): void {
  mkdirSync(dirname(configPath), { recursive: true });
  const value =
    parentKey === "network"
      ? stringArray(config.network?.allowedDomains)
      : fieldKey === "allowRead"
        ? stringArray(config.filesystem?.allowRead)
        : stringArray(config.filesystem?.allowWrite);
  if (value === null || value === undefined) {
    writeConfigFile(configPath, config);
    return;
  }

  let original: string | undefined;
  try {
    original = readFileSync(configPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (original === undefined || original.trim().length === 0) {
    writeConfigFile(configPath, config);
    return;
  }

  const located = locateConfigArray(original, parentKey, fieldKey);
  if (located === null) {
    writeConfigFile(configPath, config);
    return;
  }

  const arrayBody = (itemIndent: string, closeIndent: string): string =>
    value.length === 0
      ? "[]"
      : "[\n" +
        value.map((v) => itemIndent + JSON.stringify(v)).join(",\n") +
        "\n" +
        closeIndent +
        "]";
  const memberLine = (indent: string): string =>
    indent + JSON.stringify(fieldKey) + ": " + arrayBody(indent + "  ", indent);
  const parentBlock = (indent: string): string =>
    indent + JSON.stringify(parentKey) + ": {\n" + memberLine(indent + "  ") + "\n" + indent + "}";
  const siblingIndent = (at: number): string => {
    const j = skipSeparators(original, at);
    if (original[j] === "}") return lineIndent(original, j) + "  ";
    return lineIndent(original, j);
  };

  switch (located.kind) {
    case "exists": {
      const tail = scanArrayTail(original, located.valueStart);
      if (tail === null) {
        writeConfigFile(configPath, config);
        return;
      }
      const added = value.slice(tail.count);
      if (added.length === 0) {
        if (value.length >= tail.count) return; // nothing new; leave the file untouched
        writeConfigFile(configPath, config);
        return;
      }
      if (tail.count === 0) {
        // Empty array: rewrite only the inside of the brackets. Refuse to do
        // so when the inside carries comments we would drop.
        const inner = original.slice(located.valueStart + 1, located.valueEnd);
        if (!/^\s*$/.test(inner)) {
          writeConfigFile(configPath, config);
          return;
        }
        const closeIndent = lineIndent(original, located.valueEnd - 1);
        const content = added.map((v) => JSON.stringify(v));
        const inside = closeIndent
          ? `\n${content.map((v) => closeIndent + "  " + v).join(",\n")}\n${closeIndent}`
          : content.join(", ");
        writeFileSync(
          configPath,
          original.slice(0, located.valueStart + 1) + inside + original.slice(located.valueEnd),
          "utf-8",
        );
        return;
      }
      // Append the new elements right after the last existing one. Everything
      // before it, and the tail after its closing quote (whitespace, comments,
      // the closing bracket), is copied verbatim. Any trailing comment on the
      // last element migrates to the last new one, which is the only valid way
      // to append while keeping the file parseable.
      const itemIndent =
        lineIndent(original, tail.lastItemCol) || lineIndent(original, located.valueEnd - 1) + "  ";
      const sep = tail.multiline ? `\n${itemIndent}` : " ";
      const items = added.map((v) => JSON.stringify(v)).join("," + sep);
      writeFileSync(
        configPath,
        original.slice(0, tail.lastQuoteEnd) +
          "," +
          sep +
          items +
          original.slice(tail.lastQuoteEnd),
        "utf-8",
      );
      return;
    }
    case "after-comma": {
      const indent = siblingIndent(located.afterComma);
      const block = located.parentMissing ? parentBlock(indent) : memberLine(indent);
      writeFileSync(
        configPath,
        original.slice(0, located.afterComma) +
          "\n" +
          block +
          "," +
          original.slice(located.afterComma),
        "utf-8",
      );
      return;
    }
    case "before-close": {
      const block = located.parentMissing ? parentBlock : memberLine;
      if (located.parentEmpty) {
        const indent = lineIndent(original, located.close) + "  ";
        writeFileSync(
          configPath,
          original.slice(0, located.open + 1) +
            "\n" +
            block(indent) +
            original.slice(located.open + 1),
          "utf-8",
        );
      } else {
        const indent = siblingIndent(located.close);
        writeFileSync(
          configPath,
          original.slice(0, located.close) + ",\n" + block(indent) + original.slice(located.close),
          "utf-8",
        );
      }
      return;
    }
  }
  // Unreachable: every located case writes above.
  writeConfigFile(configPath, config);
}

export function addDomainToConfig(configPath: string, domain: string): void {
  const config = readConfigForWrite(configPath);
  const existing = stringArray(config.network?.allowedDomains) ?? [];
  if (existing.includes(domain)) return;

  config.network = {
    ...config.network,
    allowedDomains: [...existing, domain],
  };
  writeConfigFilePreservingText(configPath, config, "network", "allowedDomains");
}

export function addReadPathToConfig(configPath: string, pathToAdd: string): void {
  const config = readConfigForWrite(configPath);
  const existing = stringArray(config.filesystem?.allowRead) ?? [];
  if (existing.includes(pathToAdd)) return;

  config.filesystem = {
    ...config.filesystem,
    allowRead: [...existing, pathToAdd],
  };
  writeConfigFilePreservingText(configPath, config, "filesystem", "allowRead");
}

export function addWritePathToConfig(configPath: string, pathToAdd: string): void {
  const config = readConfigForWrite(configPath);
  const existing = stringArray(config.filesystem?.allowWrite) ?? [];
  if (existing.includes(pathToAdd)) return;

  config.filesystem = {
    ...config.filesystem,
    allowWrite: [...existing, pathToAdd],
  };
  writeConfigFilePreservingText(configPath, config, "filesystem", "allowWrite");
}
