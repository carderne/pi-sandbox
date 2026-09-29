import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux") {
  console.log("Native Linux launcher build skipped on this platform.");
} else {
  if (!["x64", "arm64"].includes(process.arch))
    throw new Error(`Unsupported architecture: ${process.arch}`);
  const root = fileURLToPath(new URL("../", import.meta.url));
  const sourceDir = join(root, "vendor/linux-launcher");
  const output = join(
    root,
    "vendor/sandbox-runtime/vendor/seccomp",
    process.arch,
    "sandbox-launcher",
  );
  mkdirSync(dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    execFileSync(
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
        join(sourceDir, "launcher.c"),
        "-o",
        temporary,
      ],
      { stdio: "inherit" },
    );
    chmodSync(temporary, 0o755);
    const sourceHash = createHash("sha256");
    for (const file of ["launcher.c", "relay.h"])
      sourceHash.update(readFileSync(join(sourceDir, file)));
    const metadata = {
      arch: process.arch,
      sourceSha256: sourceHash.digest("hex"),
      binarySha256: createHash("sha256").update(readFileSync(temporary)).digest("hex"),
    };
    renameSync(temporary, output);
    writeFileSync(`${output}.build.json`, `${JSON.stringify(metadata, null, 2)}\n`);
    console.log(`Built ${output}`);
  } finally {
    rmSync(temporary, { force: true });
  }
}
