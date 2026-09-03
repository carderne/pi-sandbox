import { constants } from "node:os";
import test from "node:test";

import assert from "node:assert/strict";

import {
  PI_SANDBOX_GUIDANCE,
  appendSandboxGuidance,
  executeAttributedBashFlow,
  hasSandboxDenialEvidence,
  isEligibleCommandFailure,
  matchesSandboxDenialFallback,
  shouldShowSandboxGuidance,
  type CompletedAttributedBashAttempt,
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

test("fallback rejects success, backend none, and unrelated errors", () => {
  assert.equal(matchesSandboxDenialFallback(observation({ exitCode: 0 }), "sandbox"), false);
  assert.equal(
    matchesSandboxDenialFallback(observation({ sandboxBackend: "none" }), "permission denied"),
    false,
  );
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
    isEligibleCommandFailure(
      observation({ exitCode: null, signal: "SIGSYS", termination: "signal" }),
    ),
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

test("sandbox-denial guidance requests one escalation without waiting for another user request", () => {
  assert.match(
    PI_SANDBOX_GUIDANCE,
    /make one new Bash tool call with `escalation: \{ "justification": "<concise user-facing reason>" \}`/,
  );
  assert.match(PI_SANDBOX_GUIDANCE, /Do not wait for the user to request escalation separately/);
  assert.match(
    PI_SANDBOX_GUIDANCE,
    /If that escalation request is declined, cancelled, times out, or is unavailable, stop/,
  );
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
