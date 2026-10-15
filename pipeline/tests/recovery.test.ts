import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { run, verify } from "../run.ts";
import { DatabaseSync } from "node:sqlite";
const options = {
  chunkSize: 256,
  concurrency: 2,
  attempts: 3,
  maxBytes: 100000,
  roles: ["summarize"],
  model: "synthetic-v1",
  engine: "synthetic" as const,
};
test("explicit resume retries exhausted failures with a fresh bounded budget and skips completed work", async () => {
  const root = await mkdtemp(join(tmpdir(), "resume-")),
    input = join(root, "input"),
    work = join(root, "work");
  await mkdir(input);
  await writeFile(join(input, "a.txt"), "Alpha.");
  await writeFile(join(input, "b.txt"), "Beta.");
  let calls = 0;
  const cfg = { ...options, input, work, attempts: 1 };
  const first = await run(cfg, async (r) => {
    calls++;
    if (r.text === "Beta.") throw Error("controlled exhausted failure");
    return { summary: r.text, facts: [], unknowns: [] };
  });
  assert.equal(first.completed, 1);
  assert.equal(first.failed, 1);
  const resumed = await run({ ...cfg, resume: true }, async (r) => {
    calls++;
    assert.equal(r.text, "Beta.");
    return { summary: r.text, facts: [], unknowns: [] };
  });
  assert.ok(resumed.integrity);
  assert.equal(resumed.completed, 2);
  assert.equal(calls, 3);
  const db = new DatabaseSync(join(work, "state", "pipeline.sqlite"), {
    readOnly: true,
  });
  assert.equal(
    db.prepare("SELECT count(*) total FROM attempts WHERE state='failed'").get()!.total,
    1,
  );
  assert.equal(db.prepare("SELECT max(attempt) latest FROM attempts").get()!.latest, 2);
  db.close();
});
test("SIGKILL leaves durable running attempt, restart recovers it exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "kill-test-")),
    input = join(root, "input"),
    work = join(root, "work");
  await mkdir(input);
  await writeFile(join(input, "text"), "hello");
  const script = join(root, "crash.ts");
  await writeFile(
    script,
    `import {run} from ${JSON.stringify(new URL("../run.ts", import.meta.url).pathname)};await run(${JSON.stringify({ ...options, input, work })},async()=>{console.log('INFERENCE_STARTED');await new Promise(()=>{});});`,
  );
  const child = spawn(process.execPath, [script]);
  await new Promise<void>((ok, no) => {
    child.stdout.on("data", (b) => {
      if (b.toString().includes("INFERENCE_STARTED")) ok();
    });
    child.on("error", no);
    child.on("exit", () => no(Error("early exit")));
  });
  child.kill("SIGKILL");
  await new Promise((ok) => child.on("exit", ok));
  const result = await run({ ...options, input, work }, async () => ({
    summary: "hello",
    facts: [],
    unknowns: [],
  }));
  assert.equal(result.completed, 1);
  assert.equal(result.integrity, true);
  const db = new DatabaseSync(join(work, "state", "pipeline.sqlite"));
  const attempts = db.prepare("SELECT * FROM attempts ORDER BY attempt").all();
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].state, "interrupted");
  assert.equal(attempts[1].state, "completed");
  db.close();
});
test("concurrent runs exclude each other; scheduler bounds active work", async () => {
  const root = await mkdtemp(join(tmpdir(), "concurrency-")),
    input = join(root, "input"),
    work = join(root, "work");
  await mkdir(input);
  for (let i = 0; i < 10; i++) await writeFile(join(input, i + ".txt"), "hello");
  let active = 0,
    peak = 0;
  let started!: () => void;
  const ready = new Promise<void>((ok) => (started = ok));
  const running = run({ ...options, input, work }, async () => {
    active++;
    peak = Math.max(peak, active);
    started();
    await new Promise((ok) => setTimeout(ok, 10));
    active--;
    return { summary: "hello", facts: [], unknowns: [] };
  });
  await ready;
  await assert.rejects(
    run({ ...options, input, work }, async () => ({})),
    /already active/,
  );
  const report = await running;
  assert.equal(report.completed, 10);
  assert.equal(peak, 2);
});
test("normalized source hashes cannot reconcile as complete after database corruption", async () => {
  const root = await mkdtemp(join(tmpdir(), "hash-test-")),
    input = join(root, "input"),
    work = join(root, "work");
  await mkdir(input);
  await writeFile(join(input, "text"), "hello");
  await run({ ...options, input, work }, async () => ({
    summary: "hello",
    facts: [],
    unknowns: [],
  }));
  const db = new DatabaseSync(join(work, "state/pipeline.sqlite"));
  db.exec("UPDATE source_data SET body=json_set(body,'$.hash','corrupt')");
  db.close();
  assert.equal((await verify(work)).integrity, false);
});
test("empty lock file is recoverable and kernel lock releases after interruption", async () => {
  const root = await mkdtemp(join(tmpdir(), "empty-lock-")),
    input = join(root, "input"),
    work = join(root, "work");
  await mkdir(input);
  await mkdir(join(work, "state"), { recursive: true });
  await writeFile(join(work, "state", "run.lock"), "");
  await writeFile(join(input, "text"), "hello");
  assert.equal(
    (
      await run({ ...options, input, work }, async () => ({
        summary: "hello",
        facts: [],
        unknowns: [],
      }))
    ).integrity,
    true,
  );
});
test("fatal worker death preserves unstarted jobs and restart completes them", async () => {
  const root = await mkdtemp(join(tmpdir(), "fatal-worker-")),
    input = join(root, "input"),
    work = join(root, "work");
  await mkdir(input);
  for (let i = 0; i < 5; i++) await writeFile(join(input, i + ".txt"), "hello");
  const { WorkerFailure } = await import("../errors.ts");
  const first = await run({ ...options, input, work }, async () => {
    throw new WorkerFailure("controlled worker death");
  });
  assert.equal(first.failed, 0);
  assert.equal(first.pending, 5);
  assert.equal(first.integrity, false);
  const second = await run({ ...options, input, work }, async () => ({
    summary: "hello",
    facts: [],
    unknowns: [],
  }));
  assert.equal(second.completed, 5);
  assert.equal(second.integrity, true);
});
