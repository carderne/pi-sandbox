/* SPDX-License-Identifier: MIT
 * Fork-only, non-dumpable relays. No executable, path, port, or protocol is
 * selected by traffic: every accepted stream goes to one pinned bridge inode.
 * Included by launcher.c after die(). This is deliberately not a general proxy.
 */
#include <arpa/inet.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/stat.h>
#include <sys/un.h>

#define MAX_CONNECTIONS 64
#define BUFFER_SIZE 16384

struct bridge {
    int listener;
    int pinned_socket;
};

static struct bridge prepare_bridge(unsigned short port, const char *path) {
    struct bridge b;
    b.pinned_socket = open(path, O_PATH | O_CLOEXEC);
    if (b.pinned_socket < 0) die("launcher: pin proxy bridge");
    struct stat st;
    if (fstat(b.pinned_socket, &st) < 0) die("launcher: stat proxy bridge");
    if (!S_ISSOCK(st.st_mode)) {
        errno = EINVAL;
        die("launcher: proxy bridge is not a socket");
    }
    b.listener = socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    if (b.listener < 0) die("launcher: relay socket");
    struct sockaddr_in addr = { .sin_family = AF_INET, .sin_port = htons(port),
                                .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
    if (bind(b.listener, (struct sockaddr *)&addr, sizeof(addr)) < 0)
        die("launcher: relay bind");
    if (listen(b.listener, 32) < 0) die("launcher: relay listen");
    return b;
}

/* Pinned procfs magic link follows the socket inode, not a mutable pathname.
 * This fd never crosses the workload's exec boundary. */
static int connect_bridge(int pinned) {
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    if (fd < 0) return -1;
    struct sockaddr_un addr = { .sun_family = AF_UNIX };
    int n = snprintf(addr.sun_path, sizeof(addr.sun_path), "/proc/self/fd/%d", pinned);
    if (n < 0 || (size_t)n >= sizeof(addr.sun_path)) { close(fd); return -1; }
    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        if (errno != EINPROGRESS) { close(fd); return -1; }
        struct pollfd p = { .fd = fd, .events = POLLOUT };
        int ready;
        do { ready = poll(&p, 1, 5000); } while (ready < 0 && errno == EINTR);
        int error = 0;
        socklen_t len = sizeof(error);
        if (ready <= 0 || getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &len) < 0 || error) {
            close(fd);
            return -1;
        }
    }
    return fd;
}

struct direction {
    unsigned char data[BUFFER_SIZE];
    size_t begin, end;
    int eof, shutdown;
};

/* Bounded nonblocking buffers, partial writes and half-close in both directions.
 * No recvmsg/SCM_RIGHTS: the bridge carries only bytes, never descriptors. */
static void pump(int client, int upstream) {
    int fds[2] = { client, upstream };
    struct direction d[2] = {0};
    for (;;) {
        struct pollfd p[2] = {{ .fd = client }, { .fd = upstream }};
        for (int i = 0; i < 2; i++) {
            if (d[i].begin == d[i].end) d[i].begin = d[i].end = 0;
            if (d[i].eof && d[i].begin == d[i].end && !d[i].shutdown) {
                (void)shutdown(fds[1-i], SHUT_WR);
                d[i].shutdown = 1;
            }
            if (!d[i].eof && d[i].end < BUFFER_SIZE) p[i].events |= POLLIN;
            if (d[1-i].begin < d[1-i].end) p[i].events |= POLLOUT;
            // Avoid a busy loop on HUP while this direction has no work.
            if (!p[i].events) p[i].fd = -1;
        }
        if (d[0].shutdown && d[1].shutdown) return;
        int ready;
        do { ready = poll(p, 2, -1); } while (ready < 0 && errno == EINTR);
        if (ready < 0) return;
        for (int i = 0; i < 2; i++) {
            if (p[i].revents & (POLLERR | POLLNVAL)) return;
            if ((p[i].revents & (POLLIN | POLLHUP)) && !d[i].eof && d[i].end < BUFFER_SIZE) {
                ssize_t n = read(fds[i], d[i].data + d[i].end, BUFFER_SIZE - d[i].end);
                if (n > 0) d[i].end += (size_t)n;
                else if (n == 0) d[i].eof = 1;
                else if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) return;
            }
            struct direction *out = &d[1-i];
            if ((p[i].revents & (POLLOUT | POLLHUP)) && out->begin < out->end) {
                ssize_t n = send(fds[i], out->data + out->begin, out->end - out->begin, MSG_NOSIGNAL);
                if (n > 0) out->begin += (size_t)n;
                else if (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) return;
            }
        }
    }
}

static void relay_loop(struct bridge bridges[2]) {
    /* PID 1 remains in charge of namespace lifetime. This child and all its
     * connection children inherit non-dumpability and NEVER exec. */
    struct sigaction normal = { .sa_handler = SIG_DFL };
    sigemptyset(&normal.sa_mask);
    if (sigaction(SIGCHLD, &normal, NULL) < 0) die("launcher: relay SIGCHLD");
    signal(SIGPIPE, SIG_IGN);
    sigset_t empty;
    sigemptyset(&empty);
    if (sigprocmask(SIG_SETMASK, &empty, NULL) < 0) die("launcher: relay signals");
    unsigned active = 0;
    for (;;) {
        while (waitpid(-1, NULL, WNOHANG) > 0) { if (active) active--; }
        struct pollfd p[2] = {
            { .fd = active < MAX_CONNECTIONS ? bridges[0].listener : -1, .events = POLLIN },
            { .fd = active < MAX_CONNECTIONS ? bridges[1].listener : -1, .events = POLLIN },
        };
        /* Timeout bounds zombie lifetime; at capacity no accepts are made. */
        int ready = poll(p, 2, 100);
        if (ready < 0) { if (errno == EINTR) continue; die("launcher: relay poll"); }
        for (int i = 0; i < 2 && active < MAX_CONNECTIONS; i++) {
            if (p[i].revents & (POLLERR | POLLHUP | POLLNVAL)) {
                errno = EIO;
                die("launcher: relay listener failed");
            }
            if (!(p[i].revents & POLLIN)) continue;
            int fd = accept4(bridges[i].listener, NULL, NULL, SOCK_NONBLOCK | SOCK_CLOEXEC);
            if (fd < 0) {
                if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR || errno == ECONNABORTED) continue;
                die("launcher: relay accept");
            }
            pid_t child = fork();
            if (child < 0) { close(fd); die("launcher: relay fork"); }
            if (child == 0) {
                for (int k = 0; k < 2; k++) close(bridges[k].listener);
                close(bridges[1-i].pinned_socket);
                int upstream = connect_bridge(bridges[i].pinned_socket);
                close(bridges[i].pinned_socket);
                if (upstream < 0) _exit(1); // Connection fails; never try a direct network route.
                pump(fd, upstream);
                _exit(0);
            }
            active++;
            close(fd);
        }
    }
}

static pid_t start_relays(const char *http, const char *socks) {
    struct bridge bridges[2] = { prepare_bridge(3128, http), prepare_bridge(1080, socks) };
    // Verify the pinned bridges are live before executing any workload.
    for (int i = 0; i < 2; i++) {
        int fd = connect_bridge(bridges[i].pinned_socket);
        if (fd < 0) { errno = ECONNREFUSED; die("launcher: proxy bridge unavailable"); }
        close(fd);
    }
    pid_t child = fork();
    if (child < 0) die("launcher: fork relay");
    if (child == 0) { relay_loop(bridges); _exit(125); }
    for (int i = 0; i < 2; i++) {
        close(bridges[i].listener);
        close(bridges[i].pinned_socket);
    }
    return child;
}
