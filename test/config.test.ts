import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import {
  addDomainToConfig,
  addReadPathToConfig,
  addWritePathToConfig,
  stripJsonComments,
  DEFAULT_CONFIG,
  DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS,
  getConfigPaths,
  loadConfig,
  mergeConfigLayers,
} from "../src/config.ts";

test("omitted settings use their defaults", () => {
  const merged = mergeConfigLayers(DEFAULT_CONFIG, {}, {});

  assert.equal(DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS, 600);
  assert.equal(merged.permissionPromptTimeoutSeconds, DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS);
  assert.equal(merged.sandboxUserShell, true);
  assert.equal(merged.network?.allowSSHAgentSocket, undefined);
});

test("mergeConfigLayers combines configured arrays and deduplicates entries", () => {
  const merged = mergeConfigLayers(
    DEFAULT_CONFIG,
    {
      network: {
        allowedDomains: ["global.example.com", "shared.example.com"],
        deniedDomains: ["blocked.example.com"],
        allowUnixSockets: ["/global.sock"],
      },
      filesystem: {
        allowRead: ["/global", "/shared"],
        denyWrite: ["global.key"],
      },
    },
    {
      network: {
        allowedDomains: ["project.example.com", "shared.example.com"],
        deniedDomains: ["project-blocked.example.com"],
        allowUnixSockets: ["/project.sock"],
      },
      filesystem: {
        allowRead: ["/project", "/shared"],
        denyWrite: ["project.key"],
      },
    },
  );

  assert.deepEqual(merged.network?.allowedDomains, [
    "global.example.com",
    "shared.example.com",
    "project.example.com",
  ]);
  assert.deepEqual(merged.network?.deniedDomains, [
    "blocked.example.com",
    "project-blocked.example.com",
  ]);
  assert.deepEqual(merged.network?.allowUnixSockets, ["/global.sock", "/project.sock"]);
  assert.deepEqual(merged.filesystem?.allowRead, ["/global", "/shared", "/project"]);
  assert.deepEqual(merged.filesystem?.denyWrite, ["global.key", "project.key"]);
});

test("mergeConfigLayers ignores malformed permission arrays", () => {
  const merged = mergeConfigLayers(
    DEFAULT_CONFIG,
    { filesystem: { denyWrite: "*.key" as unknown as string[] } },
    {},
  );

  assert.deepEqual(merged.filesystem?.denyWrite, DEFAULT_CONFIG.filesystem?.denyWrite);
});

test("mergeConfigLayers uses defaults only for arrays not configured by either file", () => {
  const merged = mergeConfigLayers(
    DEFAULT_CONFIG,
    {
      enabled: false,
      sandboxUserShell: false,
      permissionPromptTimeoutSeconds: 30,
      filesystem: { allowWrite: [] },
    },
    {
      enabled: true,
      sandboxUserShell: true,
      permissionPromptTimeoutSeconds: 0,
      allowBrowserProcess: true,
    },
  );

  assert.equal(merged.enabled, true);
  assert.equal(merged.sandboxUserShell, true);
  assert.equal(merged.permissionPromptTimeoutSeconds, 0);
  assert.equal(merged.allowBrowserProcess, true);
  assert.deepEqual(merged.filesystem?.allowWrite, []);
  assert.deepEqual(merged.filesystem?.allowRead, DEFAULT_CONFIG.filesystem?.allowRead);
  assert.deepEqual(merged.network?.allowedDomains, DEFAULT_CONFIG.network?.allowedDomains);
});

test("getConfigPaths uses Pi's configured agent directory", () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = "/tmp/custom-pi-agent";
  try {
    assert.deepEqual(getConfigPaths("/workspace"), {
      globalPath: "/tmp/custom-pi-agent/sandbox.json",
      projectPath: "/workspace/.pi/sandbox.json",
    });
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
});

test("loadConfig ignores project configuration when the project is untrusted", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-trust-"));
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "sandbox.json"), JSON.stringify({ enabled: false }));
  writeFileSync(join(projectDir, ".pi", "sandbox.json"), JSON.stringify({ enabled: true }));

  try {
    assert.equal(loadConfig(projectDir, false).enabled, false);
    assert.equal(loadConfig(projectDir, true).enabled, true);
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("stripJsonComments removes comments but preserves them inside strings", () => {
  assert.equal(stripJsonComments('{"a": 1 // trailing\n}'), '{"a": 1 \n}');
  assert.equal(stripJsonComments('{/* block */"a": 1}'), '{"a": 1}');
  assert.equal(stripJsonComments('{"url": "http://x/y"}'), '{"url": "http://x/y"}');
  assert.equal(stripJsonComments('{"s": "a // b"}'), '{"s": "a // b"}');
});

test("permission writers parse JSONC configs and preserve other sections", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-config-"));
  const configPath = join(root, "sandbox.json");
  writeFileSync(
    configPath,
    '{\n  "enabled": true, // keep me\n  "network": { "allowedDomains": ["keep.com"] }\n}\n',
  );

  addWritePathToConfig(configPath, "/write");

  const raw = readFileSync(configPath, "utf8");
  const written = JSON.parse(stripJsonComments(raw));
  assert.match(raw, /\/\/ keep me/);
  assert.equal(written.enabled, true);
  assert.deepEqual(written.network.allowedDomains, ["keep.com"]);
  assert.deepEqual(written.filesystem.allowWrite, ["/write"]);
});

test("permission writers preserve comments when extending an existing array", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-config-"));
  const configPath = join(root, "sandbox.json");
  const original = [
    "// project sandbox, keep this header",
    "{",
    '  "enabled": true /* global switch */,',
    '  "network": {',
    '    "allowedDomains": [',
    '      "keep.com" // inline note',
    "    ]",
    "  },",
    '  "logLevel": "debug" // closing member',
    "}",
    "",
  ].join("\n");
  writeFileSync(configPath, original);

  addDomainToConfig(configPath, "new.org");

  const raw = readFileSync(configPath, "utf8");
  assert.match(raw, /inline note/);
  assert.match(raw, /\/\* global switch \*\//);
  assert.match(raw, /closing member/);
  assert.match(raw, /project sandbox/);
  const written = JSON.parse(stripJsonComments(raw));
  assert.deepEqual(written.network.allowedDomains, ["keep.com", "new.org"]);
  assert.equal(written.enabled, true);
  assert.equal(written.logLevel, "debug");
});

test("permission writers preserve comments when inserting a missing member", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-config-"));
  const configPath = join(root, "sandbox.json");
  writeFileSync(
    configPath,
    '{\n  "network": {\n    "allowedDeny": ["deny.example"] // denied stuff\n  },\n  "enabled": false // off by default\n}\n',
  );

  addDomainToConfig(configPath, "example.com");

  const raw = readFileSync(configPath, "utf8");
  assert.match(raw, /denied stuff/);
  assert.match(raw, /off by default/);
  const written = JSON.parse(stripJsonComments(raw));
  assert.deepEqual(written.network, {
    allowedDeny: ["deny.example"],
    allowedDomains: ["example.com"],
  });
});

test("permission writers preserve comments when inserting a missing parent object", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-config-"));
  const configPath = join(root, "sandbox.json");
  writeFileSync(configPath, '{\n  "enabled": true // keep\n}\n');

  addReadPathToConfig(configPath, "/read");
  addWritePathToConfig(configPath, "/write");

  const raw = readFileSync(configPath, "utf8");
  assert.match(raw, /keep/);
  const written = JSON.parse(stripJsonComments(raw));
  assert.equal(written.enabled, true);
  assert.deepEqual(written.filesystem.allowRead, ["/read"]);
  assert.deepEqual(written.filesystem.allowWrite, ["/write"]);
});

test("permission-written configs remain parseable JSONC and load correctly", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-config-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "cwd");
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  const configPath = join(cwd, ".pi", "sandbox.json");
  writeFileSync(
    configPath,
    '{\n  // project sandbox\n  "network": { "allowedDomains": ["a.example"] }\n}\n',
  );

  addWritePathToConfig(configPath, "/w");
  addReadPathToConfig(configPath, "/r");

  try {
    const loaded = loadConfig(cwd, true);
    assert.deepEqual(loaded.network?.allowedDomains, ["a.example"]);
    assert.deepEqual(loaded.filesystem?.allowWrite, ["/w"]);
    assert.deepEqual(loaded.filesystem?.allowRead, ["/r"]);
    assert.match(readFileSync(configPath, "utf8"), /project sandbox/);
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("permission writers refuse to overwrite an unparseable config", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-config-"));
  const configPath = join(root, "sandbox.json");
  const broken = '{ "enabled": true, oops }';
  writeFileSync(configPath, broken);

  assert.throws(() => addWritePathToConfig(configPath, "/write"));
  assert.equal(readFileSync(configPath, "utf8"), broken);
});

test("permission writers only persist the property being changed", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-config-"));
  const configPath = join(root, "sandbox.json");

  addReadPathToConfig(configPath, "/read");
  addWritePathToConfig(configPath, "/write");
  addDomainToConfig(configPath, "example.com");

  const written = JSON.parse(readFileSync(configPath, "utf8"));
  assert.deepEqual(written, {
    network: { allowedDomains: ["example.com"] },
    filesystem: {
      allowRead: ["/read"],
      allowWrite: ["/write"],
    },
  });
});
