import test from "node:test";

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  cancelPermissionPrompts,
  permissionOptions,
  permissionPromptRemainingSeconds,
  permissionPromptTimeoutMs,
  resetPermissionPrompts,
  showPermissionPrompt,
  warnIfLinuxUnenforcedGlobs,
} from "../src/ui.ts";

for (const platform of ["linux", "android"] as const) {
  test(`warnIfLinuxUnenforcedGlobs warns only for user-supplied write globs on ${platform}`, () => {
    const warnings: string[] = [];
    const ctx = { ui: { notify: (m: string, l: string) => l === "warning" && warnings.push(m) } };
    const cfg = (fs: object) =>
      ({
        ...DEFAULT_CONFIG,
        filesystem: { ...DEFAULT_CONFIG.filesystem, ...fs },
      }) as typeof DEFAULT_CONFIG;

    // stock defaults: silent
    warnIfLinuxUnenforcedGlobs(ctx as never, DEFAULT_CONFIG, platform);
    assert.equal(warnings.length, 0);

    // user glob on Linux: one warning naming the key/value
    warnIfLinuxUnenforcedGlobs(ctx as never, cfg({ denyWrite: ["*.secret"] }), platform);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /filesystem\.denyWrite: \*\.secret/);

    // same config on macOS: silent
    warnIfLinuxUnenforcedGlobs(ctx as never, cfg({ denyWrite: ["*.secret"] }), "darwin");
    assert.equal(warnings.length, 1);

    // literal-only user entry: silent
    warnIfLinuxUnenforcedGlobs(ctx as never, cfg({ allowWrite: ["/srv/app"] }), platform);
    assert.equal(warnings.length, 1);
  });
}

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
    type PromptFactory = (
      tui: { requestRender(): void; getFocusedComponent(): null },
      theme: { fg(color: string, text: string): string },
    ) => TestComponent;

    let renderedLines: string[] = [];
    let component: TestComponent | undefined;
    const pi = {
      events: { emit: () => undefined },
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd: "/workspace",
      hasUI: true,
      ui: {
        onTerminalInput: () => () => {},
        setWidget: (_key: string, factory?: PromptFactory): void => {
          if (!factory) {
            component?.dispose?.();
            component = undefined;
            return;
          }
          component = factory(
            { requestRender: () => undefined, getFocusedComponent: () => null },
            { fg: (_color, text) => text },
          );
          renderedLines = component.render(80);
        },
      },
    } as unknown as ExtensionContext;

    const result = await showPermissionPrompt(pi, ctx, "Blocked", "example.test", () => null, 0.1);

    assert.ok(renderedLines.includes("⏳ Auto-abort in 1s (permission stays blocked)"));
    assert.deepEqual(result, { action: "abort", value: "example.test" });
  },
);
type DialogSelect = {
  title: string;
  options: string[];
  timeout: number | undefined;
  signal: AbortSignal | undefined;
  resolve: (value: string | undefined) => void;
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

/** A non-TUI (rpc) host that records dialogs and answers on demand. */
function dialogRig(signal?: AbortSignal) {
  const selects: DialogSelect[] = [];
  const opened = deferred();
  const ui = {
    setWidget: (): never => {
      throw new Error("the TUI widget requires a terminal and must not be used");
    },
    select: (title: string, options: string[], opts?: { timeout?: number; signal?: AbortSignal }) =>
      new Promise<string | undefined>((resolve) => {
        selects.push({ title, options, timeout: opts?.timeout, signal: opts?.signal, resolve });
        opened.resolve();
        opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
      }),
  };
  const ctx = {
    cwd: "/workspace",
    hasUI: true,
    mode: "rpc",
    ...(signal === undefined ? {} : { signal }),
    ui,
  } as unknown as ExtensionContext;
  return { ctx, ui, selects, opened: opened.promise };
}

test(
  "showPermissionPrompt maps dialog answers to permission actions",
  { timeout: 5_000 },
  async () => {
    const pi = { events: { emit: () => undefined } } as unknown as ExtensionAPI;

    // Expected actions stay independent of permissionOptions().
    const cases: Array<[string | undefined, string]> = [
      ["Allow for this session only", "session"],
      ["Allow for this project", "project"],
      ["Allow for all projects", "global"],
      ["Abort (keep blocked)", "abort"],
      [undefined, "abort"],
    ];
    for (const [answer, action] of cases) {
      const rig = dialogRig();
      const prompt = showPermissionPrompt(pi, rig.ctx, "Blocked", "example.test", () => null, 30);
      await rig.opened;
      assert.equal(rig.selects[0]?.timeout, 30_000);
      assert.equal(rig.selects[0]?.options.length, 4);
      const label =
        answer === undefined
          ? undefined
          : rig.selects[0]!.options.find((option) => option.startsWith(answer));
      if (answer !== undefined) assert.ok(label, `missing option label for ${answer}`);
      rig.selects[0]!.resolve(label);
      assert.deepEqual(await prompt, { action, value: "example.test" });
    }
  },
);

test("a host without UI never opens a dialog", { timeout: 5_000 }, async () => {
  const pi = { events: { emit: () => undefined } } as unknown as ExtensionAPI;
  const noUi = {
    cwd: "/workspace",
    hasUI: false,
    mode: "rpc",
    ui: {
      select: () => {
        throw new Error("select must not be called without a UI");
      },
    },
  } as unknown as ExtensionContext;

  assert.deepEqual(
    await showPermissionPrompt(pi, noUi, "Blocked", "example.test", () => null, 30),
    { action: "abort", value: "example.test" },
  );
});

test(
  "non-terminal prompts are serialized through the shared queue",
  { timeout: 5_000 },
  async () => {
    const pi = { events: { emit: () => undefined } } as unknown as ExtensionAPI;
    const first = dialogRig();
    const second = dialogRig();

    const firstPrompt = showPermissionPrompt(pi, first.ctx, "Blocked", "a.test", () => null, 30);
    const secondPrompt = showPermissionPrompt(pi, second.ctx, "Blocked", "b.test", () => null, 30);
    await first.opened;
    assert.equal(first.selects.length, 1);
    assert.equal(second.selects.length, 0);

    first.selects[0]!.resolve("Allow for this session only");
    assert.deepEqual(await firstPrompt, { action: "session", value: "a.test" });
    await second.opened;
    assert.equal(second.selects.length, 1);
    second.selects[0]!.resolve("Abort (keep blocked)");
    assert.deepEqual(await secondPrompt, { action: "abort", value: "b.test" });
  },
);

test(
  "cancelling prompts aborts an open dialog and drops queued requests",
  { timeout: 5_000 },
  async () => {
    const pi = { events: { emit: () => undefined } } as unknown as ExtensionAPI;
    const first = dialogRig();
    const second = dialogRig();

    const firstPrompt = showPermissionPrompt(pi, first.ctx, "Blocked", "a.test", () => null, 30);
    const secondPrompt = showPermissionPrompt(pi, second.ctx, "Blocked", "b.test", () => null, 30);
    await first.opened;
    assert.equal(first.selects.length, 1);
    assert.equal(second.selects.length, 0);
    assert.equal(first.selects[0]?.signal?.aborted, false);

    cancelPermissionPrompts(pi);
    assert.deepEqual(await firstPrompt, { action: "abort", value: "a.test" });
    assert.deepEqual(await secondPrompt, { action: "abort", value: "b.test" });
    assert.equal(second.selects.length, 0);
  },
);

test("an answer that arrives after cancellation never grants", { timeout: 5_000 }, async () => {
  const pi = { events: { emit: () => undefined } } as unknown as ExtensionAPI;
  const opened = deferred();
  const answers: Array<(value: string | undefined) => void> = [];
  const ctx = {
    cwd: "/workspace",
    hasUI: true,
    mode: "rpc",
    ui: {
      // Deliberately ignores the abort signal, like a slow host that already
      // accepted the user's click.
      select: () =>
        new Promise<string | undefined>((resolve) => {
          answers.push(resolve);
          opened.resolve();
        }),
    },
  } as unknown as ExtensionContext;

  const prompt = showPermissionPrompt(pi, ctx, "Blocked", "example.test", () => null, 30);
  await opened.promise;
  cancelPermissionPrompts(pi);
  answers[0]!("Allow for this session only");
  assert.deepEqual(await prompt, { action: "abort", value: "example.test" });
});

test(
  "non-terminal prompts never grant unknown answers or invalid targets",
  { timeout: 5_000 },
  async () => {
    const pi = { events: { emit: () => undefined } } as unknown as ExtensionAPI;

    const unknown = dialogRig();
    const unknownPrompt = showPermissionPrompt(
      pi,
      unknown.ctx,
      "Blocked",
      "example.test",
      () => null,
      30,
    );
    await unknown.opened;
    unknown.selects[0]!.resolve("not one of the offered options");
    assert.deepEqual(await unknownPrompt, { action: "abort", value: "example.test" });

    const invalid = dialogRig();
    const invalidPrompt = showPermissionPrompt(
      pi,
      invalid.ctx,
      "Blocked",
      "example.test",
      () => "Rule must match the blocked target.",
      30,
    );
    await invalid.opened;
    invalid.selects[0]!.resolve("Allow for this session only");
    assert.deepEqual(await invalidPrompt, { action: "abort", value: "example.test" });
  },
);

test("a pre-aborted context never opens a dialog", { timeout: 5_000 }, async () => {
  const pi = { events: { emit: () => undefined } } as unknown as ExtensionAPI;
  const controller = new AbortController();
  controller.abort();
  const rig = dialogRig(controller.signal);
  assert.deepEqual(
    await showPermissionPrompt(pi, rig.ctx, "Blocked", "example.test", () => null, 30),
    { action: "abort", value: "example.test" },
  );
  assert.equal(rig.selects.length, 0);
});

test(
  "resetting prompts aborts active and queued requests, then allows a fresh one",
  { timeout: 5_000 },
  async () => {
    const pi = { events: { emit: () => undefined } } as unknown as ExtensionAPI;
    const first = dialogRig();
    const second = dialogRig();

    const firstPrompt = showPermissionPrompt(pi, first.ctx, "Blocked", "a.test", () => null, 30);
    const secondPrompt = showPermissionPrompt(pi, second.ctx, "Blocked", "b.test", () => null, 30);
    await first.opened;
    assert.equal(first.selects.length, 1);
    assert.equal(second.selects.length, 0);

    resetPermissionPrompts(pi);
    assert.deepEqual(await firstPrompt, { action: "abort", value: "a.test" });
    assert.deepEqual(await secondPrompt, { action: "abort", value: "b.test" });
    assert.equal(second.selects.length, 0);

    // The cancelled queue is discarded: the next request prompts normally.
    const fresh = dialogRig();
    const freshPrompt = showPermissionPrompt(pi, fresh.ctx, "Blocked", "c.test", () => null, 30);
    await fresh.opened;
    assert.equal(fresh.selects.length, 1);
    fresh.selects[0]!.resolve("Allow for this session only");
    assert.deepEqual(await freshPrompt, { action: "session", value: "c.test" });
  },
);

test("aborting the context signal during a dialog grants nothing", { timeout: 5_000 }, async () => {
  const pi = { events: { emit: () => undefined } } as unknown as ExtensionAPI;

  // Signal-aware host: the dialog closes on abort without an answer.
  const controller = new AbortController();
  const abortedRig = dialogRig(controller.signal);
  const abortedPrompt = showPermissionPrompt(
    pi,
    abortedRig.ctx,
    "Blocked",
    "example.test",
    () => null,
    30,
  );
  await abortedRig.opened;
  controller.abort();
  assert.deepEqual(await abortedPrompt, { action: "abort", value: "example.test" });

  // Host that stays open and answers late: the post-await check refuses it.
  const lateController = new AbortController();
  const opened = deferred();
  const answers: Array<(value: string | undefined) => void> = [];
  const lateCtx = {
    cwd: "/workspace",
    hasUI: true,
    mode: "rpc",
    signal: lateController.signal,
    ui: {
      select: () =>
        new Promise<string | undefined>((resolve) => {
          answers.push(resolve);
          opened.resolve();
        }),
    },
  } as unknown as ExtensionContext;
  const latePrompt = showPermissionPrompt(pi, lateCtx, "Blocked", "example.test", () => null, 30);
  await opened.promise;
  lateController.abort();
  answers[0]!("Allow for this session only");
  assert.deepEqual(await latePrompt, { action: "abort", value: "example.test" });
});
