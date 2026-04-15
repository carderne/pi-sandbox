import test from "node:test";
import assert from "node:assert/strict";
import { shouldPromptForWrite } from "../policy.js";

test("prompts when allowWrite is empty (deny all by default)", () => {
  const prompt = shouldPromptForWrite("/tmp/x", [], () => false);
  assert.equal(prompt, true);
});

test("prompts when path is outside non-empty allowWrite", () => {
  const prompt = shouldPromptForWrite("/tmp/x", ["/work"], () => false);
  assert.equal(prompt, true);
});

test("does not prompt when path is inside allowWrite", () => {
  const prompt = shouldPromptForWrite("/work/file", ["/work"], () => true);
  assert.equal(prompt, false);
});
