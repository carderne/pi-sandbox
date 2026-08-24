import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";

import { SandboxManager } from "@carderne/sandbox-runtime";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG } from "../src/config.ts";
import { canonicalizePath } from "../src/policy.ts";
import {
  ancestorHasGitMetadataFile,
  buildRuntimeConfig,
  clearGitWorktreePathCache,
  discoverGitWorktreePaths,
  discoverSeparateGitDirPath,
  extractBlockedWritePath,
  initializeSandbox,
  resolveAllowances,
  supportsNodeEnvProxy,
} from "../src/sandbox-runtime.ts";

const NON_GIT_CWD = "/non-git-dir";

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).replace(/\r?\n$/, "");
}

function initializeRepository(repoDir: string): void {
  mkdirSync(repoDir, { recursive: true });
  runGit(repoDir, ["init", "--quiet"]);
  runGit(repoDir, [
    "-c",
    "user.name=Pi Sandbox Tests",
    "-c",
    "user.email=pi-sandbox@example.invalid",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "Initial commit",
  ]);
}

function createLinkedWorktree(tempDir: string): { mainRepo: string; worktreeDir: string } {
  const mainRepo = join(tempDir, "main-repo");
  const worktreeDir = join(tempDir, "linked-worktree");
  initializeRepository(mainRepo);
  runGit(mainRepo, ["worktree", "add", "--quiet", "-b", "test-worktree", worktreeDir]);
  return { mainRepo, worktreeDir };
}

function createSeparateGitDirCheckout(tempDir: string): {
  gitDir: string;
  worktreeDir: string;
} {
  const gitDir = join(tempDir, "separate-git-dir");
  const worktreeDir = join(tempDir, "separate-worktree");
  runGit(tempDir, ["init", "--quiet", `--separate-git-dir=${gitDir}`, worktreeDir]);
  return { gitDir, worktreeDir };
}

function withEnvironment(overrides: Record<string, string>, callback: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(overrides)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  try {
    callback();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

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

test("ancestorHasGitMetadataFile distinguishes worktrees from regular clones", () => {
  clearGitWorktreePathCache();
  const tempDir = mkdtempSync(join(tmpdir(), "pi-sandbox-ancestor-test-"));
  try {
    const mainRepo = join(tempDir, "main-repo");
    initializeRepository(mainRepo);
    const nestedMainRepoDir = join(mainRepo, "src", "nested");
    mkdirSync(nestedMainRepoDir, { recursive: true });

    assert.equal(ancestorHasGitMetadataFile(mainRepo), false);
    assert.equal(ancestorHasGitMetadataFile(nestedMainRepoDir), false);

    const { worktreeDir } = createLinkedWorktree(tempDir);
    const nestedWorktreeDir = join(worktreeDir, "src", "nested");
    mkdirSync(nestedWorktreeDir, { recursive: true });
    assert.equal(ancestorHasGitMetadataFile(worktreeDir), true);
    assert.equal(ancestorHasGitMetadataFile(nestedWorktreeDir), true);

    const forgedWorktree = join(tempDir, "forged-worktree");
    mkdirSync(forgedWorktree, { recursive: true });
    writeFileSync(join(forgedWorktree, ".git"), "gitdir: /tmp/does-not-matter\n");
    assert.equal(ancestorHasGitMetadataFile(forgedWorktree), true);

    const symlinkForgedWorktree = join(tempDir, "symlink-forged-worktree");
    mkdirSync(symlinkForgedWorktree, { recursive: true });
    symlinkSync(join(worktreeDir, ".git"), join(symlinkForgedWorktree, ".git"));
    assert.equal(ancestorHasGitMetadataFile(symlinkForgedWorktree), false);

    const plainDir = join(tempDir, "plain-dir");
    mkdirSync(plainDir, { recursive: true });
    assert.equal(ancestorHasGitMetadataFile(plainDir), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    clearGitWorktreePathCache();
  }
});

test("discoverGitWorktreePaths caches git discovery per cwd and returns independent array copies", () => {
  clearGitWorktreePathCache();
  const tempDir = mkdtempSync(join(tmpdir(), "pi-sandbox-git-cache-test-"));
  try {
    const { worktreeDir } = createLinkedWorktree(tempDir);
    const first = discoverGitWorktreePaths(worktreeDir);
    assert.ok(first.length > 0);

    const second = discoverGitWorktreePaths(worktreeDir);
    assert.deepEqual(second, first);
    assert.notEqual(second, first);

    first.push("/corrupted-entry");
    const third = discoverGitWorktreePaths(worktreeDir);
    assert.deepEqual(third, second);
    assert.equal(third.includes("/corrupted-entry"), false);

    clearGitWorktreePathCache();
    const fourth = discoverGitWorktreePaths(worktreeDir);
    assert.deepEqual(fourth, second);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    clearGitWorktreePathCache();
  }
});

test("initializeSandbox discards cached git discovery before building config", async () => {
  clearGitWorktreePathCache();
  const tempDir = mkdtempSync(join(tmpdir(), "pi-sandbox-git-init-cache-test-"));
  try {
    const { worktreeDir } = createLinkedWorktree(tempDir);
    const first = discoverGitWorktreePaths(worktreeDir);
    assert.ok(first.length > 0);

    writeFileSync(join(worktreeDir, ".git"), "not a gitdir line\n");
    assert.deepEqual(discoverGitWorktreePaths(worktreeDir), first);

    try {
      await initializeSandbox(
        { ...DEFAULT_CONFIG, autoAllowGitMetadata: false },
        undefined,
        worktreeDir,
      );
    } catch {
      // SandboxManager.initialize may fail without OS sandbox deps; cache must still be cleared first.
    }

    assert.deepEqual(discoverGitWorktreePaths(worktreeDir), []);
  } finally {
    try {
      await SandboxManager.reset();
    } catch {
      // Ignore cleanup errors when initialize never succeeded.
    }
    rmSync(tempDir, { recursive: true, force: true });
    clearGitWorktreePathCache();
  }
});

test("discoverGitWorktreePaths discovers linked worktree metadata from nested directories", () => {
  clearGitWorktreePathCache();
  const tempDir = mkdtempSync(join(tmpdir(), "pi-sandbox-worktree-test-"));
  try {
    const { mainRepo, worktreeDir } = createLinkedWorktree(tempDir);
    const nestedWorktreeDir = join(worktreeDir, "src", "nested");
    mkdirSync(nestedWorktreeDir, { recursive: true });

    const worktreeGitDir = runGit(worktreeDir, ["rev-parse", "--absolute-git-dir"]);
    const commonGitDir = resolve(
      worktreeDir,
      runGit(worktreeDir, ["rev-parse", "--git-common-dir"]),
    );
    const expected = [worktreeGitDir, commonGitDir];

    assert.deepEqual(discoverGitWorktreePaths(worktreeDir), expected);
    assert.deepEqual(discoverGitWorktreePaths(nestedWorktreeDir), expected);

    const unrelatedRepo = join(tempDir, "unrelated-repo");
    initializeRepository(unrelatedRepo);
    withEnvironment({ GIT_COMMON_DIR: join(unrelatedRepo, ".git") }, () => {
      assert.deepEqual(discoverGitWorktreePaths(nestedWorktreeDir), expected);
    });
    const unrelatedWorktree = join(tempDir, "unrelated-worktree");
    runGit(unrelatedRepo, [
      "worktree",
      "add",
      "--quiet",
      "-b",
      "unrelated-worktree",
      unrelatedWorktree,
    ]);
    const unrelatedGitDir = runGit(unrelatedWorktree, ["rev-parse", "--absolute-git-dir"]);
    withEnvironment({ GIT_DIR: unrelatedGitDir }, () => {
      assert.deepEqual(discoverGitWorktreePaths(worktreeDir), expected);
    });

    const forgedWorktree = join(tempDir, "forged-worktree");
    mkdirSync(forgedWorktree, { recursive: true });
    writeFileSync(join(forgedWorktree, ".git"), `gitdir: ${worktreeGitDir}\n`);
    assert.deepEqual(discoverGitWorktreePaths(forgedWorktree), []);

    const symlinkForgedWorktree = join(tempDir, "symlink-forged-worktree");
    mkdirSync(symlinkForgedWorktree, { recursive: true });
    symlinkSync(join(worktreeDir, ".git"), join(symlinkForgedWorktree, ".git"));
    assert.deepEqual(discoverGitWorktreePaths(symlinkForgedWorktree), []);

    writeFileSync(
      join(worktreeDir, ".git"),
      `gitdir: ${relative(worktreeDir, worktreeGitDir)}\r\n`,
    );
    clearGitWorktreePathCache();
    assert.deepEqual(discoverGitWorktreePaths(nestedWorktreeDir), expected);

    const nestedMainRepoDir = join(mainRepo, "src", "nested");
    mkdirSync(nestedMainRepoDir, { recursive: true });
    assert.deepEqual(discoverGitWorktreePaths(nestedMainRepoDir), []);

    const innerRepo = join(worktreeDir, "vendor", "inner-repo");
    initializeRepository(innerRepo);
    const nestedInnerRepoDir = join(innerRepo, "src", "nested");
    mkdirSync(nestedInnerRepoDir, { recursive: true });
    assert.deepEqual(discoverGitWorktreePaths(nestedInnerRepoDir), []);
    withEnvironment({ GIT_WORK_TREE: worktreeDir }, () => {
      assert.deepEqual(discoverGitWorktreePaths(nestedInnerRepoDir), []);
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    clearGitWorktreePathCache();
  }
});

test("discoverGitWorktreePaths identifies separate git dirs without auto-allowing them", () => {
  clearGitWorktreePathCache();
  const tempDir = mkdtempSync(join(tmpdir(), "pi-sandbox-separate-git-dir-test-"));
  try {
    const { gitDir, worktreeDir } = createSeparateGitDirCheckout(tempDir);
    const nestedWorktreeDir = join(worktreeDir, "src", "nested");
    mkdirSync(nestedWorktreeDir, { recursive: true });

    const restrictiveConfig = {
      ...DEFAULT_CONFIG,
      filesystem: {
        ...DEFAULT_CONFIG.filesystem!,
        allowRead: [],
        allowWrite: [],
      },
    };
    const discoveredGitDir = discoverSeparateGitDirPath(nestedWorktreeDir);
    assert.equal(discoveredGitDir, canonicalizePath(gitDir));
    assert.deepEqual(discoverGitWorktreePaths(nestedWorktreeDir), []);

    const automatic = resolveAllowances(restrictiveConfig, undefined, nestedWorktreeDir);
    assert.equal(automatic.writePaths.includes(gitDir), false);
    assert.equal(automatic.readPaths.includes(gitDir), false);

    const explicitlyAllowed = resolveAllowances(
      {
        ...restrictiveConfig,
        filesystem: { ...restrictiveConfig.filesystem, allowWrite: [gitDir] },
      },
      undefined,
      nestedWorktreeDir,
    );
    assert.equal(explicitlyAllowed.writePaths.includes(gitDir), true);
    assert.equal(explicitlyAllowed.readPaths.includes(gitDir), true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    clearGitWorktreePathCache();
  }
});

test("discoverGitWorktreePaths discovers submodule metadata from nested directories", () => {
  clearGitWorktreePathCache();
  const tempDir = mkdtempSync(join(tmpdir(), "pi-sandbox-submodule-test-"));
  try {
    const submoduleSource = join(tempDir, "submodule-source");
    const mainRepo = join(tempDir, "main-repo");
    initializeRepository(submoduleSource);
    initializeRepository(mainRepo);
    runGit(mainRepo, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "--quiet",
      submoduleSource,
      "modules/child",
    ]);

    const submoduleDir = join(mainRepo, "modules", "child");
    const nestedSubmoduleDir = join(submoduleDir, "src", "nested");
    mkdirSync(nestedSubmoduleDir, { recursive: true });
    const gitDir = runGit(submoduleDir, ["rev-parse", "--absolute-git-dir"]);
    const commonGitDir = resolve(
      submoduleDir,
      runGit(submoduleDir, ["rev-parse", "--git-common-dir"]),
    );

    assert.deepEqual(discoverGitWorktreePaths(nestedSubmoduleDir), [
      ...new Set([gitDir, commonGitDir]),
    ]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    clearGitWorktreePathCache();
  }
});

test("discoverGitWorktreePaths rejects metadata paths that git does not validate", () => {
  clearGitWorktreePathCache();
  const tempDir = mkdtempSync(join(tmpdir(), "pi-sandbox-invalid-git-test-"));
  try {
    const arbitraryTarget = join(tempDir, "arbitrary-target");
    const invalidCheckout = join(tempDir, "invalid-checkout");
    mkdirSync(arbitraryTarget, { recursive: true });
    mkdirSync(invalidCheckout, { recursive: true });
    writeFileSync(join(invalidCheckout, ".git"), `gitdir: ${arbitraryTarget}\n`);
    assert.deepEqual(discoverGitWorktreePaths(invalidCheckout), []);

    const validTarget = join(tempDir, "valid-target");
    const forgedCheckout = join(tempDir, "forged-checkout");
    initializeRepository(validTarget);
    mkdirSync(forgedCheckout, { recursive: true });
    writeFileSync(join(forgedCheckout, ".git"), `gitdir: ${join(validTarget, ".git")}\n`);
    assert.deepEqual(discoverGitWorktreePaths(forgedCheckout), []);
    withEnvironment(
      {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.worktree",
        GIT_CONFIG_VALUE_0: forgedCheckout,
      },
      () => {
        assert.deepEqual(discoverGitWorktreePaths(forgedCheckout), []);
      },
    );

    const staleCheckout = join(tempDir, "stale-checkout");
    mkdirSync(staleCheckout, { recursive: true });
    writeFileSync(join(staleCheckout, ".git"), `gitdir: ${join(tempDir, "missing")}\n`);
    assert.deepEqual(discoverGitWorktreePaths(staleCheckout), []);

    const malformedCheckout = join(tempDir, "malformed-checkout");
    mkdirSync(malformedCheckout, { recursive: true });
    writeFileSync(join(malformedCheckout, ".git"), "not a gitdir line\n");
    assert.deepEqual(discoverGitWorktreePaths(malformedCheckout), []);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    clearGitWorktreePathCache();
  }
});

test("resolveAllowances includes worktree metadata discovered from a nested directory", () => {
  clearGitWorktreePathCache();
  const tempDir = mkdtempSync(join(tmpdir(), "pi-sandbox-allowance-test-"));
  try {
    const { worktreeDir } = createLinkedWorktree(tempDir);
    const nestedWorktreeDir = join(worktreeDir, "src", "nested");
    mkdirSync(nestedWorktreeDir, { recursive: true });
    const gitPaths = discoverGitWorktreePaths(nestedWorktreeDir);
    assert.equal(gitPaths.length, 2);

    const effective = resolveAllowances(DEFAULT_CONFIG, undefined, nestedWorktreeDir);
    for (const gitPath of gitPaths) {
      assert.equal(effective.writePaths.includes(gitPath), true);
      assert.equal(effective.readPaths.includes(gitPath), true);
    }

    const disabled = resolveAllowances(
      {
        ...DEFAULT_CONFIG,
        autoAllowGitMetadata: false,
        filesystem: {
          ...DEFAULT_CONFIG.filesystem!,
          allowWrite: ["/explicit-write"],
        },
      },
      {
        domains: [],
        readPaths: [],
        writePaths: ["/session-write"],
      },
      nestedWorktreeDir,
    );
    for (const gitPath of gitPaths) {
      assert.equal(disabled.writePaths.includes(gitPath), false);
      assert.equal(disabled.readPaths.includes(gitPath), false);
    }
    assert.equal(disabled.writePaths.includes("/explicit-write"), true);
    assert.equal(disabled.writePaths.includes("/session-write"), true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    clearGitWorktreePathCache();
  }
});
