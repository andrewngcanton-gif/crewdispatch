// macos-process-info.c — bounded Darwin process identity probe.
//
// This helper intentionally exposes only non-secret process identity facts needed
// by CrewDispatch: pid/ppid/pgid/session, uid, start instant and short command
// name, plus kern.boottime. It never reads argv, environment, cwd or credentials.
//
// It uses BSD sysctl exported process fields rather than libproc private
// interfaces. MAC-02 validates this source before any production runtime path
// consumes it.
#ifdef __APPLE__

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>
#include <sys/time.h>
#include <sys/types.h>
#include <unistd.h>

static void print_json_string(const char *value) {
  const unsigned char *p = (const unsigned char *)(value ? value : "");
  putchar('"');
  for (; *p; ++p) {
    switch (*p) {
      case '"': fputs("\\\"", stdout); break;
      case '\\': fputs("\\\\", stdout); break;
      case '\b': fputs("\\b", stdout); break;
      case '\f': fputs("\\f", stdout); break;
      case '\n': fputs("\\n", stdout); break;
      case '\r': fputs("\\r", stdout); break;
      case '\t': fputs("\\t", stdout); break;
      default:
        if (*p < 0x20) printf("\\u%04x", (unsigned int)*p);
        else putchar((int)*p);
    }
  }
  putchar('"');
}

static int load_pid(pid_t pid, struct kinfo_proc *out, int *error_out) {
  int mib[4] = { CTL_KERN, KERN_PROC, KERN_PROC_PID, pid };
  size_t len = sizeof(*out);
  memset(out, 0, sizeof(*out));
  errno = 0;
  int rc = sysctl(mib, 4, out, &len, NULL, 0);
  if (rc != 0 || len == 0 || out->kp_proc.p_pid != pid) {
    int e = errno != 0 ? errno : ESRCH;
    if (error_out) *error_out = e;
    return -1;
  }
  if (error_out) *error_out = 0;
  return 0;
}

static void print_process_fields(const struct kinfo_proc *info, int include_sid) {
  pid_t sid = -1;
  int sid_error = 0;
  if (include_sid) {
    errno = 0;
    sid = getsid(info->kp_proc.p_pid);
    if (sid < 0) sid_error = errno != 0 ? errno : ESRCH;
  }

  printf(
    "\"pid\":%d,\"ppid\":%d,\"pgid\":%d,\"uid\":%u,"
    "\"start_sec\":%lld,\"start_usec\":%d,\"session_leader\":%s",
    info->kp_proc.p_pid,
    info->kp_eproc.e_ppid,
    info->kp_eproc.e_pgid,
    info->kp_eproc.e_ucred.cr_uid,
    (long long)info->kp_proc.p_starttime.tv_sec,
    info->kp_proc.p_starttime.tv_usec,
    (info->kp_eproc.e_flag & EPROC_SLEADER) ? "true" : "false"
  );
  if (include_sid) {
    if (sid >= 0) printf(",\"sid\":%d", sid);
    else printf(",\"sid\":null,\"sid_errno\":%d", sid_error);
  }
  fputs(",\"comm\":", stdout);
  print_json_string(info->kp_proc.p_comm);
}

static int process_info(pid_t pid) {
  struct kinfo_proc info;
  int e = 0;
  if (load_pid(pid, &info, &e) != 0) {
    printf("{\"ok\":false,\"op\":\"process\",\"pid\":%d,\"errno\":%d,\"error\":", pid, e);
    print_json_string(strerror(e));
    fputs("}\n", stdout);
    return 2;
  }

  errno = 0;
  pid_t sid = getsid(pid);
  if (sid < 0) {
    e = errno != 0 ? errno : ESRCH;
    printf("{\"ok\":false,\"op\":\"process\",\"pid\":%d,\"errno\":%d,\"error\":", pid, e);
    print_json_string(strerror(e));
    fputs("}\n", stdout);
    return 3;
  }

  fputs("{\"ok\":true,\"op\":\"process\",", stdout);
  print_process_fields(&info, 0);
  printf(",\"sid\":%d}\n", sid);
  return 0;
}

static int snapshot_info(void) {
  int mib[3] = { CTL_KERN, KERN_PROC, KERN_PROC_ALL };
  struct kinfo_proc *items = NULL;
  size_t bytes = 0;
  int last_error = 0;

  for (int attempt = 0; attempt < 3; ++attempt) {
    size_t needed = 0;
    errno = 0;
    if (sysctl(mib, 3, NULL, &needed, NULL, 0) != 0 || needed == 0) {
      last_error = errno != 0 ? errno : EIO;
      break;
    }

    size_t capacity = needed + (64 * sizeof(struct kinfo_proc));
    struct kinfo_proc *candidate = (struct kinfo_proc *)calloc(1, capacity);
    if (!candidate) {
      last_error = ENOMEM;
      break;
    }

    size_t actual = capacity;
    errno = 0;
    if (sysctl(mib, 3, candidate, &actual, NULL, 0) == 0) {
      items = candidate;
      bytes = actual;
      last_error = 0;
      break;
    }

    last_error = errno != 0 ? errno : EIO;
    free(candidate);
    if (last_error != ENOMEM) break;
  }

  if (!items) {
    printf("{\"ok\":false,\"op\":\"snapshot\",\"errno\":%d,\"error\":", last_error);
    print_json_string(strerror(last_error));
    fputs("}\n", stdout);
    return 5;
  }

  size_t count = bytes / sizeof(struct kinfo_proc);
  fputs("{\"ok\":true,\"op\":\"snapshot\",\"processes\":[", stdout);
  int emitted = 0;
  for (size_t i = 0; i < count; ++i) {
    const struct kinfo_proc *item = &items[i];
    if (item->kp_proc.p_pid <= 0) continue;
    if (emitted++) putchar(',');
    putchar('{');
    print_process_fields(item, 1);
    putchar('}');
  }
  fputs("]}\n", stdout);
  free(items);
  return 0;
}

static int boot_info(void) {
  struct timeval boot;
  memset(&boot, 0, sizeof(boot));
  size_t len = sizeof(boot);
  errno = 0;
  if (sysctlbyname("kern.boottime", &boot, &len, NULL, 0) != 0 || len != sizeof(boot)) {
    int e = errno != 0 ? errno : EIO;
    printf("{\"ok\":false,\"op\":\"boot\",\"errno\":%d,\"error\":", e);
    print_json_string(strerror(e));
    fputs("}\n", stdout);
    return 4;
  }
  printf(
    "{\"ok\":true,\"op\":\"boot\",\"sec\":%lld,\"usec\":%d}\n",
    (long long)boot.tv_sec,
    boot.tv_usec
  );
  return 0;
}

static int usage(const char *program) {
  fprintf(stderr, "usage: %s process <pid> | snapshot | boot\n", program);
  return 64;
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "boot") == 0) return boot_info();
  if (argc == 2 && strcmp(argv[1], "snapshot") == 0) return snapshot_info();
  if (argc == 3 && strcmp(argv[1], "process") == 0) {
    char *end = NULL;
    errno = 0;
    long raw = strtol(argv[2], &end, 10);
    if (errno != 0 || !end || *end != '\0' || raw <= 0 || raw > INT32_MAX) return usage(argv[0]);
    return process_info((pid_t)raw);
  }
  return usage(argv[0]);
}

#else
#include <stdio.h>
int main(void) {
  fputs("{\"ok\":false,\"error\":\"unsupported_platform\"}\n", stdout);
  return 70;
}
#endif