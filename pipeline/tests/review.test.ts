import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { review, gates, decide } from "../review.ts";
import { run } from "../run.ts";
async function pending(work: string) {
  for (let i = 0; i < 100; i++) {
    const row = (await gates(work)).find((r) => r.state === "waiting");
    if (row) return row;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error("review did not appear");
}
test("review decisions are durable, bound to receipts and reject incomplete approvals", async () => {
  const work = await mkdtemp(join(tmpdir(), "review-"));
  let p = review(work, "extract", "scope", [
    { id: "job", state: "failed", outputHash: null, attempt: 1 },
  ]);
  let g = await pending(work);
  assert.throws(() => decide(work, String(g.id), "approve"), /incomplete/);
  decide(work, String(g.id), "retry");
  assert.equal(await p, "retry");
  assert.throws(() => decide(work, String(g.id), "reject"), /no longer/);
  p = review(work, "extract", "scope", [
    { id: "job", state: "completed", outputHash: "abc", attempt: 2 },
  ]);
  g = await pending(work);
  decide(work, String(g.id), "approve");
  assert.equal(await p, "approve");
  assert.equal(
    await review(work, "extract", "scope", [
      { id: "job", state: "completed", outputHash: "abc", attempt: 2 },
    ]),
    "approve",
  );
});
test("stage gate prevents downstream inference and resume reuses approved results", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-run-")),
    input = join(root, "input"),
    work = join(root, "work");
  await mkdir(input);
  await writeFile(join(input, "x.txt"), "Alpha");
  const profile = {
    format: "enrichment/1" as const,
    name: "fixture",
    stages: ["extract", "check"].map((name) => ({
      name,
      system: "Read source.",
      maxTokens: 100,
      schema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
    })),
  };
  const config = {
    input,
    work,
    profile,
    review: { after: ["extract"] },
    roles: ["extract", "check"],
    engine: "synthetic" as const,
    model: "fixture",
    chunkSize: 256,
    maxBytes: 1000,
    attempts: 1,
    concurrency: 1,
  };
  const calls: string[] = [];
  const infer = async (r: any) => {
    calls.push(r.role);
    return { name: "Alpha" };
  };
  const p = run(config, infer);
  const g = await pending(work);
  assert.deepEqual(calls, ["extract"]);
  decide(work, String(g.id), "approve");
  assert.equal((await p).integrity, true);
  assert.deepEqual(calls, ["extract", "check"]);
  assert.equal((await run({ ...config, resume: true }, infer)).integrity, true);
  assert.equal(calls.length, 2);
});
test("operator retry repeats selected stage, keeps attempts and opens a new review", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-retry-")),
    input = join(root, "input"),
    work = join(root, "work");
  await mkdir(input);
  await writeFile(join(input, "x.txt"), "Alpha");
  const profile = {
    format: "enrichment/1" as const,
    name: "fixture",
    stages: [
      {
        name: "extract",
        system: "Read source.",
        maxTokens: 100,
        schema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
      },
    ],
  };
  const config = {
    input,
    work,
    profile,
    review: { after: ["extract"] },
    roles: ["extract"],
    engine: "synthetic" as const,
    model: "fixture",
    chunkSize: 256,
    maxBytes: 1000,
    attempts: 1,
    concurrency: 1,
  };
  let calls = 0;
  const p = run(config, async () => {
    calls++;
    return { name: "Alpha" };
  });
  const first = await pending(work);
  decide(work, String(first.id), "retry");
  const second = await pending(work);
  assert.notEqual(first.id, second.id);
  assert.equal(calls, 2);
  decide(work, String(second.id), "approve");
  assert.equal((await p).integrity, true);
});
test("source preparation failures cannot be approved as a complete stage", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-source-")),
    input = join(root, "input"),
    work = join(root, "work");
  await mkdir(input);
  await writeFile(join(input, "ok.txt"), "Alpha");
  await writeFile(join(input, "large.txt"), "x".repeat(20));
  const profile = {
    format: "enrichment/1" as const,
    name: "fixture",
    stages: [
      {
        name: "extract",
        system: "Read source.",
        maxTokens: 100,
        schema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
      },
    ],
  };
  const config = {
    input,
    work,
    profile,
    review: { after: ["extract"] },
    roles: ["extract"],
    engine: "synthetic" as const,
    model: "fixture",
    chunkSize: 256,
    maxBytes: 10,
    attempts: 1,
    concurrency: 1,
  };
  const p = run(config, async () => ({ name: "Alpha" }));
  const g = await pending(work);
  try {
    assert.equal(g.complete, 0);
    assert.throws(() => decide(work, String(g.id), "approve"), /incomplete/);
  } finally {
    if ((await gates(work)).some((r) => r.id === g.id && r.state === "waiting"))
      decide(work, String(g.id), "reject");
    await assert.rejects(p, /Review rejected/);
  }
});
