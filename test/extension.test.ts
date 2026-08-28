import test from "node:test";

import {
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEvent,
  type ToolCallEventResult,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { SandboxManager } from "@carderne/sandbox-runtime";
import assert from "node:assert/strict";
import { mock } from "node:test";

import { createBashEscalationCallTracker } from "../src/bash-permissions.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { refreshSandbox, registerBashEscalationHooks } from "../src/extension.ts";

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

test("escalated Bash calls bypass domain preflight even without a justification", async () => {
  const harness = createHookHarness();

  for (const justification of ["Need network access", undefined]) {
    const result = await harness.toolCallHandler(
      {
        type: "tool_call",
        toolName: "bash",
        toolCallId: `escalated-${justification ?? "missing"}`,
        input: {
          command: "curl https://blocked.example.com/data",
          sandbox_permissions: "require_escalated",
          justification,
        },
      } as ToolCallEvent,
      hookContext,
    );
    assert.equal(result, undefined);
  }

  assert.deepEqual(harness.promptedDomains, []);
  assert.deepEqual(harness.appliedDomains, []);
});

test("default Bash calls retain domain preflight for omitted and use_default permissions", async () => {
  const harness = createHookHarness();

  for (const [toolCallId, sandbox_permissions] of [
    ["default-omitted", undefined],
    ["default-explicit", "use_default"],
  ] as const) {
    const result = await harness.toolCallHandler(
      {
        type: "tool_call",
        toolName: "bash",
        toolCallId,
        input: {
          command: "curl https://blocked.example.com/data",
          sandbox_permissions,
        },
      } as ToolCallEvent,
      hookContext,
    );
    assert.deepEqual(result, {
      block: true,
      reason: 'Network access to "blocked.example.com" is blocked (not in allowedDomains).',
    });
  }

  assert.deepEqual(harness.promptedDomains, ["blocked.example.com:42", "blocked.example.com:42"]);
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
    });
    assert.equal(harness.toolResultHandler(event), undefined);
  }
});

test("refreshSandbox propagates runtime configuration publication failures", () => {
  const update = mock.method(SandboxManager, "updateConfig", () => {
    throw new Error("publication failed");
  });
  try {
    assert.throws(
      () =>
        refreshSandbox(DEFAULT_CONFIG, { domains: [], readPaths: [], writePaths: [] }, true),
      /publication failed/,
    );
  } finally {
    update.mock.restore();
  }
});
