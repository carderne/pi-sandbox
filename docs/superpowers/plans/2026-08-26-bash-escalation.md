# Explicit Bash Sandbox Escalation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Codex-style, one-call-at-a-time approval path that lets the model request execution of an exact Bash command outside pi-sandbox while leaving ordinary Bash execution unchanged.

**Architecture:** Put the escalation contract, fail-closed results, cancellation-aware FIFO queue, execution router, and renderer wrappers in a focused `src/bash-permissions.ts` module. Keep terminal interaction in `src/ui.ts`, then wire both into the existing Bash override in `src/extension.ts` so default calls retain the current sandbox/domain/write-recovery path and approved calls delegate exactly once to Pi's existing local Bash definition.

**Tech Stack:** TypeScript, pnpm, Node's built-in test runner, TypeBox 1.1.x, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui`.

**Spec:** `docs/superpowers/specs/2026-08-26-bash-escalation-design.md`

## Global Constraints

- Use pnpm and TypeScript.
- Omitted or `sandbox_permissions: "use_default"` must preserve the current sandboxed Bash path, parallelism, domain preflight, blocked-write recovery, timeout, streaming, truncation, and rendering behavior.
- `sandbox_permissions: "require_escalated"` is a one-time request for the exact original command string; never normalize, prepend, edit, cache, automatically retry, or execute it twice.
- Escalation is available only while pi-sandbox is active and both `ctx.mode === "tui"` and `ctx.hasUI` are true. RPC, JSON, and print modes fail closed without calling `ctx.ui.custom()` or either executor.
- `justification` is runtime-required for escalation, must contain non-whitespace text, and must contain at most 500 Unicode code points. It is ignored on ordinary calls.
- Every invalid, unavailable, denied, timed-out, and prompt-cancelled result must state that the command was not run outside pi-sandbox and must tell Bash not to retry without new user direction.
- A tool `AbortSignal` before process spawn must throw an error containing `aborted` and `escalated command was not run`; Escape/Ctrl-C inside the prompt returns a stable cancelled result instead.
- Serialize escalation prompts with a cancellation-aware FIFO queue. Keep ordinary Bash calls parallel, bind every decision to its own tool-call ID and exact command, and start the permission timeout only when that prompt becomes visible.
- The prompt must safely escape C0/C1 controls, DEL, ANSI escape bytes, bidirectional/format controls, and zero-width controls; keep fixed headers/actions around a bounded scrollable viewport; and execute the original string rather than its display form.
- Approval bypasses every pi-sandbox filesystem and network rule, including deny rules and the default `/Users` and `/home` read protection. UI and documentation must say “outside pi-sandbox,” because parent OS/container restrictions may remain.
- Escalated calls skip the fine-grained Bash domain preflight and blocked-write recovery. Default calls retain both.
- Do not change the `!command`/`user_bash` flow and do not add a configuration migration, approval-policy setting, or persistent approval state in v1.
- Preserve Pi's Bash command/timeout call rendering, output/result rendering, streaming, process-tree cancellation after spawn, and `truncation`/`fullOutputPath` details. Escalation metadata belongs only in `details`, never stdout/stderr.
- Add `typebox` as a direct runtime dependency; do not rely on Pi's transitive copy.
- Tests must inject prompt and executor fakes. Never execute a genuinely unsandboxed fixture command in the automated suite.

---

### Task 1: Define the Bash Escalation Contract and Fail-Closed Results

**Files:**
- Create: `src/bash-permissions.ts`
- Create: `test/bash-permissions.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `sandboxBashSchema`, `SandboxBashInput`, `BashEscalationStatus`, `SandboxBashDetails`, `EscalationDecision`, `EscalationPromptRequest`, `EscalationPrompt`, `validateEscalationJustification()`, `stripEscalationFields()`, `withEscalationStatus()`, `createNotRunResult()`, and `createEscalationAbortError()`.
- Produces: `isEscalationRequest(input: Pick<SandboxBashInput, "sandbox_permissions">): boolean`, used by the Bash tool router and `tool_call` domain preflight.

- [ ] **Step 1: Add TypeBox as a direct runtime dependency**

Run:

```bash
pnpm add typebox@^1.1.38
```

Expected: `package.json` contains `"typebox": "^1.1.38"` under `dependencies`, and `pnpm-lock.yaml` records it as a direct importer dependency without changing the Pi peer dependency range.

- [ ] **Step 2: Write failing schema, validation, metadata, and stable-result tests**

Create `test/bash-permissions.test.ts` with these initial tests:

```ts
import test from "node:test";

import assert from "node:assert/strict";
import { Check } from "typebox/value";

import {
  createEscalationAbortError,
  createNotRunResult,
  isEscalationRequest,
  sandboxBashSchema,
  stripEscalationFields,
  validateEscalationJustification,
  withEscalationStatus,
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
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /not run outside pi-sandbox/i);
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /do not retry/i);
  assert.deepEqual(result.details, { escalation: { status: "denied" } });
  assert.match(createEscalationAbortError().message, /aborted.*escalated command was not run/i);
});
```

- [ ] **Step 3: Run the focused test to verify it fails**

Run:

```bash
pnpm exec tsx --test test/bash-permissions.test.ts
```

Expected: FAIL because `src/bash-permissions.ts` does not exist.

- [ ] **Step 4: Implement the schema, types, validation, metadata merge, and centralized result text**

Create `src/bash-permissions.ts` with this public shape and behavior:

```ts
import {
  type AgentToolResult,
  type BashToolDetails,
  type BashToolInput,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

export const MAX_JUSTIFICATION_CODE_POINTS = 500;

export const sandboxBashSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(
    Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }),
  ),
  sandbox_permissions: Type.Optional(
    Type.Union([Type.Literal("use_default"), Type.Literal("require_escalated")], {
      description: "Use pi-sandbox by default, or request one-time execution outside pi-sandbox",
    }),
  ),
  justification: Type.Optional(
    Type.String({ description: "Concise user-facing reason for Bash escalation" }),
  ),
});

export type SandboxBashInput = Static<typeof sandboxBashSchema>;
export type BashEscalationStatus =
  | "requested"
  | "approved_once"
  | "denied"
  | "cancelled"
  | "timed_out"
  | "unavailable"
  | "invalid";

export interface SandboxBashDetails extends BashToolDetails {
  escalation?: { status: BashEscalationStatus };
}

export type EscalationDecision =
  | { action: "allow_once" }
  | { action: "deny"; reason: "user" | "timeout" | "cancelled" | "unavailable" };

export interface EscalationPromptRequest {
  toolCallId: string;
  command: string;
  justification: string;
  timeoutSeconds?: number;
  signal?: AbortSignal;
  ctx: ExtensionContext;
}

export type EscalationPrompt = (
  request: EscalationPromptRequest,
) => Promise<EscalationDecision>;

export const BASH_ESCALATION_GUIDELINES = [
  "When using Bash, use the default sandbox first unless the operation is inherently known to require execution outside pi-sandbox.",
  "For Bash, use require_escalated only when the command is necessary and sandbox restrictions prevent it from succeeding.",
  "For Bash escalation, include a concise, user-facing justification describing the capability being requested.",
  "For Bash escalation, do not retry after a denial, cancellation, timeout, or unavailable result unless the user explicitly asks.",
  "For Bash escalation, do not claim the command ran unless the tool returns its actual command output.",
] as const;

type JustificationValidation =
  | { ok: true; justification: string }
  | { ok: false; message: string };

export function validateEscalationJustification(value: unknown): JustificationValidation {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, message: "Bash escalation requires a non-blank justification." };
  }
  const justification = value.trim();
  if ([...justification].length > MAX_JUSTIFICATION_CODE_POINTS) {
    return {
      ok: false,
      message: `Bash escalation justification must be at most ${MAX_JUSTIFICATION_CODE_POINTS} Unicode code points.`,
    };
  }
  return { ok: true, justification };
}

export function isEscalationRequest(
  input: Pick<SandboxBashInput, "sandbox_permissions">,
): boolean {
  return input.sandbox_permissions === "require_escalated";
}

export function stripEscalationFields(input: SandboxBashInput): BashToolInput {
  return input.timeout === undefined
    ? { command: input.command }
    : { command: input.command, timeout: input.timeout };
}

export function withEscalationStatus(
  details: BashToolDetails | SandboxBashDetails | undefined,
  status: BashEscalationStatus,
): SandboxBashDetails {
  return { ...details, escalation: { status } };
}

const NOT_RUN_TEXT: Record<"invalid" | "unavailable" | "denied" | "cancelled" | "timed_out", string> = {
  invalid: "Invalid Bash escalation request. The command was not run outside pi-sandbox. Do not retry without new user direction.",
  unavailable: "Bash escalation is unavailable because local TUI approval is required. The command was not run outside pi-sandbox. Do not retry without new user direction.",
  denied: "Bash escalation was denied. The command was not run outside pi-sandbox. Do not retry without new user direction.",
  cancelled: "Bash escalation was cancelled by the user. The command was not run outside pi-sandbox. Do not retry without new user direction.",
  timed_out: "Bash escalation timed out. The command was not run outside pi-sandbox. Do not retry without new user direction.",
};

export function createNotRunResult(
  status: keyof typeof NOT_RUN_TEXT,
  prefix?: string,
): AgentToolResult<SandboxBashDetails> {
  const text = prefix ? `${prefix} ${NOT_RUN_TEXT[status]}` : NOT_RUN_TEXT[status];
  return { content: [{ type: "text", text }], details: withEscalationStatus(undefined, status) };
}

export function createEscalationAbortError(): Error {
  return new Error("aborted: escalated command was not run outside pi-sandbox");
}
```

Keep the exact stable strings in one module. If Pi's `TruncationResult` requires additional fields at compile time, construct the test fixture with the exact fields from `BashToolDetails["truncation"]` rather than weakening production types.

- [ ] **Step 5: Run the focused test and static checks**

Run:

```bash
pnpm exec tsx --test test/bash-permissions.test.ts
pnpm run check
```

Expected: both commands PASS.

- [ ] **Step 6: Commit the contract**

```bash
git add package.json pnpm-lock.yaml src/bash-permissions.ts test/bash-permissions.test.ts
git commit -m "feat: define bash escalation contract"
```

---

### Task 2: Add the Cancellation-Aware FIFO Approval Queue

**Files:**
- Modify: `src/bash-permissions.ts`
- Modify: `test/bash-permissions.test.ts`

**Interfaces:**
- Consumes: `EscalationPrompt`, `EscalationPromptRequest`, and `createEscalationAbortError()` from Task 1.
- Produces: `EscalationPromptQueue` with `enqueue(request: EscalationPromptRequest): Promise<EscalationDecision>` and `createEscalationPromptQueue(prompt: EscalationPrompt): EscalationPromptQueue`.

- [ ] **Step 1: Write failing queue-order and decision-binding tests**

Append tests that hold the first fake prompt open and prove the second prompt is not visible until the first resolves:

```ts
import { createEscalationPromptQueue, type EscalationDecision } from "../src/bash-permissions.ts";

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
```

- [ ] **Step 2: Write failing cancellation and queue-release tests**

Append tests covering a pre-aborted request, a queued abort, an active prompt rejection, and a prompt implementation that throws:

```ts
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

  const first = queue.enqueue({ toolCallId: "1", command: "first", justification: "one", ctx });
  const second = queue.enqueue({
    toolCallId: "2",
    command: "second",
    justification: "two",
    signal: queuedAbort.signal,
    ctx,
  });
  const third = queue.enqueue({ toolCallId: "3", command: "third", justification: "three", ctx });
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
```

- [ ] **Step 3: Run the focused tests to verify they fail**

Run:

```bash
pnpm exec tsx --test test/bash-permissions.test.ts
```

Expected: FAIL because `createEscalationPromptQueue()` is not exported.

- [ ] **Step 4: Implement the FIFO queue**

Add this queue structure to `src/bash-permissions.ts`:

```ts
export interface EscalationPromptQueue {
  enqueue(request: EscalationPromptRequest): Promise<EscalationDecision>;
}

interface QueueEntry {
  request: EscalationPromptRequest;
  resolve: (decision: EscalationDecision) => void;
  reject: (error: unknown) => void;
  removeQueuedAbortListener?: () => void;
}

export function createEscalationPromptQueue(prompt: EscalationPrompt): EscalationPromptQueue {
  const pending: QueueEntry[] = [];
  let active = false;

  const pump = (): void => {
    if (active) return;
    const entry = pending.shift();
    if (!entry) return;

    entry.removeQueuedAbortListener?.();
    if (entry.request.signal?.aborted) {
      entry.reject(createEscalationAbortError());
      queueMicrotask(pump);
      return;
    }

    active = true;
    Promise.resolve()
      .then(() => prompt(entry.request))
      .then(entry.resolve, entry.reject)
      .finally(() => {
        active = false;
        pump();
      });
  };

  return {
    enqueue(request) {
      if (request.signal?.aborted) return Promise.reject(createEscalationAbortError());

      return new Promise<EscalationDecision>((resolve, reject) => {
        const entry: QueueEntry = { request, resolve, reject };
        const onQueuedAbort = (): void => {
          const index = pending.indexOf(entry);
          if (index === -1) return;
          pending.splice(index, 1);
          reject(createEscalationAbortError());
        };
        if (request.signal) {
          request.signal.addEventListener("abort", onQueuedAbort, { once: true });
          entry.removeQueuedAbortListener = () =>
            request.signal?.removeEventListener("abort", onQueuedAbort);
        }
        pending.push(entry);
        pump();
      });
    },
  };
}
```

The visible prompt owns active-signal handling; it receives the same signal, checks it before rendering, closes itself on abort, and rejects. The queue owns pre-visible cancellation. Removing the queued listener immediately before calling the prompt avoids applying a queued cancellation callback to an active prompt, while the prompt's initial signal check closes the handoff race.

- [ ] **Step 5: Run the focused tests and static checks**

Run:

```bash
pnpm exec tsx --test test/bash-permissions.test.ts
pnpm run check
```

Expected: PASS. The tests also prove that exceptional settlement cannot wedge later escalation requests.

- [ ] **Step 6: Commit the queue**

```bash
git add src/bash-permissions.ts test/bash-permissions.test.ts
git commit -m "feat: serialize bash escalation prompts"
```

---

### Task 3: Build the Safe, Fail-Closed TUI Escalation Prompt

**Files:**
- Modify: `src/ui.ts`
- Modify: `test/ui.test.ts`

**Interfaces:**
- Consumes: `EscalationDecision`, `EscalationPromptRequest`, and `createEscalationAbortError()` from Task 1.
- Produces: `escapeTerminalPromptText(value: string): string` and `showBashEscalationPrompt(pi: ExtensionAPI, request: EscalationPromptRequest): Promise<EscalationDecision>`.
- The prompt body has a fixed maximum of 12 visible lines and scrolls with Up/Down/PageUp/PageDown; header, warning, choices, countdown, and footer are outside the body viewport.

- [ ] **Step 1: Write failing safe-display and TUI-gating tests**

Extend `test/ui.test.ts` imports and add these tests:

```ts
import { type Component, Key } from "@earendil-works/pi-tui";
import { escapeTerminalPromptText, showBashEscalationPrompt } from "../src/ui.ts";

test("escapeTerminalPromptText exposes terminal and Unicode controls", () => {
  assert.equal(
    escapeTerminalPromptText("ok\n\t\x1b[31m\x7f\x85\u202e\u2066\u200btext"),
    "ok\\n\\t\\u{1b}[31m\\u{7f}\\u{85}\\u{202e}\\u{2066}\\u{200b}text",
  );
});

test("Bash escalation is unavailable outside a local TUI without opening custom UI", async () => {
  for (const mode of ["rpc", "json", "print"] as const) {
    let customCalls = 0;
    const ctx = {
      mode,
      hasUI: mode === "rpc",
      ui: { custom: () => { customCalls++; } },
    } as unknown as ExtensionContext;
    const result = await showBashEscalationPrompt({ events: { emit() {} } } as never, {
      toolCallId: mode,
      command: "pnpm install",
      justification: "Need registry access?",
      ctx,
    });
    assert.deepEqual(result, { action: "deny", reason: "unavailable" });
    assert.equal(customCalls, 0);
  }
});
```

- [ ] **Step 2: Add a reusable prompt harness and failing interaction tests**

Add a local `createEscalationPromptHarness()` beside the existing permission-prompt harness. It must capture the component, call `dispose()` when `done()` resolves, expose `render(width)`, and expose `input(data)`. Use it in tests with these assertions:

```ts
function createEscalationPromptHarness() {
  let component: (Component & { dispose?(): void }) | undefined;
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const attentionEvents: string[] = [];
  const pi = {
    events: { emit: (name: string) => attentionEvents.push(name) },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: "/workspace",
    mode: "tui",
    hasUI: true,
    ui: {
      custom: <T>(factory: any): Promise<T> =>
        new Promise<T>((resolve) => {
          const done = (result: T): void => {
            resolve(result);
            queueMicrotask(() => component?.dispose?.());
          };
          Promise.resolve(
            factory(
              { requestRender: () => undefined },
              { fg: (_color: string, text: string) => text },
              {},
              done,
            ),
          ).then((created) => {
            component = created;
            markReady();
          });
        }),
    },
  } as unknown as ExtensionContext;

  return {
    pi,
    ctx,
    ready,
    attentionEvents,
    render: (width: number) => component!.render(width),
    input: (data: string) => component!.handleInput?.(data),
    dispose: () => component!.dispose?.(),
  };
}

const requestFor = (ctx: ExtensionContext, signal?: AbortSignal) => ({
  toolCallId: "prompt-test",
  command: "printf exact",
  justification: "Need an exact local capability?",
  timeoutSeconds: 0,
  signal,
  ctx,
});
```

Use the harness in tests with these assertions:

```ts
test("escalation prompt keeps fixed controls and scrolls through the complete safe command", async () => {
  const harness = createEscalationPromptHarness();
  const command = Array.from({ length: 30 }, (_, index) => `line-${index}`).join("\n");
  const pending = showBashEscalationPrompt(harness.pi, {
    toolCallId: "long",
    command,
    justification: "Inspect every line before approval",
    timeoutSeconds: 0,
    ctx: harness.ctx,
  });
  await harness.ready;

  const first = harness.render(48).join("\n");
  assert.match(first, /Run outside pi-sandbox\?/);
  assert.match(first, /bypasses all pi-sandbox filesystem and network rules/i);
  assert.match(first, /Allow once/);
  assert.match(first, /Deny/);
  assert.match(first, /line-0/);
  assert.doesNotMatch(first, /line-29/);

  for (let index = 0; index < 40; index++) harness.input(Key.down);
  const last = harness.render(48).join("\n");
  assert.match(last, /line-29/);
  assert.match(last, /Allow once/);
  assert.match(last, /Deny/);
  harness.input(Key.escape);
  assert.deepEqual(await pending, { action: "deny", reason: "cancelled" });
});

test("escalation prompt defaults to deny and distinguishes user cancellation", async () => {
  const denied = createEscalationPromptHarness();
  const denyPending = showBashEscalationPrompt(denied.pi, requestFor(denied.ctx));
  await denied.ready;
  denied.input(Key.enter);
  assert.deepEqual(await denyPending, { action: "deny", reason: "user" });

  for (const key of [Key.escape, Key.ctrl("c")]) {
    const cancelled = createEscalationPromptHarness();
    const cancelPending = showBashEscalationPrompt(cancelled.pi, requestFor(cancelled.ctx));
    await cancelled.ready;
    cancelled.input(key);
    assert.deepEqual(await cancelPending, { action: "deny", reason: "cancelled" });
  }
});

test("escalation prompt allows once only after an explicit selection", async () => {
  const harness = createEscalationPromptHarness();
  const pending = showBashEscalationPrompt(harness.pi, requestFor(harness.ctx));
  await harness.ready;
  harness.input(Key.right);
  harness.input(Key.enter);
  assert.deepEqual(await pending, { action: "allow_once" });
});
```

- [ ] **Step 3: Write failing timeout, disposal, signal-abort, and cleanup tests**

Add tests that use a 1 ms timeout, explicitly invoke `dispose()`, and abort an `AbortController`. Assert respectively:

```ts
assert.deepEqual(await timedPending, { action: "deny", reason: "timeout" });
assert.deepEqual(await disposedPending, { action: "deny", reason: "unavailable" });
await assert.rejects(abortedPending, /aborted.*escalated command was not run/i);
```

After each resolved prompt, abort its controller and assert that no additional render or decision occurs. Also assert that `request-attention` is emitted once only after TUI gating succeeds. The focused Node test process must exit cleanly; a leaked countdown interval would keep it open and fail the test timeout.

- [ ] **Step 4: Run the UI tests to verify they fail**

Run:

```bash
pnpm exec tsx --test test/ui.test.ts
```

Expected: FAIL because the new prompt exports do not exist.

- [ ] **Step 5: Implement safe text escaping and the bounded prompt component**

Update the Pi TUI import to include `wrapTextWithAnsi`. Implement escaping by Unicode code point, not UTF-16 code unit:

```ts
const MAX_ESCALATION_VIEWPORT_LINES = 12;

export function escapeTerminalPromptText(value: string): string {
  return [...value]
    .map((character) => {
      if (character === "\n") return "\\n";
      if (character === "\r") return "\\r";
      if (character === "\t") return "\\t";
      if (/^[\p{Cc}\p{Cf}]$/u.test(character)) {
        return `\\u{${character.codePointAt(0)!.toString(16)}}`;
      }
      return character;
    })
    .join("");
}
```

Implement `showBashEscalationPrompt()` with this lifecycle:

1. Return `{ action: "deny", reason: "unavailable" }` before emitting attention when mode is not TUI or `hasUI` is false.
2. Throw `createEscalationAbortError()` if the signal is already aborted.
3. Emit `request-attention`, then call `ctx.ui.custom()`.
4. Build safely escaped justification and command lines with `wrapTextWithAnsi(text, Math.max(1, width))` during each render. Keep the title, full-bypass warning, countdown, **Deny**/**Allow once** choices, and footer outside `bodyLines.slice(scrollOffset, scrollOffset + 12)`.
5. Start `permissionPromptTimeoutMs(request.timeoutSeconds)` only inside the custom-component factory, so queued time never consumes the deadline.
6. Initialize selection to **Deny**. Left/Right changes the choice; Enter resolves the selected choice. Escape/Ctrl-C resolve prompt cancellation. Up/Down scroll one body line and PageUp/PageDown scroll twelve lines without changing the approval selection.
7. On signal abort, resolve an internal `{ action: "tool_aborted" }` outcome solely to close `ctx.ui.custom()`, then throw `createEscalationAbortError()` after the custom promise resolves.
8. On timeout resolve denial reason `timeout`; on component disposal before another decision resolve reason `unavailable`; if `ctx.ui.custom()` returns `undefined`, also return unavailable.
9. A single guarded `finish()` clears timeout/countdown handles and the abort listener before calling `done()`. `dispose()` uses the same guarded path, so recursive disposal after `done()` cannot change the decision.

Use an internal outcome type so the public return type remains `EscalationDecision`:

```ts
type EscalationPromptOutcome = EscalationDecision | { action: "tool_aborted" };
```

The warning text must be fixed extension-owned copy:

```text
This command bypasses all pi-sandbox filesystem and network rules, including configured deny rules. Parent OS or container restrictions may still apply.
```

Never apply `theme` formatting to model-provided strings before `escapeTerminalPromptText()`. The original `request.command` remains untouched in the request and is not replaced with the display value.

- [ ] **Step 6: Run UI tests and static checks**

Run:

```bash
pnpm exec tsx --test test/ui.test.ts
pnpm run check
```

Expected: PASS, including cleanup assertions for every resolution path.

- [ ] **Step 7: Commit the prompt**

```bash
git add src/ui.ts test/ui.test.ts
git commit -m "feat: prompt for one-time bash escalation"
```

---

### Task 4: Route Approved Calls Exactly Once to Pi's Local Bash Executor

**Files:**
- Modify: `src/bash-permissions.ts`
- Modify: `test/bash-permissions.test.ts`

**Interfaces:**
- Consumes: the validation, queue, result, metadata, and strip helpers from Tasks 1–2.
- Produces: `BashExecutor` and `executeEscalatedBash(options: ExecuteEscalatedBashOptions): Promise<AgentToolResult<SandboxBashDetails | undefined>>`.
- `ExecuteEscalatedBashOptions` includes the tool-call ID, `SandboxBashInput`, signal, update callback, extension context, visible-prompt timeout, queue, and injected local executor.

- [ ] **Step 1: Write failing tests for invalid and unavailable requests**

Add an executor spy and prompt spy, then cover missing/blank/501-code-point justifications and `{ mode: "rpc", hasUI: true }`. Use this assertion pattern for each case:

Add these shared fixtures before the router tests:

```ts
const tuiContext = { mode: "tui", hasUI: true } as unknown as ExtensionContext;
const rpcContext = { mode: "rpc", hasUI: true } as unknown as ExtensionContext;
const textContent = (result: AgentToolResult<unknown>): string =>
  result.content
    .filter((item): item is Extract<(typeof result.content)[number], { type: "text" }> =>
      item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
const allowQueue: EscalationPromptQueue = {
  enqueue: async () => ({ action: "allow_once" }),
};
```

```ts
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
  return { content: [{ type: "text", text: "unexpected" }] };
};
const result = await executeEscalatedBash({
  toolCallId: "invalid",
  input: { command: "never-run", sandbox_permissions: "require_escalated" },
  ctx: rpcContext,
  queue,
  executeLocal,
});
assert.equal(promptCalls, 0);
assert.equal(executorCalls.length, 0);
assert.match(textContent(result), /not run outside pi-sandbox/i);
assert.deepEqual(result.details?.escalation?.status, "invalid");
```

For RPC with a valid justification, expect status `unavailable`, no prompt call, and no executor call. Include TUI with `hasUI: false` in the same table.

- [ ] **Step 2: Write failing approval, metadata, and no-retry tests**

Add tests with an injected queue returning `{ action: "allow_once" }`:

```ts
test("approval delegates the exact command and timeout once and preserves Bash details", async () => {
  const calls: unknown[][] = [];
  const updates: unknown[] = [];
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
  });

  assert.equal(calls.length, 1);
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
```

Add a second test where `executeLocal` throws `new Error("spawn failed")`; assert the same error is propagated and `executeLocal` was called once. There must be no sandbox executor in this interface, which makes fallback or blocked-write retry impossible on the escalated path.

- [ ] **Step 3: Write failing denial and cancellation-race tests**

Table-test queue decisions and expected statuses:

```ts
const deniedCases = [
  [{ action: "deny", reason: "user" }, "denied"],
  [{ action: "deny", reason: "timeout" }, "timed_out"],
  [{ action: "deny", reason: "cancelled" }, "cancelled"],
  [{ action: "deny", reason: "unavailable" }, "unavailable"],
] as const;
```

For each, assert neither executor is invoked, the content says the command was not run and not to retry, and `details.escalation.status` matches. Add distinct abort tests for:

- signal already aborted before enqueue;
- queue rejection while queued/visible;
- signal aborted by the fake queue immediately before returning `{ action: "allow_once" }`.

Each abort must reject with `/aborted.*escalated command was not run/i` and leave the executor call count at zero.

- [ ] **Step 4: Run focused tests to verify they fail**

Run:

```bash
pnpm exec tsx --test test/bash-permissions.test.ts
```

Expected: FAIL because the execution router is not exported.

- [ ] **Step 5: Implement the execution router with metadata-preserving updates**

Add these interfaces to `src/bash-permissions.ts`, importing `AgentToolUpdateCallback`:

```ts
export type BashExecutor = (
  toolCallId: string,
  input: BashToolInput,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined,
  ctx: ExtensionContext,
) => Promise<AgentToolResult<BashToolDetails | undefined>>;

export interface ExecuteEscalatedBashOptions {
  toolCallId: string;
  input: SandboxBashInput;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback<SandboxBashDetails | undefined>;
  ctx: ExtensionContext;
  promptTimeoutSeconds?: number;
  queue: EscalationPromptQueue;
  executeLocal: BashExecutor;
}
```

Implement this order exactly:

```ts
export async function executeEscalatedBash(
  options: ExecuteEscalatedBashOptions,
): Promise<AgentToolResult<SandboxBashDetails | undefined>> {
  const validation = validateEscalationJustification(options.input.justification);
  if (!validation.ok) return createNotRunResult("invalid", validation.message);
  if (options.ctx.mode !== "tui" || !options.ctx.hasUI) {
    return createNotRunResult("unavailable");
  }
  if (options.signal?.aborted) throw createEscalationAbortError();

  const decision = await options.queue.enqueue({
    toolCallId: options.toolCallId,
    command: options.input.command,
    justification: validation.justification,
    timeoutSeconds: options.promptTimeoutSeconds,
    signal: options.signal,
    ctx: options.ctx,
  });

  if (decision.action === "deny") {
    const status = {
      user: "denied",
      timeout: "timed_out",
      cancelled: "cancelled",
      unavailable: "unavailable",
    } as const;
    return createNotRunResult(status[decision.reason]);
  }

  if (options.signal?.aborted) throw createEscalationAbortError();
  const approved = "approved_once" as const;
  options.onUpdate?.({ content: [], details: withEscalationStatus(undefined, approved) });

  const forwardUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined =
    options.onUpdate
      ? (update) =>
          options.onUpdate?.({
            ...update,
            details: withEscalationStatus(update.details, approved),
          })
      : undefined;
  const result = await options.executeLocal(
    options.toolCallId,
    stripEscalationFields(options.input),
    options.signal,
    forwardUpdate,
    options.ctx,
  );
  return { ...result, details: withEscalationStatus(result.details, approved) };
}
```

Do not catch local execution errors. Once `executeLocal()` begins, Pi's local Bash implementation owns signal handling and process-tree termination.

- [ ] **Step 6: Run focused tests and static checks**

Run:

```bash
pnpm exec tsx --test test/bash-permissions.test.ts
pnpm run check
```

Expected: PASS.

- [ ] **Step 7: Commit the router**

```bash
git add src/bash-permissions.ts test/bash-permissions.test.ts
git commit -m "feat: route approved bash calls outside sandbox"
```

---

### Task 5: Wrap Pi's Bash Definition and Wire It into the Extension

**Files:**
- Modify: `src/bash-permissions.ts`
- Modify: `src/extension.ts`
- Modify: `test/bash-permissions.test.ts`

**Interfaces:**
- Consumes: `createBashToolDefinition()` from Pi and all Task 1–4 escalation interfaces.
- Produces: `createEscalatingBashToolDefinition(options)`, which returns the expanded Bash tool while delegating ordinary execution and Pi rendering through injected definitions/callbacks.
- Produces: durable call/result marker copy via `formatEscalationMarker(status)`.
- `CreateEscalatingBashToolOptions` contains `base`, `label`, `isSandboxActive()`, `executeDefault`, `promptQueue`, and `getPromptTimeoutSeconds(ctx)` with the exact signatures below.

- [ ] **Step 1: Write failing tool-routing and prompt-guideline tests**

Add tests around `createEscalatingBashToolDefinition()` with fake `base.execute`, `executeDefault`, and queue functions:

Add the production interface before implementing the factory:

```ts
export interface CreateEscalatingBashToolOptions {
  base: ReturnType<typeof createBashToolDefinition>;
  label: string;
  isSandboxActive: () => boolean;
  executeDefault: BashExecutor;
  promptQueue: EscalationPromptQueue;
  getPromptTimeoutSeconds: (ctx: ExtensionContext) => number | undefined;
}
```

Add these concrete test helpers; `createToolHarness()` composes the same public options rather than reaching into extension state:

```ts
const textResult = (text: string) => ({ content: [{ type: "text" as const, text }] });

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
```

```ts
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

  await tool.execute(
    "disabled",
    {
      command: "pwd",
      sandbox_permissions: "require_escalated",
      justification: "ignored while sandbox is disabled",
    },
    undefined,
    undefined,
    tuiContext,
  );
  assert.deepEqual(calls, ["local"]);
  assert.deepEqual(tool.promptGuidelines, BASH_ESCALATION_GUIDELINES);
});

test("active default Bash uses the existing sandbox path without prompting", async () => {
  const calls: string[] = [];
  const tool = createToolHarness({
    isSandboxActive: true,
    onLocal: () => calls.push("local"),
    onDefault: (input) => calls.push(`sandbox:${input.command}`),
    onPrompt: () => calls.push("prompt"),
  });
  await tool.execute(
    "default",
    { command: "pnpm test", sandbox_permissions: "use_default", justification: "ignored" },
    undefined,
    undefined,
    tuiContext,
  );
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
      sandbox_permissions: "require_escalated",
      justification: "Need registry access?",
    },
    undefined,
    undefined,
    tuiContext,
  );
  assert.deepEqual(calls, ["prompt:pnpm install", "local"]);
});
```

The harness must also assert all five flattened guideline strings name “Bash” and that `executionMode` is not changed to `"sequential"`.

- [ ] **Step 2: Write failing renderer-delegation and durable-marker tests**

Use a fake base renderer that records its arguments and reuses `context.lastComponent`. Assert:

- `renderCall()` receives only `{ command, timeout }`, so extra escalation fields do not alter Pi's command/timeout rendering.
- The wrapper passes the previously wrapped base child—not the outer wrapper—as `lastComponent` on re-render.
- `renderResult()` receives the original result object with `truncation` and `fullOutputPath` intact.
- Marker text is `outside pi-sandbox requested`, `outside pi-sandbox — approved once`, or `outside pi-sandbox — not run (denied|cancelled|timed out|unavailable|invalid)` as appropriate.
- A restored denied result never contains `approved once`.
- A default call/result has no escalation marker and renders exactly the base component's lines.

Use `component.render(100).join("\n")` for output assertions and pass a minimal theme fake whose `fg()` and `bold()` return their text unchanged.

- [ ] **Step 3: Run focused tests to verify they fail**

Run:

```bash
pnpm exec tsx --test test/bash-permissions.test.ts
```

Expected: FAIL because the Bash definition wrapper is not exported.

- [ ] **Step 4: Implement the tool-definition and renderer wrappers**

In `src/bash-permissions.ts`:

1. Import `Container`, `Text`, and the Pi `ToolDefinition`/render context types.
2. Define a private `EscalationRenderComponent extends Container` holding its current `baseComponent` and `markerComponent`.
3. Before delegating a base renderer, unwrap `context.lastComponent` when it is an `EscalationRenderComponent`; this preserves Pi's `Text.setText()` and Bash result component reuse instead of handing Pi the outer container.
4. Store `escalationStatus?: BashEscalationStatus` alongside Pi's opaque renderer state via an intersection cast. Update it from partial/final result details and use it in both wrappers.
5. When there is no marker, return the base component directly. When there is a marker, return/rebuild the outer container with the base component followed by a dim marker `Text`. Never insert marker text into `AgentToolResult.content`.

Define exact marker copy:

```ts
export function formatEscalationMarker(status: BashEscalationStatus): string {
  switch (status) {
    case "requested":
      return "outside pi-sandbox requested";
    case "approved_once":
      return "outside pi-sandbox — approved once";
    case "timed_out":
      return "outside pi-sandbox — not run (timed out)";
    default:
      return `outside pi-sandbox — not run (${status})`;
  }
}
```

The factory's execution router must be:

```ts
if (!options.isSandboxActive()) {
  return options.base.execute(id, stripEscalationFields(params), signal, onUpdate, ctx);
}
if (!isEscalationRequest(params)) {
  return options.executeDefault(id, stripEscalationFields(params), signal, onUpdate, ctx);
}
return executeEscalatedBash({
  toolCallId: id,
  input: params,
  signal,
  onUpdate,
  ctx,
  promptTimeoutSeconds: options.getPromptTimeoutSeconds(ctx),
  queue: options.promptQueue,
  executeLocal: options.base.execute.bind(options.base),
});
```

Spread `options.base`, then override `label`, `parameters`, `promptGuidelines`, `execute`, `renderCall`, and `renderResult`. Do not set `executionMode`; Pi's default parallel behavior must remain in force.

- [ ] **Step 5: Replace the inline Bash registration with the wrapper**

In `src/extension.ts`:

1. Import `createEscalatingBashToolDefinition`, `createEscalationPromptQueue`, `isEscalationRequest`, `SandboxBashInput`, and the executor types.
2. Import `showBashEscalationPrompt` from `src/ui.ts`.
3. Create one extension-lifetime queue:

```ts
const escalationPromptQueue = createEscalationPromptQueue((request) =>
  showBashEscalationPrompt(pi, request),
);
```

4. Move the body of the current registered Bash `execute()` into a local `executeDefaultBash` callback. Keep its `runBash()`, OS-restriction conversion, blocked-write extraction, prompt, sandbox refresh, and one retry byte-for-byte in behavior. Its parameters are already stripped `BashToolInput`, so escalation fields never reach blocked-write recovery.
5. Register:

```ts
pi.registerTool(
  createEscalatingBashToolDefinition({
    base: localBash,
    label: "bash (sandboxed)",
    isSandboxActive: () => sandboxEnabled && sandboxInitialized,
    executeDefault: executeDefaultBash,
    promptQueue: escalationPromptQueue,
    getPromptTimeoutSeconds: (ctx) => loadConfig(ctx.cwd).permissionPromptTimeoutSeconds,
  }),
);
```

6. In the Bash branch of the `tool_call` handler, cast `event.input` to `SandboxBashInput` and return before domain extraction when `isEscalationRequest(input)` is true. Do this before any `promptDomainBlock()` call. Validation and TUI availability remain the execution router's responsibility, so an invalid escalation cannot fall through to a fine-grained prompt and then execute.

This wiring ensures an escalated call cannot enter either the default domain preflight or default blocked-write recovery, while omitted/`use_default` calls retain both.

- [ ] **Step 6: Run focused and regression tests**

Run:

```bash
pnpm exec tsx --test test/bash-permissions.test.ts
pnpm exec tsx --test test/ui.test.ts test/policy.test.ts test/sandbox-runtime.test.ts
pnpm run check
```

Expected: PASS. Executor spies show zero execution on every non-approval path and one local call on approval.

- [ ] **Step 7: Commit extension integration**

```bash
git add src/bash-permissions.ts src/extension.ts test/bash-permissions.test.ts
git commit -m "feat: integrate explicit bash escalation"
```

---

### Task 6: Document the Security Boundary and Complete Verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the completed tool schema and behavior.
- Produces: user documentation for model-requested escalation, local-TUI-only approval, durable markers, queue/cancellation behavior, and the complete pi-sandbox bypass warning.

- [ ] **Step 1: Add the normal-failure/explicit-retry example**

After the Usage block, add a `### One-time Bash escalation` section containing both calls:

```json
{"command":"pnpm install"}
```

If that necessary command fails because of pi-sandbox, the model may make a new call:

```json
{
  "command": "pnpm install",
  "sandbox_permissions": "require_escalated",
  "justification": "Allow pnpm to reach the registry and update its cache outside this workspace?"
}
```

State that the retry is never automatic, approval is for this exact invocation only, no approval is remembered, and denied/cancelled/timed-out/unavailable requests must not be repeated without new user direction.

- [ ] **Step 2: Document the full security and mode boundary**

Add explicit prose that **Allow once** bypasses all pi-sandbox `allowRead`, `denyRead`, `allowWrite`, `denyWrite`, `allowedDomains`, and `deniedDomains` enforcement for that command and its subprocesses, including default broad-read protection for `/Users` and `/home`. Use “outside pi-sandbox,” not “unrestricted,” and note that the OS, a parent app sandbox, or a container can still deny access.

State that v1 works only in Pi's local TUI. RPC remains unsupported even though it reports `hasUI: true`, because it cannot render the custom complete-command approval component. JSON and print modes are also unsupported and execute nothing.

- [ ] **Step 3: Document prompt durability, queueing, and cancellation**

Document these facts exactly:

- Call history shows requested, approved-once, or not-run status without mixing that status into command output.
- Simultaneous escalation prompts are displayed FIFO, one at a time; ordinary Bash commands remain parallel.
- Escape/Ctrl-C inside the prompt declines only that request and returns a stable cancelled result.
- Cancelling the tool/turn closes a queued or visible request, runs nothing, and preserves Pi's abort semantics.
- Permission timeout begins only once a queued prompt is visible.

- [ ] **Step 4: Run the complete automated verification suite**

Run:

```bash
pnpm run ci:fmt
pnpm run lint
pnpm run check
pnpm test
git diff --check HEAD
```

Expected: formatting, lint, type checking, every test, and whitespace validation PASS. If formatting fails, run `pnpm run fmt`, inspect the diff, and rerun all five commands before continuing.

- [ ] **Step 5: Perform local interactive fail-closed verification**

From the worktree root, launch a local TUI with:

```bash
pi -e ./index.ts
```

Then verify:

1. Run an ordinary command that succeeds and confirm there is no escalation marker or prompt.
2. Run `ls /Users` on macOS or `ls /home` on Linux with default permissions and confirm the configured broad-read protection blocks it.
3. Request escalation for that exact blocked command, inspect the complete command, select **Deny**, and confirm history says not run and no output claims success.
4. Repeat the exact request, select **Allow once**, and confirm local output appears once with the approved-once marker.
5. Start two escalation requests in one model response, verify only one approval component is visible, deny the first, and confirm the second prompt shows its own exact command.
6. Dismiss one prompt with Escape and cancel one at the tool/turn level; confirm neither command runs and their outcomes remain distinct.
7. In RPC or print mode, issue a valid escalation request and confirm it returns unavailable without opening a prompt or executing the command.

Record any Pi invocation detail needed for repeatability in the PR testing notes, not in production code.

- [ ] **Step 6: Review the final diff against the spec's safety invariants**

Run:

```bash
git diff eec3354 -- src package.json pnpm-lock.yaml README.md test
```

Confirm from the diff that:

- no automatic failure parser selects escalation;
- no persistent approval state or shell prefix parser exists;
- non-TUI and every non-approval path invoke no executor;
- the escalated path delegates only to `localBash.execute()` and never to sandbox retry code;
- the original command and timeout are the values delegated;
- all five prompt guidelines explicitly name Bash;
- metadata merges retain Pi truncation/full-output fields;
- no test launches a real unsandboxed command.

- [ ] **Step 7: Commit documentation and final formatting**

```bash
git add README.md src test package.json pnpm-lock.yaml
git commit -m "docs: explain bash escalation safety boundary"
```

- [ ] **Step 8: Capture final branch evidence**

Run:

```bash
git status --short --branch
git log --oneline --decorate -7
```

Expected: the worktree is clean on `feat/bash-escalation`, with the design commit followed by the implementation commits from this plan.
