import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store.ts";
import { status } from "../status.ts";
test("status does not create a missing checkpoint", async () => {
  const work = await mkdtemp(join(tmpdir(), "status-"));
  assert.equal((await status(work)).phase, "not-started");
  await assert.rejects(stat(join(work, "state", "pipeline.sqlite")));
});
test("read-only status reports durable jobs and a stopped worker as resumable", async () => {
  const work = await mkdtemp(join(tmpdir(), "status-"));
  await mkdir(join(work, "state"));
  const db = new Store(join(work, "state", "pipeline.sqlite"));
  db.db
    .prepare(
      "INSERT INTO jobs(id,source,chunk,role,config,state,attempt) VALUES('one','fixture',0,'tag','config','completed',1),('two','fixture',0,'classify','config','running',1),('three','fixture',0,'summarize','config','pending',0)",
    )
    .run();
  db.close();
  await writeFile(
    join(work, "state", "phase.json"),
    JSON.stringify({ pid: 2147483647, phase: "classify", state: "running" }),
  );
  const report = await status(work);
  assert.equal(report.phase, "interrupted");
  assert.equal(report.resume, true);
  assert.equal(report.jobs.completed, 1);
  assert.equal(report.jobs.running, 1);
  assert.equal(report.jobs.pending, 1);
  assert.equal(report.roles.length, 3);
});
test("live phase is not hidden by an older failed benchmark report", async () => {
  const work = await mkdtemp(join(tmpdir(), "status-live-"));
  await mkdir(join(work, "state"));
  await writeFile(
    join(work, "state", "phase.json"),
    JSON.stringify({ pid: process.pid, phase: "connect", state: "running" }),
  );
  await writeFile(
    join(work, "benchmark.json"),
    JSON.stringify({ qualityErrors: ["old failure"] }),
  );
  const report = await status(work);
  assert.equal(report.alive, true);
  assert.equal(report.phase, "connect");
  assert.equal(report.resume, false);
});
