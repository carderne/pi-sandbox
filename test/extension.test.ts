import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";

import { SandboxManager } from "@carderne/sandbox-runtime";
import {
  type BashOperations,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEvent,
  type ToolCallEventResult,
  type ToolResultEvent,
  createBashToolDefinition,
} from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";

import { createBashEscalationCallTracker } from "../src/bash-permissions.ts";
import {
  executeAttributedBashFlow,
  type FinishedSandboxProcessAttempt,
} from "../src/bash-sandbox-denials.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  captureAttributedBashAttempt,
  createSandboxBashOperationRoutes,
  refreshSandbox,
  registerPiSandboxExtension,
  registerBashEscalationHooks,
  sandboxGuidanceAvailable,
} from "../src/extension.ts";

type ToolCallHandler = (
  event: ToolCallEvent,
  ctx: ExtensionContext,
) => Promise<ToolCallEventResult | undefined> | ToolCallEventResult | undefined;
type ToolResultHandler = (event: ToolResultEvent) => unknown;

function createHookHarness() {
  let toolCallHandler: ToolCallHandler | undefined;
  let toolResultHandler: ToolResultHandler | undefined;
  const pi = {
    on(event: string, handler: unknown) {
      if (event === "tool_call") toolCallHandler = handler as ToolCallHandler;
      if (event === "tool_result") toolResultHandler = handler as ToolResultHandler;
    },
  } as Pick<ExtensionAPI, "on">;
  const promptedDomains: string[] = [];
  const appliedDomains: string[] = [];
  const bashEscalationCalls = createBashEscalationCallTracker();

  registerBashEscalationHooks(pi, {
    isSandboxActive: () => true,
    effectiveDomains: () => [],
    getPromptTimeoutSeconds: () => 42,
    promptDomain: async (_ctx, domain, timeoutSeconds) => {
      promptedDomains.push(`${domain}:${timeoutSeconds ?? "none"}`);
      return { action: "abort", value: domain };
    },
    applyDomainChoice: async (_choice, value) => {
      appliedDomains.push(value);
    },
    bashEscalationCalls,
  });

  assert.ok(toolCallHandler);
  assert.ok(toolResultHandler);
  return {
    bashEscalationCalls,
    appliedDomains,
    promptedDomains,
    toolCallHandler,
    toolResultHandler,
  };
}

const hookContext = { cwd: "/workspace" } as ExtensionContext;

test("valid and malformed escalation intent bypass domain preflight", async () => {
  const harness = createHookHarness();

  for (const [toolCallId, escalation] of [
    ["valid", { justification: "Need network access" }],
    ["missing-justification", {}],
    ["null", null],
  ] as const) {
    const result = await harness.toolCallHandler(
      {
        type: "tool_call",
        toolName: "bash",
        toolCallId: `escalated-${toolCallId}`,
        input: {
          command: "curl https://blocked.example.com/data",
          escalation,
        },
      } as ToolCallEvent,
      hookContext,
    );
    assert.equal(result, undefined);
  }

  assert.deepEqual(harness.promptedDomains, []);
  assert.deepEqual(harness.appliedDomains, []);
});

test("default Bash calls retain domain preflight", async () => {
  const harness = createHookHarness();

  const result = await harness.toolCallHandler(
    {
      type: "tool_call",
      toolName: "bash",
      toolCallId: "default",
      input: { command: "curl https://blocked.example.com/data" },
    } as ToolCallEvent,
    hookContext,
  );
  assert.deepEqual(result, {
    block: true,
    reason: 'Network access to "blocked.example.com" is blocked (not in allowedDomains).',
  });

  assert.deepEqual(harness.promptedDomains, ["blocked.example.com:42"]);
  assert.deepEqual(harness.appliedDomains, []);
});

test("registered Bash result hook restores terminal metadata and consumes tracker state", () => {
  const harness = createHookHarness();
  for (const [toolCallId, mark, status] of [
    [
      "approved-call",
      () => harness.bashEscalationCalls.markApproved("approved-call"),
      "approved_once",
    ],
    ["aborted-call", () => harness.bashEscalationCalls.markAborted("aborted-call"), "aborted"],
  ] as const) {
    mark();
    const event = {
      type: "tool_result",
      toolName: "bash",
      toolCallId,
      input: { command: "pnpm install" },
      content: [{ type: "text", text: "tool failed" }],
      details: undefined,
      isError: true,
    } satisfies ToolResultEvent;

    assert.deepEqual(harness.toolResultHandler(event), {
      details: { escalation: { status } },
      ...(status === "aborted" ? { isError: true } : {}),
    });
    assert.equal(harness.toolResultHandler(event), undefined);
  }
});

test("registered Bash result hook marks every detail-carried not-run outcome as an error", () => {
  const harness = createHookHarness();

  for (const status of [
    "denied",
    "cancelled",
    "aborted",
    "timed_out",
    "unavailable",
    "invalid",
  ] as const) {
    const result = harness.toolResultHandler({
      type: "tool_result",
      toolName: "bash",
      toolCallId: `not-run-${status}`,
      input: { command: "never-run" },
      content: [{ type: "text", text: `not run: ${status}` }],
      details: { escalation: { status } },
      isError: false,
    } as ToolResultEvent);

    assert.deepEqual(result, { isError: true }, status);
  }
});

test("refreshSandbox propagates runtime configuration publication failures", () => {
  const update = mock.method(SandboxManager, "updateConfig", () => {
    throw new Error("publication failed");
  });
  try {
    assert.throws(
      () => refreshSandbox(DEFAULT_CONFIG, { domains: [], readPaths: [], writePaths: [] }, true),
      /publication failed/,
    );
  } finally {
    update.mock.restore();
  }
});

test("extension guidance gate checks current mode, UI, and both sandbox flags", () => {
  assert.equal(sandboxGuidanceAvailable({ mode: "tui", hasUI: true }, true, true), true);
  for (const mode of ["rpc", "print", "json"] as const) {
    assert.equal(sandboxGuidanceAvailable({ mode, hasUI: true }, true, true), false);
  }
  assert.equal(sandboxGuidanceAvailable({ mode: "tui", hasUI: false }, true, true), false);
  assert.equal(sandboxGuidanceAvailable({ mode: "tui", hasUI: true }, false, true), false);
  assert.equal(sandboxGuidanceAvailable({ mode: "tui", hasUI: true }, true, false), false);
});

test("sandbox Bash operation routes keep model and user factories separate", () => {
  const calls: string[] = [];
  const routes = createSandboxBashOperationRoutes(
    ((..._args: never[]) => {
      calls.push("attributed");
      return { operations: {} as never, finished: Promise.resolve({} as never) };
    }) as never,
    ((..._args: never[]) => {
      calls.push("legacy");
      return {} as never;
    }) as never,
  );

  routes.model(undefined, true);
  assert.deepEqual(calls, ["attributed"]);
  calls.length = 0;
  routes.user(undefined, true);
  assert.deepEqual(calls, ["legacy"]);
});

test("registered model Bash and user_bash use their respective operation routes", async () => {
  type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
  type RegisteredBashTool = {
    execute(
      toolCallId: string,
      params: { command: string },
      signal: AbortSignal | undefined,
      onUpdate: undefined,
      ctx: ExtensionContext,
    ): Promise<unknown>;
  };

  const testRoot = mkdtempSync(join(tmpdir(), "pi-sandbox-extension-routing-"));
  const handlers = new Map<string, Handler[]>();
  let registeredBash: RegisteredBashTool | undefined;
  const pi = {
    events: { emit() {} },
    getFlag: () => false,
    on(event: string, handler: Handler) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
    registerCommand() {},
    registerFlag() {},
    registerShortcut() {},
    registerTool(tool: RegisteredBashTool) {
      registeredBash = tool;
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: join(testRoot, "project"),
    mode: "tui",
    hasUI: true,
    ui: {
      notify() {},
      setStatus() {},
      theme: { fg: (_color: string, text: string) => text },
    },
  } as unknown as ExtensionContext;
  const calls: Array<{ route: "model" | "user"; shellPath?: string; sshProxy: boolean }> = [];
  const operations: BashOperations = {
    async exec() {
      return { exitCode: 0 };
    },
  };
  const routes = {
    model(shellPath?: string, sshProxy = true) {
      calls.push({ route: "model", shellPath, sshProxy });
      return {
        operations,
        finished: Promise.resolve({
          observation: {
            sandboxBackend: "linux-bwrap" as const,
            exitCode: 0,
            signal: null,
            termination: "exit" as const,
          },
          denials: [],
        }),
      };
    },
    user(shellPath?: string, sshProxy = true) {
      calls.push({ route: "user", shellPath, sshProxy });
      return operations;
    },
  };
  const initialize = mock.method(SandboxManager, "initialize", async () => {});
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalNodeUseEnvProxy = process.env.NODE_USE_ENV_PROXY;
  process.env.PI_CODING_AGENT_DIR = join(testRoot, "agent");

  try {
    registerPiSandboxExtension(pi, { sandboxBashOperationRoutes: routes });
    const sessionStart = handlers.get("session_start")?.[0];
    const userBash = handlers.get("user_bash")?.[0];
    assert.ok(sessionStart);
    assert.ok(userBash);
    assert.ok(registeredBash);

    await sessionStart({ type: "session_start" }, ctx);
    await registeredBash.execute(
      "model-call",
      { command: "printf model" },
      undefined,
      undefined,
      ctx,
    );
    assert.deepEqual(calls, [{ route: "model", shellPath: undefined, sshProxy: true }]);

    const userResult = (await userBash(
      { type: "user_bash", command: "printf user", excludeFromContext: false, cwd: ctx.cwd },
      ctx,
    )) as { operations?: BashOperations };
    assert.equal(userResult.operations, operations);
    assert.deepEqual(calls, [
      { route: "model", shellPath: undefined, sshProxy: true },
      { route: "user", shellPath: undefined, sshProxy: true },
    ]);
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    if (originalNodeUseEnvProxy === undefined) delete process.env.NODE_USE_ENV_PROXY;
    else process.env.NODE_USE_ENV_PROXY = originalNodeUseEnvProxy;
    initialize.mock.restore();
    rmSync(testRoot, { recursive: true, force: true });
  }
});

const bashContext = {
  cwd: process.cwd(),
  mode: "tui",
  hasUI: true,
} as unknown as ExtensionContext;

const executePiBash = (operations: BashOperations) =>
  createBashToolDefinition(process.cwd(), { operations }).execute(
    "test-call",
    { command: "ignored" },
    new AbortController().signal,
    undefined,
    bashContext,
  );

const signalFinished = (
  sandboxBackend: FinishedSandboxProcessAttempt["observation"]["sandboxBackend"],
): Promise<FinishedSandboxProcessAttempt> =>
  Promise.resolve({
    observation: {
      sandboxBackend,
      exitCode: null,
      signal: "SIGSYS",
      termination: "signal",
    },
    denials: [],
  });

test("signal adaptation retains Pi output and appends one guidance block", async () => {
  const operations: BashOperations = {
    async exec(_command, _cwd, { onData }) {
      onData(Buffer.from("retained signal output"));
      return { exitCode: null };
    },
  };

  await assert.rejects(
    executeAttributedBashFlow({
      runAttempt: () =>
        captureAttributedBashAttempt(executePiBash(operations), signalFinished("linux-seccomp")),
      recoverWrite: async () => "not-applicable",
      guidanceAvailable: () => true,
    }),
    (error: unknown) => {
      if (!(error instanceof Error)) return false;
      assert.match(
        error.message,
        /^retained signal output\n\nCommand terminated by signal SIGSYS\n\n--- pi-sandbox guidance ---/,
      );
      assert.equal(error.message.split("--- pi-sandbox guidance ---").length - 1, 1);
      return true;
    },
  );
});

test("a signal without evidence or fallback remains an unguided tool error", async () => {
  const operations: BashOperations = {
    async exec(_command, _cwd, { onData }) {
      onData(Buffer.from("ordinary signal output"));
      return { exitCode: null };
    },
  };

  await assert.rejects(
    executeAttributedBashFlow({
      runAttempt: () =>
        captureAttributedBashAttempt(executePiBash(operations), signalFinished("linux-bwrap")),
      recoverWrite: async () => "not-applicable",
      guidanceAvailable: () => true,
    }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "ordinary signal output\n\nCommand terminated by signal SIGSYS",
  );
});

test("a real exit-23 descriptor retains Pi output after cleanup and finalization", async () => {
  const calls: string[] = [];
  const prepare = mock.method(SandboxManager, "prepareSandboxAttempt", async () => ({
    attempt: { attemptId: "extension-exit-23" } as never,
    argv: ["/bin/sh", "-c", "printf 'extension retained output'; exit 23"],
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
    const attributed = createSandboxBashOperationRoutes().model(undefined, false);
    const completed = await captureAttributedBashAttempt(
      executePiBash(attributed.operations),
      attributed.finished,
    );
    assert.equal(completed.ok, false);
    if (completed.ok || !(completed.error instanceof Error)) {
      assert.fail("expected a captured Pi Bash error");
    }
    assert.equal(
      completed.error.message,
      "extension retained output\n\nCommand exited with code 23",
    );
    assert.deepEqual(completed.finished.observation, {
      sandboxBackend: "linux-bwrap",
      exitCode: 23,
      signal: null,
      termination: "exit",
    });
    assert.deepEqual(calls, ["cleanup", "finish"]);
  } finally {
    finish.mock.restore();
    cleanup.mock.restore();
    prepare.mock.restore();
  }
});
