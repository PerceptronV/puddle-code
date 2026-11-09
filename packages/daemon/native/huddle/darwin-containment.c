/* Read-only Darwin resource-coalition observation. No task ports or signals.
 * The optional private interfaces are looked up at runtime; unsupported hosts fail closed.
 * ABI and lifetime evidence: apple-oss-distributions/xnu, proc_info_private.h,
 * sys_coalition.c and coalition.c. See docs/huddle/recovery.md for the limits.
 */
#include <dlfcn.h>
#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <libproc.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <unistd.h>

static int (*usage)(uint64_t, void *, size_t);
static uint64_t number(const char *text) {
  if (!*text || strlen(text) > 20) exit(2);
  for (const char *p = text; *p; ++p) if (*p < '0' || *p > '9') exit(2);
  char *end;
  errno = 0;
  unsigned long long value = strtoull(text, &end, 10);
  if (errno || *end || !value) exit(2);
  return (uint64_t)value;
}
static uint64_t resource(pid_t pid) {
  /* PROC_PIDCOALITIONINFO: two coalition ids and three reserved uint64_t fields. */
  uint64_t result[5] = {0};
  if (proc_pidinfo(pid, 20, 0, result, sizeof(result)) != sizeof(result) || result[0] <= 4)
    exit(3);
  return result[0];
}
static int inspect(uint64_t id, int capture) {
  /* Request only the stable tasks_started/tasks_exited prefix; the kernel bounds copyout. */
  uint64_t counts[2] = {UINT64_MAX, UINT64_MAX};
  errno = 0;
  if (usage(id, counts, sizeof(counts))) {
    if (!capture && errno == ESRCH) {
      printf("{\"format\":1,\"coalition\":\"%" PRIu64 "\",\"state\":\"reaped\"}\n", id);
      return 0;
    }
    return 3;
  }
  if (counts[0] == UINT64_MAX || counts[1] == UINT64_MAX || counts[1] > counts[0] ||
      (capture && counts[0] <= counts[1])) return 3;
  printf("{\"format\":1,\"coalition\":\"%" PRIu64 "\",\"state\":\"%s\","
         "\"started\":\"%" PRIu64 "\",\"exited\":\"%" PRIu64 "\"}\n",
         id, counts[0] == counts[1] ? "empty" : "populated", counts[0], counts[1]);
  return 0;
}
int main(int argc, char **argv) {
  if (argc != 3) return 2;
  usage = dlsym(RTLD_DEFAULT, "coalition_info_resource_usage");
  if (!usage) return 3;
  uint64_t value = number(argv[2]);
  if (!strcmp(argv[1], "observe")) return inspect(value, 0);
  if (strcmp(argv[1], "capture") || value > INT_MAX || getppid() != (pid_t)value) return 2;
  struct proc_bsdinfo owner = {0};
  if (proc_pidinfo((pid_t)value, PROC_PIDTBSDINFO, 0, &owner, sizeof(owner)) != sizeof(owner) ||
      owner.pbi_ppid != 1 || owner.pbi_uid != getuid()) return 3;
  uint64_t id = resource((pid_t)value);
  if (id != resource(getpid()) || getppid() != (pid_t)value) return 3;
  return inspect(id, 1);
}
