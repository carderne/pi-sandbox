import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import {
  allowsAllDomains,
  canonicalizePath,
  decideWritePolicy,
  domainIsAllowed,
  extractDomainsFromCommand,
  matchesPattern,
  resolveWritePermission,
} from "../src/policy.ts";

test("extracts and deduplicates literal HTTP domains", () => {
  assert.deepEqual(
    extractDomainsFromCommand("curl https://api.example.com/a http://api.example.com/b"),
    ["api.example.com"],
  );
});

test("matches exact, wildcard, and all-domain policies", () => {
  assert.equal(domainIsAllowed("github.com", ["github.com"]), true);
  assert.equal(domainIsAllowed("api.github.com", ["*.github.com"]), true);
  assert.equal(domainIsAllowed("notgithub.com", ["*.github.com"]), false);
  assert.equal(allowsAllDomains(["*"]), true);
});

test("decides write policy from deny and allow lists", () => {
  assert.equal(decideWritePolicy("/tmp/file", ["/tmp"], ["/tmp/file"]), "deny");
  assert.equal(decideWritePolicy("/tmp/file", ["/tmp"], []), "allow");
  assert.equal(decideWritePolicy("/tmp/file", ["/var"], []), "prompt");
  assert.equal(decideWritePolicy("/tmp/file", [], []), "prompt");
});

test("resolves write permission without prompting for denied or allowed paths", async () => {
  const calls: string[] = [];
  const prompt = async () => {
    calls.push("prompt");
    return { action: "session" as const, value: "/tmp" };
  };
  const apply = async () => {
    calls.push("apply");
  };

  assert.deepEqual(
    await resolveWritePermission({
      path: "/tmp/file",
      allowWrite: ["/tmp"],
      denyWrite: ["/tmp/file"],
      prompt,
      saveWritePermission: apply,
    }),
    { action: "deny" },
  );
  assert.deepEqual(
    await resolveWritePermission({
      path: "/tmp/file",
      allowWrite: ["/tmp"],
      denyWrite: [],
      prompt,
      saveWritePermission: apply,
    }),
    { action: "allow" },
  );
  assert.deepEqual(calls, []);
});

test("resolves write permission prompt choices", async () => {
  const applied: string[] = [];
  assert.deepEqual(
    await resolveWritePermission({
      path: "/tmp/file",
      allowWrite: [],
      denyWrite: [],
      prompt: async () => ({ action: "abort", value: "/tmp/file" }),
      saveWritePermission: async (choice, value) => {
        applied.push(`${choice}:${value}`);
      },
    }),
    { action: "abort", value: "/tmp/file" },
  );
  assert.deepEqual(applied.length, 0);

  assert.deepEqual(
    await resolveWritePermission({
      path: "/tmp/file",
      allowWrite: [],
      denyWrite: [],
      prompt: async () => ({ action: "session", value: "/tmp" }),
      saveWritePermission: async (choice, value) => {
        applied.push(`${choice}:${value}`);
      },
    }),
    { action: "granted", value: "/tmp" },
  );
  assert.deepEqual(applied, ["session:/tmp"]);
});

test("path patterns support directory prefixes and globs", () => {
  const root = canonicalizePath(mkdtempSync(join(tmpdir(), "pi-sandbox-policy-")));
  assert.equal(matchesPattern(join(root, "nested", "file.txt"), [root]), true);
  assert.equal(matchesPattern(join(root, "file.pem"), [join(root, "*.pem")]), true);
  assert.equal(matchesPattern(join(root, "file.txt"), [join(root, "*.pem")]), false);
});

test("canonicalizes symlinks and nonexistent descendants", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-canonical-"));
  const real = join(root, "real");
  const link = join(root, "link");
  mkdirSync(real);
  symlinkSync(real, link);
  assert.equal(
    canonicalizePath(join(link, "new", "file")),
    join(canonicalizePath(real), "new", "file"),
  );
});
