import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import assert from "node:assert/strict";

test(
  "Pi's actual jiti loader runs Bash and user_bash through the vendored runtime",
  {
    skip: process.env.PI_SANDBOX_NATIVE_TEST !== "1",
    timeout: 20_000,
  },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "pi-loader-"));
    const cwd = join(root, "work");
    const agent = join(root, "agent");
    mkdirSync(cwd);
    mkdirSync(agent);
    const previousDir = process.env.PI_CODING_AGENT_DIR;
    const previousCwd = process.cwd();
    process.env.PI_CODING_AGENT_DIR = agent;
    process.chdir(cwd);
    t.after(() => {
      process.chdir(previousCwd);
      if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousDir;
      rmSync(root, { recursive: true, force: true });
    });
    writeFileSync(
      join(agent, "sandbox.json"),
      JSON.stringify({
        enabled: true,
        sandboxUserShell: true,
        network: { allowAllUnixSockets: false, allowedDomains: [], deniedDomains: [] },
        filesystem: { denyRead: ["/home"], allowRead: [cwd], allowWrite: [cwd], denyWrite: [] },
      }),
    );
    const loaderUrl = new URL(
      "./core/extensions/loader.js",
      import.meta.resolve("@earendil-works/pi-coding-agent"),
    );
    const { loadExtensions } = await import(loaderUrl.href);
    const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
    const loaded = await loadExtensions([entry], cwd);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const extension = loaded.extensions[0];
    const errors: string[] = [];
    const ctx = {
      cwd,
      hasUI: false,
      mode: "print",
      sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined },
      ui: {
        notify: (message: string, level: string) => {
          if (level === "error") errors.push(message);
        },
        setStatus() {},
        theme: { fg: (_color: string, value: string) => value },
      },
    };
    try {
      for (const handler of extension.handlers.get("session_start") ?? []) await handler({}, ctx);
      assert.deepEqual(errors, []);
      const result = await extension.tools.get("bash").definition.execute(
        "test",
        {
          command: "echo 'basic bash command OK'",
          timeout: 10,
        },
        undefined,
        undefined,
        ctx,
      );
      assert.equal(result.content[0].text.trim(), "basic bash command OK");
      for (const handler of extension.handlers.get("user_bash") ?? []) {
        const handled = await handler({ command: "echo 'user bash OK'" }, ctx);
        assert.ok(handled?.operations, "user_bash must not fall through to local execution");
        let output = "";
        const result = await handled.operations.exec("echo 'user bash OK'", cwd, {
          timeout: 10,
          env: { ...process.env },
          onData: (data: Buffer) => {
            output += data.toString();
          },
        });
        assert.equal(result.exitCode, 0, output);
        assert.equal(output.trim(), "user bash OK");
      }
    } finally {
      for (const handler of extension.handlers.get("session_shutdown") ?? [])
        await handler({}, ctx);
    }
  },
);
