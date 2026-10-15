"""Give a VM an isolated Ethernet endpoint. Every emitted frame is discarded.

No NAT, host bridge, TCP listener or Internet connection is created. Commands
execute through the hypervisor's guest-agent channel, independently of IP.
"""
import os,sys,socket,subprocess,signal,selectors
if len(sys.argv)<4:raise SystemExit('VM runner and arguments required')
left,right=socket.socketpair(socket.AF_UNIX,socket.SOCK_DGRAM)
right.set_inheritable(True)
args=sys.argv[1:];args.insert(len(args)-1,'--net-fd='+str(right.fileno()))
child=subprocess.Popen(args,pass_fds=(right.fileno(),),start_new_session=True)
right.close()
def stop(signum,frame):
    try:os.killpg(child.pid,signum)
    except ProcessLookupError:pass
for sig in (signal.SIGINT,signal.SIGTERM):signal.signal(sig,stop)
poll=selectors.DefaultSelector();poll.register(left,selectors.EVENT_READ)
try:
    while child.poll() is None:
        for key,_ in poll.select(.25):
            key.fileobj.recv(65536)  # Deliberately no forwarding path.
finally:
    poll.close();left.close()
raise SystemExit(child.wait())
