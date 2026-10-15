import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
test("an unavailable footprint observer cannot start resident workers or the application", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "observer-preflight-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, "child.py"),
    config = join(root, "launcher.json");
  await writeFile(
    script,
    "import sys,time\nfrom pathlib import Path\nPath(sys.argv[1]).write_text('started')\ntime.sleep(.1)\n",
  );
  await writeFile(
    config,
    JSON.stringify({
      count: 1,
      work: root,
      workerCwd: root,
      env: { PATH: "/usr/bin:/bin" },
      workerEnv: { PATH: "/usr/bin:/bin" },
      worker: ["/usr/bin/python3", script, join(root, "worker-started")],
      application: [
        "/usr/bin/python3",
        script,
        join(root, "application-started"),
      ],
    }),
  );
  const child = spawn("/usr/bin/python3", [
    "-c",
    [
      "import ctypes,runpy,sys",
      "def unavailable(*args, **kwargs): raise OSError('footprint observer unavailable')",
      "ctypes.CDLL = unavailable",
      "sys.argv = sys.argv[1:]",
      "runpy.run_path(sys.argv[0], run_name='__main__')",
    ].join("\n"),
    join(import.meta.dirname, "../launch.py"),
    config,
  ]);
  child.stdout.resume();
  let stderr = "";
  child.stderr.on("data", (bytes) => (stderr += bytes));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    // Wait for inherited pipes too, so a wrongly spawned child has time to write its marker.
    child.once("close", resolve);
  });
  assert.notEqual(code, 0);
  assert.match(stderr, /footprint observer unavailable/);
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.endsWith("-started")),
    [],
  );
});
async function fixture(budget: number) {
  const root = await mkdtemp(join(tmpdir(), "budget-"));
  await mkdir(join(root, "state"));
  const script = join(root, "child.py");
  await writeFile(
    script,
    `import signal,time,sys,os\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nblock=bytearray(64*1024*1024)\nif len(sys.argv)>1:\n open(sys.argv[1],'w').write(str(os.getpid()))\nwhile True:time.sleep(.1)\n`,
  );
  const config = join(root, "launcher.json");
  await writeFile(
    config,
    JSON.stringify({
      count: 1,
      budgetBytes: budget,
      work: root,
      workerCwd: root,
      env: { PATH: "/usr/bin:/bin" },
      workerEnv: { PATH: "/usr/bin:/bin" },
      worker: ["/usr/bin/python3", script],
      application: ["/usr/bin/python3", script, join(root, "ready")],
    }),
  );
  const child = spawn("/usr/bin/python3", [
    join(import.meta.dirname, "../launch.py"),
    config,
  ]);
  child.stderr.resume();
  child.stdout.resume();
  const done = new Promise<number | null>((ok, no) => {
    child.on("exit", ok);
    child.on("error", no);
  });
  return { root, child, done };
}
test("aggregate memory breach kills children even when they ignore SIGTERM", async () => {
  const start = performance.now();
  const { root, child, done } = await fixture(80 * 1024 ** 2);
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  try {
    assert.notEqual(await done, 0);
    const resources = JSON.parse(
      await readFile(join(root, "state/resources.json"), "utf8"),
    );
    assert.ok(resources.budgetExceeded);
    assert.ok(resources.processesAtPeak.some((p:{role:string})=>p.role==="application"));
    assert.ok(resources.processesAtPeak.some((p:{role:string})=>p.role==="worker:0"));
    assert.equal(resources.processesAtPeak.reduce((sum:number,p:{footprintBytes:number})=>sum+p.footprintBytes,0),resources.peakFootprintBytes);
    assert.ok(resources.peakFootprintBytes > resources.budgetBytes);
    assert.ok(performance.now() - start < 6000);
  } finally {
    clearTimeout(timer);
  }
});
test("supervisor termination escalates and cannot hang on a resistant application", async () => {
  const { root, child, done } = await fixture(32_000_000_000);
  for (let i = 0; i < 100; i++) {
    try {
      await readFile(join(root, "ready"));
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  const pid = Number(await readFile(join(root, "ready"), "utf8"));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 9000);
  try {
    await done;
    assert.throws(() => process.kill(pid, 0));
    assert.equal(
      JSON.parse(await readFile(join(root, "state/resources.json"), "utf8"))
        .budgetExceeded,
      false,
    );
  } finally {
    clearTimeout(timer);
  }
});

test("application spawn failure cleans up already started resident children", async () => {
  const root = await mkdtemp(join(tmpdir(), "spawn-failure-"));
  const marker = join(root, "pid"),
    script = join(root, "child.py");
  await writeFile(
    script,
    `import os,time\nopen(${JSON.stringify(marker)},'w').write(str(os.getpid()))\ntime.sleep(8)\n`,
  );
  const config = join(root, "launcher.json");
  await writeFile(
    config,
    JSON.stringify({
      count: 1,
      work: root,
      workerCwd: root,
      env: { PATH: "/usr/bin:/bin" },
      workerEnv: { PATH: "/usr/bin:/bin" },
      worker: ["/usr/bin/python3", script],
      application: ["/nonexistent-pipeline-executable"],
    }),
  );
  const child = spawn("/usr/bin/python3", [
    join(import.meta.dirname, "../launch.py"),
    config,
  ]);
  child.stdout.resume();
  child.stderr.resume();
  await new Promise<void>((ok, no) => {
    child.on("exit", () => ok());
    child.on("error", no);
  });
  await new Promise((r) => setTimeout(r, 200));
  let pid: number;
  try {
    pid = Number(await readFile(marker, "utf8"));
  } catch {
    return;
  }
  try {
    assert.throws(
      () => process.kill(pid, 0),
      "resident worker leaked after failed application spawn",
    );
  } finally {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
});

test('normal supervisor termination lets the application checkpoint before stopping model workers',async t=>{
 const root=await mkdtemp('/private/tmp/grace-');t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'state'));
 const worker=join(root,'worker.py'),app=join(root,'app.py'),config=join(root,'config.json');
 await writeFile(worker,`import signal,time,sys\nfrom pathlib import Path\ndef stop(*args):\n Path(sys.argv[1]).write_text('stopped')\n sys.exit(0)\nsignal.signal(signal.SIGTERM,stop)\nwhile True:time.sleep(.01)\n`);
 await writeFile(app,`import signal,time,sys\nfrom pathlib import Path\ndef stop(*args):\n time.sleep(.3)\n if Path(sys.argv[1]).exists():sys.exit(3)\n Path(sys.argv[2]).write_text('committed')\n sys.exit(0)\nsignal.signal(signal.SIGTERM,stop)\nPath(sys.argv[3]).write_text('ready')\nwhile True:time.sleep(.01)\n`);
 const stopped=join(root,'model-stopped'),checkpoint=join(root,'checkpoint'),ready=join(root,'ready');
 await writeFile(config,JSON.stringify({count:1,work:root,workerCwd:root,env:{PATH:'/usr/bin:/bin'},workerEnv:{PATH:'/usr/bin:/bin'},worker:['/usr/bin/python3',worker,stopped],application:['/usr/bin/python3',app,stopped,checkpoint,ready],budgetBytes:1024**3}));
 const child=spawn('/usr/bin/python3',[join(import.meta.dirname,'../launch.py'),config]);child.stdout.resume();child.stderr.resume();
 t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 const done=new Promise<number|null>((ok,no)=>{child.once('error',no);child.once('close',ok);});
 let started=false;for(let n=0;n<200;n++){try{await readFile(ready);started=true;break;}catch{}await new Promise(ok=>setTimeout(ok,10));}
 assert.equal(started,true);child.kill('SIGTERM');assert.equal(await done,0);assert.equal(await readFile(checkpoint,'utf8'),'committed');
});
