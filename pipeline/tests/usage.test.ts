import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Usage, usage } from "../usage.ts";
import { annotate } from "../proof.ts";

test("usage persists retry costs and separates unknown accounting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-"));
  try {
    const path = join(dir, "usage.sqlite");
    const usage = new Usage(path, "model", "config");
    await usage.measure("job", "tag", 1, async () =>
      annotate(
        {},
        {
          phases: [
            { inputTokens: 12, outputTokens: 4 },
            { inputTokens: 5, outputTokens: 2 },
          ],
        },
      ),
    );
    await assert.rejects(
      usage.measure("job", "tag", 2, async () => {
        throw Error("fixture");
      }),
    );
    assert.deepEqual(
      usage.totals().map((r) => [r.role, r.calls, r.inputTokens, r.outputTokens, r.unknown]),
      [["tag", 2, 17, 6, 1]],
    );
    usage.close();
    const resumed = new Usage(path, "model", "config");
    assert.equal(resumed.totals()[0].calls, 2);
    resumed.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("malformed proof is unknown rather than fabricated zero usage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-"));
  try {
    const usage = new Usage(join(dir, "usage.sqlite"), "model", "config");
    await usage.measure("job", "tag", 1, async () =>
      annotate({}, { phases: [{ inputTokens: -1, outputTokens: 2 }] }),
    );
    assert.equal(usage.totals()[0].unknown, 1);
    usage.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("forecast uses matching configuration and keeps missing stages unknown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forecast-"));
  try {
    await mkdir(join(dir, "state"));
    const ledger = new Usage(join(dir, "state/usage.sqlite"), "model", "config");
    await ledger.measure("job", "tag", 1, async () =>
      annotate({}, { phases: [{ inputTokens: 20, outputTokens: 3 }] }),
    );
    ledger.close();
    const db = new DatabaseSync(join(dir, "state/pipeline.sqlite"));
    db.exec(
      "CREATE TABLE jobs(role TEXT,config TEXT,state TEXT); INSERT INTO jobs VALUES('tag','config','pending'),('tag','config','running'),('tag','other','pending'),('extract','config','pending')",
    );
    db.close();
    const report = usage(dir);
    assert.ok(report.forecast);
    assert.equal(
      report.forecast.find((r) => r.role === "tag" && r.config === "config")?.inputTokens,
      40,
    );
    assert.equal(report.forecast.find((r) => r.config === "other")?.inputTokens, null);
    assert.equal(report.forecast.find((r) => r.role === "extract")?.outputTokens, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("forecast excludes archived graph generations and is independent of display history limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forecast-scope-"));
  try {
    await mkdir(join(dir, "state"));
    const ledger = new Usage(join(dir, "state/usage.sqlite"), "model", "active");
    await ledger.measure("j", "connect", 1, async () =>
      annotate({}, { phases: [{ inputTokens: 7, outputTokens: 2 }] }),
    );
    for (let i = 0; i < 105; i++)
      await ledger.measure(
        "noise" + i,
        "role" + i,
        1,
        async () => annotate({}, { phases: [{ inputTokens: 1, outputTokens: 1 }] }),
        "newer",
      );
    ledger.close();
    await writeFile(join(dir, "state/phase.json"), JSON.stringify({ generation: "active" }));
    const db = new DatabaseSync(join(dir, "state/graph.sqlite"));
    db.exec(
      "CREATE TABLE jobs(role TEXT,config TEXT,state TEXT); INSERT INTO jobs VALUES('connect','active','pending'),('connect','archived','pending')",
    );
    db.close();
    const report = usage(dir);
    assert.ok(report.forecast);
    assert.equal(report.forecast.length, 1);
    assert.equal(report.forecast[0].inputTokens, 7);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("usage integrates with durable pipeline retries and resume without duplicate calls", async () => {
  const { run } = await import("../run.ts");
  const dir = await mkdtemp(join(tmpdir(), "usage-e2e-"));
  try {
    const input = join(dir, "input"),
      work = join(dir, "work");
    await mkdir(input);
    await mkdir(join(work, "state"), { recursive: true });
    await writeFile(join(input, "a.txt"), "hello");
    await writeFile(join(input, "b.txt"), "hello");
    const ledger = new Usage(join(work, "state/usage.sqlite"), "fixture", "config");
    try {
      const config = {
        input,
        work,
        roles: ["summarize"],
        engine: "synthetic" as const,
        model: "fixture",
        chunkSize: 128,
        concurrency: 2,
        attempts: 2,
        maxBytes: 1024,
      };
      const infer = (r: import("../run.ts").Request) =>
        ledger.measure(r.id, r.role, r.attempt, async () => {
          if (r.attempt === 1) throw Error("synthetic retry");
          return annotate(
            { summary: "hello", facts: [], unknowns: [] },
            { phases: [{ inputTokens: 10, outputTokens: 3 }] },
          );
        });
      const first = await run(config, infer);
      assert.equal(first.integrity, true);
      assert.equal(first.completed, 2);
      assert.equal(ledger.totals()[0].calls, 4);
      assert.equal(ledger.totals()[0].unknown, 2);
      const second = await run(config, infer);
      assert.equal(second.integrity, true);
      assert.equal(second.completed, 2);
      assert.equal(ledger.totals()[0].calls, 4);
    } finally {
      ledger.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
