import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { profile } from "../sandbox.ts";
test("OS denies network and input writes, permits designated work writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandbox-test-")),
    input = join(root, "input"),
    work = join(root, "work");
  await mkdir(input);
  await mkdir(work);
  await writeFile(join(input, "original"), "keep");
  const sb = join(root, "runtime.sb");
  await writeFile(sb, await profile(input, work));
  const program = `const fs=require('node:fs');try{fs.writeFileSync(${JSON.stringify(join(input, "original"))},'bad');process.exit(3)}catch(e){if(e.code!=='EPERM')throw e}fs.writeFileSync(${JSON.stringify(join(work, "ok"))},'ok');const s=require('node:net').connect(9,'127.0.0.1');s.on('error',e=>process.exit(e.code==='EPERM'?0:4));`;
  execFileSync("/usr/bin/sandbox-exec", [
    "-f",
    sb,
    process.execPath,
    "-e",
    program,
  ]);
  assert.equal(await readFile(join(input, "original"), "utf8"), "keep");
  assert.equal(await readFile(join(work, "ok"), "utf8"), "ok");
});
test("model sandbox denies network, arbitrary file reads, all writes and process fork", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-guard-")),
    input = join(root, "protected.txt"),
    script = join(root, "probe.py");
  await writeFile(input, "synthetic protected fixture");
  await writeFile(
    script,
    `import socket,os,json\nchecks={}\ns=socket.socket()\ntry:s.connect(('127.0.0.1',9));checks['network']=False\nexcept PermissionError:checks['network']=True\ntry:open(${JSON.stringify(input)}).read();checks['read']=False\nexcept PermissionError:checks['read']=True\ntry:open('denied.txt','w').write('x');checks['write']=False\nexcept PermissionError:checks['write']=True\ntry:os.fork();checks['fork']=False\nexcept PermissionError:checks['fork']=True\nprint(json.dumps(checks))\n`,
  );
  const { sandbox } = await import("../legacy/sandbox.ts");
  const box = await sandbox(
    "/Users/avespoli/SonarMD-Dump-2026-10-09/enrichment/runtime",
    "/Users/avespoli/SonarMD-Dump-2026-10-09/enrichment/models/qwen2.5-3b-official",
    script,
    "/Users/avespoli/local-data-pipeline/models/anchors-experiment",
  );
  try {
    const child = box.launch([script]);
    let output = "",
      diagnostic = "";
    child.stdout.on("data", (b) => (output += b));
    child.stderr.on("data", (b) => (diagnostic += b));
    const code = await new Promise<number | null>((ok, no) => {
      child.once("error", no);
      child.once("exit", ok);
    });
    assert.equal(code, 0, diagnostic);
    assert.deepEqual(JSON.parse(output), {
      network: true,
      read: true,
      write: true,
      fork: true,
    });
  } finally {
    await box.close();
  }
});
