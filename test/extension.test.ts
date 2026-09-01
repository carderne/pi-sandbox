import { readFileSync } from "node:fs";
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

test("model Bash uses attributed operations while user_bash stays handleless", () => {
  const source = readFileSync(new URL("../src/extension.ts", import.meta.url), "utf8");
  const modelStart = source.indexOf("const executeDefaultBash");
  const userStart = source.indexOf('pi.on("user_bash"');
  const nextHook = source.indexOf('pi.on("tool_call"', userStart);
  assert.notEqual(modelStart, -1);
  assert.notEqual(userStart, -1);
  assert.notEqual(nextHook, -1);

  const modelSection = source.slice(modelStart, userStart);
  const userSection = source.slice(userStart, nextHook);
  assert.match(modelSection, /sandboxBashOperationRoutes\.model/);
  assert.doesNotMatch(modelSection, /operations:\s*createSandboxedBashOps/);
  assert.match(userSection, /operations:\s*sandboxBashOperationRoutes\.user/);
  assert.doesNotMatch(userSection, /createAttributedSandboxedBashOps/);
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
