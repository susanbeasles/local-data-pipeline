import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile, chmod, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Storage, Executor, Asset, config, provision, configuration } from "../provision.ts";
import { fileHash, seal } from "../seal.ts";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "local-provision-")));
  const storage = Object.fromEntries(["input", "staging", "state", "models", "output"].map((key) => [key, join(root, key)])) as { input: string; staging: string; state: string; models: string; output: string };
  await mkdir(storage.input);
  await writeFile(join(storage.input, "preserved.txt"), "synthetic input");
  const runner = join(root, "tart.ts");
  await writeFile(runner, `#!${process.execPath}
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
const args=process.argv.slice(2),home=process.env.TART_HOME!;
const log=join(home,'calls.json');
const calls=existsSync(log)?JSON.parse(readFileSync(log,'utf8')):[];
calls.push(args);writeFileSync(log,JSON.stringify(calls));
const vm=join(home,'vm.json');
if(args[0]==='get'){
 if(!existsSync(vm)){console.error('VM does not exist');process.exit(1);}
 console.log(readFileSync(vm,'utf8'));
} else if(args[0]==='clone') {
 if(existsSync(vm))process.exit(2);
 writeFileSync(vm,JSON.stringify({OS:'darwin',CPU:4,Memory:4096,Disk:20,MACAddress:'02:00:00:00:00:01',Running:false,State:'stopped'}));
} else if(args[0]==='set') {
 const value=JSON.parse(readFileSync(vm,'utf8'));
 for(let n=2;n<args.length;n+=2){if(args[n]==='--cpu')value.CPU=Number(args[n+1]);if(args[n]==='--memory')value.Memory=Number(args[n+1]);if(args[n]==='--disk-size')value.Disk=Number(args[n+1]);}
 writeFileSync(vm,JSON.stringify(value));
} else process.exit(3);
`);
  await chmod(runner, 0o700);
  const value = {
    format: "pipeline-provision-config/1" as const,
    storage,
    control: { root: join(storage.state, "control") },
    executor: {
      mac: { name: "pipeline-test", runner, home: join(storage.state, "vms"), image: "ghcr.io/cirruslabs/macos-tahoe-base@sha256:" + "a".repeat(64), diskBytes: 20_000_000_000, memoryBytes: 4 * 1024 ** 3, cpus: 4 },
      runner: { path: runner, sha256: await fileHash(runner) },
    },
    metadata: { placement: "pipeline.executor" as const, bootstrap: null },
  };
  return { root, value };
}

test("local storage provisions separate directories and reobserves identity without changing input", async () => {
  const { value } = await fixture();
  const storage = new Storage(value.storage);
  const first = await storage.provision();
  const second = await storage.inspect();
  assert.equal(first.identity, second.identity);
  assert.equal(first.configuration, configuration(value.storage));
  assert.equal(first.qualified, true);
  assert.equal(await readFile(join(value.storage.input, "preserved.txt"), "utf8"), "synthetic input");
});

test("storage aliases and nested corpus paths fail before resource creation", async () => {
  const { root, value } = await fixture();
  await symlink(value.storage.input, join(root, "alias"));
  for (const staging of [join(value.storage.input, "output"), join(root, "alias", "output")]) {
    await assert.rejects(async () => new Storage({ ...value.storage, staging }).provision(), /overlap|alias|corpus/i);
  }
});

test("local target config rejects broadened placement, mutable images and oversized shared memory", async () => {
  const { value } = await fixture();
  assert.equal(config(value).metadata.placement, "pipeline.executor");
  const changes: Array<(v: typeof value) => void> = [
    (v) => { Reflect.set(v.metadata, "placement", "host"); },
    (v) => { v.executor.mac.image = "ghcr.io/cirruslabs/macos-tahoe-base:latest"; },
    (v) => { v.executor.mac.memoryBytes = 32 * 1024 ** 3; },
    (v) => { v.executor.mac.home = v.storage.input; },
    (v) => { v.executor.runner.sha256 = "unknown"; },
    (v) => { Reflect.set(v.executor.mac, "mounts", [v.storage.input]); },
  ];
  for (const change of changes) { const copy = structuredClone(value); change(copy); assert.throws(() => config(copy)); }
});

test("VM resources use pinned Tart commands, retain image provenance and never start a VM during provisioning", async () => {
  const { value } = await fixture();
  await new Storage(value.storage).provision();
  const executor = new Executor(config(value));
  const first = await executor.provision();
  const second = await executor.provision();
  assert.equal(first.identity, second.identity);
  assert.equal(first.qualified, false);
  const calls = JSON.parse(await readFile(join(value.executor.mac.home, "calls.json"), "utf8")) as string[][];
  assert.equal(calls.filter((args) => args[0] === "clone").length, 1);
  assert.ok(calls.some((args) => args[0] === "set" && args.includes("--disk-size")));
  assert.ok(calls.every((args) => !["run", "exec", "delete", "prune"].includes(args[0])));
  await writeFile(value.executor.runner.path, "tampered");
  await assert.rejects(executor.inspect(), /digest|integrity/i);
});

test("missing guest metadata bootstrap cannot issue a provisioned or qualified receipt", async () => {
  const { value } = await fixture();
  await assert.rejects(provision({ format: "pipeline-provision-request/1", operation: "provision", spec: "a".repeat(64), request: "synthetic-request", config: value }), /guest.*bootstrap/i);
});

test("preexisting model assets require exact content digests and remain unqualified", async () => {
  const { value } = await fixture();
  await mkdir(value.storage.models);
  await writeFile(join(value.storage.models, "synthetic.bin"), "synthetic model bytes");
  const pin = { root: value.storage.models, sha256: (await seal(value.storage.models)).hash };
  const asset = new Asset("model", pin, value.storage.input);
  const observed = await asset.inspect();
  assert.equal(observed.identity, "sha256:" + pin.sha256);
  assert.equal(observed.qualified, false);
  await writeFile(join(value.storage.models, "synthetic.bin"), "tampered");
  await assert.rejects(asset.inspect(), /digest.*integrity/i);
});

test("runtime asset aliases cannot traverse into input records", async () => {
  const { root, value } = await fixture();
  const runtime = join(root, "runtime"); await mkdir(runtime);
  await symlink(join(value.storage.input, "preserved.txt"), join(runtime, "forbidden"));
  await assert.rejects(new Asset("runtime", { root: runtime, sha256: "a".repeat(64) }, value.storage.input).inspect(), /corpus/i);
});
