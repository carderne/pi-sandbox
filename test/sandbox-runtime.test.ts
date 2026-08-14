import test from "node:test";

import assert from "node:assert/strict";

import { DEFAULT_CONFIG } from "../src/config.ts";
import { canonicalizePath } from "../src/policy.ts";
import {
  buildRuntimeConfig,
  extractBlockedWritePath,
  resolveAllowances,
  supportsNodeEnvProxy,
} from "../src/sandbox-runtime.ts";

test("buildRuntimeConfig adds session allowances without mutating config", () => {
  const runtime = buildRuntimeConfig(DEFAULT_CONFIG, {
    domains: ["example.com"],
    readPaths: ["/read"],
    writePaths: ["/write"],
  });
  assert.equal(runtime.network?.allowedDomains?.includes("example.com"), true);
  assert.equal(runtime.filesystem?.allowRead?.includes("/read"), true);
  assert.equal(runtime.filesystem?.allowRead?.includes("/write"), true);
  assert.equal(runtime.filesystem?.allowWrite?.includes("/write"), true);
  assert.equal(DEFAULT_CONFIG.network?.allowedDomains?.includes("example.com"), false);
});

test("buildRuntimeConfig canonicalizes non-glob filesystem paths", () => {
  const runtime = buildRuntimeConfig({
    ...DEFAULT_CONFIG,
    filesystem: {
      ...DEFAULT_CONFIG.filesystem!,
      denyRead: ["/tmp"],
      allowRead: [],
      allowWrite: ["/tmp"],
      denyWrite: ["*.key"],
    },
  });

  assert.deepEqual(runtime.filesystem?.denyRead, [canonicalizePath("/tmp")]);
  assert.equal(runtime.filesystem?.allowRead?.includes(canonicalizePath("/tmp")), true);
  assert.deepEqual(runtime.filesystem?.allowWrite, [canonicalizePath("/tmp")]);
  assert.deepEqual(runtime.filesystem?.denyWrite, ["*.key"]);
});

test("resolveAllowances makes configured and session write paths readable", () => {
  const config = {
    ...DEFAULT_CONFIG,
    filesystem: {
      ...DEFAULT_CONFIG.filesystem!,
      allowRead: [],
      allowWrite: ["/configured-write"],
    },
  };
  const effective = resolveAllowances(config, {
    domains: [],
    readPaths: [],
    writePaths: ["/session-write"],
  });

  assert.deepEqual(effective.readPaths, ["/configured-write", "/session-write"]);
  assert.deepEqual(effective.writePaths, ["/configured-write", "/session-write"]);
});

test("extractBlockedWritePath recognizes shell sandbox errors", () => {
  assert.equal(
    extractBlockedWritePath("bash: line 1: /private/file: Operation not permitted"),
    "/private/file",
  );
  assert.equal(extractBlockedWritePath("permission denied"), null);
});

test("supportsNodeEnvProxy observes Node release boundaries", () => {
  assert.equal(supportsNodeEnvProxy("22.20.0"), false);
  assert.equal(supportsNodeEnvProxy("22.21.0"), true);
  assert.equal(supportsNodeEnvProxy("23.9.0"), false);
  assert.equal(supportsNodeEnvProxy("24.0.0"), true);
});
