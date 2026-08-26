import assert from "node:assert/strict";
import test from "node:test";

import {
  type AgentToolResult,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";

import {
  createEscalationAbortError,
  createEscalationPromptQueue,
  createNotRunResult,
  executeEscalatedBash,
  isEscalationAbortError,
  isEscalationRequest,
  sandboxBashSchema,
  stripEscalationFields,
  validateEscalationJustification,
  withEscalationStatus,
  type BashExecutor,
  type EscalationDecision,
  type EscalationPromptQueue,
} from "../src/bash-permissions.ts";

test("sandbox Bash schema remains backward compatible and accepts known permissions", () => {
  assert.equal(Check(sandboxBashSchema, { command: "pnpm test" }), true);
  assert.equal(
    Check(sandboxBashSchema, {
      command: "pnpm install",
      timeout: 30,
      sandbox_permissions: "require_escalated",
      justification: "Allow registry access?",
    }),
    true,
  );
  assert.equal(
    Check(sandboxBashSchema, { command: "pwd", sandbox_permissions: "use_default" }),
    true,
  );
  assert.equal(
    Check(sandboxBashSchema, { command: "pwd", sandbox_permissions: "always_allow" }),
    false,
  );
});

test("runtime justification validation counts Unicode code points", () => {
  assert.equal(validateEscalationJustification(undefined).ok, false);
  assert.equal(validateEscalationJustification(" \n\t ").ok, false);
  assert.equal(validateEscalationJustification("🧪".repeat(500)).ok, true);
  assert.equal(validateEscalationJustification("🧪".repeat(501)).ok, false);
  assert.equal(validateEscalationJustification(` ${"x".repeat(499)} `).ok, false);
  assert.deepEqual(validateEscalationJustification("  Need registry access?  "), {
    ok: true,
    justification: "Need registry access?",
  });
});

test("escalation helpers preserve ordinary Bash fields and existing details", () => {
  assert.equal(isEscalationRequest({ sandbox_permissions: "require_escalated" }), true);
  assert.equal(isEscalationRequest({ sandbox_permissions: "use_default" }), false);
  assert.deepEqual(
    stripEscalationFields({
      command: "printf exact",
      timeout: 12,
      sandbox_permissions: "require_escalated",
      justification: "Need access?",
    }),
    { command: "printf exact", timeout: 12 },
  );
  assert.deepEqual(
    withEscalationStatus(
      {
        truncation: {
          content: "data",
          truncated: false,
          truncatedBy: null,
          totalLines: 1,
          totalBytes: 4,
          outputLines: 1,
          outputBytes: 4,
          lastLinePartial: false,
          firstLineExceedsLimit: false,
          maxLines: 2_000,
          maxBytes: 51_200,
        },
      },
      "approved_once",
    ),
    {
      truncation: {
        content: "data",
        truncated: false,
        truncatedBy: null,
        totalLines: 1,
        totalBytes: 4,
        outputLines: 1,
        outputBytes: 4,
        lastLinePartial: false,
        firstLineExceedsLimit: false,
        maxLines: 2_000,
        maxBytes: 51_200,
      },
      escalation: { status: "approved_once" },
    },
  );
});

test("not-run results and tool abort errors are unambiguous", () => {
  const result = createNotRunResult("denied");
  assert.match(
    result.content[0]?.type === "text" ? result.content[0].text : "",
    /not run outside pi-sandbox/i,
  );
  assert.match(
    result.content[0]?.type === "text" ? result.content[0].text : "",
    /do not retry/i,
  );
  assert.deepEqual(result.details, { escalation: { status: "denied" } });
  const abortError = createEscalationAbortError();
  assert.equal(isEscalationAbortError(abortError), true);
  assert.equal(isEscalationAbortError(new Error(abortError.message)), false);
  assert.match(abortError.message, /aborted.*escalated command was not run/i);
});

test("escalation prompts are FIFO and decisions stay bound to their commands", async () => {
  const visible: string[] = [];
  const resolvers: Array<(decision: EscalationDecision) => void> = [];
  const queue = createEscalationPromptQueue(
    (request) =>
      new Promise((resolve) => {
        visible.push(`${request.toolCallId}:${request.command}`);
        resolvers.push(resolve);
      }),
  );
  const ctx = { mode: "tui", hasUI: true } as never;

  const first = queue.enqueue({
    toolCallId: "call-1",
    command: "first",
    justification: "first reason",
    ctx,
  });
  const second = queue.enqueue({
    toolCallId: "call-2",
    command: "second",
    justification: "second reason",
    ctx,
  });

  await Promise.resolve();
  assert.deepEqual(visible, ["call-1:first"]);
  resolvers[0]?.({ action: "deny", reason: "user" });
  assert.deepEqual(await first, { action: "deny", reason: "user" });
  await Promise.resolve();
  assert.deepEqual(visible, ["call-1:first", "call-2:second"]);
  resolvers[1]?.({ action: "allow_once" });
  assert.deepEqual(await second, { action: "allow_once" });
});

test("aborting a queued escalation removes only that request", async () => {
  const visible: string[] = [];
  const resolvers: Array<(decision: EscalationDecision) => void> = [];
  const queue = createEscalationPromptQueue(
    (request) =>
      new Promise((resolve) => {
        visible.push(request.command);
        resolvers.push(resolve);
      }),
  );
  const ctx = { mode: "tui", hasUI: true } as never;
  const queuedAbort = new AbortController();

  const first = queue.enqueue({
    toolCallId: "1",
    command: "first",
    justification: "one",
    ctx,
  });
  const second = queue.enqueue({
    toolCallId: "2",
    command: "second",
    justification: "two",
    signal: queuedAbort.signal,
    ctx,
  });
  const third = queue.enqueue({
    toolCallId: "3",
    command: "third",
    justification: "three",
    ctx,
  });
  queuedAbort.abort();
  await assert.rejects(second, /aborted.*escalated command was not run/i);
  resolvers[0]?.({ action: "deny", reason: "user" });
  await first;
  await Promise.resolve();
  assert.deepEqual(visible, ["first", "third"]);
  resolvers[1]?.({ action: "deny", reason: "timeout" });
  await third;
});

test("every prompt settlement advances the escalation queue", async () => {
  const visible: string[] = [];
  const queue = createEscalationPromptQueue(async (request) => {
    visible.push(request.command);
    if (request.command === "broken") throw new Error("render failed");
    return { action: "deny", reason: "user" };
  });
  const ctx = { mode: "tui", hasUI: true } as never;
  await assert.rejects(
    queue.enqueue({ toolCallId: "1", command: "broken", justification: "one", ctx }),
    /render failed/,
  );
  assert.deepEqual(
    await queue.enqueue({ toolCallId: "2", command: "next", justification: "two", ctx }),
    { action: "deny", reason: "user" },
  );
  assert.deepEqual(visible, ["broken", "next"]);
});

const tuiContext = { mode: "tui", hasUI: true } as unknown as ExtensionContext;
const rpcContext = { mode: "rpc", hasUI: true } as unknown as ExtensionContext;
const textContent = (result: AgentToolResult<unknown>): string =>
  result.content
    .filter(
      (item): item is Extract<(typeof result.content)[number], { type: "text" }> =>
        item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
const allowQueue: EscalationPromptQueue = {
  enqueue: async () => ({ action: "allow_once" }),
};

test("invalid escalation requests fail closed before prompting or execution", async () => {
  const invalidJustifications = [undefined, " \n\t ", "🧪".repeat(501)] as const;
  for (const justification of invalidJustifications) {
    let promptCalls = 0;
    const queue: EscalationPromptQueue = {
      enqueue: async () => {
        promptCalls++;
        return { action: "deny", reason: "user" };
      },
    };
    const executorCalls: unknown[][] = [];
    const executeLocal: BashExecutor = async (...args) => {
      executorCalls.push(args);
      return { content: [{ type: "text", text: "unexpected" }], details: undefined };
    };
    const result = await executeEscalatedBash({
      toolCallId: "invalid",
      input: {
        command: "never-run",
        sandbox_permissions: "require_escalated",
        justification,
      },
      ctx: rpcContext,
      queue,
      executeLocal,
    });
    assert.equal(promptCalls, 0);
    assert.equal(executorCalls.length, 0);
    assert.match(textContent(result), /not run outside pi-sandbox/i);
    assert.equal(result.details?.escalation?.status, "invalid");
  }
});

test("escalation is unavailable outside an interactive TUI before prompting or execution", async () => {
  for (const ctx of [
    rpcContext,
    { mode: "tui", hasUI: false } as unknown as ExtensionContext,
  ]) {
    let promptCalls = 0;
    let executorCalls = 0;
    const result = await executeEscalatedBash({
      toolCallId: "unavailable",
      input: {
        command: "never-run",
        sandbox_permissions: "require_escalated",
        justification: "Need local access?",
      },
      ctx,
      queue: {
        enqueue: async () => {
          promptCalls++;
          return { action: "allow_once" };
        },
      },
      executeLocal: async () => {
        executorCalls++;
        return { content: [], details: undefined };
      },
    });
    assert.equal(promptCalls, 0);
    assert.equal(executorCalls, 0);
    assert.equal(result.details?.escalation?.status, "unavailable");
    assert.match(textContent(result), /not run outside pi-sandbox/i);
  }
});

test("approval delegates the exact command and timeout once and preserves Bash details", async () => {
  const calls: unknown[][] = [];
  const updates: unknown[] = [];
  const approvedIds: string[] = [];
  const executeLocal: BashExecutor = async (...args) => {
    calls.push(args);
    args[3]?.({
      content: [{ type: "text", text: "partial" }],
      details: { fullOutputPath: "/tmp/full-output" },
    });
    return {
      content: [{ type: "text", text: "done" }],
      details: { fullOutputPath: "/tmp/full-output" },
    };
  };
  const result = await executeEscalatedBash({
    toolCallId: "approved",
    input: {
      command: "printf '$HOME'",
      timeout: 17,
      sandbox_permissions: "require_escalated",
      justification: "Need the exact local environment?",
    },
    ctx: tuiContext,
    queue: allowQueue,
    executeLocal,
    onUpdate: (update) => updates.push(update),
    onApproved: (toolCallId) => approvedIds.push(toolCallId),
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(approvedIds, ["approved"]);
  assert.deepEqual(calls[0]?.[1], { command: "printf '$HOME'", timeout: 17 });
  assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", "done");
  assert.deepEqual(result.details, {
    fullOutputPath: "/tmp/full-output",
    escalation: { status: "approved_once" },
  });
  assert.ok(
    updates.every(
      (update: any) => update.details?.escalation?.status === "approved_once",
    ),
  );
});

test("an approved local spawn failure propagates without retry", async () => {
  const approvedIds: string[] = [];
  let executorCalls = 0;
  const spawnError = new Error("spawn failed");
  await assert.rejects(
    executeEscalatedBash({
      toolCallId: "spawn-error",
      input: {
        command: "exact",
        sandbox_permissions: "require_escalated",
        justification: "Need local execution?",
      },
      ctx: tuiContext,
      queue: allowQueue,
      executeLocal: async () => {
        executorCalls++;
        throw spawnError;
      },
      onApproved: (toolCallId) => approvedIds.push(toolCallId),
    }),
    (error) => error === spawnError,
  );
  assert.equal(executorCalls, 1);
  assert.deepEqual(approvedIds, ["spawn-error"]);
});

test("every non-approval decision returns a stable not-run result", async () => {
  const deniedCases = [
    [{ action: "deny", reason: "user" }, "denied"],
    [{ action: "deny", reason: "timeout" }, "timed_out"],
    [{ action: "deny", reason: "cancelled" }, "cancelled"],
    [{ action: "deny", reason: "unavailable" }, "unavailable"],
  ] as const;

  for (const [decision, status] of deniedCases) {
    let executorCalls = 0;
    const result = await executeEscalatedBash({
      toolCallId: status,
      input: {
        command: "never-run",
        sandbox_permissions: "require_escalated",
        justification: "Need local execution?",
      },
      ctx: tuiContext,
      queue: { enqueue: async () => decision },
      executeLocal: async () => {
        executorCalls++;
        return { content: [], details: undefined };
      },
    });
    assert.equal(executorCalls, 0);
    assert.equal(result.details?.escalation?.status, status);
    assert.match(textContent(result), /not run outside pi-sandbox/i);
    assert.match(textContent(result), /do not retry/i);
  }
});

test("abort races before local delegation never execute the command", async () => {
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const rejectedByQueue = new AbortController();
  const approvedThenAborted = new AbortController();
  let executorCalls = 0;
  const executeLocal: BashExecutor = async () => {
    executorCalls++;
    return { content: [], details: undefined };
  };
  const input = {
    command: "never-run",
    sandbox_permissions: "require_escalated" as const,
    justification: "Need local execution?",
  };

  await assert.rejects(
    executeEscalatedBash({
      toolCallId: "already-aborted",
      input,
      signal: alreadyAborted.signal,
      ctx: tuiContext,
      queue: allowQueue,
      executeLocal,
    }),
    /aborted.*escalated command was not run/i,
  );
  await assert.rejects(
    executeEscalatedBash({
      toolCallId: "queue-aborted",
      input,
      signal: rejectedByQueue.signal,
      ctx: tuiContext,
      queue: {
        enqueue: async () => {
          rejectedByQueue.abort();
          throw createEscalationAbortError();
        },
      },
      executeLocal,
    }),
    /aborted.*escalated command was not run/i,
  );
  await assert.rejects(
    executeEscalatedBash({
      toolCallId: "approved-then-aborted",
      input,
      signal: approvedThenAborted.signal,
      ctx: tuiContext,
      queue: {
        enqueue: async () => {
          approvedThenAborted.abort();
          return { action: "allow_once" };
        },
      },
      executeLocal,
    }),
    /aborted.*escalated command was not run/i,
  );
  assert.equal(executorCalls, 0);
});

test("prompt infrastructure failures fail closed while typed aborts propagate", async () => {
  let executorCalls = 0;
  let approvalCalls = 0;
  const options = {
    toolCallId: "prompt-failure",
    input: {
      command: "never-run",
      sandbox_permissions: "require_escalated" as const,
      justification: "Need local execution?",
    },
    ctx: tuiContext,
    executeLocal: async () => {
      executorCalls++;
      return { content: [], details: undefined };
    },
    onApproved: () => {
      approvalCalls++;
    },
  };

  const result = await executeEscalatedBash({
    ...options,
    queue: { enqueue: async () => Promise.reject(new Error("render failed")) },
  });
  assert.equal(result.details?.escalation?.status, "unavailable");
  assert.match(textContent(result), /not run outside pi-sandbox/i);
  assert.match(textContent(result), /do not retry/i);
  await assert.rejects(
    executeEscalatedBash({
      ...options,
      queue: { enqueue: async () => Promise.reject(createEscalationAbortError()) },
    }),
    /aborted.*escalated command was not run/i,
  );
  assert.equal(executorCalls, 0);
  assert.equal(approvalCalls, 0);
});
