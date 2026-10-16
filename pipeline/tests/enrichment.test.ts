import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type Config } from "../run.ts";
test("chunk roles run in order with validated upstream results and namespace provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "enrichment-")),
    input = join(root, "input");
  await mkdir(input);
  await writeFile(join(input, "x.txt"), "SQLite stores records locally.");
  const cfg: Config = {
    input,
    work: join(root, "work"),
    engine: "synthetic",
    model: "six-role-fixture",
    roles: ["tag", "classify", "summarize", "knowledge"],
    enrichment: { namespace: "fixture" },
    chunkSize: 128,
    concurrency: 4,
    attempts: 1,
    maxBytes: 4096,
  };
  const seen: string[] = [];
  const infer = async (r: any) => {
    seen.push(r.role);
    assert.equal(r.payload.context.trustedNamespace, "fixture");
    if (r.role !== "tag") assert.ok(r.payload.prior.tag);
    if (r.role === "tag") return { tags: ["SQLite"] };
    if (r.role === "classify")
      return {
        namespace: "fixture",
        system: "store",
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
        summary: "Local records",
        facts: [
          {
            claim: "Local records",
            basis: "explicit",
            state: "current",
            anchorIds: [0],
          },
        ],
        unknowns: [],
      };
    return {
      entities: [
        { id: "e1", name: "store", kind: "component", namespace: "fixture" },
      ],
      claims: [
        {
          subject: "e1",
          predicate: "stores",
          object: "records locally",
          time: "unknown",
          status: "observed",
          confidence: 1,
          anchorIds: [0],
        },
      ],
      unknowns: [],
    };
  };
  const result = await run(cfg, infer);
  assert.ok(result.integrity);
  assert.equal(result.completed, 1);
  assert.deepEqual(seen, cfg.roles);
  const resumed = await run(cfg, () => {
    throw Error("completed stage was rerun");
  });
  assert.ok(resumed.integrity);
});

test("corrupt upstream outputs invalidate every completed descendant", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "descendants-")),
    input = join(root, "input");
  await mkdir(input);
  await writeFile(join(input, "x.txt"), "Local store.");
  const cfg: Config = {
    input,
    work: join(root, "work"),
    engine: "synthetic",
    model: "fixture",
    roles: ["tag", "classify"],
    enrichment: { namespace: "fixture" },
    chunkSize: 128,
    concurrency: 2,
    attempts: 2,
    maxBytes: 4096,
  };
  let calls = 0,
    changed = false;
  const infer = async (r: any) => {
    calls++;
    if (r.role === "tag") return { tags: [changed ? "changed" : "original"] };
    assert.deepEqual(r.payload.prior.tag.tags, [
      changed ? "changed" : "original",
    ]);
    return {
      namespace: "fixture",
      system: "store",
      kind: "guide",
      domain: "data",
      lifecycle: "current",
      sensitivity: "internal",
      history: "reference",
      function: "guide",
      confidence: "explicit",
      unknowns: [],
    };
  };
  assert.ok((await run(cfg, infer)).integrity);
  for (const name of await readdir(join(cfg.work, "output"))) {
    const file = join(cfg.work, "output", name);
    if (JSON.parse(await readFile(file, "utf8")).role === "tag")
      await writeFile(file, "corrupt");
  }
  changed = true;
  assert.ok((await run(cfg, infer)).integrity);
  assert.equal(calls, 4);
});
