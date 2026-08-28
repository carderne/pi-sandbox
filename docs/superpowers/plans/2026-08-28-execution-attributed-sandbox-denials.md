# Execution-Attributed Sandbox Denials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attribute each model-facing sandboxed Bash failure to its final process attempt and append cautious, explicit escalation guidance only when that attempt has structured or heuristic sandbox-denial evidence.

**Architecture:** Keep process preparation/finalization and the stable runtime configuration callback in `src/sandbox-runtime.ts`, and put pure eligibility, fallback, formatting, and initial/recovery attempt selection in a focused `src/bash-sandbox-denials.ts` module. `src/extension.ts` remains the composition root: it supplies Pi's retained-output Bash executor, the existing write resolver, live sandbox state, and the TUI/UI guidance gate while leaving `user_bash` on the legacy handleless operations path.

**Tech Stack:** TypeScript 5, pnpm 10, Node.js `child_process` and built-in test runner, `@earendil-works/pi-coding-agent` 0.80.x, and the additive `@carderne/sandbox-runtime` attributed-attempt API.

**Spec:** `docs/superpowers/specs/2026-08-27-execution-attributed-sandbox-denials-design.md`

## Global Constraints

- Use pnpm and TypeScript.
- The matching runtime plan in the `sandbox-runtime` repository, `docs/superpowers/plans/2026-08-28-execution-attributed-sandbox-denials.md`, must be implemented first. During development, pin the full immutable commit from `digitalhurricane-io/sandbox-runtime` that contains the additive `prepareSandboxAttempt`, `finishSandboxAttempt`, `SandboxBackend`, and `SandboxDenialSummary` API; never pin a moving branch or use a local link in committed files. The final `pi-sandbox` PR remains gated on the runtime PR being merged and published: replace the temporary Git commit dependency with that exact published version in both `package.json` and `pnpm-lock.yaml` before making the downstream PR ready. This plan does not duplicate runtime monitor/proxy work.
- Prepare a new attributed descriptor for every spawned model Bash process, spawn it exactly once with `argv[0]`, `argv.slice(1)`, `shell: false`, the returned `env`, and the same `cwd`, then run existing cleanup before finishing the attempt.
- Only the final process attempt contributes evidence. If write recovery runs, finish and drain attempt A before resolving the write, discard A's evidence, and classify only attempt B.
- Structured evidence takes precedence over the Codex-compatible fallback. Never combine evidence across attempts or inspect command text, host platform, generated guidance, monitor health, or unrelated runtime state.
- The fallback uses the final attempt's actual backend, exit code, signal, termination kind, and original Pi error message. It is case-insensitive for exactly `operation not permitted`, `permission denied`, `read-only file system`, `seccomp`, `sandbox`, `landlock`, and `failed to write file`.
- Without a keyword, exit codes 2, 126, and 127 are not sandbox matches. `SIGSYS` or `128 + SIGSYS` matches only an actual `linux-seccomp` descriptor.
- Success, timeout, abort, spawn error, preparation error, finish error, policy-publication error, prompt abort, and unrelated failure receive no guidance. A direct process signal is an eligible command failure unless the observation is already classified as timeout, abort, or spawn error.
- Guidance is available only when `ctx.mode === "tui"`, `ctx.hasUI === true`, and the sandbox remains enabled and initialized at formatting time.
- Preserve the original error message as the exact prefix, append the bounded guidance block at most once, and keep the result a thrown tool error. Never fabricate an `AgentToolResult` for `Operation not permitted`.
- Denial detection never requests approval, runs local Bash, retries outside the sandbox, or automatically makes a `sandbox_permissions: "require_escalated"` call.
- Existing blocked-write recovery remains in-sandbox and may run at most one retry. `denyWrite` failures may receive cautious guidance; a declined/cancelled write prompt must suppress it.
- Permission publication uses synchronous `SandboxManager.updateConfig(nextRuntimeConfig)` on supported macOS/Linux sessions. It never resets runtime monitors, proxies, credentials, or unrelated attempt attribution.
- Advance the stable allowed-domain callback snapshot only after `updateConfig` succeeds. A publication failure keeps the previous snapshot, skips attempt B, and is rethrown without guidance or local fallback.
- Preserve Pi's existing streaming, timeout, abort, process-group termination, retained output, truncation, and rendering pipeline. Do not add a second stdout/stderr buffer or change `BashOperations` exit-code normalization. Pi's installed `{ exitCode: null }` signal result is adapted locally after awaiting Pi execution and the attributed completion.
- Keep explicit escalation approval, `EscalationPrompt`, approval tracking, elevated local execution, `user_bash`, SSH routing, unauthenticated SOCKS compatibility, external proxies, enable/disable/shutdown state, and reset ownership unchanged.
- Do not add Windows support, a sandbox state machine, active-work registry, session generations, shutdown arbitration, prompt registries, exact bwrap cleanup handles, reviewer approval, authenticated SSH helpers, or automatic escalation.

## File Structure

**Create:**

- `src/bash-sandbox-denials.ts` — pure observation types, fallback predicate, guidance formatter, final-attempt classifier, and one-retry orchestration.
- `test/bash-sandbox-denials.test.ts` — classifier, formatting, evidence precedence, attempt selection, prompt-abort, and publication-failure tests.

**Modify:**

- `package.json` — consume the published runtime release containing the attributed-attempt API.
- `pnpm-lock.yaml` — lock the matching runtime release.
- `src/sandbox-runtime.ts` — enable monitors, publish config with `updateConfig`, retain a stable network callback snapshot, and add attributed Bash operations sharing the existing process behavior.
- `test/sandbox-runtime.test.ts` — configuration snapshot/order tests plus descriptor spawning, observation, cleanup/finalization, and concurrent-attempt tests.
- `src/extension.ts` — publish configuration through Task 2's migrated helper, route ordinary model Bash through attributed attempts, feed caught errors to write recovery, select only the final attempt, and apply the TUI/UI/live-sandbox gate.
- `test/extension.test.ts` — retain escalation-hook coverage and add focused live-state/mode wiring assertions where the composition seam is exported.
- `README.md` — document failure guidance as diagnostic context for making a separate explicit escalation request.

**Per-task verification rule:** Before every task commit below, run `pnpm run check` after that task's focused tests. Do not commit if it fails.

---

### Task 1: Runtime Dependency, Denial Classifier, and Guidance Formatter

**Files:**

- Create: `src/bash-sandbox-denials.ts`
- Create: `test/bash-sandbox-denials.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: `SandboxBackend` and `SandboxDenialSummary` from `@carderne/sandbox-runtime`.
- Produces: `SandboxAttemptObservation`, `FinishedSandboxProcessAttempt`, `PI_SANDBOX_GUIDANCE`, `isEligibleCommandFailure()`, `matchesSandboxDenialFallback()`, `hasSandboxDenialEvidence()`, `appendSandboxGuidance()`, and `shouldShowSandboxGuidance()`.
- Produces for Task 4: `CompletedAttributedBashAttempt<Result>`, `WriteRecoveryDisposition`, and `executeAttributedBashFlow()`.

- [ ] **Step 1: Install the immutable runtime development commit and verify the additive declarations**

Until the upstream runtime release exists, install the full commit from the contributor fork:

```bash
pnpm add '@carderne/sandbox-runtime@github:digitalhurricane-io/sandbox-runtime#65d7a9b674bc21b5fba8003c6c0254b4739cb0f5'
rg -n "prepareSandboxAttempt|finishSandboxAttempt|SandboxBackend|SandboxDenialSummary" node_modules/@carderne/sandbox-runtime/dist
```

Expected during development: the manifest and lockfile resolve the immutable full commit, and the declaration search shows both manager methods plus the public types. If the Git package does not produce `dist`, add the narrow packaging fix to the runtime PR before editing Pi.

Before the downstream Pi PR is made ready, replace this temporary dependency with the published release, remove the commit-specific `onlyBuiltDependencies` entry from `pnpm-workspace.yaml`, verify that no `digitalhurricane-io` dependency reference remains, and run the exact-version verification below.

Run after the runtime release described in Global Constraints is published, substituting the exact published version that matches the required additive API:

```bash
pnpm add --save-exact @carderne/sandbox-runtime@<published-matching-version>
pnpm exec tsx -e 'import assert from "node:assert/strict"; import { readFileSync } from "node:fs"; const pkg = JSON.parse(readFileSync("package.json", "utf8")); const specifier = pkg.dependencies["@carderne/sandbox-runtime"]; const lock = readFileSync("pnpm-lock.yaml", "utf8"); const importer = lock.slice(lock.indexOf("importers:\n"), lock.indexOf("\npackages:\n")); const match = importer.match(/\x27@carderne\/sandbox-runtime\x27:\n\s+specifier:\s+([^\n]+)\n\s+version:\s+([^\n]+)/); assert.ok(match, "root importer runtime entry is required"); const [, lockSpecifier, lockVersion] = match; assert.match(specifier, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/); assert.equal(lockSpecifier, specifier); assert.equal(lockVersion, specifier); assert.doesNotMatch(`${specifier}\n${lockSpecifier}\n${lockVersion}`, /(?:\^|~|latest)/);'
rg -n "prepareSandboxAttempt|finishSandboxAttempt|SandboxBackend|SandboxDenialSummary" node_modules/@carderne/sandbox-runtime/dist
```

Expected: `package.json` and the root `pnpm-lock.yaml` importer have the same exact semver specifier and selected version, with no caret, tilde, or `latest`; the declaration search shows both manager methods plus the public types. If the matching release has not been published or any declaration is absent, stop before editing Pi because the runtime prerequisite is not satisfied.

- [ ] **Step 2: Write failing classifier and formatting tests**

Create `test/bash-sandbox-denials.test.ts` with this table-driven coverage:

```ts
import test from "node:test";

import assert from "node:assert/strict";
import { constants } from "node:os";

import {
  PI_SANDBOX_GUIDANCE,
  appendSandboxGuidance,
  hasSandboxDenialEvidence,
  isEligibleCommandFailure,
  matchesSandboxDenialFallback,
  shouldShowSandboxGuidance,
  type SandboxAttemptObservation,
} from "../src/bash-sandbox-denials.ts";

const observation = (
  overrides: Partial<SandboxAttemptObservation> = {},
): SandboxAttemptObservation => ({
  sandboxBackend: "linux-bwrap",
  exitCode: 1,
  signal: null,
  termination: "exit",
  ...overrides,
});

test("fallback matches every supported keyword case-insensitively", () => {
  for (const keyword of [
    "Operation Not Permitted",
    "PERMISSION DENIED",
    "read-only file system",
    "SECCOMP",
    "Sandbox",
    "LANDLOCK",
    "failed to write file",
  ]) {
    assert.equal(matchesSandboxDenialFallback(observation(), `prefix ${keyword} suffix`), true);
  }
});

test("fallback rejects success, backend none, excluded exit codes, and unrelated errors", () => {
  assert.equal(matchesSandboxDenialFallback(observation({ exitCode: 0 }), "sandbox"), false);
  assert.equal(
    matchesSandboxDenialFallback(observation({ sandboxBackend: "none" }), "permission denied"),
    false,
  );
  for (const exitCode of [2, 126, 127]) {
    assert.equal(matchesSandboxDenialFallback(observation({ exitCode }), "ordinary failure"), false);
  }
  assert.equal(matchesSandboxDenialFallback(observation(), "ordinary failure"), false);
});

test("SIGSYS matches only the linux-seccomp backend", () => {
  const sigsys = constants.signals.SIGSYS;
  assert.equal(
    matchesSandboxDenialFallback(
      observation({
        sandboxBackend: "linux-seccomp",
        exitCode: null,
        signal: "SIGSYS",
        termination: "signal",
      }),
      "terminated",
    ),
    true,
  );
  assert.equal(
    matchesSandboxDenialFallback(
      observation({ sandboxBackend: "linux-seccomp", exitCode: 128 + sigsys }),
      "failed",
    ),
    true,
  );
  assert.equal(
    matchesSandboxDenialFallback(
      observation({
        sandboxBackend: "linux-bwrap",
        exitCode: null,
        signal: "SIGSYS",
        termination: "signal",
      }),
      "terminated",
    ),
    false,
  );
});

test("only exit and signal command failures are eligible", () => {
  assert.equal(isEligibleCommandFailure(observation()), true);
  assert.equal(
    isEligibleCommandFailure(observation({ exitCode: null, signal: "SIGSYS", termination: "signal" })),
    true,
  );
  for (const termination of ["timeout", "aborted", "spawn-error"] as const) {
    assert.equal(isEligibleCommandFailure(observation({ termination })), false);
  }
  assert.equal(isEligibleCommandFailure(observation({ exitCode: 0 })), false);
});

test("structured evidence takes precedence over fallback availability", () => {
  assert.equal(
    hasSandboxDenialEvidence(
      observation({ sandboxBackend: "none" }),
      [{ kind: "network", source: "http-proxy" }],
      "ordinary failure",
    ),
    true,
  );
});

test("guidance preserves the exact error prefix and is appended exactly once", () => {
  const original = new Error("original output\n\nCommand exited with code 1");
  const once = appendSandboxGuidance(original);
  const twice = appendSandboxGuidance(once);
  assert.equal(once.message.startsWith(original.message), true);
  assert.equal(once.message.split("--- pi-sandbox guidance ---").length - 1, 1);
  assert.equal(twice.message, once.message);
  assert.equal(once.message.endsWith(PI_SANDBOX_GUIDANCE), true);
});

test("a stray guidance header still receives a complete trailing block", () => {
  const original = new Error("earlier --- pi-sandbox guidance --- text");
  const guided = appendSandboxGuidance(original);
  assert.equal(guided.message.startsWith(original.message), true);
  assert.equal(guided.message.endsWith(`\n\n${PI_SANDBOX_GUIDANCE}`), true);
  assert.equal(appendSandboxGuidance(guided).message, guided.message);
});

test("guidance availability requires TUI, UI, and a live sandbox", () => {
  assert.equal(shouldShowSandboxGuidance("tui", true, true), true);
  for (const mode of ["rpc", "print", "json"] as const) {
    assert.equal(shouldShowSandboxGuidance(mode, true, true), false);
  }
  assert.equal(shouldShowSandboxGuidance("tui", false, true), false);
  assert.equal(shouldShowSandboxGuidance("tui", true, false), false);
});
```

- [ ] **Step 3: Run the focused test to verify it fails**

Run: `pnpm exec tsx --test test/bash-sandbox-denials.test.ts`

Expected: FAIL because `src/bash-sandbox-denials.ts` does not exist.

- [ ] **Step 4: Implement the observation contract, fallback, evidence precedence, and formatter**

Create `src/bash-sandbox-denials.ts` with these exact public names and predicate order:

```ts
import { constants } from "node:os";

import {
  type SandboxBackend,
  type SandboxDenialSummary,
} from "@carderne/sandbox-runtime";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface SandboxAttemptObservation {
  sandboxBackend: SandboxBackend;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  termination: "exit" | "signal" | "timeout" | "aborted" | "spawn-error";
}

export interface FinishedSandboxProcessAttempt {
  observation: SandboxAttemptObservation;
  denials: readonly SandboxDenialSummary[];
}

const DENIAL_KEYWORDS = [
  "operation not permitted",
  "permission denied",
  "read-only file system",
  "seccomp",
  "sandbox",
  "landlock",
  "failed to write file",
] as const;

export const PI_SANDBOX_GUIDANCE = `--- pi-sandbox guidance ---
This attempt appears to have failed because of a sandbox restriction. It was not retried outside the sandbox. If the command is necessary for the user's request, make a new Bash tool call with \`sandbox_permissions: "require_escalated"\` and a concise user-facing \`justification\`. Approval is still required.`;

export function isEligibleCommandFailure(observation: SandboxAttemptObservation): boolean {
  if (observation.termination === "exit") {
    return observation.exitCode !== null && observation.exitCode !== 0;
  }
  return observation.termination === "signal" && observation.signal !== null;
}

export function matchesSandboxDenialFallback(
  observation: SandboxAttemptObservation,
  originalErrorMessage: string,
): boolean {
  if (observation.sandboxBackend === "none") return false;
  if (!isEligibleCommandFailure(observation)) return false;
  const folded = originalErrorMessage.toLowerCase();
  if (DENIAL_KEYWORDS.some((keyword) => folded.includes(keyword))) return true;
  if (
    observation.exitCode === 2 ||
    observation.exitCode === 126 ||
    observation.exitCode === 127
  ) {
    return false;
  }
  return (
    observation.sandboxBackend === "linux-seccomp" &&
    (observation.signal === "SIGSYS" ||
      observation.exitCode === 128 + constants.signals.SIGSYS)
  );
}

export function hasSandboxDenialEvidence(
  observation: SandboxAttemptObservation,
  denials: readonly SandboxDenialSummary[],
  originalErrorMessage: string,
): boolean {
  if (!isEligibleCommandFailure(observation)) return false;
  if (denials.length > 0) return true;
  return matchesSandboxDenialFallback(observation, originalErrorMessage);
}

export function appendSandboxGuidance(original: Error): Error {
  if (original.message.endsWith(`\n\n${PI_SANDBOX_GUIDANCE}`)) return original;
  const guided = new Error(`${original.message}\n\n${PI_SANDBOX_GUIDANCE}`, { cause: original });
  guided.name = original.name;
  return guided;
}

export function shouldShowSandboxGuidance(
  mode: ExtensionContext["mode"],
  hasUI: boolean,
  sandboxActive: boolean,
): boolean {
  return mode === "tui" && hasUI && sandboxActive;
}
```

- [ ] **Step 5: Run the focused test to verify it passes**

Run: `pnpm exec tsx --test test/bash-sandbox-denials.test.ts`

Expected: PASS for all classifier, precedence, formatter, and mode-gate cases.

- [ ] **Step 6: Commit the classifier and dependency update**

```bash
pnpm run check
git add package.json pnpm-lock.yaml src/bash-sandbox-denials.ts test/bash-sandbox-denials.test.ts
git commit -m "feat: classify sandbox denial failures"
```

---

### Task 2: Stable Runtime Initialization and Configuration Publication

**Files:**

- Modify: `src/sandbox-runtime.ts:56-105`
- Modify: `test/sandbox-runtime.test.ts`
- Modify: `src/extension.ts:38-43,129-158`
- Modify: `test/extension.test.ts`

**Interfaces:**

- Consumes: `buildRuntimeConfig(config, allowances)` and synchronous `SandboxManager.updateConfig()`.
- Produces: `initializeSandbox(config, allowances): Promise<void>` with monitor enablement and a stable callback.
- Replaces: `reinitializeSandbox()` with `updateSandboxConfig(config, allowances): void`, including the `src/extension.ts` import and `refreshSandbox()` migration while the old export is removed.
- Maintains: one module-level `currentAllowedDomains: readonly string[]` snapshot used by the stable `networkAskCallback` closure.

- [ ] **Step 1: Write failing initialization and update-order tests**

Append tests to `test/sandbox-runtime.test.ts` using Node's method mocks:

```ts
import { mock } from "node:test";
import { SandboxManager, type SandboxAskCallback } from "@carderne/sandbox-runtime";
import {
  initializeSandbox,
  updateSandboxConfig,
} from "../src/sandbox-runtime.ts";

test("initializeSandbox enables monitoring and installs the stable domain callback", async () => {
  let callback: SandboxAskCallback | undefined;
  const initialize = mock.method(
    SandboxManager,
    "initialize",
    async (_config, ask, monitor) => {
      callback = ask;
      assert.equal(monitor, true);
    },
  );
  try {
    await initializeSandbox({
      ...DEFAULT_CONFIG,
      network: { ...DEFAULT_CONFIG.network!, allowedDomains: ["initial.example"] },
    });
    assert.ok(callback);
    assert.equal(await callback({ host: "initial.example", port: 443 }), true);
    assert.equal(await callback({ host: "future.example", port: 443 }), false);
    assert.equal(initialize.mock.callCount(), 1);
  } finally {
    initialize.mock.restore();
  }
});

test("updateSandboxConfig advances the callback only after updateConfig succeeds", async () => {
  let callback: SandboxAskCallback | undefined;
  const initialize = mock.method(SandboxManager, "initialize", async (_config, ask) => {
    callback = ask;
  });
  const update = mock.method(SandboxManager, "updateConfig", () => {});
  try {
    await initializeSandbox({
      ...DEFAULT_CONFIG,
      network: { ...DEFAULT_CONFIG.network!, allowedDomains: ["old.example"] },
    });
    const stableCallback = callback;
    updateSandboxConfig({
      ...DEFAULT_CONFIG,
      network: { ...DEFAULT_CONFIG.network!, allowedDomains: ["new.example"] },
    });
    assert.equal(callback, stableCallback);
    assert.equal(await callback!({ host: "old.example", port: 443 }), false);
    assert.equal(await callback!({ host: "new.example", port: 443 }), true);

    update.mock.mockImplementationOnce(() => {
      throw new Error("publication failed");
    });
    assert.throws(
      () =>
        updateSandboxConfig({
          ...DEFAULT_CONFIG,
          network: { ...DEFAULT_CONFIG.network!, allowedDomains: ["rejected.example"] },
        }),
      /publication failed/,
    );
    assert.equal(await callback!({ host: "new.example", port: 443 }), true);
    assert.equal(await callback!({ host: "rejected.example", port: 443 }), false);
  } finally {
    update.mock.restore();
    initialize.mock.restore();
  }
});
```

Also add a focused extension test proving that the refresh helper propagates an `updateSandboxConfig()` failure to its caller rather than logging and swallowing it. This is the publication-failure boundary used by Task 4's recovery flow; do not defer the extension migration to Task 5.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `pnpm exec tsx --test test/sandbox-runtime.test.ts test/extension.test.ts`

Expected: FAIL because `updateSandboxConfig` is not exported, initialization does not pass `true`, and the extension still swallows the publication failure.

- [ ] **Step 3: Implement the stable callback and synchronous publication**

Replace the callback/reinitialization block in `src/sandbox-runtime.ts` with:

```ts
let currentAllowedDomains: readonly string[] = [];

const networkAskCallback: SandboxAskCallback = async ({ host }) =>
  domainIsAllowed(host, currentAllowedDomains);

export async function initializeSandbox(
  config: SandboxConfig,
  allowances?: SessionAllowances,
): Promise<void> {
  const runtimeConfig = buildRuntimeConfig(config, allowances);
  currentAllowedDomains = [...(runtimeConfig.network?.allowedDomains ?? [])];
  await SandboxManager.initialize(runtimeConfig, networkAskCallback, true);
}

export function updateSandboxConfig(
  config: SandboxConfig,
  allowances?: SessionAllowances,
): void {
  const nextRuntimeConfig = buildRuntimeConfig(config, allowances);
  SandboxManager.updateConfig(nextRuntimeConfig);
  currentAllowedDomains = [...(nextRuntimeConfig.network?.allowedDomains ?? [])];
}
```

Delete `createNetworkAskCallback(allowedDomains)` and `reinitializeSandbox()`. In this same task, update `src/extension.ts` to import `updateSandboxConfig`, remove the old `reinitializeSandbox` import, and make the existing `refreshSandbox(cwd)` call `updateSandboxConfig(loadConfig(cwd), allowances)` synchronously in place. Remove its warning-and-swallow `try/catch` so a publication failure is visible to (and prevents) recovery. Do not call `reset()` from this publication path. Leave extension disablement, shutdown, and explicit initialization resets untouched.

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `pnpm exec tsx --test test/sandbox-runtime.test.ts test/extension.test.ts`

Expected: PASS, including proof that a thrown `updateConfig` leaves the prior callback snapshot live.

- [ ] **Step 5: Commit runtime publication behavior**

```bash
pnpm run check
git add src/sandbox-runtime.ts test/sandbox-runtime.test.ts src/extension.ts test/extension.test.ts
git commit -m "feat: publish sandbox config without reset"
```

---

### Task 3: Attributed Bash Process Operations

**Files:**

- Modify: `src/sandbox-runtime.ts:1-190`
- Modify: `test/sandbox-runtime.test.ts`

**Interfaces:**

- Consumes: `SandboxManager.prepareSandboxAttempt(options)` and `finishSandboxAttempt(handle)` from the published runtime.
- Imports: `SandboxAttemptDescriptor` from `@carderne/sandbox-runtime` for the prepared descriptor local.
- Consumes: `SandboxAttemptObservation` and `FinishedSandboxProcessAttempt` from Task 1.
- Produces: `AttributedSandboxedBashOps = { operations: BashOperations; finished: Promise<FinishedSandboxProcessAttempt> }`.
- Produces: `createAttributedSandboxedBashOps(shellPath?: string, sshProxy?: boolean): AttributedSandboxedBashOps` for model-facing Bash only.
- Preserves: `createSandboxedBashOps(shellPath?, sshProxy?)` as the handleless compatibility path used by `user_bash`.

- [ ] **Step 1: Write failing descriptor, lifecycle, and observation tests**

Append focused tests to `test/sandbox-runtime.test.ts`. Mock only `SandboxManager` methods; use harmless local child processes so the tests exercise the actual event ordering:

```ts
import { tmpdir } from "node:os";
import {
  createAttributedSandboxedBashOps,
  type AttributedSandboxedBashOps,
} from "../src/sandbox-runtime.ts";

async function runAttributed(
  attributed: AttributedSandboxedBashOps,
  options: { signal?: AbortSignal; timeout?: number } = {},
) {
  const chunks: Buffer[] = [];
  const execution = attributed.operations.exec("same command", tmpdir(), {
    onData: (chunk) => chunks.push(chunk),
    env: { PATH: process.env.PATH },
    ...options,
  });
  return { execution, chunks };
}

test("attributed operations spawn descriptor argv once and finalize after cleanup", async () => {
  const calls: string[] = [];
  const prepare = mock.method(SandboxManager, "prepareSandboxAttempt", async () => ({
    attempt: { attemptId: "a" } as never,
    argv: ["/bin/echo", "literal; exit 7"],
    env: { PATH: process.env.PATH },
    sandboxBackend: "linux-bwrap" as const,
  }));
  const cleanup = mock.method(SandboxManager, "cleanupAfterCommand", () => calls.push("cleanup"));
  const finish = mock.method(SandboxManager, "finishSandboxAttempt", async () => {
    calls.push("finish");
    return { denials: [{ kind: "network", source: "http-proxy" }] as const };
  });
  try {
    const attributed = createAttributedSandboxedBashOps();
    const { execution, chunks } = await runAttributed(attributed);
    assert.deepEqual(await execution, { exitCode: 0 });
    assert.match(Buffer.concat(chunks).toString(), /literal; exit 7/);
    assert.deepEqual(await attributed.finished, {
      observation: {
        sandboxBackend: "linux-bwrap",
        exitCode: 0,
        signal: null,
        termination: "exit",
      },
      denials: [{ kind: "network", source: "http-proxy" }],
    });
    assert.deepEqual(calls, ["cleanup", "finish"]);
    assert.equal(prepare.mock.callCount(), 1);
  } finally {
    finish.mock.restore();
    cleanup.mock.restore();
    prepare.mock.restore();
  }
});

test("spawn errors still cleanup and finish without becoming eligible", async () => {
  const prepare = mock.method(SandboxManager, "prepareSandboxAttempt", async () => ({
    attempt: { attemptId: "spawn-error" } as never,
    argv: ["/definitely/missing/pi-sandbox-test"],
    env: {},
    sandboxBackend: "linux-seccomp" as const,
  }));
  const cleanup = mock.method(SandboxManager, "cleanupAfterCommand", () => {});
  const finish = mock.method(SandboxManager, "finishSandboxAttempt", async () => ({ denials: [] }));
  try {
    const attributed = createAttributedSandboxedBashOps();
    const { execution } = await runAttributed(attributed);
    await assert.rejects(execution);
    assert.equal((await attributed.finished).observation.termination, "spawn-error");
    assert.equal(cleanup.mock.callCount(), 1);
    assert.equal(finish.mock.callCount(), 1);
  } finally {
    finish.mock.restore();
    cleanup.mock.restore();
    prepare.mock.restore();
  }
});

test("an already-aborted signal after preparation never spawns and is finalized", async () => {
  const controller = new AbortController();
  const prepare = mock.method(SandboxManager, "prepareSandboxAttempt", async () => {
    controller.abort();
    return {
      attempt: { attemptId: "aborted" } as never,
      argv: ["/bin/echo", "must-not-run"],
      env: {},
      sandboxBackend: "macos-seatbelt" as const,
    };
  });
  const cleanup = mock.method(SandboxManager, "cleanupAfterCommand", () => {});
  const finish = mock.method(SandboxManager, "finishSandboxAttempt", async () => ({ denials: [] }));
  try {
    const attributed = createAttributedSandboxedBashOps();
    const { execution, chunks } = await runAttributed(attributed, { signal: controller.signal });
    await assert.rejects(execution, /aborted/);
    assert.deepEqual(chunks, []);
    assert.equal((await attributed.finished).observation.termination, "aborted");
  } finally {
    finish.mock.restore();
    cleanup.mock.restore();
    prepare.mock.restore();
  }
});
```

Add these lifecycle cases after the three tests above (reuse the same mock/restore pattern around every test so no manager method leaks into its neighbor):

```ts
test("timeout, post-spawn abort, and signal close retain distinct observations", async () => {
  const descriptors = [
    {
      attempt: { attemptId: "timeout" } as never,
      argv: ["/bin/sh", "-c", "sleep 5"],
      env: { PATH: process.env.PATH },
      sandboxBackend: "linux-bwrap" as const,
    },
    {
      attempt: { attemptId: "abort" } as never,
      argv: ["/bin/sh", "-c", "sleep 5"],
      env: { PATH: process.env.PATH },
      sandboxBackend: "linux-bwrap" as const,
    },
    {
      attempt: { attemptId: "signal" } as never,
      argv: ["/bin/sh", "-c", "kill -SYS $$"],
      env: { PATH: process.env.PATH },
      sandboxBackend: "linux-seccomp" as const,
    },
  ];
  const prepare = mock.method(
    SandboxManager,
    "prepareSandboxAttempt",
    async () => descriptors.shift()!,
  );
  const cleanup = mock.method(SandboxManager, "cleanupAfterCommand", () => {});
  const finish = mock.method(SandboxManager, "finishSandboxAttempt", async () => ({ denials: [] }));
  try {
    const timed = createAttributedSandboxedBashOps();
    await assert.rejects((await runAttributed(timed, { timeout: 0.01 })).execution, /timeout/);
    assert.equal((await timed.finished).observation.termination, "timeout");

    const controller = new AbortController();
    const aborted = createAttributedSandboxedBashOps();
    const abortExecution = (await runAttributed(aborted, { signal: controller.signal })).execution;
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(abortExecution, /aborted/);
    assert.equal((await aborted.finished).observation.termination, "aborted");

    const signaled = createAttributedSandboxedBashOps();
    await (await runAttributed(signaled)).execution;
    assert.deepEqual((await signaled.finished).observation, {
      sandboxBackend: "linux-seccomp",
      exitCode: null,
      signal: "SIGSYS",
      termination: "signal",
    });
  } finally {
    finish.mock.restore();
    cleanup.mock.restore();
    prepare.mock.restore();
  }
});

test("preparation and finish failures stay runtime errors", async () => {
  const cleanup = mock.method(SandboxManager, "cleanupAfterCommand", () => {});
  const finish = mock.method(SandboxManager, "finishSandboxAttempt", async () => {
    throw new Error("finish failed");
  });
  const prepare = mock.method(SandboxManager, "prepareSandboxAttempt", async () => {
    throw new Error("prepare failed");
  });
  try {
    const preparation = createAttributedSandboxedBashOps();
    await assert.rejects((await runAttributed(preparation)).execution, /prepare failed/);
    await assert.rejects(preparation.finished, /prepare failed/);
    assert.equal(cleanup.mock.callCount(), 0);
    assert.equal(finish.mock.callCount(), 0);

    prepare.mock.mockImplementationOnce(async () => ({
      attempt: { attemptId: "finish" } as never,
      argv: ["/bin/true"],
      env: { PATH: process.env.PATH },
      sandboxBackend: "linux-bwrap" as const,
    }));
    const finalization = createAttributedSandboxedBashOps();
    await assert.rejects((await runAttributed(finalization)).execution, /finish failed/);
    await assert.rejects(finalization.finished, /finish failed/);
    assert.equal(cleanup.mock.callCount(), 1);
    assert.equal(finish.mock.callCount(), 1);
  } finally {
    prepare.mock.restore();
    finish.mock.restore();
    cleanup.mock.restore();
  }
});

test("preparation receives cwd and env while identical commands retain handle evidence", async () => {
  const prepared: Array<{ cwd?: string; env?: NodeJS.ProcessEnv }> = [];
  let next = 0;
  const prepare = mock.method(SandboxManager, "prepareSandboxAttempt", async (options) => {
    prepared.push({ cwd: options.cwd, env: options.env });
    next++;
    return {
      attempt: { attemptId: `attempt-${next}` } as never,
      argv: ["/bin/echo", `stream-${next}`],
      env: { PATH: process.env.PATH, ATTEMPT: String(next) },
      sandboxBackend: next === 1 ? ("linux-bwrap" as const) : ("linux-seccomp" as const),
    };
  });
  const cleanup = mock.method(SandboxManager, "cleanupAfterCommand", () => {});
  const finish = mock.method(SandboxManager, "finishSandboxAttempt", async (handle) => ({
    denials:
      handle.attemptId === "attempt-2"
        ? ([{ kind: "filesystem", source: "linux-seccomp" }] as const)
        : [],
  }));
  try {
    const a = createAttributedSandboxedBashOps();
    const b = createAttributedSandboxedBashOps();
    const aRun = await runAttributed(a);
    const bRun = await runAttributed(b);
    await Promise.all([aRun.execution, bRun.execution]);
    assert.equal(Buffer.concat(aRun.chunks).toString().includes("stream-1"), true);
    assert.equal(Buffer.concat(bRun.chunks).toString().includes("stream-2"), true);
    assert.equal(prepared[0]?.cwd, tmpdir());
    assert.deepEqual(prepared[0]?.env, { PATH: process.env.PATH });
    assert.deepEqual((await a.finished).denials, []);
    assert.deepEqual((await b.finished).denials, [
      { kind: "filesystem", source: "linux-seccomp" },
    ]);
    assert.equal((await a.finished).observation.sandboxBackend, "linux-bwrap");
    assert.equal((await b.finished).observation.sandboxBackend, "linux-seccomp");
  } finally {
    finish.mock.restore();
    cleanup.mock.restore();
    prepare.mock.restore();
  }
});
```

Add a real nonzero descriptor lifecycle test using, for example, `argv: ["/bin/sh", "-c", "printf 'nonzero retained output'; exit 23"]`. It must exercise the real child process and assert all of: streamed/retained output, operation resolution `{ exitCode: 23 }`, final observation `{ termination: "exit", exitCode: 23 }`, `cleanupAfterCommand()` before `finishSandboxAttempt()`, and one attempt finalization. Do not claim nonzero coverage until this test is present.

Add a runtime integration-style concurrent-publication test after attributed operations are available. Hold unrelated attempt X open, complete A, call `updateSandboxConfig`, run and finish B, then finish or abort X. Have each mocked `finishSandboxAttempt(handle)` return a distinct handle-derived summary; assert X, A, and B observe only their own summary, `updateConfig` is called once, and `SandboxManager.reset()` is never called. This test must use separate attempt handles and real operation completion ordering, not command-text correlation.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `pnpm exec tsx --test test/sandbox-runtime.test.ts`

Expected: FAIL because `createAttributedSandboxedBashOps` and its completion interface do not exist.

- [ ] **Step 3: Refactor the shared SSH prefix and process-group helpers**

Keep the existing SSH function text byte-for-byte and extract only reusable private helpers:

```ts
function createSshProxyCommand(sshProxy: boolean): string {
  const socksProxyPort = sshProxy ? SandboxManager.getSocksProxyPort() : undefined;
  return process.platform === "darwin" && socksProxyPort !== undefined
    ? `ssh() { /usr/bin/ssh -o 'ProxyCommand=/usr/bin/nc -X 5 -x localhost:${socksProxyPort} %h %p' "$@"; }; `
    : "";
}

function killProcessGroup(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}
```

Have legacy `createSandboxedBashOps()` call these helpers without changing its wrapper, cleanup, timeout, abort, streaming, or resolution semantics.

- [ ] **Step 4: Implement the attributed descriptor lifecycle**

Add the interface and sibling factory. The implementation must use a single deferred completion, attach a no-op rejection handler immediately, retain child `error` until `close`, and centralize cleanup-then-finish:

```ts
export interface AttributedSandboxedBashOps {
  operations: BashOperations;
  finished: Promise<FinishedSandboxProcessAttempt>;
}

export function createAttributedSandboxedBashOps(
  shellPath?: string,
  sshProxy = true,
): AttributedSandboxedBashOps {
  let resolveFinished!: (value: FinishedSandboxProcessAttempt) => void;
  let rejectFinished!: (reason: unknown) => void;
  const finished = new Promise<FinishedSandboxProcessAttempt>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });
  void finished.catch(() => {});

  const operations: BashOperations = {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      let descriptor: SandboxAttemptDescriptor;
      try {
        if (!existsSync(cwd)) {
          throw new Error(`Working directory does not exist: ${cwd}`);
        }
        const { shell } = getShellConfig(shellPath);
        descriptor = await SandboxManager.prepareSandboxAttempt({
          command: `${createSshProxyCommand(sshProxy)}${command}`,
          binShell: shell,
          abortSignal: signal,
          cwd,
          env,
        });
      } catch (error) {
        rejectFinished(error);
        throw error;
      }

      const finalize = async (observation: SandboxAttemptObservation) => {
        SandboxManager.cleanupAfterCommand();
        try {
          const result = await SandboxManager.finishSandboxAttempt(descriptor.attempt);
          const value = { observation, denials: result.denials };
          resolveFinished(value);
          return value;
        } catch (error) {
          rejectFinished(error);
          throw error;
        }
      };

      if (signal?.aborted) {
        await finalize({
          sandboxBackend: descriptor.sandboxBackend,
          exitCode: null,
          signal: null,
          termination: "aborted",
        });
        throw new Error("aborted");
      }

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(descriptor.argv[0], descriptor.argv.slice(1), {
          cwd,
          env: descriptor.env,
          shell: false,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        await finalize({
          sandboxBackend: descriptor.sandboxBackend,
          exitCode: null,
          signal: null,
          termination: "spawn-error",
        });
        throw error;
      }

      return new Promise((resolve, reject) => {
        let timedOut = false;
        let spawnError: Error | undefined;
        let timeoutHandle: NodeJS.Timeout | undefined;
        const kill = () => killProcessGroup(child);

        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            kill();
          }, timeout * 1000);
        }
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        child.on("error", (error) => {
          spawnError = error;
        });
        signal?.addEventListener("abort", kill, { once: true });
        child.on("close", async (exitCode, closeSignal) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", kill);
          const termination: SandboxAttemptObservation["termination"] = signal?.aborted
            ? "aborted"
            : timedOut
              ? "timeout"
              : spawnError
                ? "spawn-error"
                : closeSignal
                  ? "signal"
                  : "exit";
          try {
            await finalize({
              sandboxBackend: descriptor.sandboxBackend,
              exitCode,
              signal: closeSignal,
              termination,
            });
            if (signal?.aborted) reject(new Error("aborted"));
            else if (timedOut) reject(new Error(`timeout:${timeout}`));
            else if (spawnError) reject(spawnError);
            else resolve({ exitCode });
          } catch (error) {
            reject(error);
          }
        });
      });
    },
  };
  return { operations, finished };
}
```

Private factoring is allowed only if it preserves the exact interface and ordering above. Do not make `finishSandboxAttempt` own `cleanupAfterCommand`, do not finish a preparation that returned no handle, and do not reject immediately from the child `error` listener.

- [ ] **Step 5: Run process-lifecycle tests**

Run: `pnpm exec tsx --test test/sandbox-runtime.test.ts`

Expected: PASS for success, the asserted real nonzero exit, signal, timeout, abort, already-aborted, spawn-error, preparation-error, finish-error, streaming, exact descriptor spawning, concurrent identical attempts, and concurrent configuration publication without reset.

- [ ] **Step 6: Commit attributed operations**

```bash
pnpm run check
git add src/sandbox-runtime.ts test/sandbox-runtime.test.ts
git commit -m "feat: run attributed sandbox bash attempts"
```

---

### Task 4: Final-Attempt Selection and Write-Recovery Orchestration

**Files:**

- Modify: `src/bash-sandbox-denials.ts`
- Modify: `test/bash-sandbox-denials.test.ts`

**Interfaces:**

- Consumes: `FinishedSandboxProcessAttempt`, `hasSandboxDenialEvidence()`, and `appendSandboxGuidance()` from Task 1.
- Produces the decision-complete tagged union:

  ```ts
  export type CompletedAttributedBashAttempt<Result> =
    | { ok: true; result: Result; finished: FinishedSandboxProcessAttempt }
    | { ok: false; error: unknown; finished: FinishedSandboxProcessAttempt };
  ```
- Produces: `WriteRecoveryDisposition = "not-applicable" | "deny" | "abort" | "retry"`.
- Produces: `executeAttributedBashFlow<Result>(options): Promise<Result>`; it calls `recoverWrite` only for attempt A and calls `runAttempt` at most twice.

- [ ] **Step 1: Write failing flow tests for final-attempt ownership**

Append tests using small fake attempts:

```ts
import {
  executeAttributedBashFlow,
  type CompletedAttributedBashAttempt,
} from "../src/bash-sandbox-denials.ts";

type Result = { value: string };
const failedAttempt = (
  message: string,
  denials: CompletedAttributedBashAttempt<Result>["finished"]["denials"] = [],
): CompletedAttributedBashAttempt<Result> => ({
  ok: false,
  error: new Error(message),
  finished: { observation: observation(), denials },
});

test("a successful first attempt returns without recovery or guidance", async () => {
  let recoveries = 0;
  const result = await executeAttributedBashFlow({
    runAttempt: async () => ({
      ok: true,
      result: { value: "ok" },
      finished: { observation: observation({ exitCode: 0 }), denials: [] },
    }),
    recoverWrite: async () => {
      recoveries++;
      return "retry";
    },
    guidanceAvailable: () => true,
  });
  assert.deepEqual(result, { value: "ok" });
  assert.equal(recoveries, 0);
});

test("retry discards attempt A evidence and uses only failed attempt B", async () => {
  const attempts = [
    failedAttempt("A failed", [{ kind: "filesystem", source: "linux-seccomp" }]),
    failedAttempt("B ordinary failure"),
  ];
  await assert.rejects(
    executeAttributedBashFlow({
      runAttempt: async () => attempts.shift()!,
      recoverWrite: async () => "retry",
      guidanceAvailable: () => true,
    }),
    (error: unknown) => error instanceof Error && error.message === "B ordinary failure",
  );
  assert.equal(attempts.length, 0);
});

test("failed attempt B gets guidance from B evidence without a second recovery", async () => {
  let recoveries = 0;
  const attempts = [
    failedAttempt("A permission denied"),
    failedAttempt("B failed", [{ kind: "network", source: "http-proxy" }]),
  ];
  await assert.rejects(
    executeAttributedBashFlow({
      runAttempt: async () => attempts.shift()!,
      recoverWrite: async () => {
        recoveries++;
        return "retry";
      },
      guidanceAvailable: () => true,
    }),
    /B failed[\s\S]*pi-sandbox guidance/,
  );
  assert.equal(recoveries, 1);
});

test("prompt abort suppresses otherwise matching guidance", async () => {
  const original = new Error("permission denied");
  await assert.rejects(
    executeAttributedBashFlow({
      runAttempt: async () => ({
        ok: false,
        error: original,
        finished: { observation: observation(), denials: [] },
      }),
      recoverWrite: async () => "abort",
      guidanceAvailable: () => true,
    }),
    (error: unknown) => error === original,
  );
});

test("publication errors skip attempt B and receive no guidance", async () => {
  let attempts = 0;
  const publication = new Error("publication failed");
  await assert.rejects(
    executeAttributedBashFlow({
      runAttempt: async () => {
        attempts++;
        return failedAttempt("permission denied");
      },
      recoverWrite: async () => {
        throw publication;
      },
      guidanceAvailable: () => true,
    }),
    (error: unknown) => error === publication,
  );
  assert.equal(attempts, 1);
});
```

Complete the flow matrix with these tests:

```ts
test("deny and not-applicable both classify attempt A", async () => {
  for (const disposition of ["deny", "not-applicable"] as const) {
    let attempts = 0;
    await assert.rejects(
      executeAttributedBashFlow({
        runAttempt: async () => {
          attempts++;
          return failedAttempt("permission denied");
        },
        recoverWrite: async () => disposition,
        guidanceAvailable: () => true,
      }),
      /permission denied[\s\S]*pi-sandbox guidance/,
    );
    assert.equal(attempts, 1);
  }
});

test("a successful recovery attempt returns normally", async () => {
  const attempts: CompletedAttributedBashAttempt<Result>[] = [
    failedAttempt("A failed"),
    {
      ok: true,
      result: { value: "recovered" },
      finished: { observation: observation({ exitCode: 0 }), denials: [] },
    },
  ];
  const result = await executeAttributedBashFlow({
    runAttempt: async () => attempts.shift()!,
    recoverWrite: async () => "retry",
    guidanceAvailable: () => true,
  });
  assert.deepEqual(result, { value: "recovered" });
});

test("a closed guidance gate and non-Error failures are rethrown unchanged", async () => {
  const original = new Error("permission denied");
  await assert.rejects(
    executeAttributedBashFlow({
      runAttempt: async () => ({
        ok: false,
        error: original,
        finished: { observation: observation(), denials: [] },
      }),
      recoverWrite: async () => "not-applicable",
      guidanceAvailable: () => false,
    }),
    (error: unknown) => error === original,
  );

  const nonError = { failure: "permission denied" };
  await assert.rejects(
    executeAttributedBashFlow({
      runAttempt: async () => ({
        ok: false,
        error: nonError,
        finished: { observation: observation(), denials: [] },
      }),
      recoverWrite: async () => "not-applicable",
      guidanceAvailable: () => true,
    }),
    (error: unknown) => error === nonError,
  );
});

test("timeout, abort, and spawn errors stay unguided even with summaries", async () => {
  for (const termination of ["timeout", "aborted", "spawn-error"] as const) {
    const original = new Error("permission denied");
    await assert.rejects(
      executeAttributedBashFlow({
        runAttempt: async () => ({
          ok: false,
          error: original,
          finished: {
            observation: observation({ termination }),
            denials: [{ kind: "network", source: "http-proxy" }],
          },
        }),
        recoverWrite: async () => "not-applicable",
        guidanceAvailable: () => true,
      }),
      (error: unknown) => error === original,
    );
  }
});

test("the tagged failure outcome preserves throw undefined", async () => {
  let caught = false;
  try {
    await executeAttributedBashFlow({
      runAttempt: async () => ({
        ok: false,
        error: undefined,
        finished: { observation: observation(), denials: [] },
      }),
      recoverWrite: async () => "not-applicable",
      guidanceAvailable: () => true,
    });
  } catch (error) {
    caught = true;
    assert.equal(error, undefined);
  }
  assert.equal(caught, true);

  const result = await executeAttributedBashFlow({
    runAttempt: async () => ({
      ok: true,
      result: { value: "no throw" },
      finished: { observation: observation({ exitCode: 0 }), denials: [] },
    }),
    recoverWrite: async () => "not-applicable",
    guidanceAvailable: () => true,
  });
  assert.deepEqual(result, { value: "no throw" });
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `pnpm exec tsx --test test/bash-sandbox-denials.test.ts`

Expected: FAIL because the flow interfaces and function are not exported.

- [ ] **Step 3: Implement the one-retry final-attempt flow**

Append this orchestration to `src/bash-sandbox-denials.ts`:

```ts
export type CompletedAttributedBashAttempt<Result> =
  | { ok: true; result: Result; finished: FinishedSandboxProcessAttempt }
  | { ok: false; error: unknown; finished: FinishedSandboxProcessAttempt };

export type WriteRecoveryDisposition = "not-applicable" | "deny" | "abort" | "retry";

export async function executeAttributedBashFlow<Result>(options: {
  runAttempt: () => Promise<CompletedAttributedBashAttempt<Result>>;
  recoverWrite: (error: unknown) => Promise<WriteRecoveryDisposition>;
  guidanceAvailable: () => boolean;
}): Promise<Result> {
  const finish = (attempt: CompletedAttributedBashAttempt<Result>): Result => {
    if (attempt.ok) return attempt.result;
    if (
      attempt.error instanceof Error &&
      options.guidanceAvailable() &&
      hasSandboxDenialEvidence(
        attempt.finished.observation,
        attempt.finished.denials,
        attempt.error.message,
      )
    ) {
      throw appendSandboxGuidance(attempt.error);
    }
    throw attempt.error;
  };

  const first = await options.runAttempt();
  if (first.ok) return first.result;

  const recovery = await options.recoverWrite(first.error);
  if (recovery === "abort") throw first.error;
  if (recovery !== "retry") return finish(first);

  const second = await options.runAttempt();
  return finish(second);
}
```

Do not call `recoverWrite` for attempt B. Runtime preparation and finalization failures must reject from `runAttempt()` before a `CompletedAttributedBashAttempt` exists, so they bypass both recovery and guidance.

- [ ] **Step 4: Run the flow tests to verify they pass**

Run: `pnpm exec tsx --test test/bash-sandbox-denials.test.ts`

Expected: PASS, proving that only the final attempt controls both the returned result and denial decision.

- [ ] **Step 5: Commit final-attempt orchestration**

```bash
pnpm run check
git add src/bash-sandbox-denials.ts test/bash-sandbox-denials.test.ts
git commit -m "feat: select final sandbox bash attempt"
```

---

### Task 5: Extension Wiring, Existing Write Recovery, and Mode Gate

**Files:**

- Modify: `src/extension.ts:38-43,232-345`
- Modify: `test/extension.test.ts`

**Interfaces:**

- Consumes: `createAttributedSandboxedBashOps()` from Task 3 and `executeAttributedBashFlow()` / `shouldShowSandboxGuidance()` from Tasks 1 and 4.
- Consumes: existing `resolveWritePermission()`, `extractBlockedWritePath()`, `promptWriteBlock()`, `applyChoice()`, and `onUpdate` retry notice.
- Consumes Task 2's already-migrated `updateSandboxConfig()` refresh helper; this task must not repeat the import or `refreshSandbox()` migration.
- Preserves: `createSandboxedBashOps()` exclusively for `user_bash`, and `localBash.execute()` for disabled/uninitialized sandbox execution and approved explicit escalation.

- [ ] **Step 1: Write failing composition tests for live-state gating and caught-error recovery**

Add tests to `test/extension.test.ts` that import the intended, not-yet-implemented `sandboxGuidanceAvailable()` and `createSandboxBashOperationRoutes()` exports. Do not add either production export during this red step.

```ts
import {
  createSandboxBashOperationRoutes,
  sandboxGuidanceAvailable,
} from "../src/extension.ts";

test("extension guidance gate checks current mode, UI, and both sandbox flags", () => {
  assert.equal(
    sandboxGuidanceAvailable({ mode: "tui", hasUI: true }, true, true),
    true,
  );
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
```

Import `readFileSync` from `node:fs` and add this source-boundary regression test; it is deliberately narrow because the extension's default export closes over live Pi state:

```ts
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
  assert.match(modelSection, /createAttributedSandboxedBashOps/);
  assert.doesNotMatch(modelSection, /operations:\s*createSandboxedBashOps/);
  assert.match(userSection, /operations:\s*createSandboxedBashOps/);
  assert.doesNotMatch(userSection, /createAttributedSandboxedBashOps/);
});
```

Keep the existing escalation hook tests unchanged. The executable routing test is the behavioral assertion; keep the source-boundary assertion only as supplemental coverage.

Add end-to-end composition tests through `createBashToolDefinition` using operations that stream text and resolve Pi's installed `{ exitCode: null }` signal result. For a `linux-seccomp`/`SIGSYS` completion, assert the final flow rejects with the exact retained Pi output prefix, `Command terminated by signal SIGSYS`, and exactly one guidance block. Add a negative signal/backend case (such as `linux-bwrap`/`SIGSYS` with no summaries and no fallback match) that remains a tool error without guidance. Add the real exit-23 descriptor case from Task 3 at this boundary and assert Pi rejects with retained output containing `Command exited with code 23` after cleanup and attempt finalization.

- [ ] **Step 2: Run extension tests to verify they fail**

Run: `pnpm exec tsx --test test/extension.test.ts`

Expected: FAIL because `sandboxGuidanceAvailable()` and `createSandboxBashOperationRoutes()` are not exported and model Bash is not wired to attributed operations.

- [ ] **Step 3: Replace the model Bash body with attributed attempt capture and signal-result adaptation**

Implement the two seams exercised by Step 1 before wiring the model Bash body:

```ts
export function sandboxGuidanceAvailable(
  ctx: Pick<ExtensionContext, "mode" | "hasUI">,
  sandboxEnabled: boolean,
  sandboxInitialized: boolean,
): boolean {
  return shouldShowSandboxGuidance(
    ctx.mode,
    ctx.hasUI,
    sandboxEnabled && sandboxInitialized,
  );
}

export function createSandboxBashOperationRoutes(
  attributedFactory: typeof createAttributedSandboxedBashOps =
    createAttributedSandboxedBashOps,
  legacyFactory: typeof createSandboxedBashOps = createSandboxedBashOps,
) {
  return {
    model: (shellPath?: string, sshProxy = true) =>
      attributedFactory(shellPath, sshProxy),
    user: (shellPath?: string, sshProxy = true) => legacyFactory(shellPath, sshProxy),
  };
}
```

Create one default `sandboxBashOperationRoutes` instance in the extension composition root. The model-attempt path below must call `sandboxBashOperationRoutes.model(...)`; the existing `user_bash` hook must call `sandboxBashOperationRoutes.user(...)`. This executable wiring, rather than the source-regex assertion, is the primary regression boundary.

For an active sandbox, construct one new Pi Bash definition and one new attributed operations instance per call to `runAttempt()`. Catch only Pi's ordinary result/error around `execute`; then await the operations completion. Do not catch a rejected `finished` promise. Use the tagged completion contract, not optional `result`/`error` fields. If ordinary Pi execution returned a result but the completed observation is `termination: "signal"`, extract the already-retained text content and return an `ok: false` local adapter error whose message is exactly `<retained Pi output>\n\nCommand terminated by signal <SIGNAL>`. This adapter is local to pi-sandbox: it must not alter `BashOperations`, add a stream buffer, or require an upstream Pi release.

```ts
const runAttempt = async () => {
  const attributed = sandboxBashOperationRoutes.model(
    userShellPath,
    loadConfig(ctx.cwd).network?.sshProxy !== false,
  );
  let result!: AgentToolResult<any>;
  let threw = false;
  let caught: unknown;
  try {
    result = await createBashToolDefinition(localCwd, {
      operations: attributed.operations,
      shellPath: userShellPath,
    }).execute(id, params, signal, onUpdate, ctx);
  } catch (error) {
    threw = true;
    caught = error;
  }
  const finished = await attributed.finished;
  if (threw) return { ok: false as const, error: caught, finished };
  if (finished.observation.termination === "signal") {
    const retained = retainedPiText(result);
    const signalName = finished.observation.signal ?? "unknown";
    return {
      ok: false as const,
      error: new Error(`${retained}\n\nCommand terminated by signal ${signalName}`),
      finished,
    };
  }
  return { ok: true as const, result, finished };
};
```

`retainedPiText()` must read Pi's existing retained text content only; it must not reassemble `onData` chunks. If the sandbox is disabled or uninitialized at entry, return `localBash.execute(...)` exactly as before; do not prepare an attributed descriptor. Remove the entire `Operation not permitted` conversion to `AgentToolResult`.

- [ ] **Step 4: Feed the caught original error into the existing write resolver**

Call Task 4's flow with a recovery callback that inspects only attempt A's caught `Error.message` and maps every resolver outcome explicitly:

```ts
return executeAttributedBashFlow({
  runAttempt,
  recoverWrite: async (error) => {
    if (!(error instanceof Error) || !ctx.hasUI) return "not-applicable";
    const blockedPath = extractBlockedWritePath(error.message);
    if (!blockedPath) return "not-applicable";

    const path = canonicalizePath(blockedPath);
    const config = loadConfig(ctx.cwd);
    const writePermission = await resolveWritePermission({
      path,
      allowWrite: effectiveWritePaths(ctx.cwd),
      denyWrite: config.filesystem?.denyWrite ?? [],
      prompt: (candidate) =>
        promptWriteBlock(pi, ctx, candidate, config.permissionPromptTimeoutSeconds),
      saveWritePermission: (choice, value) =>
        applyChoice(choice, "write", value, ctx.cwd),
    });

    if (writePermission.action === "abort") return "abort";
    if (writePermission.action === "deny") return "deny";
    if (writePermission.action === "allow") {
      await refreshSandbox(ctx.cwd);
      return "retry";
    }
    onUpdate?.({
      content: [
        {
          type: "text",
          text: `\n--- Write access granted for "${writePermission.value}", retrying ---\n`,
        },
      ],
      details: {},
    });
    return "retry";
  },
  guidanceAvailable: () =>
    sandboxGuidanceAvailable(ctx, sandboxEnabled, sandboxInitialized),
});
```

`granted` has already persisted and published through `applyChoice`; `allow` explicitly republishes the current effective configuration. `deny` leaves attempt A as final and eligible for ordinary cautious classification. `abort` rethrows A unchanged and suppresses guidance. A rejected publication escapes directly, and Task 4 never starts B.

- [ ] **Step 5: Verify compatibility boundaries in the composition root**

Confirm the actual diff has all of these properties:

```text
model default Bash -> createAttributedSandboxedBashOps -> executeAttributedBashFlow
explicit approved Bash -> existing localBash.execute
user_bash -> existing createSandboxedBashOps
disable/shutdown -> existing SandboxManager.reset
permission refresh -> updateSandboxConfig, never reset
```

Do not change `createEscalatingBashToolDefinition`, `EscalationPrompt`, approval tracking, `registerBashEscalationHooks`, SSH proxy selection, or the `user_bash` result shape.

- [ ] **Step 6: Run extension, flow, and runtime tests**

Run:

```bash
pnpm exec tsx --test test/extension.test.ts test/bash-sandbox-denials.test.ts test/sandbox-runtime.test.ts
```

Expected: PASS. Failures must remain thrown errors; direct signals are locally adapted from Pi's successful-null-exit result after retained output is available; successful attempt B returns Pi's normal retained-output result; prompt abort and non-TUI modes retain the original error unchanged.

- [ ] **Step 7: Commit extension integration**

```bash
pnpm run check
git add src/extension.ts test/extension.test.ts
git commit -m "feat: guide final sandbox bash denials"
```

---

### Task 6: User Documentation and Full Compatibility Verification

**Files:**

- Modify: `README.md`
- Verify: `src/bash-permissions.ts`, `src/extension.ts`, `src/sandbox-runtime.ts`, and all `test/**/*.test.ts`

**Interfaces:**

- Documents: guidance is diagnostic, does not rerun outside the sandbox, and requires a separate explicit request plus human approval.
- Verifies: TypeScript compilation, formatting, lint, complete test suite, reset/updateConfig boundaries, and unchanged escalation/user Bash routing.

- [ ] **Step 1: Add concise guidance documentation next to explicit Bash escalation**

Add this paragraph after the existing explicit escalation description in `README.md`:

```markdown
When a sandboxed model Bash command fails, pi-sandbox may append a bounded
guidance block if the final process attempt has runtime denial evidence or
matches a cautious compatibility heuristic. The failed call remains a tool
error and is never retried outside pi-sandbox. In interactive TUI sessions,
the model can make a separate `sandbox_permissions: "require_escalated"`
request with a concise justification; the existing human approval prompt is
still required. Headless modes and successful, timed-out, aborted, spawn, or
unrelated failures receive no guidance.
```

Do not describe the heuristic as certainty and do not imply that approval is automatic.

- [ ] **Step 2: Audit all six review findings and compatibility boundaries**

Run:

```bash
rg -n "reinitializeSandbox|Failed to reinitialize|OS-level sandbox restriction" src test README.md
rg -n "SandboxManager\.reset|SandboxManager\.updateConfig|createAttributedSandboxedBashOps|createSandboxedBashOps" src/extension.ts src/sandbox-runtime.ts
rg -n "result\?:|error\?:|sandbox attempt must complete with exactly one" src test
pnpm exec tsx -e 'import assert from "node:assert/strict"; import { readFileSync } from "node:fs"; const pkg = JSON.parse(readFileSync("package.json", "utf8")); const specifier = pkg.dependencies["@carderne/sandbox-runtime"]; const lock = readFileSync("pnpm-lock.yaml", "utf8"); const importer = lock.slice(lock.indexOf("importers:\n"), lock.indexOf("\npackages:\n")); const match = importer.match(/\x27@carderne\/sandbox-runtime\x27:\n\s+specifier:\s+([^\n]+)\n\s+version:\s+([^\n]+)/); assert.ok(match, "root importer runtime entry is required"); const [, lockSpecifier, lockVersion] = match; assert.match(specifier, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/); assert.equal(lockSpecifier, specifier); assert.equal(lockVersion, specifier); assert.doesNotMatch(`${specifier}\n${lockSpecifier}\n${lockVersion}`, /(?:\^|~|latest)/);'
rg -n "endsWith\(.*PI_SANDBOX_GUIDANCE|stray guidance header|throw undefined|Command terminated by signal|exitCode: 23" src test
```

Expected: the first command returns no matches. The second shows `reset()` only in disable/shutdown lifecycle paths, `updateConfig()` in permission publication, attributed operations for model default Bash, and legacy operations for `user_bash`. The tagged-union search finds no optional outcome contract or sentinel validation; the exact-version assertion proves the manifest and root lockfile importer use the same plain semver with no caret, tilde, or `latest`; the final search proves exact trailing-block idempotence, `throw undefined`, local signal adaptation, and real exit-23 coverage. Manually audit the concurrent X/A/B test for handle-scoped summaries and no reset, and the executable routing seam for model versus `user_bash` operations.

- [ ] **Step 3: Run the complete repository verification**

Run each command separately:

```bash
pnpm run ci:fmt
pnpm run ci:lint
pnpm run ci:check
pnpm run ci:test
```

Expected: formatter completes, linter reports no errors, `tsc --noEmit` passes, and every Node test passes. Review formatter changes before staging; only files listed by this plan should change.

- [ ] **Step 4: Inspect the final diff against the acceptance criteria**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Expected: no whitespace errors; only the planned source, test, dependency, lockfile, and README files are modified. Manually map each spec acceptance criterion to the passing test named in Tasks 1-5, especially final-attempt-only evidence, structured precedence, publication failure, prompt abort, mode gating, and unchanged `user_bash`/explicit escalation.

- [ ] **Step 5: Commit documentation and verification**

```bash
pnpm run check
git add README.md
git commit -m "docs: explain sandbox denial guidance"
```
