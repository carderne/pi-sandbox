import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import extension from "../src/extension.ts";

type Handler = (event: any, ctx: ExtensionContext) => any;

function session(cwd: string) {
  const handlers = new Map<string, Handler>();
  let bash: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
  const errors: string[] = [];
  const api = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerTool: (tool: typeof bash) => {
      if (tool?.name === "bash") bash = tool;
    },
    registerFlag: () => {},
    registerShortcut: () => {},
    registerCommand: () => {},
    getFlag: () => false,
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    hasUI: false,
    ui: {
      notify: (message: string, level: string) => {
        if (level === "error") errors.push(message);
      },
      setStatus: () => {},
      theme: { fg: (_color: string, text: string) => text },
    },
  } as unknown as ExtensionContext;
  extension(api);
  return {
    async start() {
      await handlers.get("session_start")!({ reason: "startup" }, ctx);
      assert.deepEqual(errors, []);
    },
    async shutdown() {
      await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
    },
    async bash(command: string) {
      const result = await bash!.execute(
        "test",
        { command, timeout: 5 },
        undefined,
        undefined,
        ctx,
      );
      return result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
    },
    async userBash(command: string) {
      const result = await handlers.get("user_bash")!({ command, cwd }, ctx);
      assert.ok(result.operations);
      let output = "";
      const execution = await result.operations.exec(command, cwd, {
        timeout: 5,
        env: { ...process.env },
        onData: (data: Buffer) => {
          output += data.toString();
        },
      });
      assert.equal(execution.exitCode, 0, output);
      return output;
    },
  };
}

test(
  "a subagent shutdown does not stop its parent's bash or user shell",
  {
    skip: process.platform !== "darwin",
    timeout: 15_000,
  },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "pi-sandbox-sessions-"));
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    mkdirSync(process.env.PI_CODING_AGENT_DIR);
    writeFileSync(
      join(process.env.PI_CODING_AGENT_DIR, "sandbox.json"),
      JSON.stringify({
        enabled: true,
        network: { allowedDomains: ["localhost"], deniedDomains: [] },
        filesystem: { denyRead: [], allowRead: [], allowWrite: [root], denyWrite: [] },
      }),
    );
    const parent = session(root);
    const child = session(root);
    t.after(async () => {
      await Promise.all([parent.shutdown(), child.shutdown()]);
      if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
      rmSync(root, { recursive: true, force: true });
    });
    await Promise.all([parent.start(), child.start()]);
    const command = `printf '%s' "$GIT_SSH_COMMAND"`;
    const parentProxy = await parent.bash(command);
    assert.match(parentProxy, /ProxyCommand/);
    assert.notEqual(parentProxy, await child.bash(command));
    await child.shutdown();
    assert.equal(await parent.bash(command), parentProxy);
    assert.equal(await parent.userBash(command), parentProxy);
  },
);
