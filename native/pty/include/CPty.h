#include <sys/types.h>
pid_t pipeline_pty(const char *file, char *const argv[], char *const env[], int *fd, unsigned short cols, unsigned short rows);
