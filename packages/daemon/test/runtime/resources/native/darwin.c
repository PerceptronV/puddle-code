/* Fixture-only process counters, compiled against the installed public SDK.
 * XNU: bsd_kern.c fill_task_rusage -> task.c task_power_info_locked uses
 * recount's Mach-time counters. These are NOT nanoseconds on every machine.
 * https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/bsd_kern.c
 * https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/task.c
 * Reaped children are accumulated by update_rusage_info_child in kern_resource.c;
 * they exclude live children and must not be labelled a complete process tree.
 * https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_resource.c
 */
#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <libproc.h>
#include <mach/mach_time.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static mach_timebase_info_data_t timebase;

static void die(const char *operation) {
  perror(operation);
  exit(1);
}

static uint64_t nanos(uint64_t ticks) {
  __uint128_t value = (__uint128_t)ticks * timebase.numer / timebase.denom;
  if (value > UINT64_MAX) {
    errno = EOVERFLOW;
    die("Mach time conversion");
  }
  return (uint64_t)value;
}

static uint64_t cpu_clock(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &value)) die("CPU clock");
  return (uint64_t)value.tv_sec * 1000000000 + (uint64_t)value.tv_nsec;
}

static uint64_t usage_clock(int who) {
  struct rusage value;
  if (getrusage(who, &value)) die("getrusage");
  return ((uint64_t)value.ru_utime.tv_sec + (uint64_t)value.ru_stime.tv_sec) * 1000000000
      + ((uint64_t)value.ru_utime.tv_usec + (uint64_t)value.ru_stime.tv_usec) * 1000;
}

static struct rusage_info_v1 usage(pid_t pid) {
  struct rusage_info_v1 value = {0};
  if (proc_pid_rusage(pid, RUSAGE_INFO_V1, (rusage_info_t *)&value))
    die("proc_pid_rusage");
  return value;
}

static void workload(void) {
  uint64_t start_cpu = cpu_clock();
  uint64_t start_wall = mach_absolute_time();
  volatile uint64_t value = 1;
  while (cpu_clock() - start_cpu < 50000000) {
    for (int i = 0; i < 10000; i++) value = value * 1664525 + 1013904223;
    if (nanos(mach_absolute_time() - start_wall) > 2000000000) {
      errno = ETIMEDOUT;
      die("Calibration workload");
    }
  }
}

static uint64_t total(const struct rusage_info_v1 *value, int children) {
  return children ? value->ri_child_user_time + value->ri_child_system_time
                  : value->ri_user_time + value->ri_system_time;
}

static void calibrate(void) {
  struct rusage_info_v1 before = usage(getpid());
  uint64_t clock_before = cpu_clock();
  uint64_t usage_before = usage_clock(RUSAGE_SELF);
  workload();
  uint64_t usage_after = usage_clock(RUSAGE_SELF);
  uint64_t clock_after = cpu_clock();
  struct rusage_info_v1 after = usage(getpid());
  uint64_t own_ticks = total(&after, 0) - total(&before, 0);

  struct rusage_info_v1 child_before = usage(getpid());
  uint64_t child_usage_before = usage_clock(RUSAGE_CHILDREN);
  pid_t child = fork();
  if (child == -1) die("Calibration fork");
  if (child == 0) {
    workload();
    _exit(0);
  }
  int status;
  while (waitpid(child, &status, 0) == -1) if (errno != EINTR) die("Calibration wait");
  if (!WIFEXITED(status) || WEXITSTATUS(status)) {
    errno = ECHILD;
    die("Calibration child");
  }
  uint64_t child_usage_after = usage_clock(RUSAGE_CHILDREN);
  struct rusage_info_v1 child_after = usage(getpid());
  uint64_t child_ticks = total(&child_after, 1) - total(&child_before, 1);

  struct rusage_info_v1 wake_before = usage(getpid());
  for (int i = 0; i < 5; i++) {
    struct timespec interval = {.tv_sec = 0, .tv_nsec = 10000000};
    while (nanosleep(&interval, &interval)) if (errno != EINTR) die("Calibration sleep");
  }
  struct rusage_info_v1 wake_after = usage(getpid());
  printf("{\"timebase\":{\"numer\":%u,\"denom\":%u},"
         "\"self_ticks\":\"%" PRIu64 "\",\"self_ns\":\"%" PRIu64 "\","
         "\"clock_process_ns\":\"%" PRIu64 "\",\"getrusage_self_ns\":\"%" PRIu64 "\","
         "\"reaped_child_ticks\":\"%" PRIu64 "\",\"reaped_child_ns\":\"%" PRIu64 "\","
         "\"getrusage_children_ns\":\"%" PRIu64 "\","
         "\"interrupt_wakeups\":\"%" PRIu64 "\",\"package_idle_wakeups\":\"%" PRIu64 "\"}\n",
         timebase.numer, timebase.denom, own_ticks, nanos(own_ticks),
         clock_after - clock_before, usage_after - usage_before,
         child_ticks, nanos(child_ticks), child_usage_after - child_usage_before,
         wake_after.ri_interrupt_wkups - wake_before.ri_interrupt_wkups,
         wake_after.ri_pkg_idle_wkups - wake_before.ri_pkg_idle_wkups);
}

int main(int argc, char **argv) {
  if (mach_timebase_info(&timebase) != KERN_SUCCESS || !timebase.numer || !timebase.denom) {
    errno = EINVAL;
    die("mach_timebase_info");
  }
  if (argc == 2 && strcmp(argv[1], "--calibrate") == 0) {
    calibrate();
    return 0;
  }
  if (argc < 2 || argc > 129) return 2;
  pid_t pids[128];
  for (int i = 1; i < argc; i++) {
    for (const char *c = argv[i]; *c; c++) if (*c < '0' || *c > '9') return 2;
    char *end;
    errno = 0;
    long value = strtol(argv[i], &end, 10);
    if (errno || *end || value <= 0 || value > INT_MAX) return 2;
    pids[i - 1] = (pid_t)value;
    for (int j = 0; j < i - 1; j++) if (pids[j] == pids[i - 1]) return 2;
  }
  printf("{\"timebase\":{\"numer\":%u,\"denom\":%u},\"rows\":[", timebase.numer, timebase.denom);
  for (int i = 0; i < argc - 1; i++) {
    uint64_t before = mach_absolute_time();
    struct rusage_info_v1 value = usage(pids[i]);
    uint64_t after = mach_absolute_time();
    printf("%s{\"pid\":%d,\"start_ticks\":\"%" PRIu64 "\",\"exit_ticks\":\"%" PRIu64 "\","
           "\"before_ticks\":\"%" PRIu64 "\",\"after_ticks\":\"%" PRIu64 "\","
           "\"user_ticks\":\"%" PRIu64 "\",\"system_ticks\":\"%" PRIu64 "\","
           "\"reaped_child_user_ticks\":\"%" PRIu64 "\",\"reaped_child_system_ticks\":\"%" PRIu64 "\","
           "\"interrupt_wakeups\":\"%" PRIu64 "\",\"package_idle_wakeups\":\"%" PRIu64 "\","
           "\"reaped_child_interrupt_wakeups\":\"%" PRIu64 "\","
           "\"reaped_child_package_idle_wakeups\":\"%" PRIu64 "\"}",
           i ? "," : "", pids[i], value.ri_proc_start_abstime, value.ri_proc_exit_abstime,
           before, after, value.ri_user_time, value.ri_system_time,
           value.ri_child_user_time, value.ri_child_system_time,
           value.ri_interrupt_wkups, value.ri_pkg_idle_wkups,
           value.ri_child_interrupt_wkups, value.ri_child_pkg_idle_wkups);
  }
  puts("]}");
  return 0;
}
