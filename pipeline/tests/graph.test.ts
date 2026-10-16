import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enrich } from "../enrich.ts";
import type { Config } from "../run.ts";
test("all six stages produce attributable graph outputs and resume without repeated inference", async () => {
  const root = await mkdtemp(join(tmpdir(), "six-stages-")),
    input = join(root, "input");
  await mkdir(input);
  await writeFile(join(input, "a.txt"), "Alpha stores records locally.");
  await writeFile(join(input, "b.txt"), "Beta reads from Alpha.");
  const cfg: Config = {
    input,
    work: join(root, "work"),
    roles: [
      "tag",
      "classify",
      "summarize",
      "knowledge",
      "reconcile",
      "connect",
    ],
    enrichment: { namespace: "fixture" },
    engine: "synthetic",
    model: "fixture",
    chunkSize: 128,
    concurrency: 4,
    attempts: 2,
    maxBytes: 4096,
  };
  let calls = 0;
  const infer = async (r: any) => {
    calls++;
    const name = r.payload?.context.sourceName === "a.txt" ? "Alpha" : "Beta";
    if (r.role === "tag") return { tags: [name] };
    if (r.role === "classify")
      return {
        namespace: "fixture",
        system: name,
        kind: "guide",
        domain: "data",
        lifecycle: "current",
        sensitivity: "internal",
        history: "reference",
        function: "guide",
        confidence: "explicit",
        unknowns: [],
      };
    if (r.role === "summarize")
      return {
        summary: name,
        facts: [
          { claim: name, basis: "explicit", state: "current", anchorIds: [0] },
        ],
        unknowns: [],
      };
    if (r.role === "knowledge")
      return {
        entities: [{ id: "e1", name, kind: "component", namespace: "fixture" }],
        claims: [
          {
            subject: "e1",
            predicate: "behavior",
            object: r.text,
            time: "unknown",
            status: "observed",
            confidence: 1,
            anchorIds: [0],
          },
        ],
        unknowns: [],
      };
    const pair = r.payload.context.candidates;
    assert.equal(r.payload.spans.length, 2);
    for (const proof of pair.evidence)
      assert.equal(r.payload.spans[proof.spanId].text, proof.text);
    if (r.role === "reconcile") return { groups: [], unknowns: [] };
    assert.ok(r.payload.prior.reconcile);
    return {
      edges: [
        {
          from: pair.members[0].id,
          to: pair.members[1].id,
          relation: "depends-on",
          basis: "explicit",
          evidenceIds: pair.evidence.map((e: any) => e.id),
        },
      ],
      unknowns: [],
    };
  };
  const report = await enrich(cfg, infer);
  assert.ok(report.integrity);
  assert.equal(report.completed, 2);
  assert.equal(report.graph.candidates, 1);
  assert.equal(report.graph.completed, 2);
  assert.equal(calls, 10);
  const again = await enrich(cfg, () => {
    throw Error("unexpected rerun");
  });
  assert.ok(again.integrity);
  assert.equal(again.completed, 2);
  const graph = JSON.parse(
    await readFile(join(cfg.work, "output", "graph.json"), "utf8"),
  );
  assert.equal(graph.entities.count, 2);
  const entities = (await readFile(graph.entities.path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  for (const entity of entities)
    for (const claim of entity.claims) assert.equal(claim.subject, entity.id);
  assert.equal(graph.edges.count, 1);
  const edge = JSON.parse((await readFile(graph.edges.path, "utf8")).trim());
  assert.ok(edge.evidenceIds.length >= 2);
});

test("graph checkpoints retry failed roles and recover corrupt graph publication without repeating chunk inference", async () => {
  const { fileHash } = await import("../seal.ts");
  const root = await mkdtemp(join(tmpdir(), "graph-recovery-")),
    input = join(root, "input");
  await mkdir(input);
  await writeFile(join(input, "a.txt"), "Alpha.");
  await writeFile(join(input, "b.txt"), "Beta.");
  const cfg: Config = {
    input,
    work: join(root, "work"),
    roles: [
      "tag",
      "classify",
      "summarize",
      "knowledge",
      "reconcile",
      "connect",
    ],
    enrichment: { namespace: "fixture" },
    engine: "synthetic",
    model: "fixture",
    chunkSize: 128,
    concurrency: 4,
    attempts: 2,
    maxBytes: 4096,
  };
  let chunkCalls = 0,
    graphCalls = 0;
  const infer = async (r: any) => {
    if (["connect", "reconcile"].includes(r.role)) {
      graphCalls++;
      if (r.role === "connect" && r.attempt === 1)
        throw Error("controlled inference failure");
      return r.role === "reconcile"
        ? { groups: [], unknowns: [] }
        : { edges: [], unknowns: [] };
    }
    chunkCalls++;
    if (r.role === "tag") return { tags: ["local"] };
    if (r.role === "classify")
      return {
        namespace: "fixture",
        system: "unknown",
        kind: "guide",
        domain: "data",
        lifecycle: "current",
        sensitivity: "internal",
        history: "reference",
        function: "guide",
        confidence: "explicit",
        unknowns: [],
      };
    if (r.role === "summarize")
      return { summary: r.text, facts: [], unknowns: [] };
    return {
      entities: [
        { id: "e1", name: r.text, kind: "component", namespace: "fixture" },
      ],
      claims: [
        {
          subject: "e1",
          predicate: "exists",
          object: r.text,
          time: "unknown",
          status: "observed",
          confidence: 1,
          anchorIds: [0],
        },
      ],
      unknowns: [],
    };
  };
  assert.ok((await enrich(cfg, infer)).integrity);
  assert.equal(chunkCalls, 8);
  assert.equal(graphCalls, 3);
  await writeFile(join(cfg.work, "output", "graph.json"), "corrupt");
  await writeFile(join(cfg.work, "output", "edges.jsonl"), "corrupt");
  assert.ok(
    (
      await enrich(cfg, () => {
        throw Error("unexpected inference replay");
      })
    ).integrity,
  );
  assert.equal(chunkCalls, 8);
  assert.equal(graphCalls, 3);
  assert.ok(
    (await fileHash(join(cfg.work, "output", "graph.json"))).length === 64,
  );
  const retry = { ...cfg, work: join(root, "retry"), attempts: 1 };
  const failed = await enrich(retry, infer);
  assert.equal(failed.integrity, false);
  const saved = chunkCalls;
  const recovered = await enrich({ ...retry, resume: true }, infer);
  assert.ok(recovered.integrity);
  assert.equal(chunkCalls, saved);
  assert.equal(recovered.completed, 2);
});
