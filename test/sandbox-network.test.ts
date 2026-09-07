import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { SandboxManager } from "@carderne/sandbox-runtime";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG } from "../src/config.ts";
import { initializeSandbox, updateSandboxConfig } from "../src/sandbox-runtime.ts";

test(
  "permission updates preserve the proxy and enforce the new allowlist",
  {
    skip: process.platform !== "darwin",
    timeout: 15_000,
  },
  async (t) => {
    let releaseResponse: (() => void) | undefined;
    let responseStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      responseStarted = resolve;
    });
    const origin = createServer((req, res) => {
      if (req.url === "/hold") {
        res.write("before");
        releaseResponse = () => res.end("after");
      } else {
        res.end("ok");
      }
    });
    t.after(async () => {
      releaseResponse?.();
      origin.closeAllConnections();
      origin.close();
      await SandboxManager.reset();
    });
    await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
    const originPort = (origin.address() as AddressInfo).port;
    const config = {
      ...DEFAULT_CONFIG,
      network: { ...DEFAULT_CONFIG.network!, allowedDomains: ["127.0.0.1"] },
    };
    await initializeSandbox(config);
    const proxyPort = SandboxManager.getProxyPort();
    const socksPort = SandboxManager.getSocksProxyPort();
    const token = SandboxManager.getProxyAuthToken();
    assert.ok(proxyPort);
    assert.ok(socksPort);

    function throughProxy(host: string, path = "/") {
      return new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: proxyPort,
            path: `http://${host}:${originPort}${path}`,
            headers: token
              ? { "Proxy-Authorization": `Basic ${Buffer.from(`srt:${token}`).toString("base64")}` }
              : {},
          },
          (res) => {
            let body = "";
            res.on("data", (data) => {
              body += data.toString();
              if (path === "/hold") responseStarted?.();
            });
            res.on("error", reject);
            res.on("end", () => resolve({ status: res.statusCode, body }));
          },
        );
        req.on("error", reject);
        req.end();
      });
    }

    const pending = throughProxy("127.0.0.1", "/hold");
    // Attach a handler immediately so a broken refresh reports a test failure,
    // rather than an unhandled rejection from the interrupted connection.
    pending.catch(() => {});
    await started;
    updateSandboxConfig(
      { ...config, network: { ...config.network, allowedDomains: ["localhost"] } },
      {
        domains: [],
        readPaths: ["/tmp/newly-allowed"],
        writePaths: [],
      },
    );
    assert.equal(SandboxManager.getProxyPort(), proxyPort);
    assert.equal(SandboxManager.getSocksProxyPort(), socksPort);
    assert.equal((await throughProxy("127.0.0.1")).status, 403);
    assert.deepEqual(await throughProxy("localhost"), { status: 200, body: "ok" });
    releaseResponse!();
    assert.deepEqual(await pending, { status: 200, body: "beforeafter" });
  },
);
