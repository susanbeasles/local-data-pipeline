#include "CPty.h"
#include <util.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/ioctl.h>
/* Child uses only async-signal-safe calls between fork and exec. */
pid_t pipeline_pty(const char *file, char *const argv[], char *const env[], int *fd, unsigned short cols, unsigned short rows) {
 struct winsize size = {.ws_col=cols,.ws_row=rows};
 long limit = sysconf(_SC_OPEN_MAX);
 if(limit<0) limit=10240;
 pid_t pid = forkpty(fd,0,0,&size);
 if(pid==0) {
  /* Do not leak dashboard file handles or control channels into the CLI. */
  for(int handle=3;handle<limit;handle++) close(handle);
  execve(file,argv,env); _exit(127);
 }
 if(pid>0) { fcntl(*fd,F_SETFD,FD_CLOEXEC); fcntl(*fd,F_SETFL,O_NONBLOCK); }
 return pid;
}
