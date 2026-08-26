import test from "node:test";

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, Key } from "@earendil-works/pi-tui";
import assert from "node:assert/strict";

import {
  escapeTerminalPromptText,
  permissionOptions,
  permissionPromptRemainingSeconds,
  permissionPromptTimeoutMs,
  showBashEscalationPrompt,
  showPermissionPrompt,
} from "../src/ui.ts";

test("permissionPromptTimeoutMs defaults omission and enables only positive finite timeouts", () => {
  assert.equal(permissionPromptTimeoutMs(undefined), 600_000);
  assert.equal(permissionPromptTimeoutMs(0), undefined);
  assert.equal(permissionPromptTimeoutMs(-1), undefined);
  assert.equal(permissionPromptTimeoutMs(Number.NaN), undefined);
  assert.equal(permissionPromptTimeoutMs(Number.POSITIVE_INFINITY), undefined);
  assert.equal(permissionPromptTimeoutMs("30"), undefined);
  assert.equal(permissionPromptTimeoutMs(30), 30_000);
  assert.equal(permissionPromptTimeoutMs(Number.MAX_VALUE), 2_147_483_647);
});

test("permissionOptions displays Pi's configured global path", () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = "/tmp/custom-pi-agent";
  try {
    assert.equal(permissionOptions("/workspace")[3]?.hint, "→ /tmp/custom-pi-agent/sandbox.json");
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
});

test("permissionPromptRemainingSeconds rounds up and stops at zero", () => {
  const deadlineMs = 10_000;
  assert.equal(permissionPromptRemainingSeconds(deadlineMs, 7_000), 3);
  assert.equal(permissionPromptRemainingSeconds(deadlineMs, 7_001), 3);
  assert.equal(permissionPromptRemainingSeconds(deadlineMs, 8_000), 2);
  assert.equal(permissionPromptRemainingSeconds(deadlineMs, 9_999), 1);
  assert.equal(permissionPromptRemainingSeconds(deadlineMs, 10_000), 0);
  assert.equal(permissionPromptRemainingSeconds(deadlineMs, 11_000), 0);
});

test(
  "showPermissionPrompt safely aborts when its timeout expires",
  { timeout: 1_000 },
  async () => {
    type TestComponent = { render(width: number): string[]; dispose?(): void };
    type PromptFactory<T> = (
      tui: { requestRender(): void },
      theme: { fg(color: string, text: string): string },
      keybindings: object,
      done: (result: T) => void,
    ) => TestComponent;

    let renderedLines: string[] = [];
    const pi = {
      events: { emit: () => undefined },
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd: "/workspace",
      hasUI: true,
      ui: {
        custom: <T>(factory: PromptFactory<T>): Promise<T> =>
          new Promise<T>((resolve) => {
            let component: TestComponent | undefined;
            const done = (result: T): void => {
              component?.dispose?.();
              resolve(result);
            };
            component = factory(
              { requestRender: () => undefined },
              { fg: (_color, text) => text },
              {},
              done,
            );
            renderedLines = component.render(80);
          }),
      },
    } as unknown as ExtensionContext;

    const result = await showPermissionPrompt(
      pi,
      ctx,
      "Blocked",
      "example.test",
      () => null,
      0.001,
    );

    assert.ok(renderedLines.includes("⏳ Auto-abort in 1s (permission stays blocked)"));
    assert.deepEqual(result, { action: "abort", value: "example.test" });
  },
);

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
      ui: {
        custom: () => {
          customCalls++;
        },
      },
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

function createEscalationPromptHarness() {
  let component: (Component & { dispose?(): void }) | undefined;
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const attentionEvents: string[] = [];
  let renderRequests = 0;
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
              {
                requestRender: () => {
                  renderRequests++;
                },
              },
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

  const rawKey = (data: string): string => {
    const keys: Record<string, string> = {
      [Key.down]: "\x1b[B",
      [Key.up]: "\x1b[A",
      [Key.left]: "\x1b[D",
      [Key.right]: "\x1b[C",
      [Key.pageUp]: "\x1b[5~",
      [Key.pageDown]: "\x1b[6~",
      [Key.enter]: "\r",
      [Key.escape]: "\x1b",
      [Key.ctrl("c")]: "\x03",
    };
    return keys[data] ?? data;
  };

  return {
    pi,
    ctx,
    ready,
    attentionEvents,
    get renderRequests() {
      return renderRequests;
    },
    render: (width: number) => component!.render(width),
    input: (data: string) => component!.handleInput?.(rawKey(data)),
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

test("escalation prompt keeps fixed controls and scrolls through the complete safe command", async () => {
  const harness = createEscalationPromptHarness();
  const command = Array.from({ length: 120 }, (_, index) => `line-${index}-${"x".repeat(40)}`).join(
    "\n",
  );
  const pending = showBashEscalationPrompt(harness.pi, {
    toolCallId: "long",
    command,
    justification: "Inspect every line before approval",
    timeoutSeconds: 0,
    ctx: harness.ctx,
  });
  await harness.ready;
  try {
    const first = harness.render(48).join("\n");
    assert.match(first, /Run outside pi-sandbox\?/);
    assert.match(first, /bypasses all pi-sandbox filesystem\s+and network rules/i);
    assert.match(first, /Allow once/);
    assert.match(first, /Deny/);
    assert.match(first, /line-0/);
    assert.doesNotMatch(first, /line-119/);

    for (let index = 0; index < 240; index++) harness.input(Key.down);
    const last = harness.render(48).join("\n");
    assert.match(last, /line-119/);
    assert.doesNotMatch(last, /line-0-/);
    assert.match(last, /Allow once/);
    assert.match(last, /Deny/);
  } finally {
    harness.input(Key.escape);
  }
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

test("escalation prompt times out only after becoming visible and cleans up", async () => {
  const harness = createEscalationPromptHarness();
  const controller = new AbortController();
  const timedPending = showBashEscalationPrompt(harness.pi, {
    ...requestFor(harness.ctx, controller.signal),
    timeoutSeconds: 0.001,
  });
  await harness.ready;
  assert.deepEqual(harness.attentionEvents, ["request-attention"]);
  assert.deepEqual(await timedPending, { action: "deny", reason: "timeout" });
  const renderRequests = harness.renderRequests;
  controller.abort();
  await Promise.resolve();
  assert.equal(harness.renderRequests, renderRequests);
});

test("disposing an escalation prompt fails closed and cleans up", async () => {
  const harness = createEscalationPromptHarness();
  const controller = new AbortController();
  const disposedPending = showBashEscalationPrompt(
    harness.pi,
    requestFor(harness.ctx, controller.signal),
  );
  await harness.ready;
  harness.dispose();
  assert.deepEqual(await disposedPending, { action: "deny", reason: "unavailable" });
  const renderRequests = harness.renderRequests;
  controller.abort();
  await Promise.resolve();
  assert.equal(harness.renderRequests, renderRequests);
});

test("aborting a visible escalation prompt preserves tool abort semantics and cleans up", async () => {
  const harness = createEscalationPromptHarness();
  const controller = new AbortController();
  const abortedPending = showBashEscalationPrompt(
    harness.pi,
    requestFor(harness.ctx, controller.signal),
  );
  await harness.ready;
  controller.abort();
  await assert.rejects(abortedPending, /aborted.*escalated command was not run/i);
  const renderRequests = harness.renderRequests;
  controller.abort();
  await Promise.resolve();
  assert.equal(harness.renderRequests, renderRequests);
});
