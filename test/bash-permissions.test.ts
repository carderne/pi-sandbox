import assert from "node:assert/strict";
import test from "node:test";

import { Check } from "typebox/value";

import {
  createEscalationAbortError,
  createEscalationPromptQueue,
  createNotRunResult,
  isEscalationAbortError,
  isEscalationRequest,
  sandboxBashSchema,
  stripEscalationFields,
  validateEscalationJustification,
  withEscalationStatus,
  type EscalationDecision,
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
