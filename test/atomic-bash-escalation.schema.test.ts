import test from "node:test";

import assert from "node:assert/strict";
import { Check } from "typebox/value";

import {
  MAX_JUSTIFICATION_CODE_POINTS,
  classifyBashInput,
  sandboxBashSchema,
} from "../src/bash-permissions.ts";

test("strict Bash schema accepts only nested, non-blank bounded escalation", () => {
  assert.equal(Check(sandboxBashSchema, { command: "pwd" }), true);
  assert.equal(
    Check(sandboxBashSchema, {
      command: "pnpm install",
      timeout: 30,
      escalation: { justification: "Need registry access?" },
    }),
    true,
  );

  for (const input of [
    { command: "pwd", sandbox_permissions: "require_escalated", justification: "legacy" },
    { command: "pwd", escalation: { justification: "Need access?", extra: true } },
    { command: "pwd", escalation: { justifiction: "misspelled" } },
    { command: "pwd", escalation: null },
    { command: "pwd", escalation: [] },
    { command: "pwd", escalation: {} },
    { command: "pwd", escalation: { justification: " \n\t " } },
    { command: "pwd", escalation: { justification: "x".repeat(501) } },
    { command: "pwd", extra: true },
  ]) {
    assert.equal(Check(sandboxBashSchema, input), false, JSON.stringify(input));
  }
});

test("Bash escalation schema accepts full Unicode and counts astral code points", () => {
  const input = (justification: string) => ({
    command: "pwd",
    escalation: { justification },
  });

  assert.equal(Check(sandboxBashSchema, input("Need 🧪 access")), true);
  assert.equal(Check(sandboxBashSchema, input("🧪".repeat(500))), true);
  assert.equal(Check(sandboxBashSchema, input("🧪".repeat(501))), false);
  assert.equal(Check(sandboxBashSchema, input(" \n\t ")), false);

  assert.equal(classifyBashInput(input("Need 🧪 access")).kind, "escalation");
  assert.equal(classifyBashInput(input("🧪".repeat(500))).kind, "escalation");
  assert.equal(classifyBashInput(input("🧪".repeat(501))).kind, "invalid");
});

test("Bash input classifier recognizes default, valid, and invalid escalation before routing", () => {
  assert.deepEqual(classifyBashInput({ command: "pwd" }), { kind: "default" });
  assert.deepEqual(
    classifyBashInput({
      command: "pwd",
      escalation: { justification: "  Need local access?  " },
    }),
    { kind: "escalation", justification: "Need local access?" },
  );

  for (const escalation of [
    null,
    [],
    {},
    { justification: "" },
    { justification: " \n\t " },
    { justification: "x".repeat(MAX_JUSTIFICATION_CODE_POINTS + 1) },
    { justification: "Need access?", typo: true },
  ]) {
    assert.equal(classifyBashInput({ command: "pwd", escalation }).kind, "invalid");
  }

  assert.equal(
    classifyBashInput({
      command: "pwd",
      sandbox_permissions: "require_escalated",
      justification: "legacy",
    }).kind,
    "invalid",
  );
});
