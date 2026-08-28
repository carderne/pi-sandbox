import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock, type TestContext } from "node:test";
import assert from "node:assert/strict";

import {
  SandboxManager,
  type PrepareSandboxAttemptOptions,
  type SandboxAskCallback,
  type SandboxAttemptHandle,
  type SandboxRuntimeConfig,
} from "@carderne/sandbox-runtime";

import { DEFAULT_CONFIG } from "../src/config.ts";
import { canonicalizePath } from "../src/policy.ts";
import {
  buildRuntimeConfig,
  createAttributedSandboxedBashOps,
  createSandboxedBashOps,
  extractBlockedWritePath,
  initializeSandbox,
  resolveAllowances,
  supportsNodeEnvProxy,
  type AttributedSandboxedBashOps,
  updateSandboxConfig,
} from "../src/sandbox-runtime.ts";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function createExecTestContext(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-sandbox-exec-"));
  const backgroundPidPaths: string[] = [];

  // Exercise exec without an OS sandbox session: identity wrap, no SSH proxy.
  mock.method(SandboxManager, "wrapWithSandbox", async (command: string) => command);
  t.after(() => {
    try {
      for (const pidPath of backgroundPidPaths) terminateRecordedProcess(pidPath);
    } finally {
      mock.restoreAll();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  return {
    cwd,
    exec: createSandboxedBashOps(undefined, false).exec,
    trackBackgroundProcess: (pidPath: string) => backgroundPidPaths.push(pidPath),
  };
}

function terminateRecordedProcess(pidPath: string): void {
  try {
    const pid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error.code !== "ENOENT" && error.code !== "ESRCH")
    ) {
      throw error;
    }
  }
}

function backgroundNodeCommand(cwd: string, source: string): { command: string; pidPath: string } {
  const pidPath = join(cwd, "background.pid");
  const childSource = [
    `require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
    source,
  ].join("\n");
  const command = [
    `${shellQuote(process.execPath)} -e ${shellQuote(childSource)} &`,
    `while [ ! -s ${shellQuote(pidPath)} ]; do sleep 0.01; done`,
  ].join(" ");
  return { command, pidPath };
}

test("buildRuntimeConfig adds session allowances without mutating config", () => {
  const runtime = buildRuntimeConfig(DEFAULT_CONFIG, {
    domains: ["example.com"],
    readPaths: ["/read"],
    writePaths: ["/write"],
  });
  assert.equal(runtime.network?.allowedDomains?.includes("example.com"), true);
  assert.equal(runtime.filesystem?.allowRead?.includes("/read"), true);
  assert.equal(runtime.filesystem?.allowRead?.includes("/write"), true);
  assert.equal(runtime.filesystem?.allowWrite?.includes("/write"), true);
  assert.equal(DEFAULT_CONFIG.network?.allowedDomains?.includes("example.com"), false);
});

test("buildRuntimeConfig canonicalizes non-glob filesystem paths", () => {
  const runtime = buildRuntimeConfig({
    ...DEFAULT_CONFIG,
    filesystem: {
      ...DEFAULT_CONFIG.filesystem!,
      denyRead: ["/tmp"],
      allowRead: [],
      allowWrite: ["/tmp"],
      denyWrite: ["*.key"],
    },
  });

  assert.deepEqual(runtime.filesystem?.denyRead, [canonicalizePath("/tmp")]);
  assert.equal(runtime.filesystem?.allowRead?.includes(canonicalizePath("/tmp")), true);
  assert.deepEqual(runtime.filesystem?.allowWrite, [canonicalizePath("/tmp")]);
  assert.deepEqual(runtime.filesystem?.denyWrite, ["*.key"]);
});

test("resolveAllowances makes configured and session write paths readable", () => {
  const config = {
    ...DEFAULT_CONFIG,
    filesystem: {
      ...DEFAULT_CONFIG.filesystem!,
      allowRead: [],
      allowWrite: ["/configured-write"],
    },
  };
  const effective = resolveAllowances(config, {
    domains: [],
    readPaths: [],
    writePaths: ["/session-write"],
  });

  assert.deepEqual(effective.readPaths, ["/configured-write", "/session-write"]);
  assert.deepEqual(effective.writePaths, ["/configured-write", "/session-write"]);
});

test("extractBlockedWritePath recognizes shell sandbox errors", () => {
  assert.equal(
    extractBlockedWritePath("bash: line 1: /private/file: Operation not permitted"),
    "/private/file",
  );
  assert.equal(extractBlockedWritePath("permission denied"), null);
});

test("supportsNodeEnvProxy observes Node release boundaries", () => {
  assert.equal(supportsNodeEnvProxy("22.20.0"), false);
  assert.equal(supportsNodeEnvProxy("22.21.0"), true);
  assert.equal(supportsNodeEnvProxy("23.9.0"), false);
  assert.equal(supportsNodeEnvProxy("24.0.0"), true);
});

test("exec resolves when the command exits even if a daemonized grandchild holds the stdio pipes", async (t) => {
  const { cwd, exec, trackBackgroundProcess } = createExecTestContext(t);
  const { command, pidPath } = backgroundNodeCommand(cwd, "setInterval(() => {}, 1000);");
  trackBackgroundProcess(pidPath);

  // The background process inherits stdout/stderr indefinitely. Exec should
  // return after its post-exit idle grace, not wait for natural pipe EOF.
  const started = Date.now();
  const { exitCode } = await exec(command, cwd, { onData: () => {} });
  const elapsed = Date.now() - started;

  assert.equal(exitCode, 0);
  assert.ok(elapsed < 2000, `exec returned after ${elapsed}ms; expected early teardown`);
});

test("exec drains output that stays active after the direct child exits", async (t) => {
  const { cwd, exec, trackBackgroundProcess } = createExecTestContext(t);
  const writerSource = `
let tick = 0;
const writer = setInterval(() => {
  tick += 1;
  process.stdout.write(\`stdout-\${tick}\\n\`);
  process.stderr.write(\`stderr-\${tick}\\n\`);
  if (tick === 6) clearInterval(writer);
}, 50);
setInterval(() => {}, 1000);
`;
  const { command, pidPath } = backgroundNodeCommand(cwd, writerSource);
  trackBackgroundProcess(pidPath);

  const chunks: Buffer[] = [];
  const started = Date.now();
  const { exitCode } = await exec(command, cwd, { onData: (data) => chunks.push(data) });
  const elapsed = Date.now() - started;
  const output = Buffer.concat(chunks).toString("utf8");

  assert.equal(exitCode, 0);
  for (let tick = 1; tick <= 6; tick += 1) {
    assert.ok(output.includes(`stdout-${tick}\n`), `missing stdout token ${tick}`);
    assert.ok(output.includes(`stderr-${tick}\n`), `missing stderr token ${tick}`);
  }
  assert.ok(elapsed < 2000, `exec returned after ${elapsed}ms; expected idle teardown`);
});

test("exec returns a nonzero exit code", async (t) => {
  const { cwd, exec } = createExecTestContext(t);

  assert.deepEqual(await exec("exit 7", cwd, { onData: () => {} }), { exitCode: 7 });
});

test("exec rejects after its command timeout", async (t) => {
  const { cwd, exec } = createExecTestContext(t);

  await assert.rejects(
    exec("sleep 5", cwd, { onData: () => {}, timeout: 0.05 }),
    new Error("timeout:0.05"),
  );
});

test("exec rejects when an in-flight command is aborted", async (t) => {
  const { cwd, exec } = createExecTestContext(t);
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 50);
  t.after(() => clearTimeout(abortTimer));

  await assert.rejects(
    exec("sleep 5", cwd, { onData: () => {}, signal: controller.signal }),
    new Error("aborted"),
  );
});

test("initializeSandbox enables monitoring and installs the stable domain callback", async () => {
  let callback: SandboxAskCallback | undefined;
  const initialize = mock.method(
    SandboxManager,
    "initialize",
    async (_config: SandboxRuntimeConfig, ask: SandboxAskCallback, monitor?: boolean) => {
      callback = ask;
      assert.equal(monitor, true);
    },
  );
  try {
    await initializeSandbox({
      ...DEFAULT_CONFIG,
      network: { ...DEFAULT_CONFIG.network!, allowedDomains: ["initial.example"] },
    });
    assert.ok(callback);
    assert.equal(await callback({ host: "initial.example", port: 443 }), true);
    assert.equal(await callback({ host: "future.example", port: 443 }), false);
    assert.equal(initialize.mock.callCount(), 1);
  } finally {
    initialize.mock.restore();
  }
});

test("updateSandboxConfig advances the callback only after updateConfig succeeds", async () => {
  let callback: SandboxAskCallback | undefined;
  const initialize = mock.method(
    SandboxManager,
    "initialize",
    async (_config: SandboxRuntimeConfig, ask: SandboxAskCallback) => {
      callback = ask;
    },
  );
  const update = mock.method(SandboxManager, "updateConfig", () => {});
  try {
    await initializeSandbox({
      ...DEFAULT_CONFIG,
      network: { ...DEFAULT_CONFIG.network!, allowedDomains: ["old.example"] },
    });
    const stableCallback = callback;
    updateSandboxConfig({
      ...DEFAULT_CONFIG,
      network: { ...DEFAULT_CONFIG.network!, allowedDomains: ["new.example"] },
    });
    assert.equal(callback, stableCallback);
    assert.equal(await callback!({ host: "old.example", port: 443 }), false);
    assert.equal(await callback!({ host: "new.example", port: 443 }), true);

    update.mock.mockImplementationOnce(() => {
      throw new Error("publication failed");
    });
    assert.throws(
      () =>
        updateSandboxConfig({
          ...DEFAULT_CONFIG,
          network: { ...DEFAULT_CONFIG.network!, allowedDomains: ["rejected.example"] },
        }),
      /publication failed/,
    );
    assert.equal(await callback!({ host: "new.example", port: 443 }), true);
    assert.equal(await callback!({ host: "rejected.example", port: 443 }), false);
  } finally {
    update.mock.restore();
    initialize.mock.restore();
  }
});

async function runAttributed(
  attributed: AttributedSandboxedBashOps,
  options: { signal?: AbortSignal; timeout?: number } = {},
) {
  const chunks: Buffer[] = [];
  const execution = attributed.operations.exec("same command", tmpdir(), {
    onData: (chunk) => chunks.push(chunk),
    env: { PATH: process.env.PATH },
    ...options,
  });
  return { execution, chunks };
}

test("attributed exec resolves when a daemonized grandchild holds the stdio pipes", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-sandbox-attributed-exec-"));
  const { command, pidPath } = backgroundNodeCommand(cwd, "setInterval(() => {}, 1000);");
  const prepare = mock.method(SandboxManager, "prepareSandboxAttempt", async () => ({
    attempt: { attemptId: "daemonized-grandchild" } as never,
    argv: ["/bin/sh", "-c", command],
    env: { PATH: process.env.PATH },
    sandboxBackend: "linux-bwrap" as const,
  }));
  const cleanup = mock.method(SandboxManager, "cleanupAfterCommand", () => {});
  const finish = mock.method(SandboxManager, "finishSandboxAttempt", async () => ({ denials: [] }));

  const attributed = createAttributedSandboxedBashOps();
  const execution = attributed.operations.exec("same command", cwd, { onData: () => {} });
  t.after(async () => {
    terminateRecordedProcess(pidPath);
    await execution.catch(() => {});
    finish.mock.restore();
    cleanup.mock.restore();
    prepare.mock.restore();
    rmSync(cwd, { recursive: true, force: true });
  });
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("attributed exec did not resolve after child exit")), 1000);
  });

  assert.deepEqual(await Promise.race([execution, timeout]), { exitCode: 0 });
  await attributed.finished;
});

test("command timeout excludes attributed attempt finalization time", async () => {
  const prepare = mock.method(SandboxManager, "prepareSandboxAttempt", async () => ({
    attempt: { attemptId: "slow-finish-timeout" } as never,
    argv: ["/bin/sh", "-c", "exit 0"],
    env: { PATH: process.env.PATH },
    sandboxBackend: "linux-bwrap" as const,
  }));
  const cleanup = mock.method(SandboxManager, "cleanupAfterCommand", () => {});
  const finish = mock.method(SandboxManager, "finishSandboxAttempt", async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { denials: [] };
  });
  try {
    const attributed = createAttributedSandboxedBashOps();
    const { execution } = await runAttributed(attributed, { timeout: 0.1 });
    assert.deepEqual(await execution, { exitCode: 0 });
    assert.equal((await attributed.finished).observation.termination, "exit");
  } finally {
    finish.mock.restore();
    cleanup.mock.restore();
    prepare.mock.restore();
  }
});

test("abort after child exit does not reclassify attributed finalization", async () => {
  const controller = new AbortController();
  const prepare = mock.method(SandboxManager, "prepareSandboxAttempt", async () => ({
    attempt: { attemptId: "abort-during-finish" } as never,
    argv: ["/bin/sh", "-c", "exit 0"],
    env: { PATH: process.env.PATH },
    sandboxBackend: "linux-bwrap" as const,
  }));
  const cleanup = mock.method(SandboxManager, "cleanupAfterCommand", () => {});
  const finish = mock.method(SandboxManager, "finishSandboxAttempt", async () => {
    controller.abort();
    return { denials: [] };
  });
  try {
    const attributed = createAttributedSandboxedBashOps();
    const { execution } = await runAttributed(attributed, { signal: controller.signal });
    assert.deepEqual(await execution, { exitCode: 0 });
    assert.equal((await attributed.finished).observation.termination, "exit");
  } finally {
    finish.mock.restore();
    cleanup.mock.restore();
    prepare.mock.restore();
  }
});

test("attributed operations spawn descriptor argv once and finalize after cleanup", async () => {
  const calls: string[] = [];
  const prepare = mock.method(SandboxManager, "prepareSandboxAttempt", async () => ({
    attempt: { attemptId: "a" } as never,
    argv: ["/bin/echo", "literal; exit 7"],
    env: { PATH: process.env.PATH },
    sandboxBackend: "linux-bwrap" as const,
  }));
  const cleanup = mock.method(SandboxManager, "cleanupAfterCommand", () => {
    calls.push("cleanup");
  });
  const finish = mock.method(SandboxManager, "finishSandboxAttempt", async () => {
    calls.push("finish");
    return { denials: [{ kind: "network", source: "http-proxy" }] as const };
  });
  try {
    const attributed = createAttributedSandboxedBashOps();
    const { execution, chunks } = await runAttributed(attributed);
    assert.deepEqual(await execution, { exitCode: 0 });
    assert.match(Buffer.concat(chunks).toString(), /literal; exit 7/);
    assert.deepEqual(await attributed.finished, {
      observation: {
        sandboxBackend: "linux-bwrap",
        exitCode: 0,
        signal: null,
        termination: "exit",
      },
      denials: [{ kind: "network", source: "http-proxy" }],
    });
    assert.deepEqual(calls, ["cleanup", "finish"]);
    assert.equal(prepare.mock.callCount(), 1);
  } finally {
    finish.mock.restore();
    cleanup.mock.restore();
    prepare.mock.restore();
  }
});

test("spawn errors still cleanup and finish without becoming eligible", async () => {
  const prepare = mock.method(SandboxManager, "prepareSandboxAttempt", async () => ({
    attempt: { attemptId: "spawn-error" } as never,
    argv: ["/definitely/missing/pi-sandbox-test"],
    env: {},
    sandboxBackend: "linux-seccomp" as const,
  }));
  const cleanup = mock.method(SandboxManager, "cleanupAfterCommand", () => {});
  const finish = mock.method(SandboxManager, "finishSandboxAttempt", async () => ({ denials: [] }));
  try {
    const attributed = createAttributedSandboxedBashOps();
    const { execution } = await runAttributed(attributed);
    await assert.rejects(execution);
    assert.equal((await attributed.finished).observation.termination, "spawn-error");
    assert.equal(cleanup.mock.callCount(), 1);
    assert.equal(finish.mock.callCount(), 1);
  } finally {
    finish.mock.restore();
    cleanup.mock.restore();
    prepare.mock.restore();
  }
});

test("an already-aborted signal after preparation never spawns and is finalized", async () => {
  const controller = new AbortController();
  const prepare = mock.method(SandboxManager, "prepareSandboxAttempt", async () => {
    controller.abort();
    return {
      attempt: { attemptId: "aborted" } as never,
      argv: ["/bin/echo", "must-not-run"],
      env: {},
      sandboxBackend: "macos-seatbelt" as const,
    };
  });
  const cleanup = mock.method(SandboxManager, "cleanupAfterCommand", () => {});
  const finish = mock.method(SandboxManager, "finishSandboxAttempt", async () => ({ denials: [] }));
  try {
    const attributed = createAttributedSandboxedBashOps();
    const { execution, chunks } = await runAttributed(attributed, { signal: controller.signal });
    await assert.rejects(execution, /aborted/);
    assert.deepEqual(chunks, []);
    assert.equal((await attributed.finished).observation.termination, "aborted");
  } finally {
    finish.mock.restore();
    cleanup.mock.restore();
    prepare.mock.restore();
  }
});

test("timeout, post-spawn abort, and signal close retain distinct observations", async () => {
  const descriptors = [
    {
      attempt: { attemptId: "timeout" } as never,
      argv: ["/bin/sh", "-c", "sleep 5"],
      env: { PATH: process.env.PATH },
      sandboxBackend: "linux-bwrap" as const,
    },
    {
      attempt: { attemptId: "abort" } as never,
      argv: ["/bin/sh", "-c", "sleep 5"],
      env: { PATH: process.env.PATH },
      sandboxBackend: "linux-bwrap" as const,
    },
    {
      attempt: { attemptId: "signal" } as never,
      argv: ["/bin/sh", "-c", "kill -SYS $$"],
      env: { PATH: process.env.PATH },
      sandboxBackend: "linux-seccomp" as const,
    },
  ];
  const prepare = mock.method(
    SandboxManager,
    "prepareSandboxAttempt",
    async () => descriptors.shift()!,
  );
  const cleanup = mock.method(SandboxManager, "cleanupAfterCommand", () => {});
  const finish = mock.method(SandboxManager, "finishSandboxAttempt", async () => ({ denials: [] }));
  try {
    const timed = createAttributedSandboxedBashOps();
    await assert.rejects((await runAttributed(timed, { timeout: 0.01 })).execution, /timeout/);
    assert.equal((await timed.finished).observation.termination, "timeout");

    const controller = new AbortController();
    const aborted = createAttributedSandboxedBashOps();
    const abortExecution = (await runAttributed(aborted, { signal: controller.signal })).execution;
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(abortExecution, /aborted/);
    assert.equal((await aborted.finished).observation.termination, "aborted");

    const signaled = createAttributedSandboxedBashOps();
    await (await runAttributed(signaled)).execution;
    assert.deepEqual((await signaled.finished).observation, {
      sandboxBackend: "linux-seccomp",
      exitCode: null,
      signal: "SIGSYS",
      termination: "signal",
    });
  } finally {
    finish.mock.restore();
    cleanup.mock.restore();
    prepare.mock.restore();
  }
});

test("preparation and finish failures stay runtime errors", async () => {
  const cleanup = mock.method(SandboxManager, "cleanupAfterCommand", () => {});
  const finish = mock.method(SandboxManager, "finishSandboxAttempt", async () => {
    throw new Error("finish failed");
  });
  const prepare = mock.method(SandboxManager, "prepareSandboxAttempt", async () => {
    throw new Error("prepare failed");
  });
  try {
    const preparation = createAttributedSandboxedBashOps();
    await assert.rejects((await runAttributed(preparation)).execution, /prepare failed/);
    await assert.rejects(preparation.finished, /prepare failed/);
    assert.equal(cleanup.mock.callCount(), 0);
    assert.equal(finish.mock.callCount(), 0);

    prepare.mock.mockImplementationOnce(async () => ({
      attempt: { attemptId: "finish" } as never,
      argv: ["/usr/bin/true"],
      env: { PATH: process.env.PATH },
      sandboxBackend: "linux-bwrap" as const,
    }));
    const finalization = createAttributedSandboxedBashOps();
    await assert.rejects((await runAttributed(finalization)).execution, /finish failed/);
    await assert.rejects(finalization.finished, /finish failed/);
    assert.equal(cleanup.mock.callCount(), 1);
    assert.equal(finish.mock.callCount(), 1);
  } finally {
    prepare.mock.restore();
    finish.mock.restore();
    cleanup.mock.restore();
  }
});

test("preparation receives cwd and env while identical commands retain handle evidence", async () => {
  const prepared: Array<{ cwd?: string; env?: NodeJS.ProcessEnv }> = [];
  let next = 0;
  const prepare = mock.method(
    SandboxManager,
    "prepareSandboxAttempt",
    async (options: PrepareSandboxAttemptOptions) => {
    prepared.push({ cwd: options.cwd, env: options.env });
    next++;
    return {
      attempt: { attemptId: `attempt-${next}` } as never,
      argv: ["/bin/echo", `stream-${next}`],
      env: { PATH: process.env.PATH, ATTEMPT: String(next) },
      sandboxBackend: next === 1 ? ("linux-bwrap" as const) : ("linux-seccomp" as const),
    };
    },
  );
  const cleanup = mock.method(SandboxManager, "cleanupAfterCommand", () => {});
  const finish = mock.method(
    SandboxManager,
    "finishSandboxAttempt",
    async (handle: SandboxAttemptHandle) => ({
    denials:
      handle.attemptId === "attempt-2"
        ? ([{ kind: "filesystem", source: "linux-seccomp" }] as const)
        : [],
    }),
  );
  try {
    const a = createAttributedSandboxedBashOps();
    const b = createAttributedSandboxedBashOps();
    const aRun = await runAttributed(a);
    const bRun = await runAttributed(b);
    await Promise.all([aRun.execution, bRun.execution]);
    assert.equal(Buffer.concat(aRun.chunks).toString().includes("stream-1"), true);
    assert.equal(Buffer.concat(bRun.chunks).toString().includes("stream-2"), true);
    assert.equal(prepared[0]?.cwd, tmpdir());
    assert.deepEqual(prepared[0]?.env, { PATH: process.env.PATH });
    assert.deepEqual((await a.finished).denials, []);
    assert.deepEqual((await b.finished).denials, [
      { kind: "filesystem", source: "linux-seccomp" },
    ]);
    assert.equal((await a.finished).observation.sandboxBackend, "linux-bwrap");
    assert.equal((await b.finished).observation.sandboxBackend, "linux-seccomp");
  } finally {
    finish.mock.restore();
    cleanup.mock.restore();
    prepare.mock.restore();
  }
});

test("a real nonzero descriptor retains output and finalizes after cleanup", async () => {
  const calls: string[] = [];
  const prepare = mock.method(SandboxManager, "prepareSandboxAttempt", async () => ({
    attempt: { attemptId: "nonzero" } as never,
    argv: ["/bin/sh", "-c", "printf 'nonzero retained output'; exit 23"],
    env: { PATH: process.env.PATH },
    sandboxBackend: "linux-bwrap" as const,
  }));
  const cleanup = mock.method(SandboxManager, "cleanupAfterCommand", () => {
    calls.push("cleanup");
  });
  const finish = mock.method(SandboxManager, "finishSandboxAttempt", async () => {
    calls.push("finish");
    return { denials: [] };
  });
  try {
    const attributed = createAttributedSandboxedBashOps();
    const { execution, chunks } = await runAttributed(attributed);
    assert.deepEqual(await execution, { exitCode: 23 });
    assert.equal(Buffer.concat(chunks).toString(), "nonzero retained output");
    assert.deepEqual((await attributed.finished).observation, {
      sandboxBackend: "linux-bwrap",
      exitCode: 23,
      signal: null,
      termination: "exit",
    });
    assert.deepEqual(calls, ["cleanup", "finish"]);
    assert.equal(finish.mock.callCount(), 1);
  } finally {
    finish.mock.restore();
    cleanup.mock.restore();
    prepare.mock.restore();
  }
});

test("configuration publication does not disturb an unrelated attributed attempt", async () => {
  const descriptors = [
    {
      attempt: { attemptId: "x" } as never,
      argv: ["/bin/sh", "-c", "sleep 5"],
      env: { PATH: process.env.PATH },
      sandboxBackend: "linux-bwrap" as const,
    },
    {
      attempt: { attemptId: "a" } as never,
      argv: ["/usr/bin/true"],
      env: { PATH: process.env.PATH },
      sandboxBackend: "linux-bwrap" as const,
    },
    {
      attempt: { attemptId: "b" } as never,
      argv: ["/usr/bin/true"],
      env: { PATH: process.env.PATH },
      sandboxBackend: "linux-seccomp" as const,
    },
  ];
  const prepare = mock.method(
    SandboxManager,
    "prepareSandboxAttempt",
    async () => descriptors.shift()!,
  );
  const cleanup = mock.method(SandboxManager, "cleanupAfterCommand", () => {});
  const finish = mock.method(
    SandboxManager,
    "finishSandboxAttempt",
    async (handle: SandboxAttemptHandle) => ({
    denials: [
      {
        kind: "network" as const,
        source: handle.attemptId === "x" ? ("socks-proxy" as const) : ("http-proxy" as const),
      },
    ],
    }),
  );
  const update = mock.method(SandboxManager, "updateConfig", () => {});
  const reset = mock.method(SandboxManager, "reset", async () => {});
  try {
    const controller = new AbortController();
    const x = createAttributedSandboxedBashOps();
    const xExecution = (await runAttributed(x, { signal: controller.signal })).execution;

    const a = createAttributedSandboxedBashOps();
    await (await runAttributed(a)).execution;
    updateSandboxConfig(DEFAULT_CONFIG);

    const b = createAttributedSandboxedBashOps();
    await (await runAttributed(b)).execution;

    controller.abort();
    await assert.rejects(xExecution, /aborted/);

    assert.deepEqual((await x.finished).denials, [
      { kind: "network", source: "socks-proxy" },
    ]);
    assert.deepEqual((await a.finished).denials, [
      { kind: "network", source: "http-proxy" },
    ]);
    assert.deepEqual((await b.finished).denials, [
      { kind: "network", source: "http-proxy" },
    ]);
    assert.equal(update.mock.callCount(), 1);
    assert.equal(reset.mock.callCount(), 0);
  } finally {
    reset.mock.restore();
    update.mock.restore();
    finish.mock.restore();
    cleanup.mock.restore();
    prepare.mock.restore();
  }
});
