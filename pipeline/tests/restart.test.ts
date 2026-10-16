import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.ts";
import { hash } from "../store.ts";
test("identical normalized source avoids writes but repairs corrupt chunks", () => {
  const s = new Store(":memory:");
  const chunk = { id: "c", index: 0, start: 0, end: 5, text: "hello", hash: hash("hello") };
  const source = { id: "s", path: "a", hash: hash("hello"), state: "pending", chunks: [chunk] };
  const context = { roles: ["tag"], configHash: "cfg" };
  s.records.ingest(source as any, context);
  const before = s.db.prepare("SELECT total_changes() n").get()!.n;
  s.records.ingest(source as any, context);
  assert.equal(s.db.prepare("SELECT total_changes() n").get()!.n, before);
  s.db.exec("UPDATE chunk_data SET digest='broken'");
  s.records.ingest(source as any, context);
  assert.equal(s.records.chunk("s", 0)?.text, "hello");
  s.close();
});

import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Jobs } from "../jobs.ts";
test("recreated job counters recover from durable attempt history", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "counters-")), "state.sqlite");
  let s = new Store(path);
  s.db.exec(
    "INSERT INTO jobs(id,source,chunk,role,config,state) VALUES('job','source',0,'tag','cfg','pending');INSERT INTO attempts VALUES('job',4,'interrupted',NULL,'time')",
  );
  s.close();
  s = new Store(path);
  assert.equal(s.db.prepare("SELECT attempt FROM jobs WHERE id='job'").get()!.attempt, 4);
  assert.equal(new Jobs(s, 1).claim()?.attempt, 5);
  assert.equal(s.db.prepare("SELECT count(*) n FROM attempts").get()!.n, 2);
  s.close();
});
