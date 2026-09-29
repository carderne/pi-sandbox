# Capability-free Linux supervisor foundation

**Experimental, not wired into the runtime or enabled for Pi commands.** This
is the first native implementation stage of `docs/linux-sandbox-repair.md`.
It does not yet contain the TCP-to-Unix relays, runtime integration, or optional
violation observation. It is not a drop-in replacement for apply-seccomp.

Bubblewrap remains responsible for all namespace and filesystem setup. The
supervisor requires PID 1 (`--as-pid-1`) and empty effective, permitted,
inheritable, and bounding capability sets. It installs no_new_privs, becomes
non-dumpable, closes inherited infrastructure FDs, forks a worker, installs
workload seccomp, and execs the requested command. It never creates a namespace,
mounts a filesystem, writes UID maps, or needs CAP_SYS_ADMIN.

The unfiltered PID 1 never execs. Its non-dumpability protects its procfs memory
and descriptors; workload syscall filtering alone would not do so. Its signal
handlers forward to the worker; its exit tears down remaining descendants.

The filter denies Unix socket and socketpair creation (including high-bit
argument disguises), ptrace, process_vm_readv/writev, pidfd_getfd, io_uring,
namespace creation/entry, and mount operations. clone3 returns ENOSYS so libc
can fall back to clone; ordinary thread and process creation remains available.
Other syscall ABIs fail closed. Only x86_64 and aarch64 are supported; aarch64
still requires validation on an actual ARM runner. Linux >=5.9 is required for
close_range; failure is fatal rather than falling back to FD leakage.

## Tests

From the repository root:

```sh
corepack pnpm test:linux-launcher
```

Requires existing gcc/static libc, Bubblewrap, Bash, and Python 3. The test
builds a temporary static binary; it installs nothing and changes no host
security settings. Missing dependencies fail the explicit suite. Ordinary
`pnpm test` skips native integration unless `PI_SANDBOX_NATIVE_TEST=1` is set.

Tested on the affected Ubuntu 26.04.1 x86_64 host with Bubblewrap 0.11.1:
Bash process substitution/pipelines, threads/forks, exit status, filesystem
write denial, zero capabilities, procfs helper protections, syscall denials,
alternative x86 ABIs, signal forwarding, and orphan cleanup.

## Remaining work before runtime use

- Vendor and pin the runtime's source/build inputs and wire direct invocation.
- Implement fork-only non-dumpable native relays with pinned bridge endpoints,
  readiness guarantees, bounded resources, and fail-closed lifecycle behavior.
- Preserve host HTTP/SOCKS policy and test allowed/denied traffic end-to-end.
- Audit every inherited descriptor and every unfiltered process in the complete
  topology, including optional observation if retained.
- Test cancellation/concurrency, relay attacks/failures, ARM64, and procfs
  protection on a separate permissive-Yama CI host (do not change this host).
- Test packaging/missing-helper failures; prohibit global-helper fallback.

The existing production runtime still has the diagnosed Ubuntu failure. This
foundation intentionally does not weaken it to make untested integration run.
