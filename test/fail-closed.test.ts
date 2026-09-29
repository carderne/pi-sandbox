import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import type { ISandboxManager } from "../src/runtime.ts";

import { registerSandboxExtension } from "../src/extension.ts";

test("requested sandbox fails closed, can retry, and only explicit opt-out allows local execution", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-fail-closed-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  mkdirSync(process.env.PI_CODING_AGENT_DIR);
  writeFileSync(
    join(process.env.PI_CODING_AGENT_DIR, "sandbox.json"),
    JSON.stringify({ enabled: true }),
  );
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });

  let fail = true;
  let resets = 0;
  const manager = {
    async initialize() {
      if (fail) throw new Error("setup refused");
    },
    async reset() {
      resets++;
    },
  } as unknown as ISandboxManager;
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => any>();
  let bash: Parameters<ExtensionAPI["registerTool"]>[0];
  const notifications: string[] = [];
  const api = {
    on: (name: string, handler: any) => handlers.set(name, handler),
    registerTool: (tool: typeof bash) => {
      bash = tool;
    },
    registerCommand: (name: string, command: any) => commands.set(name, command.handler),
    registerFlag() {},
    registerShortcut() {},
    getFlag: () => false,
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: root,
    hasUI: false,
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus() {},
      theme: { fg: (_color: string, text: string) => text },
    },
  } as unknown as ExtensionContext;
  registerSandboxExtension(api, manager);
  const marker = join(root, "must-not-exist");
  const execute = () =>
    bash.execute("test", { command: `touch '${marker}'` }, undefined, undefined, ctx);
  const userBash = () => handlers.get("user_bash")!({ command: `touch '${marker}'` }, ctx);

  await assert.rejects(execute(), /Sandbox has not initialized/);
  assert.equal((await userBash()).result.exitCode, 1);

  await handlers.get("session_start")!({}, ctx);
  assert.equal(resets, 1, "failed initialization releases partial resources");
  await assert.rejects(execute(), /setup refused.*Bash is blocked/);
  const blocked = await userBash();
  assert.equal(blocked.result.exitCode, 1);
  assert.match(blocked.result.output, /setup refused/);
  assert.equal(blocked.operations, undefined);
  assert.equal(existsSync(marker), false);
  assert.ok(notifications.some((message) => message.includes("Bash is blocked")));

  // A successful explicit retry restores sandbox operations, not local execution.
  fail = false;
  await commands.get("sandbox-enable")!("", ctx);
  assert.ok((await userBash()).operations);
  await commands.get("sandbox-disable")!("", ctx);
  assert.equal(await userBash(), undefined, "explicit disable permits Pi's local user shell");
  await execute();
  assert.equal(existsSync(marker), true);

  // Trying to enable again reinstates the requirement even after an opt-out.
  fail = true;
  await commands.get("sandbox-enable")!("", ctx);
  await assert.rejects(execute(), /setup refused/);
  assert.equal((await userBash()).result.exitCode, 1);
  await commands.get("sandbox-disable")!("", ctx);
  assert.equal(await userBash(), undefined, "explicit disable also works after failed startup");
});
