/** Real-model six-stage acceptance on synthetic data only; no production paths. */
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assets } from "../local.ts";
import { launch } from "../sandbox.ts";
import type { Model } from "../mlx.ts";
const bindings = assets();
const root = await mkdtemp(join(import.meta.dirname, "../../state/sqlite-acceptance-"));
const input = join(root, "input"),
  work = join(root, "packaged");
await mkdir(input);
await mkdir(work);
await writeFile(
  join(input, "a.txt"),
  "Alpha is a component. Alpha stores records locally. Network access is disabled.",
);
await writeFile(
  join(input, "b.txt"),
  "Beta is a component. Beta reads records from Alpha. Network access is disabled.",
);
const model: Model = {
  ...bindings,
  adapters: {},
  roleMode: "packaged",
  workers: 1,
  batchSize: 64,
  prefillSize: 4,
  memoryBytes: 31_000_000_000,
  budgetBytes: 32_000_000_000,
  timeoutMs: 180000,
  maxTokens: 1600,
};
console.log(JSON.stringify({ root, synthetic: true }));
const exit = await launch(
  input,
  work,
  join(import.meta.dirname, "../enrichment-benchmark.ts"),
  [root, "packaged"],
  model,
);
if (exit !== 0) throw Error("real-model acceptance failed: " + exit);
const report = JSON.parse(await readFile(join(work, "benchmark.json"), "utf8"));
const counts: Record<string, Record<string, number>> = {};
for (const name of ["pipeline", "graph"]) {
  const db = new DatabaseSync(join(work, "state", name + ".sqlite"), { readOnly: true });
  try {
    counts[name] = Object.fromEntries(
      ["source_data", "chunk_data", "results", "attempt_data"].map((table) => [
        table,
        Number(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n),
      ]),
    );
  } finally {
    db.close();
  }
}
if (
  !report.integrity ||
  report.qualityErrors.length ||
  report.completed !== 2 ||
  counts.pipeline.source_data !== 2 ||
  counts.pipeline.chunk_data !== 2 ||
  counts.pipeline.results !== 8 ||
  counts.graph.results < 2
)
  throw Error("SQLite acceptance coverage mismatch");
console.log(
  JSON.stringify({
    passed: true,
    completed: report.completed,
    seconds: report.seconds,
    counts,
    qualityErrors: report.qualityErrors,
  }),
);
