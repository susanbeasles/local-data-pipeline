import { assets } from "../local.ts";
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
  execFileSync("/usr/bin/sandbox-exec", ["-f", sb, process.execPath, "-e", program]);
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
  const box = await sandbox(assets().runtime, assets().base, script, assets().package);
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

test("PostgreSQL access allows one canonical Unix socket while TCP and other sockets stay denied", async (t) => {
  const { createServer } = await import("node:net");
  const { realpath, rm, chmod } = await import("node:fs/promises");
  const { promisify } = await import("node:util");
  const { execFile } = await import("node:child_process");
  const root = await mkdtemp("/private/tmp/pg-box-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, "input"),
    work = join(root, "work"),
    socket = join(work, "pg");
  await mkdir(input);
  await mkdir(work);
  await mkdir(socket, { mode: 0o700 });
  const allowed = join(socket, ".s.PGSQL.5432"),
    denied = join(socket, ".s.PGSQL.5433");
  const servers = [createServer((s) => s.end()), createServer((s) => s.end())];
  for (const [index, server] of servers.entries()) {
    await new Promise<void>((ok, no) => {
      server.once("error", no);
      server.listen([allowed, denied][index], ok);
    });
    t.after(() => new Promise<void>((ok) => server.close(() => ok())));
  }
  const sb = join(root, "runtime.sb");
  await writeFile(sb, await profile(input, work, { socket }));
  const program = `const net=require('node:net');const probe=options=>new Promise(resolve=>{const s=net.connect(options);s.on('connect',()=>{s.destroy();resolve('connected')});s.on('error',e=>resolve(e.code));});(async()=>{const result=[await probe({path:${JSON.stringify(allowed)}}),await probe({path:${JSON.stringify(denied)}}),await probe({port:9,host:'127.0.0.1'})];console.log(JSON.stringify(result));})();`;
  const result = await promisify(execFile)(
    "/usr/bin/sandbox-exec",
    ["-f", sb, process.execPath, "-e", program],
    { timeout: 10000 },
  );
  assert.deepEqual(JSON.parse(result.stdout), ["connected", "EPERM", "EPERM"]);
  await assert.rejects(profile(input, work, { socket: input }), /socket|work/i);
  const alias = join(work, "alias");
  const { symlink } = await import("node:fs/promises");
  await symlink(socket, alias);
  await assert.rejects(profile(input, work, { socket: alias }), /canonical|alias/i);
  await chmod(socket, 0o777);
  await assert.rejects(profile(input, work, { socket }), /permission|writable/i);
  assert.equal(await realpath(root), root);
});
