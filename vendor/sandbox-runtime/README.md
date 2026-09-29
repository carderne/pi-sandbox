# Controlled sandbox-runtime source vendor

Upstream: https://github.com/carderne/sandbox-runtime

- Version: `@carderne/sandbox-runtime` **0.0.72**
- Commit: `dea3f1a241c189f0f954ac989dfc2c2a95b64c39`
- License: Apache-2.0; see [LICENSE](LICENSE).
- `upstream-package.json` preserves upstream metadata (it is not an install manifest).
- `src/` was copied from that commit, not from a global npm installation.

Pi loads this source through `src/runtime.ts` in the enclosing fork. Pi's jiti
loader and the tsx test runner resolve the source's `.js` imports to `.ts`.
The enclosing package declares and locks the upstream runtime dependencies.
There is no dependency on a separately installed `@carderne/sandbox-runtime`.

## Local changes

- `src/sandbox/linux-sandbox-utils.ts`: use the fork's native capability-free
  supervisor as Bubblewrap PID 1 when Unix sockets are restricted. Retain the
  existing filesystem argument generator, host bridges, HTTP/SOCKS policy and
  proxy environment. Mount infrastructure after the filesystem policy and
  read-only. Missing helpers, weak proc mode, and custom helper overrides fail
  closed; no global-helper search or warning-only Unix-filter fallback.
- `src/sandbox/linux-launcher.ts`: resolve only our architecture-specific
  artifact and validate its source and binary hashes before use.
- `src/sandbox/http-proxy.ts`: annotate the CONNECT head as Buffer for Node 24
  type compatibility (no proxy behavior change).
- `src/utils/which.ts`: describe optional Bun.which locally rather than requiring
  Bun's global types in a Node/Pi project.

The upstream `generate-seccomp-filter.ts` is retained for provenance but is not
imported by the Linux launcher path. No upstream apply-seccomp binary is shipped
or selected by this fork. The explicit `allowAllUnixSockets=true` legacy opt-out
retains upstream shell/socat behavior; the repair does not use that opt-out.

## Native artifact

From the enclosing repo root:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build:sandbox
```

This builds `vendor/seccomp/<arch>/sandbox-launcher` and its hash manifest from
`../linux-launcher/{launcher.c,relay.h}`. Generated artifacts are ignored by Git.
Rebuild after native source changes. A missing or stale artifact blocks startup
instead of falling back to another binary or an unsandboxed command.

This checkout is intended for local-folder Pi loading. Do not publish a generic
npm release from it without arranging and validating native artifacts for each
supported target. The local x86_64 build is not an ARM64 binary.
