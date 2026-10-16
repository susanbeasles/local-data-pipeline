"""Kernel-managed lock: process death and stdin EOF release ownership."""
import sys,fcntl,json,os
with open(sys.argv[1],'a+') as handle:
    try:fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:
        print(json.dumps({'status':'busy'}),flush=True);sys.exit(2)
    handle.seek(0);handle.truncate();handle.write(json.dumps({'pid':os.getpid()}));handle.flush();os.fsync(handle.fileno())
    print(json.dumps({'status':'locked'}),flush=True)
    sys.stdin.buffer.read()
