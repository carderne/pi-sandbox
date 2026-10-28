import test from "node:test";

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  permissionOptions,
  permissionPromptRemainingSeconds,
  permissionPromptTimeoutMs,
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
