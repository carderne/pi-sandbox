import { spawn } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { requireLinuxLauncher } from "../vendor/sandbox-runtime/src/sandbox/linux-launcher.ts";

test(
  "native relays pin endpoints and preserve bidirectional half-close/backpressure",
  {
    skip: process.env.PI_SANDBOX_NATIVE_TEST !== "1",
    timeout: 20_000,
  },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "pi-relay-"));
    const bridge = join(root, "bridge.sock");
    const privatePath = join(root, "private.sock");
    const go = join(root, "go");
    let privateConnections = 0;
    const connections = new Set<Socket>();
    const servers: Server[] = [];
    const approved = createServer({ allowHalfOpen: true }, (socket) => {
      connections.add(socket);
      socket.on("close", () => connections.delete(socket));
      socket.on("error", () => {});
      const chunks: Buffer[] = [];
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.on("end", () => socket.end(Buffer.concat(chunks)));
    });
    const forbidden = createServer((socket) => {
      privateConnections++;
      socket.end("wrong endpoint");
    });
    servers.push(approved, forbidden);
    t.after(() => {
      for (const connection of connections) connection.destroy();
      for (const server of servers) server.close();
      rmSync(root, { recursive: true, force: true });
    });
    await Promise.all([
      new Promise<void>((resolve) => approved.listen(bridge, resolve)),
      new Promise<void>((resolve) => forbidden.listen(privatePath, resolve)),
    ]);
    const program = [
      "import os, socket, time",
      "print('READY', flush=True)",
      `while not os.path.exists(${JSON.stringify(go)}): time.sleep(.01)`,
      "payload = bytes(range(256)) * 4096",
      "for port in (3128, 1080):",
      " with socket.create_connection(('127.0.0.1', port), timeout=5) as s:",
      "  s.sendall(payload)",
      "  s.shutdown(socket.SHUT_WR)",
      "  result = bytearray()",
      "  while True:",
      "   chunk = s.recv(8192)",
      "   if not chunk: break",
      "   result.extend(chunk)",
      "  assert result == payload, len(result)",
      "print('PINNED and HALF-CLOSE OK')",
    ].join("\n");
    // No socket bind-mount: this specifically tests native inode pinning, not
    // Bubblewrap accidentally pinning the endpoint on the relay's behalf.
    const child = spawn(
      "bwrap",
      [
        "--new-session",
        "--die-with-parent",
        "--unshare-user",
        "--unshare-pid",
        "--unshare-net",
        "--cap-drop",
        "ALL",
        "--ro-bind",
        "/",
        "/",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--as-pid-1",
        "--",
        requireLinuxLauncher(),
        "--http-socket",
        bridge,
        "--socks-socket",
        bridge,
        "--",
        "python3",
        "-c",
        program,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    t.after(() => child.kill("SIGKILL"));
    let output = "";
    let swapped = false;
    let positiveControl: Promise<void> | undefined;
    child.stdout.on("data", (data) => {
      output += data.toString();
      if (!swapped && output.includes("READY")) {
        swapped = true;
        renameSync(bridge, join(root, "original.sock"));
        symlinkSync(privatePath, bridge);
        // Positive control: ordinary pathname lookup now reaches the replacement.
        positiveControl = new Promise<void>((resolve, reject) => {
          const socket = createConnection(bridge);
          socket.on("error", reject);
          socket.on("data", () => {});
          socket.on("end", resolve);
        });
        writeFileSync(go, "go");
      }
    });
    child.stderr.on("data", (data) => {
      output += data.toString();
    });
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    await positiveControl;
    assert.equal(exit, 0, output);
    assert.equal(swapped, true);
    assert.match(output, /PINNED and HALF-CLOSE OK/);
    assert.equal(privateConnections, 1, "only the host positive control may reach the replacement");
  },
);
