"""Harmless probes: no real host service is contacted or host policy changed."""
import ctypes
import errno
import os
import platform
import socket
import threading

libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long
arch = platform.machine()
# Explicit tables for the two supported Linux ABIs, not guessed syscall IDs.
nrs = {
    "x86_64": {"socket": 41, "socketpair": 53, "ptrace": 101, "readv": 310,
               "writev": 311, "unshare": 272, "setns": 308, "mount": 165,
               "umount2": 166, "pivot_root": 155, "clone": 56},
    "aarch64": {"socket": 198, "socketpair": 199, "ptrace": 117, "readv": 270,
                "writev": 271, "unshare": 97, "setns": 268, "mount": 40,
                "umount2": 39, "pivot_root": 41, "clone": 220},
}[arch]

with open("/proc/self/status") as f:
    status = dict(line.strip().split(":", 1) for line in f if ":" in line)
for field in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"):
    assert int(status[field].strip(), 16) == 0, (field, status[field])
assert status["NoNewPrivs"].strip() == "1"
assert status["Seccomp"].strip() == "2"
assert os.getppid() == 1
# Positive control: procfs itself is not masked. Helper access is denied by
# non-dumpability, independently of the ptrace syscall's seccomp denial.
with open("/proc/self/mem", "rb"):
    pass
assert os.listdir("/proc/self/fd")
for path, mode in (("/proc/1/mem", "rb"), ("/proc/1/mem", "r+b")):
    try:
        with open(path, mode):
            raise AssertionError("helper memory accessible: " + path)
    except PermissionError:
        pass
try:
    os.listdir("/proc/1/fd")
    raise AssertionError("helper fd directory accessible")
except PermissionError:
    pass
for path in ("/proc/1/root", "/proc/1/cwd"):
    try:
        os.readlink(path)
        raise AssertionError("helper magic link accessible: " + path)
    except PermissionError:
        pass

# Test opening a namespace handle, not readlink's display string (some
# kernels return an empty string for a non-dumpable task's namespace link).
for namespace in ("user", "pid", "mnt", "net"):
    own = os.open("/proc/self/ns/" + namespace, os.O_RDONLY)
    os.close(own)
    try:
        other = os.open("/proc/1/ns/" + namespace, os.O_RDONLY)
    except PermissionError:
        pass
    else:
        os.close(other)
        raise AssertionError("helper namespace handle accessible: " + namespace)

# Every syscall below is denied before argument validation; probes do not
# dereference another process's memory, mount anything, or create namespaces.
def denied(nr, *args, expected=errno.EPERM):
    ctypes.set_errno(0)
    result = libc.syscall(ctypes.c_long(nr), *[
        ctypes.c_ulonglong(arg) for arg in (*args, *([0] * (6 - len(args))))
    ])
    assert result == -1 and ctypes.get_errno() == expected, (nr, result, ctypes.get_errno())

for name in ("ptrace", "readv", "writev", "unshare", "setns", "mount", "umount2", "pivot_root"):
    denied(nrs[name])
for nr in (425, 426, 427, 428, 429, 430, 431, 432, 433, 438, 442, 467):
    denied(nr)
denied(435, expected=errno.ENOSYS)  # clone3; libc may fall back to clone.
for flag in (0x10000000, 0x00020000, 0x20000000, 0x40000000,
             0x08000000, 0x04000000, 0x02000000):
    denied(nrs["clone"], flag)
for name in ("socket", "socketpair"):
    for domain in (socket.AF_UNIX, (1 << 32) | socket.AF_UNIX):
        denied(nrs[name], domain, socket.SOCK_DGRAM, 0)
        denied(nrs[name], domain, socket.SOCK_STREAM, 0)

# Positive controls: normal network syscalls, descendants, and threads still
# work. No host network service is used: loopback is this sandbox's own netns.
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    with socket.create_connection(server.getsockname()) as client:
        connection, _ = server.accept()
        with connection:
            client.sendall(b"ok")
            assert connection.recv(2) == b"ok"
with socket.socket(socket.AF_INET, socket.SOCK_DGRAM):
    pass
result = []
t = threading.Thread(target=lambda: result.append("thread worked"))
t.start()
t.join()
assert result == ["thread worked"]
child = os.fork()
if child == 0:
    os._exit(0)
assert os.waitpid(child, 0)[1] == 0
print("ALL CHECKS PASSED")
