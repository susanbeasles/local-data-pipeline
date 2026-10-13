"""Descriptor supervisor; never reads corpus or model traffic. Enforces total footprint."""
import sys,json,os,subprocess,signal,time,threading,ctypes,re
from pathlib import Path
config=json.loads(Path(sys.argv[1]).read_text())
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
lib=ctypes.CDLL('/usr/lib/libproc.dylib')
lib.proc_pid_rusage.argtypes=[ctypes.c_int,ctypes.c_int,ctypes.c_void_p]
def memory(pid):
    data=ctypes.create_string_buffer(1024)
    if lib.proc_pid_rusage(pid,2,data):return None
    values=ctypes.cast(ctypes.addressof(data)+16,ctypes.POINTER(ctypes.c_uint64))
    return {'residentBytes':values[6],'footprintBytes':values[7]}
stop_event=threading.Event();samples=[];exceeded=False
budget=config.get('budgetBytes',32_000_000_000)
def stop(*args,force=False):
    processes=([app] if app else [])+workers
    for process in processes:
        if process.poll() is None:
            try:process.kill() if force else process.terminate()
            except ProcessLookupError:pass
    if not force:
        def escalate():
            time.sleep(5)
            for process in processes:
                if process.poll() is None:
                    try:process.kill()
                    except ProcessLookupError:pass
        threading.Thread(target=escalate,daemon=True).start()
def monitor():
    global exceeded
    while not stop_event.is_set():
        processes=[memory(os.getpid())]+[memory(p.pid) for p in [app]+workers if p.poll() is None]
        if any(p is None for p in processes):
            exceeded=True;stop(force=True);break
        sample={'seconds':time.monotonic()-started,'footprintBytes':sum(p['footprintBytes'] for p in processes),'residentBytes':sum(p['residentBytes'] for p in processes)}
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
    report={'workers':len(workers),'budgetBytes':budget,'budgetExceeded':exceeded,'peakFootprintBytes':max((s['footprintBytes'] for s in samples),default=0),'peakResidentBytes':max((s['residentBytes'] for s in samples),default=0),'gpuMeanPercent':sum(gpu)/len(gpu) if gpu else None,'gpuPeakPercent':max(gpu) if gpu else None,'gpuScope':'system-wide Apple GPU device utilization; other applications may contribute','samples':samples,'exitCode':status}
    target=Path(config['work'])/'state'/'resources.json';temp=target.with_suffix('.tmp')
    with temp.open('w') as stream:json.dump(report,stream);stream.flush();os.fsync(stream.fileno())
    os.replace(temp,target)
sys.exit(1 if exceeded else status)
