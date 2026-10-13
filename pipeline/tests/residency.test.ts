import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { profile } from "../sandbox.ts";

test("four independent resident processes feed centralized durable results and resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "residency-")),
    input = join(root, "input"),
    work = join(root, "work");
  await mkdir(input);
  await mkdir(work);
  await mkdir(join(work, "state"));
  for (let i = 0; i < 32; i++)
    await writeFile(join(input, `${i}.txt`), `Synthetic ${i}`);
  const script = join(root, "worker.py"),
    application = join(root, "app.ts"),
    seatbelt = join(root, "runtime.sb");
  await writeFile(
    script,
    `import sys,json,os,time\nprint(json.dumps({'ready':True}),flush=True)\nfor line in sys.stdin:\n r=json.loads(line);time.sleep(.005)\n print(json.dumps({'id':r['id'],'result':{'summary':str(os.getpid()),'facts':[],'unknowns':[]}}),flush=True)\n`,
  );
  const project = join(import.meta.dirname, "..");
  await writeFile(
    application,
    `
 import {pool} from ${JSON.stringify(join(project, "mlx.ts"))};
 import {run} from ${JSON.stringify(join(project, "run.ts"))};
 import {writeFile} from 'node:fs/promises';
 const model={workers:4,budgetBytes:32_000_000_000,memoryBytes:7_750_000_000,batchSize:2,runtime:'unused',base:'unused',adapters:{summarize:'unused'},timeoutMs:5000,maxTokens:256};
 const workers=pool(model);await workers.ready;
 try{
  const cfg={input:${JSON.stringify(input)},work:${JSON.stringify(work)},chunkSize:6000,concurrency:8,attempts:2,maxBytes:1024,roles:['summarize'],model:'process-integration',engine:'mlx'};
  const first=await run(cfg,r=>workers.infer(r));
  const second=await run(cfg,()=>{throw Error('completed result was re-inferred');});
  await writeFile(${JSON.stringify(join(work, "checks.json"))},JSON.stringify({first,second,stats:await workers.stats()}));
 }finally{await workers.close();}
 `,
  );
  await writeFile(seatbelt, await profile(input, work));
  const config = join(root, "launch.json");
  await writeFile(
    config,
    JSON.stringify({
      count: 4,
      budgetBytes: 32_000_000_000,
      work,
      workerCwd: root,
      env: { PATH: "/usr/bin:/bin" },
      workerEnv: { PATH: "/usr/bin:/bin" },
      worker: ["/usr/bin/python3", script],
      application: [
        "/usr/bin/sandbox-exec",
        "-f",
        seatbelt,
        process.execPath,
        application,
      ],
    }),
  );
  const child = spawn("/usr/bin/python3", [join(project, "launch.py"), config]);
  let log = "";
  child.stdout.on("data", (b) => (log += b));
  child.stderr.on("data", (b) => (log += b));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  assert.equal(code, 0, log);
  const checks = JSON.parse(await readFile(join(work, "checks.json"), "utf8"));
  assert.equal(checks.first.completed, 32);
  assert.ok(checks.first.integrity);
  assert.ok(checks.second.integrity);
  assert.equal(checks.stats.length, 4);
  assert.ok(checks.stats.every((s: any) => s.responses > 0));
  const pids = new Set(
    await Promise.all(
      (await readdir(join(work, "output"))).map(
        async (file) =>
          JSON.parse(await readFile(join(work, "output", file), "utf8")).result
            .summary,
      ),
    ),
  );
  assert.equal(pids.size, 4);
  const resources = JSON.parse(
    await readFile(join(work, "state/resources.json"), "utf8"),
  );
  assert.equal(resources.workers, 4);
  assert.equal(resources.budgetExceeded, false);
  assert.ok(resources.peakFootprintBytes > 0);
});
