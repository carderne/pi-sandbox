# Capability-free Linux supervisor

This is the active Linux launch path of this fork's vendored runtime when
`network.allowAllUnixSockets` is false or omitted. It replaces the nested
apply-seccomp setup, not Bubblewrap. No host security configuration changes are
required. It is not argv-compatible with the upstream apply-seccomp binary.

## Process and security boundaries

Bubblewrap creates the filesystem, user, PID and network namespaces, mounts a
fresh `/proc`, and drops **all** capabilities. It directly executes this native
supervisor with `--as-pid-1`; no setup shell or stock socat runs inside first.

The supervisor requires PID 1 and empty effective, permitted, inheritable and
bounding capability sets. It sets no_new_privs and non-dumpability, closes
inherited non-stdio descriptors, pins the two approved proxy socket inodes, and
binds loopback TCP ports 3128/1080 before forking the relay and workload.

```
Bubblewrap sandbox
  PID 1: native, non-dumpable supervisor/reaper
    relay: native, non-dumpable listener
      connection children: native, non-dumpable byte pumps
    workload: hardened seccomp -> selected shell -> command
```

PID 1 and relays never exec; they retain PR_SET_DUMPABLE=0. This protects their
procfs memory and descriptors independently of the workload's syscall filter.
They are visible and signalable, unlike the old nested PID design: killing the
relay terminates the sandbox; killing connection children can deny service but
cannot select a different destination or enable direct networking.

The relay forwards only byte streams to pinned Unix socket inodes, never
SCM_RIGHTS, destination names, commands, or descriptors supplied by the workload.
It handles nonblocking partial reads/writes, bidirectional backpressure and
half-close with 16 KiB buffers per direction and at most 64 active connection
children per command. All control/socket/directory FDs are closed in the worker.
Only caller-supplied stdio survives, as in the existing Pi spawn contract.

The filter denies Unix socket and socketpair creation (including high-bit
argument disguises), ptrace, process_vm_readv/writev, pidfd_getfd, all io_uring
entry points, namespace creation/entry, and mount operations. clone3 returns
ENOSYS so libc can fall back to filtered clone. Ordinary threads/forks work.
Other syscall ABIs fail closed. The worker has no elevated capabilities.

The helper itself never creates namespaces, mounts filesystems, writes UID maps,
or uses CAP_SYS_ADMIN. PID 1 forwards signals and reaps children; its exit tears
down the namespace, including detached descendants. Relay failure is fatal.

## Build and tests

Requires existing gcc/static libc, Bubblewrap, socat (host bridges), ripgrep,
Bash and Python 3. Build/test commands install no system packages and change no
host policy:

```sh
corepack pnpm build:sandbox
corepack pnpm test:linux-launcher
corepack pnpm test:linux-integration
```

The build writes an architecture-specific artifact and a source/binary hash
manifest under `vendor/sandbox-runtime/vendor/seccomp`. Rebuild after native
source changes. The runtime refuses missing or stale artifacts; it never searches
PATH or global npm installations for a replacement helper.

Integration tests use real Bubblewrap, the real proxy manager, Pi's jiti loader,
and harmless local TCP/Unix fixtures. They cover HTTP/SOCKS allowlisting, direct
network denial, filesystem denial, Unix sockets/socketpair, all unfiltered helper
processes, syscall/ABI denial, FD hygiene, endpoint replacement, large transfers,
half-close, parallel commands, live allowlist updates, signals/timeouts, and
orphan cleanup. No real SSH-agent, D-Bus, or keyring service is contacted.

## Compatibility and validation limits

- Tested on the affected Ubuntu 26.04.1 x86_64 host, Bubblewrap 0.11.1, with
  AppArmor unchanged. Linux >=5.9 is required for close_range.
- Source supports x86_64 and aarch64; ARM64 still needs its own runner validation.
- Debugging/ptrace, io_uring, nested namespace tools, and Unix socketpair-based
  workloads are intentionally restricted. Browser compatibility is not promised.
- Fresh `/proc` is mandatory. `enableWeakerNestedSandbox` and custom seccomp
  helper overrides are rejected for this path.
- Optional Linux syscall observation is not implemented and is explicitly
  rejected when requested. Pi does not enable that upstream diagnostic feature.
- A separate permissive-Yama CI run and independent security review remain useful;
  successful tests are not a claim of a comprehensive security audit.
