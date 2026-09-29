/* SPDX-License-Identifier: MIT
 * A static workload fixture: no interpreter/dlopen-owned FDs confuse the
 * launcher's descriptor inheritance test. */
#define _GNU_SOURCE
#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>

int main(void) {
    DIR *dir = opendir("/proc/self/fd");
    if (!dir) return 1;
    struct dirent *entry;
    while ((entry = readdir(dir))) {
        char *end;
        long fd = strtol(entry->d_name, &end, 10);
        if (*end || fd <= 2 || fd == dirfd(dir)) continue;
        fprintf(stderr, "unexpected inherited fd: %ld\n", fd);
        closedir(dir);
        return 1;
    }
    closedir(dir);
    return 0;
}
