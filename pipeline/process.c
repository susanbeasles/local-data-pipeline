/* Nonprivileged macOS process birth identity for sandboxed local workers. */
#include <libproc.h>
#include <sys/proc_info.h>
#include <stdio.h>
#include <stdlib.h>
#include <limits.h>
int main(int argc, char **argv) {
  if (argc != 2) return 64;
  char *end; long value = strtol(argv[1], &end, 10);
  if (*end || value < 1 || value > INT_MAX) return 64;
  struct proc_bsdinfo info;
  if (proc_pidinfo((int)value, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) return 1;
  char path[PROC_PIDPATHINFO_MAXSIZE];
  if (proc_pidpath((int)value, path, sizeof(path)) <= 0) return 1;
  printf("%llu:%llu:%s\n", info.pbi_start_tvsec, info.pbi_start_tvusec, path);
  return 0;
}
