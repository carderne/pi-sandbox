import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import assert from "node:assert/strict";

import extension from "../src/extension.ts";

type Handler = (event: any, ctx: ExtensionContext) => any;

// Enabling the sandbox initializes the real runtime, which needs sandbox-exec
// on macOS, or bwrap + socat and unprivileged user namespaces on Linux.
function sandboxAvailable(): boolean {
  if (process.platform === "darwin") return true;
  if (process.platform !== "linux") return false;
  const ok = (cmd: string, args: string[]) => spawnSync(cmd, args).status === 0;
  return (
    ok("which", ["bwrap"]) &&
    ok("which", ["socat"]) &&
    ok("bwrap", [
      "--ro-bind",
      "/",
      "/",
      "--unshare-user",
      "--unshare-pid",
      "--proc",
      "/proc",
      "true",
    ])
  );
}
const noSandbox = !sandboxAvailable();

function session(cwd: string, flags: Record<string, boolean> = {}) {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  const api = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerTool: () => {},
    registerFlag: () => {},
    registerShortcut: () => {},
    registerCommand: (name: string, command: { handler: any }) =>
      commands.set(name, command.handler),
    getFlag: (name: string) => flags[name] ?? false,
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    hasUI: false,
    isProjectTrusted: () => true,
    ui: {
      notify: () => {},
      setStatus: () => {},
      theme: { fg: (_color: string, text: string) => text },
    },
  } as unknown as ExtensionContext;
  extension(api);
  return {
    start: () => handlers.get("session_start")!({ reason: "startup" }, ctx),
    shutdown: () => handlers.get("session_shutdown")!({ reason: "quit" }, ctx),
    command: (name: string) => commands.get(name)!("", ctx),
    toolCall: (toolName: string, input: Record<string, unknown>) =>
      handlers.get("tool_call")!({ toolName, input }, ctx),
  };
}

function setup(t: TestContext, config: object = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-ext-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "sandbox.json"), JSON.stringify(config));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalEnvProxy = process.env.NODE_USE_ENV_PROXY;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.NODE_USE_ENV_PROXY;
  t.after(() => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    if (originalEnvProxy === undefined) delete process.env.NODE_USE_ENV_PROXY;
    else process.env.NODE_USE_ENV_PROXY = originalEnvProxy;
    rmSync(root, { recursive: true, force: true });
  });
  return { root, agentDir };
}

test(
  "disable releases NODE_USE_ENV_PROXY; re-enable restores it",
  { skip: noSandbox || process.versions.node.split(".")[0] === "20", timeout: 15_000 },
  async (t) => {
    const { root } = setup(t);
    const current = session(root);
    t.after(() => current.shutdown());

    await current.start();
    assert.equal(process.env.NODE_USE_ENV_PROXY, "1");

    await current.command("sandbox-disable");
    assert.equal(process.env.NODE_USE_ENV_PROXY, undefined);

    await current.command("sandbox-enable");
    assert.equal(process.env.NODE_USE_ENV_PROXY, "1");
  },
);
