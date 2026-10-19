import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createSandboxManager } from "@carderne/sandbox-runtime";
import assert from "node:assert/strict";

import extension from "../src/extension.ts";

const runtimeDir = dirname(fileURLToPath(import.meta.resolve("@carderne/sandbox-runtime")));
const { wrapCommandWithSandboxLinux, cleanupBwrapMountPoints } = await import(
  pathToFileURL(join(runtimeDir, "sandbox/linux-sandbox-utils.js")).href
);

test(
  "serial sandbox arguments select character devices and safe stable links without hardware",
  {
    skip: process.platform !== "linux",
  },
  async (t) => {
    let discoveries = 0;
    const originalRead = fs.readdirSync;
    const originalStat = fs.lstatSync;
    const originalRealpath = fs.realpathSync;
    const nodeNames = ["ttyACM0", "ttyUSB2", "ttyACM9", "ttyUSB8", "sda", "ttyACMbad"];
    const missing = () => Object.assign(new Error("gone"), { code: "ENOENT" });
    t.mock.method(fs, "readdirSync", (path: fs.PathLike, ...args: unknown[]) => {
      if (path === "/dev") {
        discoveries++;
        return nodeNames;
      }
      if (path === "/dev/serial/by-id") return ["safe", "disk", "gone"];
      if (path === "/dev/serial/by-path") return ["safe-path"];
      return Reflect.apply(originalRead, fs, [path, ...args]);
    });
    t.mock.method(fs, "lstatSync", (path: fs.PathLike, ...args: unknown[]) => {
      if (path === "/dev/ttyUSB8") throw missing();
      if (nodeNames.some((name) => path === `/dev/${name}`)) {
        return { isCharacterDevice: () => path === "/dev/ttyACM0" || path === "/dev/ttyUSB2" };
      }
      if (String(path).startsWith("/dev/serial/")) return { isSymbolicLink: () => true };
      return Reflect.apply(originalStat, fs, [path, ...args]);
    });
    t.mock.method(fs, "realpathSync", (path: fs.PathLike, ...args: unknown[]) => {
      if (path === "/dev/serial/by-path/safe-path") return "/dev/ttyUSB2";
      if (path === "/dev/serial/by-id/safe") return "/dev/ttyACM0";
      if (path === "/dev/serial/by-id/disk") return "/dev/sda";
      if (path === "/dev/serial/by-id/gone") throw missing();
      return Reflect.apply(originalRealpath, fs, [path, ...args]);
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    const params = {
      command: "true",
      needsNetworkRestriction: true,
      allowAllUnixSockets: true,
      binShell: "/bin/sh",
      bwrapPath: "/usr/bin/bwrap",
    };
    for (const enabled of [false, true]) {
      let wrapped: string;
      try {
        wrapped = await wrapCommandWithSandboxLinux({ ...params, allowSerialDevices: enabled });
      } finally {
        cleanupBwrapMountPoints();
      }
      assert.match(wrapped, /--dev \/dev/);
      assert.match(wrapped, /--unshare-net/);
      if (!enabled) {
        assert.doesNotMatch(wrapped, /--dev-bind-try|--symlink/);
        continue;
      }
      assert.match(wrapped, /--dev-bind-try \/dev\/ttyACM0 \/dev\/ttyACM0/);
      assert.match(wrapped, /--dev-bind-try \/dev\/ttyUSB2 \/dev\/ttyUSB2/);
      assert.match(wrapped, /--symlink \/dev\/ttyACM0 \/dev\/serial\/by-id\/safe/);
      assert.match(wrapped, /--symlink \/dev\/ttyUSB2 \/dev\/serial\/by-path\/safe-path/);
      assert.doesNotMatch(
        wrapped,
        /ttyACM9|ttyUSB8|sda|ttyACMbad|by-id\/disk|by-id\/gone|--dev-bind \/dev/,
      );
    }
    const config = {
      network: { allowedDomains: [], deniedDomains: [], allowAllUnixSockets: true },
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
      allowSerialDevices: false,
    };
    const manager = createSandboxManager();
    await manager.initialize(config);
    t.after(() => manager.reset());
    const pending = manager.wrapWithSandbox("true", "/bin/sh");
    const enabledConfig = { ...config, allowSerialDevices: true };
    manager.updateConfig(enabledConfig);
    assert.doesNotMatch(await pending, /--dev-bind-try/);
    manager.cleanupAfterCommand();
    const enabledWrap = manager.wrapWithSandbox("true", "/bin/sh");
    manager.updateConfig(config);
    assert.match(await enabledWrap, /--dev-bind-try/);
    manager.cleanupAfterCommand();

    const root = fs.mkdtempSync("/tmp/pi-serial-flow-");
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    t.after(() => {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    });
    const save = (enabled: boolean) =>
      fs.writeFileSync(
        join(root, "sandbox.json"),
        JSON.stringify({ ...config, enabled: true, allowSerialDevices: enabled }),
      );
    save(false);
    const handlers = new Map<string, Function>();
    const commands = new Map<string, Function>();
    let bash: Parameters<ExtensionAPI["registerTool"]>[0];
    extension({
      on: (name: string, handler: Function) => handlers.set(name, handler),
      registerCommand: (name: string, value: { handler: Function }) =>
        commands.set(name, value.handler),
      registerTool: (tool: typeof bash) => {
        bash = tool;
      },
      registerFlag: () => {},
      registerShortcut: () => {},
      getFlag: () => false,
    } as unknown as ExtensionAPI);
    const ctx = {
      cwd: root,
      hasUI: false,
      isProjectTrusted: () => true,
      ui: {
        notify: () => {},
        setStatus: () => {},
        theme: { fg: (_: string, value: string) => value },
      },
    } as unknown as ExtensionContext;
    await handlers.get("session_start")!({}, ctx);
    t.after(() => handlers.get("session_shutdown")!({}, ctx));
    const check = async (expected: boolean) => {
      for (const user of [false, true]) {
        const before = discoveries;
        if (user) {
          const result = await handlers.get("user_bash")!({ command: "true" }, ctx);
          await result.operations.exec("true", root, {
            env: { ...process.env },
            onData: () => {},
            timeout: 5,
          });
        } else {
          try {
            await bash!.execute("test", { command: "true", timeout: 5 }, undefined, undefined, ctx);
          } catch (error) {
            assert.match(String(error), /bwrap|Command exited/);
          }
        }
        assert.equal(
          discoveries > before,
          expected,
          `serial discovery through ${user ? "user shell" : "bash tool"}`,
        );
      }
    };
    await check(false);
    await commands.get("sandbox-serial")!("on", ctx);
    await check(true);
    await commands.get("sandbox-serial")!("off", ctx);
    save(true);
    await check(false);
    await commands.get("sandbox-serial")!("reset", ctx);
    await check(true);
    save(false);
    await check(false);
  },
);

test("publication refuses the local-only patched runtime", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const manifest = JSON.parse(fs.readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(manifest.scripts.prepublishOnly, "node scripts/block-publish.mjs");
  const result = spawnSync(process.execPath, [join(root, "scripts/block-publish.mjs")], {
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Publishing blocked.*local pnpm runtime patch/);
});
