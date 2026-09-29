import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createConnection, createServer as createUnixServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import assert from "node:assert/strict";

import { createSandboxManager } from "../src/runtime.ts";
import {
  createSandboxedBashOps,
  initializeSandbox,
  updateSandboxConfig,
} from "../src/sandbox-runtime.ts";
import { quote } from "../vendor/sandbox-runtime/src/utils/shell-quote.ts";

// Real manager, real native relays, real proxies, and harmless local fixtures.
// No host security changes and no real SSH-agent/D-Bus/keyring connections.
test(
  "Linux runtime enforces filesystem, Unix IPC, helper and proxy boundaries",
  {
    skip: process.env.PI_SANDBOX_NATIVE_TEST !== "1",
    timeout: 60_000,
  },
  async (t) => {
    assert.equal(process.platform, "linux");
    const root = mkdtempSync(join(tmpdir(), "pi-sandbox-runtime-"));
    const work = join(root, "work");
    const readDenied = join(root, "hidden");
    mkdirSync(work);
    mkdirSync(readDenied);
    const deniedWrite = join(work, ".env");
    writeFileSync(deniedWrite, "unchanged");
    writeFileSync(join(readDenied, "secret"), "private fixture");
    const large = Buffer.alloc(256 * 1024, "proxy-data-");
    const origin = createServer((req, res) => {
      res.end(req.url === "/large" ? large : "origin OK");
    });
    const socketPath = join(root, "agent-fixture.sock");
    const unixServer = createUnixServer((socket) => socket.end("private IPC"));
    const manager = createSandboxManager();
    t.after(async () => {
      await manager.reset();
      origin.closeAllConnections();
      origin.close();
      unixServer.close();
      rmSync(root, { recursive: true, force: true });
    });
    await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => unixServer.listen(socketPath, resolve));
    // Positive control: the Unix fixture is live and accessible to this host user.
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(socketPath);
      socket.on("error", reject);
      socket.on("data", () => {});
      socket.on("end", resolve);
    });
    const port = (origin.address() as AddressInfo).port;
    const config = {
      network: { allowedDomains: ["localhost"], deniedDomains: [], allowAllUnixSockets: false },
      filesystem: {
        denyRead: [readDenied],
        allowRead: [work],
        allowWrite: [work],
        denyWrite: [deniedWrite],
      },
    };
    await initializeSandbox(manager, config);
    const ops = createSandboxedBashOps(manager, "/bin/bash", false);
    const run = async (command: string, timeout = 10) => {
      let output = "";
      const result = await ops.exec(command, work, {
        timeout,
        env: { ...process.env, NO_PROXY: "", no_proxy: "" },
        onData: (data) => {
          output += data.toString();
        },
      });
      return { ...result, output };
    };
    const succeeds = async (command: string) => {
      const result = await run(command);
      assert.equal(result.exitCode, 0, result.output);
      return result.output;
    };
    const curl = (host: string, path = "/") =>
      `curl --silent --show-error --fail --max-time 5 --noproxy '' http://${host}:${port}${path}`;

    await t.test(
      "native path is selected; basic Bash and filesystem enforcement work",
      async () => {
        const wrapped = await manager.wrapWithSandbox("echo OK", "/bin/bash");
        try {
          assert.match(wrapped, /--as-pid-1/);
          assert.match(wrapped, /sandbox-launcher/);
          assert.doesNotMatch(wrapped, /apply-seccomp|TCP-LISTEN/);
          assert.match(wrapped, /--cap-drop ALL/);
        } finally {
          manager.cleanupAfterCommand();
        }
        assert.equal(await succeeds("echo 'basic bash command OK'"), "basic bash command OK\n");
        assert.equal(await succeeds("cat <(printf hello) | tr a-z A-Z"), "HELLO");
        await succeeds("printf writable > normal.txt");
        assert.equal(readFileSync(join(work, "normal.txt"), "utf8"), "writable");
        assert.notEqual((await run("printf forbidden > .env")).exitCode, 0);
        assert.equal(readFileSync(deniedWrite, "utf8"), "unchanged");
        assert.notEqual((await run(quote(["cat", join(readDenied, "secret")]))).exitCode, 0);
      },
    );
    await t.test("HTTP allowlisting and backpressure work through native relays", async () => {
      assert.equal(await succeeds(curl("localhost")), "origin OK");
      const denied = await run(curl("127.0.0.1"));
      assert.notEqual(denied.exitCode, 0);
      assert.match(denied.output, /403/);
      const digest = createHash("sha256").update(large).digest("hex");
      assert.match(
        await succeeds(`${curl("localhost", "/large")} | sha256sum`),
        new RegExp(`^${digest}`),
      );
      const direct = await run(
        `curl --silent --show-error --fail --max-time 2 --noproxy '*' http://127.0.0.1:${port}/`,
      );
      assert.notEqual(direct.exitCode, 0, "host TCP is not directly reachable");
    });
    await t.test("authenticated SOCKS allowlisting remains enforced", async () => {
      // Curl's SOCKS path gets the same credentials as HTTP but uses port 1080.
      const prefix = 'proxy="${HTTP_PROXY/3128/1080}"; proxy="${proxy/http:/socks5h:}"; ';
      assert.equal(
        await succeeds(
          prefix + `curl -fsS --max-time 5 --noproxy '' --proxy "$proxy" http://localhost:${port}/`,
        ),
        "origin OK",
      );
      assert.notEqual(
        (
          await run(
            prefix +
              `curl -fsS --max-time 5 --noproxy '' --proxy "$proxy" http://127.0.0.1:${port}/`,
          )
        ).exitCode,
        0,
      );
    });
    await t.test("Unix IPC, PID 1 and actual relay processes are protected", async () => {
      const probe = fileURLToPath(new URL("fixtures/linux-launcher-probe.py", import.meta.url));
      assert.match(await succeeds(quote(["python3", probe])), /ALL CHECKS PASSED/);
      const program = [
        "import os, socket, stat, time",
        `assert stat.S_ISSOCK(os.stat(${JSON.stringify(socketPath)}).st_mode)`,
        "for make in [lambda: socket.socket(socket.AF_UNIX), lambda: socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM)]:",
        " try: make(); raise AssertionError('Unix socket permitted')",
        " except PermissionError: pass",
        "connection = socket.create_connection(('127.0.0.1', 3128), timeout=2)",
        "for attempt in range(100):",
        " helpers = [int(p) for p in os.listdir('/proc') if p.isdigit() and int(p) != os.getpid() and open('/proc/'+p+'/comm').read().strip() == 'sandbox-launche']",
        " if len(helpers) >= 3: break",
        " time.sleep(.01)",
        // Linux comm truncates sandbox-launcher to 15 bytes. Check PID 1,
        // the relay listener, AND its live per-connection child.
        "assert len(helpers) >= 3, helpers",
        "for pid in helpers:",
        " for suffix in ['mem', 'fd/0']:",
        "  try:",
        "   with open(f'/proc/{pid}/{suffix}', 'rb'): raise AssertionError('helper accessible')",
        "  except PermissionError: pass",
        "print('relay IPC protection OK')",
      ].join("\n");
      assert.match(await succeeds(quote(["python3", "-c", program])), /relay IPC protection OK/);
    });
    await t.test(
      "parallel commands retain their own relays and live allowlist updates",
      async () => {
        const results = await Promise.all(
          Array.from({ length: 4 }, () => succeeds(curl("localhost"))),
        );
        assert.deepEqual(results, Array(4).fill("origin OK"));
        updateSandboxConfig(
          manager,
          { ...config, network: { ...config.network, allowedDomains: ["127.0.0.1"] } },
          { domains: [], readPaths: [], writePaths: [] },
        );
        assert.equal(await succeeds(curl("127.0.0.1")), "origin OK");
        assert.notEqual((await run(curl("localhost"))).exitCode, 0);
      },
    );
    await t.test("relay death fails closed and cancellation cleans the namespace", async () => {
      const killed = await run("kill -KILL 2; sleep 30");
      assert.equal(killed.exitCode, 125, killed.output);
      assert.match(killed.output, /network relay exited/);
      await assert.rejects(run("sleep 30", 0.1), /timeout/);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 100);
      try {
        await assert.rejects(
          ops.exec("sleep 30", work, {
            env: process.env,
            signal: controller.signal,
            onData: () => {},
          }),
          /aborted/,
        );
      } finally {
        clearTimeout(timer);
      }
      assert.equal(await succeeds("echo survived"), "survived\n");
    });
  },
);
