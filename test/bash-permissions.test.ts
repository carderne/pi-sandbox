import assert from "node:assert/strict";
import test from "node:test";

import { Check } from "typebox/value";

import {
  createEscalationAbortError,
  createNotRunResult,
  isEscalationAbortError,
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
