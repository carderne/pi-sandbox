/* SPDX-License-Identifier: MIT
 * Capability-free supervisor and proxy relays for the vendored runtime.
 * bwrap supplies the PID/mount/user/network namespaces and drops ALL caps.
 * This program must be its direct --as-pid-1 command, never behind a shell.
 *
 * PID 1 and fork-only relays are non-dumpable and never exec. Only the
 * workload child executes user code, after FD cleanup and seccomp.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <linux/audit.h>
#include <linux/capability.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <sched.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

#if defined(__x86_64__)
#define NATIVE_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define NATIVE_ARCH AUDIT_ARCH_AARCH64
#else
#error "Unsupported syscall ABI: only Linux x86_64 and aarch64 are audited"
#endif

/* Linux 6.15 added open_tree_attr, after many build environments' headers.
 * It is syscall 467 on both supported architectures. Never silently omit it. */
#ifndef SYS_open_tree_attr
#define SYS_open_tree_attr 467
#endif

#define DENIED (SECCOMP_RET_ERRNO | EPERM)
#define DENY_SYSCALL(name) \
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_##name, 0, 1), \
    BPF_STMT(BPF_RET | BPF_K, DENIED)
#define LOAD_NR BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr))
/* Socket's domain is an int: compare its LOW 32 bits, not the whole register.
 * Both supported ABIs are little-endian. socketpair(datagram) otherwise lets
 * a workload sendto arbitrary pathname Unix sockets without calling socket. */
#define DENY_UNIX(name) \
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_##name, 0, 3), \
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])), \
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 0, 1), \
    BPF_STMT(BPF_RET | BPF_K, DENIED), \
    LOAD_NR

static const struct sock_filter workload_filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, NATIVE_ARCH, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    LOAD_NR,
#if defined(__x86_64__)
    /* x32 shares AUDIT_ARCH_X86_64 but uses a different syscall table. */
    BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000U, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
#endif
    DENY_UNIX(socket),
    DENY_UNIX(socketpair),
    DENY_SYSCALL(ptrace),
    DENY_SYSCALL(process_vm_readv),
    DENY_SYSCALL(process_vm_writev),
    DENY_SYSCALL(pidfd_getfd),
    DENY_SYSCALL(io_uring_setup),
    DENY_SYSCALL(io_uring_enter),
    DENY_SYSCALL(io_uring_register),
    DENY_SYSCALL(unshare),
    DENY_SYSCALL(setns),
    DENY_SYSCALL(mount),
    DENY_SYSCALL(umount2),
    DENY_SYSCALL(pivot_root),
    DENY_SYSCALL(open_tree),
    DENY_SYSCALL(open_tree_attr),
    DENY_SYSCALL(move_mount),
    DENY_SYSCALL(fsopen),
    DENY_SYSCALL(fsconfig),
    DENY_SYSCALL(fsmount),
    DENY_SYSCALL(fspick),
    DENY_SYSCALL(mount_setattr),
    DENY_SYSCALL(open_by_handle_at),
    /* clone3 flags live behind a pointer. ENOSYS lets libc use filtered clone. */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_clone3, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_clone, 0, 3),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K,
             CLONE_NEWUSER | CLONE_NEWNS | CLONE_NEWPID | CLONE_NEWNET |
             CLONE_NEWIPC | CLONE_NEWUTS | CLONE_NEWCGROUP, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, DENIED),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
};

static void die(const char *message) {
    perror(message);
    _exit(125);
}

#include "relay.h"

static void require_zero_caps(void) {
    struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3 };
    struct __user_cap_data_struct caps[2] = {{0}};
    if (syscall(SYS_capget, &header, caps) < 0) die("launcher: capget");
    for (unsigned i = 0; i < 2; i++) {
        if (caps[i].effective || caps[i].permitted || caps[i].inheritable) {
            errno = EPERM;
            die("launcher: caller must drop all capabilities");
        }
    }
    /* Fail closed even when today's effective set is zero but exec could
     * acquire a capability from an inherited/bounding set. */
    for (unsigned cap = 0; cap < 64; cap++) {
        int present = prctl(PR_CAPBSET_READ, cap, 0, 0, 0);
        if (present < 0 && errno == EINVAL) break;
        if (present < 0) die("launcher: PR_CAPBSET_READ");
        if (present) {
            errno = EPERM;
            die("launcher: capability bounding set must be empty");
        }
    }
}

static volatile sig_atomic_t worker_pid = -1;
static const int forwarded_signals[] = {
    SIGTERM, SIGINT, SIGHUP, SIGQUIT, SIGUSR1, SIGUSR2,
};

static void forward_signal(int number) {
    int saved = errno;
    if (worker_pid > 0) (void)kill((pid_t)worker_pid, number);
    errno = saved;
}

static int reap_worker(pid_t worker, pid_t relay) {
    for (;;) {
        int status;
        pid_t child = waitpid(-1, &status, 0);
        if (child < 0) {
            if (errno == EINTR) continue;
            die("launcher: waitpid");
        }
        if (relay > 0 && child == relay) {
            fputs("launcher: network relay exited; terminating sandbox\n", stderr);
            return 125;
        }
        if (child != worker) continue;
        if (WIFEXITED(status)) return WEXITSTATUS(status);
        if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
        return 125;
    }
}

int main(int argc, char **argv) {
    if (argc == 2 && strcmp(argv[1], "--version") == 0) {
        puts("pi-sandbox-launcher 1");
        return 0;
    }
    const char *http = NULL, *socks = NULL;
    int command = 1;
    while (command < argc && strcmp(argv[command], "--") != 0) {
        if (command + 1 >= argc) break;
        if (!http && strcmp(argv[command], "--http-socket") == 0) http = argv[command+1];
        else if (!socks && strcmp(argv[command], "--socks-socket") == 0) socks = argv[command+1];
        else break;
        command += 2;
    }
    if (command + 1 >= argc || strcmp(argv[command], "--") != 0 || (!!http != !!socks)) {
        fputs("Usage: launcher [--http-socket PATH --socks-socket PATH] -- COMMAND [ARGS...]\n", stderr);
        return 125;
    }
    command++;
    if (getpid() != 1) {
        fputs("launcher: requires Bubblewrap --as-pid-1\n", stderr);
        return 125;
    }
    require_zero_caps();
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) die("launcher: no_new_privs");
    if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) < 0) die("launcher: non-dumpable");
    /* Drop any inherited control/directory/Unix/ring descriptors. stdio is the
     * only intentional inheritance. Linux >=5.9 is required; no weak fallback. */
    if (syscall(SYS_close_range, 3U, ~0U, 0) < 0) die("launcher: close_range");

    // Pin bridge inodes and bind both TCP listeners before any workload exists.
    pid_t relay = http ? start_relays(http, socks) : -1;

    sigset_t blocked;
    sigemptyset(&blocked);
    struct sigaction forward = { .sa_handler = forward_signal };
    sigemptyset(&forward.sa_mask);
    for (unsigned i = 0; i < sizeof(forwarded_signals) / sizeof(int); i++) {
        sigaddset(&blocked, forwarded_signals[i]);
        if (sigaction(forwarded_signals[i], &forward, NULL) < 0) die("launcher: sigaction");
    }
    struct sigaction normal = { .sa_handler = SIG_DFL };
    sigemptyset(&normal.sa_mask);
    if (sigaction(SIGCHLD, &normal, NULL) < 0) die("launcher: SIGCHLD");
    if (sigprocmask(SIG_BLOCK, &blocked, NULL) < 0) die("launcher: block signals");

    pid_t child = fork();
    if (child < 0) die("launcher: fork");
    if (child == 0) {
        for (unsigned i = 0; i < sizeof(forwarded_signals) / sizeof(int); i++) {
            if (sigaction(forwarded_signals[i], &normal, NULL) < 0) die("launcher: child signals");
        }
        /* No native infrastructure FD may cross the workload exec boundary. */
        if (syscall(SYS_close_range, 3U, ~0U, 0) < 0) die("launcher: worker close_range");
        struct sock_fprog filter = {
            .len = (unsigned short)(sizeof(workload_filter) / sizeof(workload_filter[0])),
            .filter = (struct sock_filter *)workload_filter,
        };
        if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &filter) < 0) die("launcher: seccomp");
        sigset_t empty;
        sigemptyset(&empty);
        if (sigprocmask(SIG_SETMASK, &empty, NULL) < 0) die("launcher: worker unblock");
        execvp(argv[command], &argv[command]);
        die("launcher: execvp");
    }
    worker_pid = child;
    sigset_t empty;
    sigemptyset(&empty);
    if (sigprocmask(SIG_SETMASK, &empty, NULL) < 0) die("launcher: unblock");
    /* PID 1 exiting makes the kernel kill every remaining namespace member. */
    _exit(reap_worker(child, relay));
}
