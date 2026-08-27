import test from "node:test";

import {
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEvent,
  type ToolCallEventResult,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";

import { createApprovedBashCallTracker } from "../src/bash-permissions.ts";
import { registerBashEscalationHooks } from "../src/extension.ts";

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
  const approvedBashCalls = createApprovedBashCallTracker();

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
    approvedBashCalls,
  });

  assert.ok(toolCallHandler);
  assert.ok(toolResultHandler);
  return {
    approvedBashCalls,
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

test("registered Bash result hook restores approved metadata and consumes tracker state", () => {
  const harness = createHookHarness();
  harness.approvedBashCalls.markApproved("approved-call");
  const event = {
    type: "tool_result",
    toolName: "bash",
    toolCallId: "approved-call",
    input: { command: "pnpm install" },
    content: [{ type: "text", text: "spawn failed" }],
    details: undefined,
    isError: true,
  } satisfies ToolResultEvent;

  assert.deepEqual(harness.toolResultHandler(event), {
    details: { escalation: { status: "approved_once" } },
  });
  assert.equal(harness.toolResultHandler(event), undefined);
});
