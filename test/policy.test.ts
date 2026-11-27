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

test("extracts short, IP, userinfo and mixed-case hosts; skips expansions and single labels", () => {
  assert.deepEqual(
    extractDomainsFromCommand(
      'curl https://x.com/a "https://1.2.3.4:8080/b" https://user:pw@Git.Example.ORG/c HTTPS://y.io.',
    ),
    ["x.com", "1.2.3.4", "git.example.org", "y.io"],
  );
  assert.deepEqual(
    extractDomainsFromCommand(
      "curl https://$HOST/a https://${HOST}/b https://a$B.com http://localhost:3000 http://[::1]/c",
    ),
    [],
  );
  assert.deepEqual(
    extractDomainsFromCommand(
      "curl https://a.com, https://b.com; (curl https://c.com)&& curl https://d.com|x",
    ),
    ["a.com", "b.com", "c.com", "d.com"],
  );
});

test("matches exact, wildcard, and all-domain policies", () => {
  assert.equal(domainIsAllowed("github.com", ["github.com"]), true);
  assert.equal(domainIsAllowed("api.github.com", ["*.github.com"]), true);
  assert.equal(domainIsAllowed("notgithub.com", ["*.github.com"]), false);
  assert.equal(domainIsAllowed("somea.example.org", ["someA.example.org"]), true);
  assert.equal(domainIsAllowed("API.GitHub.com", ["*.github.com"]), true);
  assert.equal(domainIsAllowed("github.com", ["*.GitHub.com"]), true);
  assert.equal(allowsAllDomains(["*"]), true);
});

test("decides write policy from deny and allow lists", () => {
  assert.equal(decideWritePolicy("/tmp/file", ["/tmp"], ["/tmp/file"]), "deny");
  assert.equal(decideWritePolicy("/tmp/file", ["/tmp"], []), "allow");
  assert.equal(decideWritePolicy("/tmp/file", ["/var"], []), "prompt");
  assert.equal(decideWritePolicy("/tmp/file", [], []), "prompt");
});

test("resolves write permission without prompting for denied or allowed paths", async () => {
  let prompts = 0;
  const prompt = async () => {
    prompts++;
    return { action: "session" as const, value: "/tmp" };
  };

  assert.deepEqual(
    await resolveWritePermission({
      path: "/tmp/file",
      allowWrite: ["/tmp"],
      denyWrite: ["/tmp/file"],
      prompt,
    }),
    { action: "deny" },
  );
  assert.deepEqual(
    await resolveWritePermission({
      path: "/tmp/file",
      allowWrite: ["/tmp"],
      denyWrite: [],
      prompt,
    }),
    { action: "allow" },
  );
  assert.equal(prompts, 0);
});

test("resolves write permission prompt choices", async () => {
  const resolve = (action: "abort" | "allowed" | "session") =>
    resolveWritePermission({
      path: "/tmp/file",
      allowWrite: [],
      denyWrite: [],
      prompt: async () => ({ action, value: "/tmp" }),
    });
  assert.deepEqual(await resolve("abort"), { action: "abort", value: "/tmp" });
  assert.deepEqual(await resolve("allowed"), { action: "allow" });
  assert.deepEqual(await resolve("session"), { action: "granted", value: "/tmp" });
});

test("path patterns support directory prefixes and globs", () => {
  const root = canonicalizePath(mkdtempSync(join(tmpdir(), "pi-sandbox-policy-")));
  assert.equal(matchesPattern(join(root, "nested", "file.txt"), [root]), true);
  assert.equal(matchesPattern(join(root, "file.pem"), [join(root, "*.pem")]), true);
  assert.equal(matchesPattern(join(root, "file.txt"), [join(root, "*.pem")]), false);
});

test("glob patterns match like the sandbox runtime", () => {
  const root = canonicalizePath(mkdtempSync(join(tmpdir(), "pi-sandbox-glob-")));
  const matches = (path: string, pattern: string) =>
    matchesPattern(join(root, path), [pattern], root);

  // No "/": any depth below the cwd.
  assert.equal(matches("top.pem", "*.pem"), true);
  assert.equal(matches("deep/nested/prod.pem", "*.pem"), true);
  assert.equal(matches(".env.local", ".env.*"), true);
  assert.equal(matches("config/.env.production", ".env.*"), true);
  assert.equal(matches("top.pem.txt", "*.pem"), false);

  // With "/": anchored at the cwd, and `*` does not cross directories.
  assert.equal(matches("secrets/a.json", "secrets/*.json"), true);
  assert.equal(matches("secrets/nested/a.json", "secrets/*.json"), false);
  assert.equal(matches("other/secrets/a.json", "secrets/*.json"), false);
  assert.equal(matches("secrets/nested/a.json", "secrets/**/*.json"), true);
  assert.equal(matches("secrets/nested/a.json", "secrets/**"), true);
});

test("glob patterns match when the cwd is reached through a symlink", () => {
  const real = canonicalizePath(mkdtempSync(join(tmpdir(), "pi-sandbox-glob-real-")));
  const link = join(canonicalizePath(mkdtempSync(join(tmpdir(), "pi-sandbox-glob-link-"))), "p");
  symlinkSync(real, link);
  mkdirSync(join(real, "deep"));

  for (const path of [join(link, "top.pem"), join(link, "deep", "prod.pem")]) {
    assert.equal(matchesPattern(path, ["*.pem"], link), true, path);
    assert.equal(matchesPattern(path, [join(link, "**/*.pem")], link), true, path);
  }
});

test("relative paths resolve against baseCwd, not process.cwd()", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-basecwd-"));
  const project = canonicalizePath(root);

  // "." and relative entries resolve against the passed baseCwd.
  assert.equal(canonicalizePath(".", project), project);
  assert.equal(canonicalizePath("sub/file", project), join(project, "sub", "file"));

  // matchesPattern honors baseCwd for both the path and the pattern.
  assert.equal(matchesPattern(join(project, "f.txt"), ["."], project), true);
  assert.equal(matchesPattern("f.txt", ["."], project), true);
  assert.equal(matchesPattern("f.txt", ["other"], project), false);

  // decideWritePolicy threads baseCwd through to the pattern match.
  assert.equal(decideWritePolicy("f.txt", ["."], [], project), "allow");
  assert.equal(decideWritePolicy("f.txt", [], [], project), "prompt");
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
