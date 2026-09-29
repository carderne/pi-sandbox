import { spawnSync } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import assert from "node:assert/strict";

// Explicit opt-in: missing native build/test tools must FAIL this suite, not
// silently skip its security assertions on a release/integration runner.
test(
  "capability-free Linux supervisor",
  {
    skip: process.env.PI_SANDBOX_NATIVE_TEST !== "1",
    timeout: 30_000,
  },
  async (t) => {
    assert.equal(process.platform, "linux");
    const root = mkdtempSync(join(tmpdir(), "pi-sandbox-native-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const binary = join(root, "launcher");
    const source = fileURLToPath(new URL("../vendor/linux-launcher/launcher.c", import.meta.url));
    const compile = spawnSync(
      "gcc",
      [
        "-std=c11",
        "-static",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-fstack-protector-strong",
        "-D_FORTIFY_SOURCE=3",
        "-Wl,-z,noexecstack",
        source,
        "-o",
        binary,
      ],
      { encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(compile.status, 0, `${compile.error ?? ""}\n${compile.stderr}`);
    const work = join(root, "work");
    mkdirSync(work);
    const denied = join(work, "denied");
    mkdirSync(denied);
    const secret = join(denied, "sentinel");
    writeFileSync(secret, "unchanged");
    const args = [
      "--die-with-parent",
      "--new-session",
      "--unshare-user",
      "--unshare-net",
      "--unshare-pid",
      "--cap-drop",
      "ALL",
      "--ro-bind",
      "/",
      "/",
      "--bind",
      work,
      work,
      "--ro-bind",
      denied,
      denied,
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--as-pid-1",
    ];
    const run = (...command: string[]) =>
      spawnSync("bwrap", [...args, "--", binary, "--", ...command], {
        encoding: "utf8",
        timeout: 5_000,
        cwd: work,
      });
    const succeeds = (...command: string[]) => {
      const result = run(...command);
      assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
      return result.stdout;
    };

    await t.test("refuses standalone use outside Bubblewrap PID 1", () => {
      const result = spawnSync(binary, ["--", "/bin/true"], { encoding: "utf8" });
      assert.equal(result.status, 125);
      assert.match(result.stderr, /requires Bubblewrap --as-pid-1/);
    });
    await t.test("missing, non-socket and dead bridges refuse to start the workload", () => {
      const dead = join(work, "dead.sock");
      const bind = spawnSync(
        "python3",
        [
          "-c",
          "import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.close()",
          dead,
        ],
        { encoding: "utf8" },
      );
      assert.equal(bind.status, 0, bind.stderr);
      for (const socket of [join(work, "missing.sock"), secret, dead]) {
        const result = spawnSync(
          "bwrap",
          [
            ...args,
            "--",
            binary,
            "--http-socket",
            socket,
            "--socks-socket",
            socket,
            "--",
            "/bin/echo",
            "MUST NOT RUN",
          ],
          { encoding: "utf8", timeout: 5_000 },
        );
        assert.equal(result.status, 125, result.stderr);
        assert.equal(result.stdout, "");
      }
    });
    await t.test("Bash, pipelines, process substitution, fork and exit status work", () => {
      assert.equal(succeeds("/bin/bash", "-c", "cat <(printf hello) | tr a-z A-Z"), "HELLO");
      assert.equal(run("/bin/bash", "-c", "exit 37").status, 37);
      assert.equal(run("/bin/bash", "-c", "kill -TERM $$").status, 143);
    });
    await t.test("mount policy still denies writes and allows the selected work directory", () => {
      succeeds("/bin/bash", "-c", "printf allowed > allowed");
      assert.equal(readFileSync(join(work, "allowed"), "utf8"), "allowed");
      assert.notEqual(run("/bin/bash", "-c", "printf forbidden > denied/sentinel").status, 0);
      assert.equal(readFileSync(secret, "utf8"), "unchanged");
    });
    await t.test("workload has no capabilities, cannot inspect PID 1, or bypass the filter", () => {
      const probe = fileURLToPath(new URL("fixtures/linux-launcher-probe.py", import.meta.url));
      assert.match(succeeds("/usr/bin/python3", probe), /ALL CHECKS PASSED/);
    });
    await t.test("inherited non-stdio descriptors are closed before workload exec", () => {
      const fixture = join(root, "fds");
      const fixtureSource = fileURLToPath(
        new URL("fixtures/linux-launcher-fds.c", import.meta.url),
      );
      const build = spawnSync("gcc", ["-static", fixtureSource, "-o", fixture], {
        encoding: "utf8",
      });
      assert.equal(build.status, 0, build.stderr);
      const fd = openSync(root, "r");
      try {
        const options = {
          encoding: "utf8" as const,
          timeout: 5_000,
          stdio: ["ignore", "pipe", "pipe", fd] as ["ignore", "pipe", "pipe", number],
        };
        const control = spawnSync("bwrap", [...args, "--", fixture], options);
        assert.equal(control.status, 1);
        assert.match(control.stderr, /unexpected inherited fd: 3/);
        const filtered = spawnSync("bwrap", [...args, "--", binary, "--", fixture], options);
        assert.equal(filtered.status, 0, filtered.stderr);
      } finally {
        closeSync(fd);
      }
    });
    await t.test("PID 1 forwards termination and tears down stragglers", () => {
      assert.equal(run("/bin/bash", "-c", "sleep 60 & kill -TERM 1; wait").status, 143);
      const start = Date.now();
      assert.equal(run("/bin/bash", "-c", "sleep 60 & exit 0").status, 0);
      assert.ok(Date.now() - start < 3_000, "orphan must not retain stdio for its lifetime");
    });
    await t.test("x86 alternative syscall ABIs fail closed", () => {
      if (process.arch !== "x64") return;
      for (const code of [
        // x32 getpid (same audit arch, distinct syscall number space).
        '__asm__ volatile("syscall" : : "a"(0x40000027UL) : "rcx", "r11", "memory");',
        // i386 getpid through int 0x80 (distinct audit arch).
        '__asm__ volatile("int $0x80" : : "a"(20) : "memory");',
      ]) {
        const src = join(root, "abi.c");
        const executable = join(root, "abi");
        writeFileSync(src, `int main(void) { ${code} return 0; }\n`);
        const build = spawnSync("gcc", [src, "-o", executable], { encoding: "utf8" });
        assert.equal(build.status, 0, build.stderr);
        assert.equal(run(executable).status, 159, "unsupported ABI must terminate with SIGSYS");
      }
    });
  },
);
