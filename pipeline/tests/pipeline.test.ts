import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, verify } from "../run.ts";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "local-pipeline-"));
  const input = join(root, "input"),
    work = join(root, "work");
  await mkdir(input);
  return { root, input, work };
}
const config = {
  chunkSize: 256,
  concurrency: 3,
  attempts: 3,
  maxBytes: 1024 * 1024,
  roles: ["summarize"],
  model: "synthetic-v1",
  engine: "synthetic" as const,
};
test("end to end lossless chunks, retries, duplicates, unsupported and restart", async () => {
  const f = await fixture();
  const text = "Alpha\r\n😀 beta ".repeat(400);
  await writeFile(join(f.input, "a.txt"), text);
  await writeFile(join(f.input, "b.txt"), text);
  await writeFile(join(f.input, "bad.txt"), Buffer.from([0xff]));
  await writeFile(join(f.input, "bin"), Buffer.from([0, 1]));
  await symlink("a.txt", join(f.input, "link"));
  let calls = 0;
  const infer = async (r: any) => {
    calls++;
    if (r.attempt === 1) throw Error("controlled failure");
    return {
      summary: "Synthetic result",
      facts: [{ claim: "Alpha", start: 0, end: 5 }],
      unknowns: [],
    };
  };
  const first = await run({ ...f, ...config }, infer);
  assert.equal(first.completed, 2);
  assert.equal(first.invalid, 1);
  assert.equal(first.unsupported, 2);
  assert.equal(first.integrity, true);
  const before = calls;
  const second = await run({ ...f, ...config }, infer);
  assert.equal(second.completed, 2);
  assert.equal(calls, before);
  assert.equal((await readdir(f.input)).length, 5);
  const staged = JSON.parse(
    await readFile(join(f.work, "staging", first.sources[0] + ".json"), "utf8"),
  );
  assert.equal(
    staged.chunks.map((c: any) => c.text).join(""),
    text.replaceAll("\r\n", "\n"),
  );
});
test("input overlap, malformed JSONL, exhaustion and evidence are rejected", async () => {
  const f = await fixture();
  await writeFile(join(f.input, "x.jsonl"), "{}\ninvalid\n");
  await writeFile(join(f.input, "huge.txt"), "a".repeat(2000));
  await writeFile(join(f.input, "ok.txt"), "small");
  await assert.rejects(
    run({ ...f, ...config, work: f.input }, async () => ({})),
    /overlap/,
  );
  const r = await run({ ...f, ...config, maxBytes: 1000 }, async () => ({
    summary: "bad",
    facts: [{ claim: "x", start: 0, end: 999 }],
    unknowns: [],
  }));
  assert.equal(r.completed, 0);
  assert.equal(r.invalid, 1);
  assert.equal(r.failed, 2);
  assert.equal(r.integrity, false);
});
test("corrupt outputs and modified source invalidate completion", async () => {
  const f = await fixture();
  await writeFile(join(f.input, "a.txt"), "hello");
  const infer = async () => ({ summary: "hello", facts: [], unknowns: [] });
  await run({ ...f, ...config }, infer);
  const output = join(f.work, "output");
  const file = (await readdir(output)).find((n) => n.endsWith(".json"))!;
  await writeFile(join(output, file), "{}");
  assert.equal((await verify(f.work)).integrity, false);
  const r = await run({ ...f, ...config }, infer);
  assert.equal(r.integrity, true);
  await writeFile(join(f.input, "a.txt"), "changed");
  const r2 = await run({ ...f, ...config }, infer);
  assert.equal(r2.completed, 1);
  assert.equal(r2.integrity, true);
});
test("source anchor references are resolved deterministically rather than inferred character counts", async () => {
  const { valid } = await import("../run.ts");
  assert.equal(
    valid(
      {
        summary: "fact",
        facts: [{ claim: "fact", anchorIds: [0] }],
        unknowns: [],
      },
      "fact",
    ),
    true,
  );
  assert.equal(
    valid(
      {
        summary: "fact",
        facts: [{ claim: "fact", anchorIds: [1] }],
        unknowns: [],
      },
      "fact",
    ),
    false,
  );
});
test("deterministic chunk JSONL is complete and independently parseable", async () => {
  const f = await fixture();
  await writeFile(join(f.input, "text"), "hello\r\nworld");
  const r = await run({ ...f, ...config }, async () => ({
    summary: "hello",
    facts: [],
    unknowns: [],
  }));
  const records = (
    await readFile(join(f.work, "staging", r.sources[0] + ".jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(records.map((c) => c.text).join(""), "hello\nworld");
  assert.equal(records[0].sourceHash.length, 64);
});
test("unexpected output artifacts do not pass reconciliation", async () => {
  const f = await fixture();
  await writeFile(join(f.input, "text"), "hello");
  await run({ ...f, ...config }, async () => ({
    summary: "hello",
    facts: [],
    unknowns: [],
  }));
  await writeFile(join(f.work, "output", "duplicate.json"), "{}");
  assert.equal((await verify(f.work)).integrity, false);
});
test("missing scheduled chunk cannot pass coverage", async () => {
  const f = await fixture();
  await writeFile(join(f.input, "text"), "hello ".repeat(200));
  await run({ ...f, ...config }, async () => ({
    summary: "hello",
    facts: [],
    unknowns: [],
  }));
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(f.work, "state", "pipeline.sqlite"));
  db.prepare(
    "DELETE FROM jobs WHERE id IN (SELECT id FROM jobs LIMIT 1)",
  ).run();
  db.close();
  assert.equal((await verify(f.work)).integrity, false);
});
test("source changed during inference invalidates completion", async () => {
  const f = await fixture();
  await writeFile(join(f.input, "text"), "hello");
  const r = await run({ ...f, ...config }, async () => {
    await writeFile(join(f.input, "text"), "changed");
    return { summary: "hello", facts: [], unknowns: [] };
  });
  assert.equal(r.integrity, false);
});
test("new input during inference is reported as missing coverage", async () => {
  const f = await fixture();
  await writeFile(join(f.input, "first"), "hello");
  const r = await run({ ...f, ...config }, async () => {
    await writeFile(join(f.input, "added"), "new");
    return { summary: "hello", facts: [], unknowns: [] };
  });
  assert.equal(r.integrity, false);
  assert.ok(r.errors.some((e) => e.startsWith("unrecorded-source:")));
});
