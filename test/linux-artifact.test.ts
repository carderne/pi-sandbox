import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import assert from "node:assert/strict";

import { validateLinuxLauncher } from "../vendor/sandbox-runtime/src/sandbox/linux-launcher.ts";

// Validation only: the fake artifact is never executed.
test("missing, stale, damaged, non-executable and wrong-architecture launchers fail closed", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-launcher-artifact-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const artifact = join(dir, "launcher");
  const source = join(dir, "launcher.c");
  const sources = [pathToFileURL(source)];
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  const valid = () => validateLinuxLauncher(artifact, sources, "x64");
  const metadata = { arch: "x64", sourceSha256: hash("source"), binarySha256: hash("artifact") };
  const writeMetadata = (value = metadata) =>
    writeFileSync(`${artifact}.build.json`, JSON.stringify(value));
  assert.equal(valid(), false);
  writeFileSync(source, "source");
  writeFileSync(artifact, "artifact", { mode: 0o755 });
  assert.equal(valid(), false, "manifest is mandatory");
  writeMetadata();
  assert.equal(valid(), true);
  writeMetadata({ ...metadata, arch: "arm64" });
  assert.equal(valid(), false);
  writeMetadata();
  writeFileSync(source, "new source");
  assert.equal(valid(), false, "source changes require rebuilding");
  writeFileSync(source, "source");
  writeFileSync(artifact, "damaged");
  assert.equal(valid(), false);
  writeFileSync(artifact, "artifact");
  if (process.platform !== "win32") {
    chmodSync(artifact, 0o644);
    assert.equal(valid(), false);
    chmodSync(artifact, 0o755);
  }
  assert.equal(valid(), true);
});
