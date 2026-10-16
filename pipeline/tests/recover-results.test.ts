import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, hash } from "../store.ts";
import { recover } from "../recover-results.ts";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "receipts-"));
  await mkdir(join(root, "state"));
  await mkdir(join(root, "output"));
  const store = new Store(join(root, "state/pipeline.sqlite"));
  const chunk = { id: "chunk", index: 0, start: 0, end: 5, text: "hello", hash: hash("hello") };
  const source = { id: "s", path: "a", hash: hash("hello"), state: "pending", chunks: [chunk] };
  store.records.ingest(source as any, { roles: ["tag"], configHash: "cfg" });
  store.db
    .prepare("INSERT INTO sources VALUES(?,?,?,?,?,?,?,?)")
    .run("s", "a", source.hash, "pending", null, "stage", "digest", "generation");
  const job = hash("chunk:tag:cfg"),
    r = {
      job,
      source: "s",
      sourceHash: source.hash,
      chunk: "chunk",
      chunkHash: chunk.hash,
      role: "tag",
      configHash: "cfg",
      model: "model",
      attempt: 1,
      payload: {},
      result: { tags: ["test"] },
    };
  store.records.write(job, r);
  store.db.prepare("INSERT INTO attempts VALUES(?,?,?,?,?)").run(job, 1, "completed", null, "time");
  store.close();
  const path = join(root, "output", job + ".json");
  await writeFile(path, JSON.stringify(r) + "\n");
  return { root, path, job };
}
test("verified saved result reattaches once and remains idempotent", async () => {
  const f = await fixture();
  assert.deepEqual(await recover(f.root), { verified: 1, restored: 1 });
  assert.deepEqual(await recover(f.root), { verified: 1, restored: 0 });
});
test("corrupt output cannot restore completed state", async () => {
  const f = await fixture();
  await writeFile(f.path, "corrupt");
  await assert.rejects(recover(f.root), /hash/);
  const s = new Store(join(f.root, "state/pipeline.sqlite"));
  assert.equal(s.db.prepare("SELECT count(*) n FROM jobs").get()!.n, 0);
  s.close();
});
