import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { DEFAULT_CONFIG } from "../src/config.ts";
import { canonicalizePath } from "../src/policy.ts";
import {
  buildRuntimeConfig,
  discoverGitWorktreePaths,
  extractBlockedWritePath,
  resolveAllowances,
  supportsNodeEnvProxy,
} from "../src/sandbox-runtime.ts";

const NON_GIT_CWD = "/non-git-dir";

test("buildRuntimeConfig adds session allowances without mutating config", () => {
  const runtime = buildRuntimeConfig(
    DEFAULT_CONFIG,
    {
      domains: ["example.com"],
      readPaths: ["/read"],
      writePaths: ["/write"],
    },
    NON_GIT_CWD,
  );
  assert.equal(runtime.network?.allowedDomains?.includes("example.com"), true);
  assert.equal(runtime.filesystem?.allowRead?.includes("/read"), true);
  assert.equal(runtime.filesystem?.allowRead?.includes("/write"), true);
  assert.equal(runtime.filesystem?.allowWrite?.includes("/write"), true);
  assert.equal(DEFAULT_CONFIG.network?.allowedDomains?.includes("example.com"), false);
});

test("buildRuntimeConfig canonicalizes non-glob filesystem paths", () => {
  const runtime = buildRuntimeConfig(
    {
      ...DEFAULT_CONFIG,
      filesystem: {
        ...DEFAULT_CONFIG.filesystem!,
        denyRead: ["/tmp"],
        allowRead: [],
        allowWrite: ["/tmp"],
        denyWrite: ["*.key"],
      },
    },
    undefined,
    NON_GIT_CWD,
  );

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
  const effective = resolveAllowances(
    config,
    {
      domains: [],
      readPaths: [],
      writePaths: ["/session-write"],
    },
    NON_GIT_CWD,
  );

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

test("discoverGitWorktreePaths discovers external worktree and common git directories", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-sandbox-worktree-test-"));
  try {
    const mainRepo = join(tempDir, "main-repo");
    const mainGit = join(mainRepo, ".git");
    const worktreeGitDir = join(mainGit, "worktrees", "feature-branch");
    const worktreeDir = join(tempDir, "worktrees", "feature-branch");

    mkdirSync(worktreeGitDir, { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });

    writeFileSync(join(worktreeGitDir, "commondir"), "../..\n");
    writeFileSync(join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);

    const discovered = discoverGitWorktreePaths(worktreeDir);
    assert.deepEqual(discovered, [worktreeGitDir, mainGit]);

    // Relative gitdir path (common in real worktrees)
    const relWorktreeGitDir = join(mainGit, "worktrees", "rel-branch");
    const relWorktreeDir = join(tempDir, "worktrees", "rel-branch");
    mkdirSync(relWorktreeGitDir, { recursive: true });
    mkdirSync(relWorktreeDir, { recursive: true });
    writeFileSync(join(relWorktreeGitDir, "commondir"), "../..\n");
    writeFileSync(
      join(relWorktreeDir, ".git"),
      `gitdir: ../../main-repo/.git/worktrees/rel-branch\n`,
    );
    assert.deepEqual(discoverGitWorktreePaths(relWorktreeDir), [relWorktreeGitDir, mainGit]);

    // Worktree with absolute commondir and trailing whitespace / CRLF in .git
    const absWorktreeGitDir = join(mainGit, "worktrees", "abs-branch");
    const absWorktreeDir = join(tempDir, "worktrees", "abs-branch");
    mkdirSync(absWorktreeGitDir, { recursive: true });
    mkdirSync(absWorktreeDir, { recursive: true });
    writeFileSync(join(absWorktreeGitDir, "commondir"), `${mainGit}\n`);
    writeFileSync(join(absWorktreeDir, ".git"), `gitdir: ${absWorktreeGitDir}  \r\n`);
    assert.deepEqual(discoverGitWorktreePaths(absWorktreeDir), [absWorktreeGitDir, mainGit]);

    // Worktree without commondir returns only worktreeGitDir without escalating to parents
    const noCommondirGitDir = join(tempDir, "isolated-gitdir");
    const noCommondirWorktreeDir = join(tempDir, "isolated-worktree");
    mkdirSync(noCommondirGitDir, { recursive: true });
    mkdirSync(noCommondirWorktreeDir, { recursive: true });
    writeFileSync(join(noCommondirWorktreeDir, ".git"), `gitdir: ${noCommondirGitDir}\n`);
    assert.deepEqual(discoverGitWorktreePaths(noCommondirWorktreeDir), [noCommondirGitDir]);

    // Non-existent gitdir pointer returns empty
    const staleWorktreeDir = join(tempDir, "stale-worktree");
    mkdirSync(staleWorktreeDir, { recursive: true });
    writeFileSync(join(staleWorktreeDir, ".git"), `gitdir: ${join(tempDir, "does-not-exist")}\n`);
    assert.deepEqual(discoverGitWorktreePaths(staleWorktreeDir), []);

    // Malformed .git file returns empty
    const malformedDir = join(tempDir, "malformed-worktree");
    mkdirSync(malformedDir, { recursive: true });
    writeFileSync(join(malformedDir, ".git"), "not a gitdir line\n");
    assert.deepEqual(discoverGitWorktreePaths(malformedDir), []);

    // Regular clone with .git directory returns empty
    assert.deepEqual(discoverGitWorktreePaths(mainRepo), []);

    // Non-git directory returns empty
    const nonGitDir = join(tempDir, "plain-dir");
    mkdirSync(nonGitDir, { recursive: true });
    assert.deepEqual(discoverGitWorktreePaths(nonGitDir), []);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolveAllowances includes discovered git worktree paths", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-sandbox-allowance-test-"));
  try {
    const mainGit = join(tempDir, "main-repo", ".git");
    const worktreeGitDir = join(mainGit, "worktrees", "task");
    const worktreeDir = join(tempDir, "task-worktree");

    mkdirSync(worktreeGitDir, { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });

    writeFileSync(join(worktreeGitDir, "commondir"), "../..\n");
    writeFileSync(join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);

    const effective = resolveAllowances(DEFAULT_CONFIG, undefined, worktreeDir);
    assert.equal(effective.writePaths.includes(worktreeGitDir), true);
    assert.equal(effective.writePaths.includes(mainGit), true);
    assert.equal(effective.readPaths.includes(worktreeGitDir), true);
    assert.equal(effective.readPaths.includes(mainGit), true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
