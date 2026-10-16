"""Descriptor supervisor; never reads corpus or model traffic. Enforces total footprint."""
import sys,json,os,subprocess,signal,time,threading,ctypes,re
from pathlib import Path
config=json.loads(Path(sys.argv[1]).read_text())
# Establish the required footprint observer before starting any child process.
# A missing/incompatible library must not leave unsupervised workers behind.
lib=ctypes.CDLL('/usr/lib/libproc.dylib')
lib.proc_pid_rusage.argtypes=[ctypes.c_int,ctypes.c_int,ctypes.c_void_p]
roots=config.get('observeRoots',[])
if not isinstance(roots,list) or len(roots)>16 or any(type(pid) is not int or pid<2 for pid in roots):raise ValueError('invalid observed pipeline roots')
def observed():
    if not roots:return []
    output=subprocess.check_output(['/bin/ps','-axo','pid=,ppid='],text=True,timeout=2)
    pairs=[tuple(map(int,line.split())) for line in output.splitlines() if line.strip()]
    alive={pid for pid,parent in pairs}; selected=set(roots)&alive
    while True:
        more={pid for pid,parent in pairs if parent in selected}-selected
        if not more:break
        selected.update(more)
    return sorted(selected)
observed() # fail before starting workers if shared-budget observation is unavailable
workers=[];fds=[];passed=[];env=dict(config['env'])
app=None
try:
    for index in range(config.get('count',1)):
        ri,wi=os.pipe();ro,wo=os.pipe();re_,we=os.pipe()
        fds.extend((ri,wi,ro,wo,re_,we));passed.extend((wi,ro,re_))
        worker=subprocess.Popen(config['worker'],stdin=ri,stdout=wo,stderr=we,env=config['workerEnv'],cwd=config['workerCwd'])
        workers.append(worker)
        for key,value in [('IN',wi),('OUT',ro),('ERR',re_),('PID',worker.pid)]:env['PIPELINE_WORKER_'+key+'_'+str(index)]=str(value)
    app=subprocess.Popen(config['application'],env=env,cwd=config['work'],pass_fds=tuple(passed))
except BaseException:
    for worker in workers:
        if worker.poll() is None:worker.kill()
        worker.wait()
    raise
finally:
    for fd in fds:os.close(fd)
def memory(pid):
    data=ctypes.create_string_buffer(1024)
    if lib.proc_pid_rusage(pid,2,data):return None
    values=ctypes.cast(ctypes.addressof(data)+16,ctypes.POINTER(ctypes.c_uint64))
    return {'residentBytes':values[6],'footprintBytes':values[7]}
stop_event=threading.Event();samples=[];exceeded=False
budget=config.get('budgetBytes',32_000_000_000)
def stop(*args,force=False):
    # Signals give the application time to persist its checkpoint while its
    # inference descriptors remain usable. Resource violations still kill all.
    graceful=bool(args) and not force
    processes=([app] if app else [])+([] if graceful else workers)
    for process in processes:
        if process.poll() is None:
            try:process.kill() if force else process.terminate()
            except ProcessLookupError:pass
    if not force:
        def escalate():
            time.sleep(5)
            for process in (([app] if app else [])+workers):
                if process.poll() is None:
                    try:process.kill()
                    except ProcessLookupError:pass
        threading.Thread(target=escalate,daemon=True).start()
def monitor():
    global exceeded
    while not stop_event.is_set():
        identities=[('supervisor',os.getpid())]+[('application',app.pid)] if app.poll() is None else [('supervisor',os.getpid())]
        identities += [('worker:'+str(index),p.pid) for index,p in enumerate(workers) if p.poll() is None]
        try:
            known={pid for role,pid in identities}
            identities += [('observed:'+str(pid),pid) for pid in observed() if pid not in known]
        except (OSError,subprocess.SubprocessError,ValueError):
            exceeded=True;stop(force=True);break
        processes=[]
        for role,pid in identities:
            usage=memory(pid)
            if usage is None and role.startswith('observed:'):
                try:os.kill(pid,0)
                except ProcessLookupError:continue
            processes.append(dict(role=role,pid=pid,**usage) if usage is not None else None)
        if any(p is None for p in processes):
            exceeded=True;stop(force=True);break
        sample={'seconds':time.monotonic()-started,'footprintBytes':sum(p['footprintBytes'] for p in processes),'residentBytes':sum(p['residentBytes'] for p in processes),'processes':processes}
        samples.append(sample)
        if sample['footprintBytes']>budget:
            exceeded=True;print('aggregate process footprint exceeded memory budget',file=sys.stderr);stop(force=True);break
        sample['gpuPercent']=gpu_value
        stop_event.wait(0.25)
gpu_value=None
def gpu_monitor():
    global gpu_value
    while not stop_event.is_set():
        try:
            output=subprocess.check_output(['/usr/sbin/ioreg','-r','-c','IOAccelerator','-l'],text=True,timeout=2)
            match=re.search(r'"Device Utilization %"=(\d+)',output)
            gpu_value=int(match.group(1)) if match else None
        except (OSError,subprocess.SubprocessError):gpu_value=None
        stop_event.wait(0.5)
started=time.monotonic();gpu_thread=threading.Thread(target=gpu_monitor,daemon=True);gpu_thread.start();thread=threading.Thread(target=monitor,daemon=True);thread.start()
signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
try:status=app.wait()
finally:
    stop_event.set();thread.join(timeout=3);gpu_thread.join(timeout=3);stop()
    for worker in workers:
        try:worker.wait(timeout=10)
        except subprocess.TimeoutExpired:worker.kill();worker.wait()
    gpu=[s['gpuPercent'] for s in samples if s.get('gpuPercent') is not None]
    report={'workers':len(workers),'observedRoots':roots,'budgetBytes':budget,'budgetExceeded':exceeded,'peakFootprintBytes':max((s['footprintBytes'] for s in samples),default=0),'peakResidentBytes':max((s['residentBytes'] for s in samples),default=0),'processesAtPeak':max(samples,key=lambda s:s['footprintBytes']).get('processes',[]) if samples else [],'gpuMeanPercent':sum(gpu)/len(gpu) if gpu else None,'gpuPeakPercent':max(gpu) if gpu else None,'gpuScope':'system-wide Apple GPU device utilization; other applications may contribute','samples':samples,'exitCode':status}
    target=Path(config['work'])/'state'/'resources.json';temp=target.with_suffix('.tmp')
    with temp.open('w') as stream:json.dump(report,stream);stream.flush();os.fsync(stream.fileno())
    os.replace(temp,target)
sys.exit(1 if exceeded else status)
