# Linux sandbox repair plan

## Baseline and constraints

Investigation baseline: pi-sandbox `c3b2f73`, @carderne/sandbox-runtime 0.0.72
(source `dea3f1a241c189f0f954ac989dfc2c2a95b64c39`), Bubblewrap 0.11.1.
Affected host: Ubuntu 26.04.1, kernel 7.0.0-34-generic, unprivileged pi-dev.

Keep filesystem isolation, network allowlisting, `allowAllUnixSockets=false`,
zero workload capabilities, and the host's existing security configuration.
Do not use sudo or change AppArmor, sysctls, Bubblewrap, capabilities, or installed
packages under ~/.pi/agent/npm/node_modules.

## Root cause and current execution

Pi's registered Bash tool calls `createSandboxedBashOps` in
`src/sandbox-runtime.ts`. This invokes manager.wrapWithSandbox and spawns the
returned shell command. The runtime's `wrapCommandWithSandboxLinux` constructs
Bubblewrap mounts, network/PID/user isolation, and `--cap-drop ALL`.

Inside Bubblewrap, shell wrappers start TCP-to-Unix socat relays, then invoke
apply-seccomp. The latter creates nested user/PID/mount namespaces, remounts
/proc, forks a non-dumpable init, and applies seccomp to the workload.
Ubuntu's bwrap//&unpriv_bwrap AppArmor stack denies CAP_SYS_ADMIN to the helper;
it fails writing /proc/self/setgroups before the command executes. Installing
seccomp with no_new_privs itself does not need this capability.

The nested namespace is a security boundary: it hides unfiltered bwrap, shell,
and socat processes from the workload. Removing it without replacement exposes
those processes to ptrace, process_vm_*, pidfd_getfd, and /proc memory/FD access.

Host Node HTTP/SOCKS proxies and host socat bridges stay outside the sandbox.
The in-sandbox socat relays require Unix sockets to reach those bridges. An
optional seccomp observation supervisor also uses Unix sockets; pi-sandbox
currently does not enable it.

The installed helper also permits socketpair(AF_UNIX, SOCK_DGRAM). A harmless
standalone test sent a datagram from such a pair to a private temporary external
fixture even though socket(AF_UNIX) was denied. Close this filter gap too.

## Chosen direction (not yet production ready)

Retain Bubblewrap and the existing host proxy/bridge infrastructure. Introduce
a capability-free native supervisor inside Bubblewrap's existing namespaces:

```
host proxy/bridge
  -> bwrap: existing mounts, --unshare-net/user/pid, --cap-drop ALL, --as-pid-1
      -> native PID 1 (non-dumpable, no namespace or mount operations)
          -> native TCP-to-Unix relay children (fork-only, non-dumpable)
          -> hardened seccomp -> selected shell -> workload
```

Replace the in-sandbox setup shells and socat, not Bubblewrap. Setting
PR_SET_DUMPABLE=0 before execing stock socat is insufficient: exec resets it.
Pin approved bridge socket inodes before starting untrusted code. Never let
workload input choose a relay destination. Close all infrastructure FDs before
workload exec. Preserve reaping, signal forwarding, command exit status,
readiness ordering, and fail-closed relay lifecycle behavior.

Workload seccomp must deny Unix socket/socketpair, ptrace, process_vm_readv,
process_vm_writev, pidfd_getfd, all io_uring entry points, and namespace/mount
operations that undermine confinement. Handle syscall ABIs, integer argument
widths, clone flags, and clone3 deliberately while preserving normal threads.
Non-dumpability of every unfiltered helper is additionally required to protect
/proc/<pid>/{mem,fd,root,cwd,ns}; syscall denials alone are insufficient.

Bubblewrap's --seccomp cannot directly replace apply-seccomp in the current
layout: it would also prevent socat from creating its required Unix sockets.
A proc-less fallback has unacceptable general Bash/runtime compatibility costs.
Replacing Bubblewrap entirely is a much larger change and cannot assume the
replacement inherits Ubuntu's Bubblewrap AppArmor permissions.

## Staged implementation

1. Commit this investigation and plan on a repair branch.
2. Make requested sandbox initialization failures block Bash and user_bash;
   never fall through to unsandboxed execution. Add regression tests.
3. Vendor/pin the runtime source and reproducible native build inputs. Do not
   silently resolve an unrelated globally installed helper.
4. Implement and independently test the hardened capability-free supervisor.
5. Wire the runtime wrapper to launch it directly as Bubblewrap PID 1, retaining
   existing filesystem/network policy and dropping all capabilities.
6. Fail closed when helpers, filters, or hardening are unavailable. Preserve
   optional diagnostic observation separately from enforcement.
7. Run integration tests on the unchanged affected Ubuntu host before enabling
   the new path by default. Keep incomplete work explicitly marked as such.

Acceptance tests: ordinary Bash/build commands; read/write denial; HTTP and
SOCKS allowed/denied requests; Unix stream/datagram fixtures and socketpair;
all seven inspection/FD/io_uring paths; alternate syscall ABIs; zero capabilities
and no_new_privs; inherited FDs; namespace/mount denial; concurrent commands;
relay failures; signals/timeouts/reaping; missing helper and initialization
failure. Use positive controls. Test permissive-Yama hosts separately in CI,
not by changing this host's sysctls. Never probe real credential services.

## Upstream references

- https://github.com/anthropics/sandbox-runtime/issues/429 — matching AppArmor failure;
  its suggested unisolated fallback does not meet our security requirements.
- https://github.com/anthropics/sandbox-runtime/pull/183 — nested PID isolation and
  io_uring denial (`7ee4ac6`).
- https://github.com/anthropics/sandbox-runtime/pull/390 — capability-drop hardening
  (`85738f3`), needed to prevent filesystem remount escapes.
- https://github.com/anthropics/sandbox-runtime/pull/272 — larger launcher redesign;
  native relay and pinned endpoint code are useful references, not a drop-in fix.
- https://github.com/anthropics/sandbox-runtime/pull/505 — root/CAP_SETFCAP handling,
  not a fix for this host's AppArmor denial.
- https://github.com/anthropics/sandbox-runtime/pull/588 — namespace hardening ideas;
  do not adopt its sysctl changes here.
- https://github.com/carderne/pi-sandbox/pull/82 — helper read visibility fix,
  already included and distinct from the capability failure.
