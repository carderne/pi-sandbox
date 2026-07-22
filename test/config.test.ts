import test from "node:test";

import assert from "node:assert/strict";

import { deepMerge, DEFAULT_CONFIG } from "../src/config.ts";

test("deepMerge merges sections while replacing configured arrays", () => {
  const merged = deepMerge(DEFAULT_CONFIG, {
    enabled: false,
    network: { allowedDomains: ["example.com"], deniedDomains: [] },
    filesystem: {
      denyRead: DEFAULT_CONFIG.filesystem?.denyRead ?? [],
      allowRead: DEFAULT_CONFIG.filesystem?.allowRead,
      allowWrite: ["/work"],
      denyWrite: DEFAULT_CONFIG.filesystem?.denyWrite ?? [],
    },
    allowBrowserProcess: true,
  });

  assert.equal(merged.enabled, false);
  assert.deepEqual(merged.network?.allowedDomains, ["example.com"]);
  assert.deepEqual(merged.network?.deniedDomains, []);
  assert.equal(merged.network?.allowUnauthenticatedSocksProxy, process.platform === "darwin");
  assert.deepEqual(merged.filesystem?.allowWrite, ["/work"]);
  assert.deepEqual(merged.filesystem?.denyWrite, DEFAULT_CONFIG.filesystem?.denyWrite);
  assert.equal(merged.allowBrowserProcess, true);
});

test("a later merge takes precedence over global configuration", () => {
  const global = deepMerge(DEFAULT_CONFIG, {
    filesystem: {
      denyRead: [],
      allowRead: ["/global"],
      allowWrite: [],
      denyWrite: [],
    },
  });
  const project = deepMerge(global, {
    filesystem: {
      denyRead: [],
      allowRead: ["/project"],
      allowWrite: [],
      denyWrite: [],
    },
  });
  assert.deepEqual(project.filesystem?.allowRead, ["/project"]);
});
