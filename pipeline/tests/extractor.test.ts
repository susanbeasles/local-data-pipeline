import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { seal } from "../seal.ts";
import { inspect, load } from "../extractor.ts";
import { launch } from "../sandbox.ts";
import { source } from "../source.ts";
test("extractor contract preserves raw hash and rejects normalized exhaustion", async () => {
  const root = await mkdtemp(join(tmpdir(), "extract-contract-"));
  const path = join(root, "binary");
  await writeFile(path, Buffer.from([0, 1, 2]));
  const a = await source(root, path, 100, 20, {
    extract: () => ({ text: "Alpha", format: "synthetic" }),
  });
  assert.equal(a.state, "pending");
  assert.equal(a.chunks.map((c) => c.text).join(""), "Alpha");
  assert.equal(a.hash?.length, 64);
  const b = await source(root, path, 100, 20, {
    extract: () => ({ text: "x".repeat(101), format: "synthetic" }),
  });
  assert.equal(b.state, "failed");
  const c = await source(root, path, 100, 20, {
    extract: () => ({ unsupported: "No codec" }),
  });
  assert.equal(c.state, "unsupported");
  assert.equal(c.hash, a.hash);
});
test("sealed extractor executes only under OS restrictions and participates in resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "extractor-"));
  const input = join(root, "input"),
    work = join(root, "work"),
    directory = join(root, "extension");
  await mkdir(input);
  await mkdir(directory);
  await writeFile(join(input, "binary"), Buffer.from([0, 1, 2]));
  await writeFile(
    join(directory, "main.ts"),
    "export function extract(source: {bytes:Uint8Array}) {return {text:'Alpha',format:'fixture'};}\n",
  );
  const ext = {
    directory,
    entry: "main.ts",
    hash: (await seal(directory)).hash,
  };
  await inspect(ext, input);
  await assert.rejects(load(ext, input), /OS network denial/);
  const config = {
    input,
    work,
    extractor: ext,
    roles: ["summary"],
    engine: "synthetic",
    model: "fixture",
    chunkSize: 256,
    maxBytes: 1000,
    concurrency: 1,
    attempts: 1,
  };
  const script = join(root, "run.ts");
  await writeFile(
    script,
    `import {run} from ${JSON.stringify(join(import.meta.dirname, "../run.ts"))};import {writeFile} from 'node:fs/promises';const config=${JSON.stringify(config)};let calls=0;const infer=async()=>{calls++;return {summary:'Alpha',facts:[],unknowns:[]};};const first=await run(config,infer);const second=await run({...config,resume:true},infer);await writeFile(${JSON.stringify(join(work, "result.json"))},JSON.stringify({first,second,calls}));`,
  );
  assert.equal(await launch(input, work, script, []), 0);
  const result = JSON.parse(await readFile(join(work, "result.json"), "utf8"));
  assert.equal(result.first.integrity, true);
  assert.equal(result.second.integrity, true);
  assert.equal(result.calls, 1);
  await writeFile(join(directory, "main.ts"), 'throw Error("tampered")');
  await assert.rejects(inspect(ext, input), /integrity/);
  await assert.rejects(inspect({ ...ext, directory: input }, input), /overlap/);
});

test("oversized binary input stays unsupported with a complete source hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "binary-budget-"));
  const path = join(root, "fixture.bin");
  await writeFile(path, Buffer.alloc(4096));
  const result = await source(root, path, 128, 64);
  assert.equal(result.state, "unsupported");
  assert.equal(result.reason, "binary format has no installed extractor");
  assert.equal(result.hash?.length, 64);
  const text = join(root, "large.log");
  await writeFile(text, "A".repeat(4096));
  assert.equal((await source(root, text, 128, 64)).state, "failed");
});
