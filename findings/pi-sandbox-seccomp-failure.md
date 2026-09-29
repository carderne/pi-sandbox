# Findings: Linux Bash sandbox failure and capability-free repair

## 1. Outcome

**Resolved for the tested Ubuntu x86_64 host.** The repaired extension executes
Bash through the sandbox without changing host security policy or enabling
unrestricted Unix sockets. The implementation is committed and pushed to
[`Cogz-amorphous/pi-sandbox`](https://github.com/Cogz-amorphous/pi-sandbox), branch
`fix/linux-capability-free-sandbox`, at `e223886`.

The exact original smoke command now succeeds through Pi's actual extension
loader and registered Bash tool, using the existing global sandbox configuration
from `/home/pi-dev/projects/personal/pi-sandbox-test`:

```sh
echo 'basic bash command OK'
```

Output:

```text
basic bash command OK
```

After the automated and loader-based checks, the user independently tested the
extension in `pi-sandbox-test` and confirmed that the fix was applied. That
confirmation establishes successful use in the user's Pi session; it is not a
claim that the user independently repeated every security regression test below.

This report records the investigation, implementation, and validation already
performed. Creating this document did not rerun those tests or change the fix.

## 2. Environment and constraints

| Component | Investigated/tested value |
| --- | --- |
| OS | Ubuntu 26.04.1 LTS |
| Kernel | `7.0.0-34-generic` |
| Architecture | x86_64 |
| Account | Unprivileged `pi-dev` |
| Bubblewrap | 0.11.1 |
| Original pi-sandbox baseline | `c3b2f73` |
| Runtime baseline | `@carderne/sandbox-runtime` 0.0.72 |
| Runtime source commit | `dea3f1a241c189f0f954ac989dfc2c2a95b64c39` |
| Node used locally | 22.22.1 |
| pnpm used locally | 10.34.3, invoked through Corepack |
| Native compiler | GCC 15.2, with static libc available |
| Repair checkout | `/home/pi-dev/projects/personal/pi-sandbox-fix` |

Required properties:

- Keep filesystem read/write restrictions and network allowlisting.
- Keep `network.allowAllUnixSockets=false`.
- Prevent workload access to host SSH-agent, D-Bus, and keyring sockets.
- Give the workload no capabilities.
- Never silently fall back to unsandboxed execution.
- Do not use sudo, alter AppArmor or sysctls, grant capabilities, replace
  Bubblewrap with a privileged installation, or otherwise change host security.
- Do not patch packages under `~/.pi/agent/npm/node_modules`.

The repair meets these constraints on the tested host. Credential services were
not contacted during testing; harmless private Unix-socket fixtures were used
instead.

## 3. Original failure

Even an ordinary Bash command failed before its workload could execute:

```text
apply-seccomp: write /proc/self/setgroups (nested userns is capability-restricted; caller must provide CAP_SYS_ADMIN): Permission denied
```

The relevant execution chain was:

```text
Pi Bash tool / user_bash
  -> createSandboxedBashOps
  -> sandbox manager wrapWithSandbox
  -> Bubblewrap: filesystem + network + user + PID isolation; drop capabilities
      -> setup shells and in-sandbox socat relays
      -> apply-seccomp
          -> nested user/PID/mount setup and fresh procfs
          -> filtered workload
```

The runtime's `apply-seccomp` helper did more than install a syscall filter. It
created nested namespaces and remounted `/proc` to separate the filtered workload
from the unfiltered setup processes and proxy relays.

On this host, Ubuntu's `bwrap//&unpriv_bwrap` AppArmor stack restricted capabilities
in the nested user namespace. The helper failed at `/proc/self/setgroups` during
that setup. Installing seccomp under `no_new_privs` does not itself require
`CAP_SYS_ADMIN`; the failing requirement came from the helper's namespace setup.

This was therefore **not** an error in the submitted `echo` command, a missing
shell, or merely a helper-file visibility problem.

## 4. Why deleting the failing setup would be unsafe

The nested PID/mount arrangement was a security boundary, not incidental setup.
It hid unfiltered shells and socat processes from the workload. Simply removing
it while retaining those helpers would expose processes that could create Unix
sockets on the workload's behalf if compromised.

The review covered multiple routes to such a compromise:

| Interface | Concern | Replacement protection |
| --- | --- | --- |
| `ptrace` | Control an unfiltered process | Workload syscall denial, plus helper non-dumpability |
| `process_vm_readv` / `process_vm_writev` | Read or overwrite helper memory | Workload syscall denial |
| `pidfd_getfd` | Duplicate a helper's privileged socket/control FD | Workload syscall denial |
| `/proc/<pid>/mem` | Memory access without a `ptrace` syscall | Non-dumpability of every unfiltered helper |
| `/proc/<pid>/fd` | Inspect or obtain helper descriptors | Non-dumpability and worker FD cleanup |
| `/proc/<pid>/{root,cwd,ns}` | Obtain helper filesystem/namespace handles | Non-dumpability, plus namespace/mount syscall restrictions |
| `io_uring` | Alternate kernel operation paths and inherited ring access | Deny all three entry points; close inherited non-stdio FDs |

Blocking `ptrace` alone does not block opening `/proc/<pid>/mem`. Likewise,
setting non-dumpability before executing a stock helper is not sufficient:
`exec` can reset dumpability. The replacement unfiltered helpers therefore must
remain native, fork-only processes that never exec.

### Additional finding: Unix datagram socketpair bypass

The installed filter blocked `socket(AF_UNIX, ...)` but still allowed
`socketpair(AF_UNIX, SOCK_DGRAM, ...)`. A harmless standalone positive-control
experiment demonstrated sending a datagram from such a pair to a private
external Unix-socket fixture.

The repair consequently blocks both Unix `socket` and `socketpair` creation,
including arguments with misleading high bits. Blocking socketpairs is a
stricter compatibility choice than the old filter; IPC-dependent applications
may be affected.

## 5. Selected architecture

Keep Bubblewrap as the trusted namespace/mount setup component. Replace the
in-sandbox setup shells, socat relays, and nested `apply-seccomp` path with a
capability-free native supervisor and native relays:

```text
Host, outside the sandbox
  Pi / Node HTTP and SOCKS policy proxies
  host socat Unix-socket bridges
       ^
       | approved, pinned bridge endpoints only
       |
Bubblewrap: filesystem + user + PID + network namespaces; fresh /proc
            --cap-drop ALL --as-pid-1
  native PID 1: non-dumpable supervisor and reaper
    native relay listener: non-dumpable, never execs
      native per-connection byte pumps: non-dumpable, never exec
    worker: close infrastructure FDs -> hardened seccomp -> shell -> command
```

### Supervisor and workload boundary

The supervisor:

1. Requires PID 1 and empty effective, permitted, inheritable, and bounding
   capability sets.
2. Sets `no_new_privs` and `PR_SET_DUMPABLE=0`.
3. Closes inherited descriptors above stdio using `close_range`.
4. Pins bridge socket inodes, prepares loopback listeners, and checks bridge
   connectivity before starting the workload.
5. Forks the relay and workload without creating any further namespaces.
6. Installs the worker's seccomp filter before executing the selected shell.
7. Forwards signals, reaps children, and preserves workload exit status.
8. Exits when the workload ends; PID namespace teardown kills remaining members.
   Unexpected relay-process exit terminates the sandbox with status 125.

The workload filter additionally denies namespace entry/creation and mount
operations. `clone3` returns `ENOSYS` so libc can fall back to filtered `clone`;
ordinary forks and threads remain usable. Alternate syscall ABIs fail closed.

Unlike the old nested-PID layout, native helpers remain visible and signalable.
The workload can cause denial of service by killing them, but this does not
provide a new destination, unfiltered execution, or direct host-network access.

### Native relay behavior

- Fixed sandbox-loopback TCP ports: HTTP 3128 and SOCKS 1080.
- Approved Unix bridge endpoints pinned with `O_PATH` before workload startup.
- Connections follow pinned socket inodes rather than resolving mutable endpoint
  names supplied by the workload.
- Traffic is byte streams only: no `SCM_RIGHTS` descriptor forwarding, command
  execution, or workload-selected Unix destinations.
- Nonblocking partial reads/writes, bidirectional backpressure, and half-close.
- 16 KiB buffers per direction and at most 64 active connection children per
  command.
- No infrastructure descriptors survive into the worker; only caller-provided
  stdin/stdout/stderr are intentionally inherited.

The existing host proxies retain HTTP/SOCKS authentication and domain policy.
The isolated network namespace prevents bypassing them through direct host TCP
connections. Native relays transport bytes; they do not replace policy checks.

### Filesystem and failure behavior

The existing filesystem policy generator is retained. Helper and bridge mounts
are applied read-only after policy mounts so broad read denials cannot hide
required infrastructure. This does not grant general access to the surrounding
home directory.

Requested sandbox initialization failures, including pending initialization,
block both Bash and `user_bash`. Missing/stale native artifacts are fatal rather
than warnings. Cancellation before or during command wrapping does not start a
command, and completed wrapper bookkeeping is released appropriately.

Explicit sandbox opt-outs retain their prior semantics. The legacy
`allowAllUnixSockets=true` path still exists, but was neither enabled nor used
as the repair.

## 6. Source control and artifact selection

The fork now owns its runtime source and native build inputs:

| Path | Responsibility |
| --- | --- |
| [`src/runtime.ts`](../src/runtime.ts) | Routes production imports to the controlled source vendor |
| [`src/extension.ts`](../src/extension.ts) | Fail-closed extension initialization and execution gating |
| [`src/sandbox-runtime.ts`](../src/sandbox-runtime.ts) | Runtime configuration, Bash execution, cancellation, helper read visibility |
| [`vendor/sandbox-runtime/`](../vendor/sandbox-runtime/README.md) | Pinned upstream source, license, provenance, and local integration changes |
| [`linux-sandbox-utils.ts`](../vendor/sandbox-runtime/src/sandbox/linux-sandbox-utils.ts) | Bubblewrap construction and direct native PID 1 selection |
| [`linux-launcher.ts`](../vendor/sandbox-runtime/src/sandbox/linux-launcher.ts) | Bundled-only native artifact resolution and validation |
| [`launcher.c`](../vendor/linux-launcher/launcher.c) | Capability checks, syscall filter, worker launch, signal/reaping lifecycle |
| [`relay.h`](../vendor/linux-launcher/relay.h) | Pinned native byte relays |
| [`scripts/build-sandbox.ts`](../scripts/build-sandbox.ts) | Local static native build and hash manifest generation |

The npm dependency on `@carderne/sandbox-runtime` was removed. Required runtime
dependencies are declared and locked directly. No installed global runtime or
helper is selected as a fallback. Pi's actual jiti loader was tested loading the
vendored TypeScript source, including its upstream `.js` import specifiers.

The native build produces:

```text
vendor/sandbox-runtime/vendor/seccomp/<arch>/sandbox-launcher
vendor/sandbox-runtime/vendor/seccomp/<arch>/sandbox-launcher.build.json
```

The manifest records architecture and SHA-256 hashes of native sources and the
binary. Runtime validation checks readability/executability and those values.
Missing, stale, corrupted, non-executable, or wrong-architecture artifacts fail
closed. These hashes detect mismatched build artifacts; they are not signatures
or protection against a host actor who can rewrite both trusted code and metadata.

Artifacts are Git-ignored and must be built locally. The build is static and uses
compiler warnings as errors, stack protection, fortified libc calls, and a
non-executable stack. It does not require libseccomp development packages.

### Commit sequence

| Commit | Change |
| --- | --- |
| `5694dc6` | Investigation and repair plan |
| `2b658e2` | Fail-closed Bash and user-shell initialization |
| `498709a` | Native supervisor foundation and security probes |
| `65968d5` | Unmodified upstream runtime source snapshot for reviewable provenance |
| `e223886` | Runtime integration, native relays, artifact checks, tests, and documentation |

The final push succeeded. An optional CI build-step change was removed before
the successful push because the existing OAuth credential lacked workflow-edit
scope. Credentials/permissions were not expanded, and the workflow was left
unchanged. Native testing reported here was run explicitly on the affected host,
not inferred from CI.

## 7. Validation evidence

### Automated checks completed before the final push

| Check | Recorded result |
| --- | --- |
| Root TypeScript check | Passed |
| Vendored runtime TypeScript check | Passed |
| Lint and formatting | Passed |
| Ordinary test run | 31 passed, 7 skipped, 0 failed |
| Native supervisor suite | 9 passed, 0 skipped, 0 failed |
| Linux integration suite | 11 passed, 0 skipped, 0 failed |
| `git diff --check` | Passed |

Counts are the test runner's reported totals, including parent/subtest entries
where applicable. The ordinary run skips opt-in Linux and platform-specific
tests; Linux suites were separately enabled and executed as shown above.

### Coverage and controls

| Area | Evidence |
| --- | --- |
| Basic shell behavior | Exact smoke command, pipelines, process substitution, fork, exit status, and shell command prefix |
| Filesystem policy | Allowed work-directory writes; denied fixture reads; denied `.env` writes with original bytes preserved |
| HTTP policy | Allowed hostname succeeds; denied hostname receives 403; 256 KiB response digest matches |
| SOCKS policy | Authenticated allowed request succeeds; denied destination fails |
| Direct networking | Direct access to the host TCP fixture fails without the proxy |
| Unix IPC | Live host-accessible fixture is visible by pathname but new workload Unix sockets/socketpairs are denied |
| Process isolation | PID 1, relay listener, and a live connection child deny tested procfs memory/FD access |
| Syscall enforcement | Inspection/FD-theft, io_uring, namespace/mount, clone flags, Unix argument-width, and alternate-ABI probes |
| Workload state | Effective, permitted, inheritable, bounding, and ambient capability sets all zero; `NoNewPrivs=1`; seccomp filter mode active |
| FD inheritance | Static probe confirms inherited non-stdio descriptors are removed |
| Pinned endpoints | Pathname replacement does not redirect the relay; host positive control reaches the replacement |
| Stream behavior | Both relay ports preserve 1 MiB transfers and half-close behavior |
| Startup failure | Missing, non-socket, and dead bridge fixtures prevent workload startup |
| Lifecycle | Signal forwarding, detached-descendant teardown, relay death, timeout, abort, and subsequent command success |
| Concurrency | Four parallel commands and live allowlist updates retain enforcement |
| Session isolation | Subagent shutdown does not stop the parent's Bash or user shell |
| Pi integration | Actual jiti loader starts extension and executes registered Bash and `user_bash` operations |
| Artifact failures | Missing, stale, damaged, non-executable, and wrong-architecture helper checks fail closed |

Procfs probes include positive controls: the workload can access its own memory,
FD directory, and namespace handles while helper access is denied. Ordinary
IPv4 TCP/UDP creation, a local TCP exchange inside the sandbox network namespace,
threads, and forks also work. These controls distinguish targeted restrictions
from an entirely unusable environment.

Tests use disposable fixtures, not real credential services. They support the
intended isolation properties but do not constitute an exhaustive security audit.

### Clean-checkout and actual-user-config checks

A clean source archive was extracted to a temporary directory without the local
native artifact or `node_modules`. Frozen-lockfile dependency installation,
TypeScript checking, a native rebuild, and all 11 Linux integration test entries
passed there.

The first offline-only dependency installation could not complete because the
package store lacked a tarball. A normal frozen-lockfile installation then
succeeded. This was a cache availability issue, not a sandbox failure; offline
fresh-checkout installation was not established by that attempt.

Separately, the installed Pi loader loaded this checkout's `index.ts` from
`pi-sandbox-test`, using the user's existing global configuration. The smoke
check explicitly verified `network.allowAllUnixSockets` remained false before
executing the exact original command. The user subsequently confirmed successful
operation in their own Pi session.

## 8. Reproduction and maintenance

With the existing host prerequisites available, from the repair checkout:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build:sandbox
corepack pnpm run check
corepack pnpm exec tsc --noEmit -p vendor/sandbox-runtime/tsconfig.json
corepack pnpm run lint
NODE_OPTIONS='--import tsx' corepack pnpm run ci:fmt
corepack pnpm test
corepack pnpm test:linux-launcher
corepack pnpm test:linux-integration
```

The `NODE_OPTIONS` invocation accommodates the formatter's TypeScript config
on the tested Node version. Native tests use existing GCC/static libc,
Bubblewrap, socat, ripgrep, Bash, Python 3, and curl; no host-policy changes are
part of these commands. Dependency installation may require registry access.

Load `/home/pi-dev/projects/personal/pi-sandbox-fix/index.ts` as the extension.
Do not load both this checkout and the npm-published sandbox extension. Rebuild
after native source changes, then reload or restart Pi. Installing
`npm:pi-sandbox` is not how this folder-loaded repair is selected.

Keep `allowAllUnixSockets=false` and `enableWeakerNestedSandbox=false`. Treat the
extension source, dependencies, native artifact, and manifest as trusted code;
keep them outside untrusted workloads' writable paths.

## 9. Alternatives rejected

- **Relax Ubuntu/AppArmor or grant capabilities:** violates the host constraints
  and is unnecessary for installing seccomp itself.
- **Remove nested namespaces but retain unfiltered shells/socat:** exposes
  takeover targets without replacing their isolation boundary.
- **Drop capabilities less aggressively:** undermines filesystem protection
  against remount and related privileged operations.
- **Set `allowAllUnixSockets=true` or run unsandboxed:** bypasses the required
  protection rather than repairing it.
- **Apply the Unix filter to all existing helpers through Bubblewrap:** prevents
  the existing socat relays from creating their required bridge connections.
- **Set non-dumpability then exec stock socat:** does not preserve the required
  non-dumpable state across exec.
- **Remove procfs entirely:** unacceptable general runtime compatibility costs.
- **Replace Bubblewrap wholesale:** much larger scope and no guarantee that a
  replacement receives the host's existing Bubblewrap AppArmor permissions.

## 10. Remaining limits

- Validation is specific to the tested Ubuntu x86_64 host. ARM64 source support
  exists but has not been validated on an ARM64 runner.
- Linux >=5.9 is required for `close_range`. Build prerequisites must already be
  available; missing hardening is not silently worked around.
- Multi-platform npm release packaging remains unvalidated. Generated artifacts
  are not committed, and a local x86_64 build is not an ARM64 release artifact.
- Unix socketpair-dependent programs, debugging/ptrace, io_uring, and nested
  namespace tools are intentionally restricted. General browser or arbitrary
  build-tool compatibility is not promised by the successful Bash tests.
- Fresh sandbox procfs is mandatory. Weak proc mode and custom seccomp helper
  overrides are rejected on the hardened path.
- Optional upstream Linux syscall observation is unsupported on the new path;
  Pi does not enable it. Enforcement does not depend on observation.
- A separate permissive-Yama runner and independent security review remain
  desirable. Host sysctls were not changed to manufacture that test environment.
- Helpers share the workload's PID namespace and can be signaled. Resource
  exhaustion and denial of service are not eliminated by this design.

## 11. References

Local documentation and regression sources:

- [Repair plan and investigation record](../docs/linux-sandbox-repair.md)
- [Native supervisor design](../vendor/linux-launcher/README.md)
- [Vendored runtime provenance](../vendor/sandbox-runtime/README.md)
- [Fail-closed extension tests](../test/fail-closed.test.ts)
- [Native supervisor tests](../test/linux-launcher.test.ts)
- [Syscall/procfs/capability probe](../test/fixtures/linux-launcher-probe.py)
- [Runtime/network integration tests](../test/linux-runtime.test.ts)
- [Pinned relay/stream tests](../test/linux-relay.test.ts)
- [Pi loader integration test](../test/linux-pi-loader.test.ts)
- [Native artifact validation tests](../test/linux-artifact.test.ts)
- [Session isolation tests](../test/session-isolation.test.ts)

Upstream investigation references, not assertions that these changes have been
merged upstream:

- [sandbox-runtime issue #429](https://github.com/anthropics/sandbox-runtime/issues/429): matching AppArmor failure; an unisolated fallback does not meet this repair's constraints.
- [PR #183](https://github.com/anthropics/sandbox-runtime/pull/183): nested PID isolation and io_uring denial.
- [PR #390](https://github.com/anthropics/sandbox-runtime/pull/390): capability-drop hardening.
- [PR #272](https://github.com/anthropics/sandbox-runtime/pull/272): larger launcher redesign with useful native relay/pinning references, not a drop-in fix.
- [PR #505](https://github.com/anthropics/sandbox-runtime/pull/505): root/CAP_SETFCAP handling, distinct from this host's failure.
- [PR #588](https://github.com/anthropics/sandbox-runtime/pull/588): namespace-hardening discussion; its host sysctl changes were not adopted.
- [pi-sandbox PR #82](https://github.com/carderne/pi-sandbox/pull/82): helper read visibility, a separate issue from the capability denial.
