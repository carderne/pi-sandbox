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
