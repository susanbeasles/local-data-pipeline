import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../store.ts";
import { run } from "../run.ts";
test("inference reads normalized chunks and prior results from SQLite when exports disappear", async () => {
  const root = await mkdtemp(join(tmpdir(), "records-")),
    input = join(root, "input"),
    work = join(root, "work");
  await mkdir(input);
  await writeFile(join(input, "a.txt"), "Alpha is local.");
  let calls = 0;
  const report = await run(
    {
      input,
      work,
      roles: ["first", "second"],
      engine: "synthetic",
      model: "fixture",
      chunkSize: 128,
      maxBytes: 10000,
      attempts: 1,
      concurrency: 1,
      profile: {
        format: "enrichment/1",
        name: "test",
        stages: [
          {
            name: "first",
            system: "tag",
            maxTokens: 128,
            schema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false,
            },
          },
          {
            name: "second",
            system: "classify",
            maxTokens: 128,
            schema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false,
            },
          },
        ],
      },
    },
    async (request) => {
      calls++;
      assert.equal(request.text, "Alpha is local.");
      for (const name of await readdir(join(work, "staging")))
        if (!name.endsWith(".jsonl")) await rm(join(work, "staging", name), { force: true });
      await rm(join(work, "output"), { recursive: true, force: true });
      if (request.role === "second")
        assert.deepEqual(request.payload?.prior, { first: { value: "first" } });
      return { value: request.role };
    },
  );
  assert.equal(calls, 2);
  assert.equal(report.completed, 1);
  assert.equal(report.integrity, true);
  const db = new Store(join(work, "state/pipeline.sqlite"));
  assert.equal(
    db.records.chunk(db.db.prepare("SELECT id FROM sources").get()!.id as string, 0)?.text,
    "Alpha is local.",
  );
  assert.equal(db.db.prepare("SELECT count(*) n FROM results").get()!.n, 2);
  db.close();
});
test("SQLite payload hashes reject tampering and missing results", () => {
  const db = new Store(":memory:");
  db.records.write("job", { job: "job", result: { value: "ok" } });
  assert.deepEqual(db.records.result("job").result, { value: "ok" });
  db.db
    .prepare("UPDATE results SET body=json_set(body,'$.result.value','wrong') WHERE job='job'")
    .run();
  assert.throws(() => db.records.result("job"), /hash/);
  assert.throws(() => db.records.result("missing"), /missing/);
  db.close();
});

test("missing or corrupt normalized SQLite chunks cannot reconcile as complete", async () => {
  const { verify } = await import("../run.ts");
  const root = await mkdtemp(join(tmpdir(), "records-corrupt-")),
    input = join(root, "input"),
    work = join(root, "work");
  await mkdir(input);
  await writeFile(join(input, "a.txt"), "Alpha.");
  await run(
    {
      input,
      work,
      roles: ["summarize"],
      engine: "synthetic",
      model: "fixture",
      chunkSize: 128,
      maxBytes: 10000,
      attempts: 1,
      concurrency: 1,
    },
    async () => ({ summary: "Alpha.", facts: [], unknowns: [] }),
  );
  const db = new Store(join(work, "state/pipeline.sqlite"));
  db.db.prepare("UPDATE chunk_data SET body=json_set(body,'$.text','corrupt')").run();
  db.close();
  assert.equal((await verify(work)).integrity, false);
  const missing = new Store(join(work, "state/pipeline.sqlite"));
  missing.db.exec("DELETE FROM chunk_data");
  missing.close();
  assert.equal((await verify(work)).integrity, false);
});

test("legacy checkpoints block before inference and verified import preserves completed jobs", async () => {
  const { migrate } = await import("../migrate.ts");
  const root = await mkdtemp(join(tmpdir(), "records-legacy-")),
    input = join(root, "input"),
    work = join(root, "work");
  await mkdir(input);
  await writeFile(join(input, "a.txt"), "Alpha.");
  const cfg = {
    input,
    work,
    roles: ["summarize"],
    engine: "synthetic" as const,
    model: "fixture",
    chunkSize: 128,
    maxBytes: 10000,
    attempts: 1,
    concurrency: 1,
  };
  await run(cfg, async () => ({ summary: "Alpha.", facts: [], unknowns: [] }));
  const db = new Store(join(work, "state/pipeline.sqlite"));
  db.db.exec(
    "DELETE FROM source_data;DELETE FROM chunk_data;DELETE FROM results;DELETE FROM data_schema",
  );
  db.close();
  let calls = 0;
  await assert.rejects(
    run(cfg, async () => {
      calls++;
      return { summary: "wrong", facts: [], unknowns: [] };
    }),
    /explicit import/,
  );
  assert.equal(calls, 0);
  const imported = await migrate(work);
  assert.equal(imported.sources, 1);
  assert.equal(imported.results, 1);
  assert.ok(
    (
      await run(cfg, async () => {
        calls++;
        throw Error("must not rerun");
      })
    ).integrity,
  );
  assert.equal(calls, 0);
});
test("failed inference request and partial response remain in SQLite", async () => {
  const root = await mkdtemp(join(tmpdir(), "records-failed-")),
    input = join(root, "input"),
    work = join(root, "work");
  await mkdir(input);
  await writeFile(join(input, "a.txt"), "Alpha.");
  await run(
    {
      input,
      work,
      roles: ["summarize"],
      engine: "synthetic",
      model: "fixture",
      chunkSize: 128,
      maxBytes: 10000,
      attempts: 1,
      concurrency: 1,
    },
    async () => {
      throw Object.assign(Error("controlled"), { partial: "incomplete", outputTokens: 3 });
    },
  );
  const db = new Store(join(work, "state/pipeline.sqlite"));
  const row = JSON.parse(String(db.db.prepare("SELECT body FROM attempt_data").get()!.body));
  assert.equal(row.request.text, "Alpha.");
  assert.equal(row.partial, "incomplete");
  assert.equal(row.outputTokens, 3);
  db.close();
});

test("optional export failure cannot retry or lose a completed SQLite inference", async () => {
  const root = await mkdtemp(join(tmpdir(), "records-export-")),
    input = join(root, "input"),
    work = join(root, "work");
  await mkdir(input);
  await writeFile(join(input, "a.txt"), "Alpha.");
  let calls = 0;
  const cfg = {
    input,
    work,
    roles: ["summarize"],
    engine: "synthetic" as const,
    model: "fixture",
    chunkSize: 128,
    maxBytes: 10000,
    attempts: 3,
    concurrency: 1,
  };
  const report = await run(cfg, async (request) => {
    calls++;
    await mkdir(join(work, "output", request.id + ".json"));
    return { summary: "Alpha.", facts: [], unknowns: [] };
  });
  assert.equal(calls, 1);
  assert.equal(report.completed, 1);
  assert.ok(report.integrity);
  assert.ok(report.exportErrors.length);
  const resumed = await run(cfg, async () => {
    calls++;
    throw Error("must not retry");
  });
  assert.ok(resumed.integrity);
  assert.equal(calls, 1);
});

test("later retrieval uses indexed SQLite search and returns complete verified chunk data", async () => {
  const { search } = await import("../records.ts");
  const { hash } = await import("../store.ts");
  const db = new Store(":memory:");
  const text = "Alpha stores the complete local record.";
  db.transaction(() =>
    db.records.ingest(
      {
        id: "source",
        path: "source.txt",
        hash: hash(text),
        state: "pending",
        normalizedHash: hash(text),
        chunks: [{ id: "chunk", index: 0, start: 0, end: text.length, text, hash: hash(text) }],
      },
      { roles: ["summarize"], configHash: "fixture" },
    ),
  );
  const found = search(db.db, "Alpha");
  assert.equal(found.records[0].chunk.text, text);
  assert.equal(found.more, false);
  db.db.exec("UPDATE chunk_data SET body=json_set(body,'$.text','corrupt')");
  assert.throws(() => search(db.db, "Alpha"), /integrity/);
  db.close();
});
