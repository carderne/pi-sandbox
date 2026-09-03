import test from "node:test";

import {
  type AgentToolResult,
  type BashToolInput,
  type ExtensionContext,
  createBashToolDefinition,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { type Component } from "@earendil-works/pi-tui";
import assert from "node:assert/strict";

import {
  BASH_ESCALATION_GUIDELINES,
  createBashEscalationCallTracker,
  createEscalatingBashToolDefinition,
  createEscalationAbortError,
  createEscalationPromptQueue,
  createNotRunResult,
  executeEscalatedBash,
  formatEscalationMarker,
  isEscalationAbortError,
  isEscalationRequest,
  shouldPreflightBashDomains,
  stripEscalationFields,
  validateEscalationJustification,
  withEscalationStatus,
  type BashExecutor,
  type EscalationDecision,
  type EscalationPromptQueue,
  type EscalationPromptRequest,
} from "../src/bash-permissions.ts";

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
  assert.equal(isEscalationRequest({ escalation: { justification: "Need local access?" } }), true);
  assert.equal(isEscalationRequest({}), false);
  assert.deepEqual(
    stripEscalationFields({
      command: "printf exact",
      timeout: 12,
      escalation: { justification: "Need access?" },
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
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /do not retry/i);
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
        escalation: { justification },
      } as never,
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
  for (const ctx of [rpcContext, { mode: "tui", hasUI: false } as unknown as ExtensionContext]) {
    let promptCalls = 0;
    let executorCalls = 0;
    const result = await executeEscalatedBash({
      toolCallId: "unavailable",
      input: {
        command: "never-run",
        escalation: { justification: "Need local access?" },
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
      escalation: { justification: "Need the exact local environment?" },
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
  assert.deepEqual(updates, [
    {
      content: [],
      details: { escalation: { status: "approved_once" } },
    },
    {
      content: [{ type: "text", text: "partial" }],
      details: {
        fullOutputPath: "/tmp/full-output",
        escalation: { status: "approved_once" },
      },
    },
  ]);
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
        escalation: { justification: "Need local execution?" },
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
        escalation: { justification: "Need local execution?" },
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
  const abortedIds: string[] = [];
  let executorCalls = 0;
  const executeLocal: BashExecutor = async () => {
    executorCalls++;
    return { content: [], details: undefined };
  };
  const input = {
    command: "never-run",
    escalation: { justification: "Need local execution?" },
  };

  await assert.rejects(
    executeEscalatedBash({
      toolCallId: "already-aborted",
      input,
      signal: alreadyAborted.signal,
      ctx: tuiContext,
      queue: allowQueue,
      executeLocal,
      onAborted: (toolCallId) => abortedIds.push(toolCallId),
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
      onAborted: (toolCallId) => abortedIds.push(toolCallId),
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
      onAborted: (toolCallId) => abortedIds.push(toolCallId),
    }),
    /aborted.*escalated command was not run/i,
  );
  assert.equal(executorCalls, 0);
  assert.deepEqual(abortedIds, ["already-aborted", "queue-aborted", "approved-then-aborted"]);
});

test("prompt infrastructure failures fail closed while typed aborts propagate", async () => {
  let executorCalls = 0;
  let approvalCalls = 0;
  const options = {
    toolCallId: "prompt-failure",
    input: {
      command: "never-run",
      escalation: { justification: "Need local execution?" },
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

const textResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: undefined,
});

const fakeBashDefinition = (
  execute: ReturnType<typeof createBashToolDefinition>["execute"],
): ReturnType<typeof createBashToolDefinition> => ({
  ...createBashToolDefinition(process.cwd()),
  execute,
});

const neverPromptQueue: EscalationPromptQueue = {
  enqueue: async () => {
    throw new Error("prompt must not open");
  },
};

function createToolHarness(options: {
  isSandboxActive: boolean;
  onLocal: () => void;
  onDefault: (input: BashToolInput) => void;
  onPrompt: (request: EscalationPromptRequest) => EscalationDecision;
}) {
  return createEscalatingBashToolDefinition({
    base: fakeBashDefinition(async () => {
      options.onLocal();
      return textResult("local");
    }),
    label: "bash (sandboxed)",
    isSandboxActive: () => options.isSandboxActive,
    executeDefault: async (_id, input) => {
      options.onDefault(input);
      return textResult("sandbox");
    },
    promptQueue: { enqueue: async (request) => options.onPrompt(request) },
    getPromptTimeoutSeconds: () => 600,
  });
}

test("expanded Bash tool preserves default routing and local behavior when sandbox is disabled", async () => {
  const calls: string[] = [];
  const base = fakeBashDefinition(async () => {
    calls.push("local");
    return textResult("local");
  });
  const tool = createEscalatingBashToolDefinition({
    base,
    label: "bash (sandboxed)",
    isSandboxActive: () => false,
    executeDefault: async () => {
      calls.push("sandbox");
      return textResult("sandbox");
    },
    promptQueue: neverPromptQueue,
    getPromptTimeoutSeconds: () => 600,
  });

  for (const [id, input] of [
    ["disabled-default", { command: "pwd" }],
    [
      "disabled-escalation",
      {
        command: "pwd",
        escalation: { justification: "ignored while sandbox is disabled" },
      },
    ],
  ] as const) {
    await tool.execute(id, input, undefined, undefined, tuiContext);
  }
  assert.deepEqual(calls, ["local", "local"]);
  assert.deepEqual(tool.promptGuidelines, BASH_ESCALATION_GUIDELINES);
  assert.ok(tool.promptGuidelines?.every((guideline) => guideline.includes("Bash")));
  assert.notEqual(tool.executionMode, "sequential");
});

test("malformed escalation fails closed before active or inactive routing", async () => {
  for (const isSandboxActive of [true, false]) {
    const calls: string[] = [];
    const tool = createToolHarness({
      isSandboxActive,
      onLocal: () => calls.push("local"),
      onDefault: () => calls.push("sandbox"),
      onPrompt: () => {
        calls.push("prompt");
        return { action: "allow_once" };
      },
    });

    for (const escalation of [null, [], {}, { justification: " \n\t " }]) {
      const result = await tool.execute(
        `invalid-${String(isSandboxActive)}`,
        { command: "never-run", escalation } as never,
        undefined,
        undefined,
        tuiContext,
      );
      assert.equal(result.details?.escalation?.status, "invalid");
    }
    assert.deepEqual(calls, []);
  }
});

test("Bash prompt guidance distinguishes a sandbox failure from a declined escalation", () => {
  const guidance = BASH_ESCALATION_GUIDELINES.join("\n");

  assert.match(guidance, /omit the `escalation` field/i);
  assert.match(guidance, /`escalation: \{ "justification": "<concise user-facing reason>" \}`/);
  assert.match(guidance, /Do not wait for the user to request escalation separately/);
  assert.match(guidance, /if the user declines that escalation prompt/i);
  assert.doesNotMatch(guidance, /do not retry after a denial/);
});

test("active default Bash uses the existing sandbox path without prompting", async () => {
  const calls: string[] = [];
  const tool = createToolHarness({
    isSandboxActive: true,
    onLocal: () => calls.push("local"),
    onDefault: (input) => calls.push(`sandbox:${input.command}`),
    onPrompt: () => {
      calls.push("prompt");
      return { action: "deny", reason: "user" };
    },
  });
  await tool.execute("default", { command: "pnpm test" }, undefined, undefined, tuiContext);
  assert.deepEqual(calls, ["sandbox:pnpm test"]);
});

test("active escalated Bash prompts and invokes only the local path", async () => {
  const calls: string[] = [];
  const tool = createToolHarness({
    isSandboxActive: true,
    onLocal: () => calls.push("local"),
    onDefault: () => calls.push("sandbox"),
    onPrompt: (request) => {
      calls.push(`prompt:${request.command}`);
      return { action: "allow_once" };
    },
  });
  await tool.execute(
    "escalated",
    {
      command: "pnpm install",
      escalation: { justification: "Need registry access?" },
    },
    undefined,
    undefined,
    tuiContext,
  );
  assert.deepEqual(calls, ["prompt:pnpm install", "local"]);
});

test("only default Bash calls enter domain preflight", () => {
  assert.equal(shouldPreflightBashDomains({ command: "pwd" }), true);
  assert.equal(
    shouldPreflightBashDomains({
      command: "pwd",
      escalation: { justification: "Need access?" },
    }),
    false,
  );
  assert.equal(shouldPreflightBashDomains({ command: "pwd", escalation: {} } as never), false);
  assert.equal(shouldPreflightBashDomains({ command: "pwd", escalation: null } as never), false);
});

class MutableComponent {
  constructor(public text: string) {}
  render(): string[] {
    return [this.text];
  }
  invalidate(): void {}
}

const renderTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

test("Bash renderer delegates stripped inputs, preserves details, and updates durable markers", () => {
  const callArgs: unknown[] = [];
  const callLastComponents: unknown[] = [];
  const callBaseComponents: MutableComponent[] = [];
  const resultObjects: unknown[] = [];
  const resultLastComponents: unknown[] = [];
  const resultBaseComponents: MutableComponent[] = [];
  const base = fakeBashDefinition(async () => textResult("unused"));
  base.renderCall = (args, _theme, context) => {
    callArgs.push(args);
    callLastComponents.push(context.lastComponent);
    const component =
      context.lastComponent instanceof MutableComponent
        ? context.lastComponent
        : new MutableComponent("base call");
    component.text = `call:${args.command}:${args.timeout ?? "none"}`;
    callBaseComponents.push(component);
    return component;
  };
  base.renderResult = (result, _options, _theme, context) => {
    resultObjects.push(result);
    resultLastComponents.push(context.lastComponent);
    const component =
      context.lastComponent instanceof MutableComponent
        ? context.lastComponent
        : new MutableComponent("base result");
    component.text = `result:${result.details?.fullOutputPath ?? "none"}`;
    resultBaseComponents.push(component);
    return component;
  };
  const tool = createEscalatingBashToolDefinition({
    base,
    label: "bash (sandboxed)",
    isSandboxActive: () => true,
    executeDefault: async () => textResult("sandbox"),
    promptQueue: neverPromptQueue,
    getPromptTimeoutSeconds: () => 600,
  });
  const args = {
    command: "pnpm install",
    timeout: 10,
    escalation: { justification: "Need registry?" },
  };
  const state = {};
  const contextBase = {
    args,
    toolCallId: "rendered",
    invalidate() {},
    state,
    cwd: process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
  };
  const callContext = {
    ...contextBase,
    lastComponent: undefined as Component | undefined,
  };
  const resultContext = {
    ...contextBase,
    lastComponent: undefined as Component | undefined,
  };

  const callComponent = tool.renderCall!(args, renderTheme as never, callContext as never);
  assert.deepEqual(callArgs, [{ command: "pnpm install", timeout: 10 }]);
  assert.match(callComponent.render(100).join("\n"), /outside pi-sandbox requested/);

  const result = {
    content: [{ type: "text" as const, text: "denied" }],
    details: {
      fullOutputPath: "/tmp/full-output",
      escalation: { status: "denied" as const },
    },
  };
  const resultComponent = tool.renderResult!(
    result,
    { expanded: false, isPartial: false },
    renderTheme as never,
    resultContext as never,
  );
  assert.equal(resultObjects[0], result);
  assert.equal(callLastComponents[0], undefined);
  assert.equal(resultLastComponents[0], undefined);
  assert.match(resultComponent.render(100).join("\n"), /result:\/tmp\/full-output/);
  assert.match(callComponent.render(100).join("\n"), /outside pi-sandbox — not run \(denied\)/);
  assert.doesNotMatch(callComponent.render(100).join("\n"), /approved once/);
  assert.equal(
    [callComponent, resultComponent]
      .flatMap((component) => component.render(100))
      .join("\n")
      .match(/outside pi-sandbox/g)?.length,
    1,
  );
  assert.doesNotMatch(resultComponent.render(100).join("\n"), /outside pi-sandbox/);

  callContext.lastComponent = callComponent;
  tool.renderCall!(args, renderTheme as never, callContext as never);
  assert.equal(callLastComponents[1], callBaseComponents[0]);

  resultContext.lastComponent = resultComponent;
  tool.renderResult!(
    result,
    { expanded: true, isPartial: false },
    renderTheme as never,
    resultContext as never,
  );
  assert.equal(resultLastComponents[1], resultBaseComponents[0]);
});

test("malformed escalation rendering reaches a durable invalid marker safely", () => {
  const base = fakeBashDefinition(async () => textResult("unused"));
  base.renderCall = (args) => new MutableComponent(`call:${args.command}`);
  base.renderResult = (result) =>
    new MutableComponent(
      `result:${result.content[0]?.type === "text" ? result.content[0].text : ""}`,
    );
  const tool = createEscalatingBashToolDefinition({
    base,
    label: "bash (sandboxed)",
    isSandboxActive: () => true,
    executeDefault: async () => textResult("sandbox"),
    promptQueue: neverPromptQueue,
    getPromptTimeoutSeconds: () => 600,
  });
  const args = { command: "never-run", escalation: null } as never;
  const contextBase = {
    args,
    toolCallId: "invalid-render",
    invalidate() {},
    state: {},
    cwd: process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
  };
  const callComponent = tool.renderCall!(
    args,
    renderTheme as never,
    { ...contextBase, lastComponent: undefined } as never,
  );
  tool.renderResult!(
    {
      content: [{ type: "text", text: "invalid" }],
      details: { escalation: { status: "invalid" } },
    },
    { expanded: false, isPartial: false },
    renderTheme as never,
    { ...contextBase, lastComponent: undefined } as never,
  );

  assert.match(callComponent.render(100).join("\n"), /outside pi-sandbox — not run \(invalid\)/);
});

test("inactive Bash hides escalation requests while restored details remain durable", () => {
  const base = fakeBashDefinition(async () => textResult("local"));
  base.renderCall = (args) => new MutableComponent(`call:${args.command}`);
  base.renderResult = (result) =>
    new MutableComponent(
      `result:${result.content[0]?.type === "text" ? result.content[0].text : ""}`,
    );
  const tool = createEscalatingBashToolDefinition({
    base,
    label: "bash (sandboxed)",
    isSandboxActive: () => false,
    executeDefault: async () => textResult("sandbox"),
    promptQueue: neverPromptQueue,
    getPromptTimeoutSeconds: () => 600,
  });
  const args = {
    command: "pwd",
    escalation: { justification: "ignored while inactive" },
  };
  const renderPair = (details: { escalation: { status: "approved_once" } } | undefined) => {
    const state = {};
    const contextBase = {
      args: {
        ...args,
      },
      toolCallId: "inactive-render",
      invalidate() {},
      state,
      cwd: process.cwd(),
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: false,
      showImages: false,
      isError: false,
    };
    const callComponent = tool.renderCall!(
      args,
      renderTheme as never,
      { ...contextBase, lastComponent: undefined } as never,
    );
    const resultComponent = tool.renderResult!(
      {
        content: [{ type: "text", text: "local" }],
        details,
      },
      { expanded: false, isPartial: false },
      renderTheme as never,
      { ...contextBase, lastComponent: undefined } as never,
    );
    return [callComponent, resultComponent]
      .flatMap((component) => component.render(100))
      .join("\n");
  };

  const inactiveOutput = renderPair(undefined);
  assert.doesNotMatch(inactiveOutput, /outside pi-sandbox/);

  const restoredOutput = renderPair({ escalation: { status: "approved_once" } });
  assert.match(restoredOutput, /outside pi-sandbox — approved once/);
  assert.equal(restoredOutput.match(/outside pi-sandbox/g)?.length, 1);
});

test("Pi pre-execution aborts render as terminal not-run status without durable details", () => {
  const render = (text: string, isError: boolean): string => {
    const base = fakeBashDefinition(async () => textResult("local"));
    base.renderCall = (args) => new MutableComponent(`call:${args.command}`);
    base.renderResult = (result) =>
      new MutableComponent(
        `result:${result.content[0]?.type === "text" ? result.content[0].text : ""}`,
      );
    const tool = createEscalatingBashToolDefinition({
      base,
      label: "bash (sandboxed)",
      isSandboxActive: () => false,
      executeDefault: async () => textResult("sandbox"),
      promptQueue: neverPromptQueue,
      getPromptTimeoutSeconds: () => 600,
    });
    const args = {
      command: "pwd",
      escalation: { justification: "Need local execution?" },
    };
    const contextBase = {
      args,
      toolCallId: "core-aborted",
      invalidate() {},
      state: {},
      cwd: process.cwd(),
      executionStarted: false,
      argsComplete: true,
      isPartial: false,
      expanded: false,
      showImages: false,
      isError,
    };
    const callComponent = tool.renderCall!(
      args,
      renderTheme as never,
      { ...contextBase, lastComponent: undefined } as never,
    );
    const resultComponent = tool.renderResult!(
      {
        content: [{ type: "text", text }],
        details: {},
      },
      { expanded: false, isPartial: false },
      renderTheme as never,
      { ...contextBase, lastComponent: undefined } as never,
    );
    return [callComponent, resultComponent]
      .flatMap((component) => component.render(100))
      .join("\n");
  };

  const output = render("Operation aborted", true);

  assert.match(output, /outside pi-sandbox — not run \(aborted\)/);
  assert.doesNotMatch(output, /outside pi-sandbox requested/);
  assert.doesNotMatch(render("Operation aborted", false), /outside pi-sandbox/);
  assert.doesNotMatch(render("Error: Operation aborted", true), /outside pi-sandbox/);
});

test("default Bash rendering is unchanged and has no escalation marker", () => {
  const base = fakeBashDefinition(async () => textResult("unused"));
  base.renderCall = () => new MutableComponent("plain base call");
  const tool = createEscalatingBashToolDefinition({
    base,
    label: "bash (sandboxed)",
    isSandboxActive: () => true,
    executeDefault: async () => textResult("sandbox"),
    promptQueue: neverPromptQueue,
    getPromptTimeoutSeconds: () => 600,
  });
  const component = tool.renderCall!(
    { command: "pwd" },
    renderTheme as never,
    {
      args: { command: "pwd" },
      lastComponent: undefined,
      state: {},
    } as never,
  );
  assert.deepEqual(component.render(100), ["plain base call"]);
});

test("escalation markers use stable requested, approval, and not-run copy", () => {
  assert.equal(formatEscalationMarker("requested"), "outside pi-sandbox requested");
  assert.equal(formatEscalationMarker("approved_once"), "outside pi-sandbox — approved once");
  for (const [status, suffix] of [
    ["denied", "denied"],
    ["cancelled", "cancelled"],
    ["aborted", "aborted"],
    ["timed_out", "timed out"],
    ["unavailable", "unavailable"],
    ["invalid", "invalid"],
  ] as const) {
    assert.equal(formatEscalationMarker(status), `outside pi-sandbox — not run (${suffix})`);
  }
});

test("Bash escalation not-run results are errors even when execution returned normally", () => {
  const tracker = createBashEscalationCallTracker();

  for (const status of [
    "denied",
    "cancelled",
    "aborted",
    "timed_out",
    "unavailable",
    "invalid",
  ] as const) {
    const result = tracker.handleToolResult({
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

test("Bash escalation tracker ignores nonterminal and unknown detail-carried statuses", () => {
  const tracker = createBashEscalationCallTracker();

  for (const status of ["requested", "approved_once", "unknown"] as const) {
    assert.equal(
      tracker.handleToolResult({
        type: "tool_result",
        toolName: "bash",
        toolCallId: `unchanged-${status}`,
        input: { command: "pwd" },
        content: [{ type: "text", text: "unchanged" }],
        details: { escalation: { status } },
        isError: false,
      } as ToolResultEvent),
      undefined,
      status,
    );
  }
});

test("Bash escalation tracker restores aborted metadata over conflicting details and consumes state", () => {
  const tracker = createBashEscalationCallTracker();
  tracker.markAborted("aborted-call");
  const event = {
    type: "tool_result",
    toolName: "bash",
    toolCallId: "aborted-call",
    input: { command: "pnpm install" },
    content: [{ type: "text", text: "aborted: escalated command was not run" }],
    details: {
      fullOutputPath: "/tmp/full-output",
      escalation: { status: "approved_once" },
    },
    isError: true,
  } satisfies ToolResultEvent;

  assert.deepEqual(tracker.handleToolResult(event), {
    details: {
      fullOutputPath: "/tmp/full-output",
      escalation: { status: "aborted" },
    },
    isError: true,
  });
  assert.equal(tracker.handleToolResult(event), undefined);
});

test("approved Bash tracker ignores unrelated results and overrides denied details", () => {
  const tracker = createBashEscalationCallTracker();
  tracker.markApproved("approved");
  const unrelated = {
    type: "tool_result",
    toolName: "read",
    toolCallId: "approved",
    input: { path: "README.md" },
    content: [{ type: "text", text: "data" }],
    details: undefined,
    isError: false,
  } satisfies ToolResultEvent;
  assert.equal(tracker.handleToolResult(unrelated), undefined);

  const result = tracker.handleToolResult({
    type: "tool_result",
    toolName: "bash",
    toolCallId: "approved",
    input: { command: "pwd" },
    content: [{ type: "text", text: "data" }],
    details: {
      fullOutputPath: "/tmp/full-output",
      escalation: { status: "denied" },
    },
    isError: false,
  });
  assert.deepEqual(result, {
    details: {
      fullOutputPath: "/tmp/full-output",
      escalation: { status: "approved_once" },
    },
  });
  assert.equal(
    tracker.handleToolResult({
      type: "tool_result",
      toolName: "bash",
      toolCallId: "missing",
      input: { command: "pwd" },
      content: [],
      details: undefined,
      isError: false,
    }),
    undefined,
  );
});
