import type { Component, TUI } from "@earendil-works/pi-tui";

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";

import extension from "../src/extension.ts";

async function fixture(t: TestContext, enableAccessRequestTool: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-sandbox-access-")));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  writeFileSync(
    join(agentDir, "sandbox.json"),
    JSON.stringify({
      enabled: false,
      enableAccessRequestTool,
      network: { allowedDomains: ["allowed.example"], deniedDomains: ["blocked.example"] },
      filesystem: {
        allowRead: [join(root, "read")],
        allowWrite: [join(root, "write")],
        denyWrite: [join(root, "write", "denied")],
      },
    }),
  );
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });
  const tools = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>();
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
  let prompts = 0;
  let input: ((data: string) => { consume?: boolean } | undefined) | undefined;
  let widget: (Component & { dispose?(): void }) | undefined;
  const editor = Object.create(CustomEditor.prototype) as CustomEditor;
  const tui = { requestRender() {}, getFocusedComponent: () => editor } as unknown as TUI;
  const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
  const api = {
    registerTool: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => tools.set(tool.name, tool),
    on: (event: string, handler: (event: any, ctx: ExtensionContext) => any) =>
      handlers.set(event, handler),
    registerFlag() {},
    registerShortcut() {},
    registerCommand() {},
    getFlag: () => false,
    events: { emit() {} },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: root,
    hasUI: true,
    isProjectTrusted: () => true,
    ui: {
      notify() {},
      onTerminalInput(handler: typeof input) {
        input = handler;
        return () => {
          input = undefined;
        };
      },
      setWidget(_key: string, factory?: (tui: TUI, theme: Theme) => typeof widget) {
        widget?.dispose?.();
        widget = undefined;
        if (!factory) return;
        prompts++;
        widget = factory(tui, theme);
      },
    },
  } as unknown as ExtensionContext;
  extension(api);
  t.after(() => handlers.get("session_shutdown")!({}, ctx));
  await handlers.get("session_start")!({}, ctx);
  return {
    root,
    tools,
    prompts: () => prompts,
    send: (data: string) => {
      assert.ok(input, "Permission widget must be listening for input");
      input(data);
    },
    execute: (name: string, params: Record<string, unknown> = {}) =>
      tools.get(name)!.execute("test", params, undefined, undefined, ctx),
  };
}

test("access tools remain opt-in", async (t) => {
  const f = await fixture(t, false);
  assert.equal(f.tools.has("sandbox_status"), false);
  assert.equal(f.tools.has("sandbox_request_access"), false);
});

test("access tools report effective grants and avoid redundant or forbidden prompts", async (t) => {
  const f = await fixture(t, true);
  const request = (kind: string, target: string) =>
    f.execute("sandbox_request_access", { kind, target, reason: "Inspect project" });
  const status = async () => {
    const result = await f.execute("sandbox_status");
    const content = result.content.find((part) => part.type === "text");
    assert.ok(content && content.type === "text");
    return JSON.parse(content.text);
  };
  const initial = await status();
  assert.equal(initial.enabled, false);
  assert.deepEqual(initial.network.allowedDomains, ["allowed.example"]);
  assert.ok(initial.filesystem.allowRead.includes(join(f.root, "write")));
  assert.deepEqual(initial.sessionGrants, { domains: [], readPaths: [], writePaths: [] });

  await request("domain", "allowed.example");
  await request("read", join(f.root, "write", "file"));
  await request("write", join(f.root, "write", "file"));
  await assert.rejects(request("write", join(f.root, "write", "denied")), /explicitly denied/);
  await assert.rejects(request("domain", "blocked.example"), /explicitly denied/);
  assert.equal(f.prompts(), 0);

  const pending = request("read", join(f.root, "new", "file"));
  await setImmediate();
  f.send("\t");
  f.send("\x15");
  f.send(join(f.root, "new"));
  f.send("\r");
  const granted = await pending;
  const message = granted.content.find((part) => part.type === "text");
  assert.ok(message && message.type === "text");
  assert.ok(message.text.includes(`Rule: ${JSON.stringify(join(f.root, "new"))}`));
  assert.match(message.text, /Scope: session/);
  const updated = await status();
  assert.ok(updated.filesystem.allowRead.includes(join(f.root, "new")));
  assert.deepEqual(updated.sessionGrants.readPaths, [join(f.root, "new")]);
  await request("read", join(f.root, "new", "another-file"));
  assert.equal(f.prompts(), 1);
});
