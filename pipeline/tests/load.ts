/** Controlled production-sized batching acceptance; synthetic inputs only. */
import { mkdir, mkdtemp, writeFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { pool, type Model } from "../mlx.ts";
import { launch, assertNetworkDenied } from "../sandbox.ts";
import { atomic, hash } from "../store.ts";
import { validRole } from "../roles.ts";
const model: Model = {
  runtime: "/Users/avespoli/SonarMD-Dump-2026-10-09/enrichment/runtime",
  base: "/Users/avespoli/SonarMD-Dump-2026-10-09/enrichment/models/qwen2.5-3b-official",
  package: await realpath(
    join(import.meta.dirname, "../../models/qwen-roles-v14"),
  ),
  adapters: {},
  workers: 1,
  batchSize: 64,
  prefillSize: 4,
  memoryBytes: 31_000_000_000,
  budgetBytes: 32_000_000_000,
  timeoutMs: Number(
    process.argv.find((a) => a.startsWith("--timeout="))?.split("=")[1] ??
      180000,
  ),
  maxTokens: 1600,
};
const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
const root = process.argv[2]?.startsWith("--") ? undefined : process.argv[2];
if (!root) {
  const root = await mkdtemp(join(import.meta.dirname, "../../state/load-"));
  await mkdir(join(root, "input"));
  await mkdir(join(root, "work"));
  await writeFile(join(root, "input/fixture.txt"), "Synthetic fixture");
  console.log(JSON.stringify({ root }));
  process.exitCode = await launch(
    join(root, "input"),
    join(root, "work"),
    import.meta.filename,
    [root, ...flags],
    model,
  );
} else {
  await assertNetworkDenied();
  const workers = pool(model);
  const begin = performance.now();
  const text = process.argv.includes("--dense")
    ? Array.from({ length: 150 }, (_, i) => `record ${i}: ${hash(String(i))}`)
        .join("\n")
        .slice(0, 6000)
    : "Alpha stores records locally. Beta reads records from Alpha. Network access is disabled. "
        .repeat(70)
        .slice(0, 6000);
  const payload = {
    spans: [{ id: 0, text }],
    context: {
      trustedNamespace: "synthetic",
      sourceId: "synthetic",
      sourceHash: hash(text),
      chunkId: "synthetic",
      sourceName: "fixture.txt",
    },
    prior: {},
  };
  try {
    await workers.ready;
    const results = await Promise.allSettled(
      Array.from({ length: 64 }, (_, i) =>
        workers.infer({
          id: String(i),
          role: "tag",
          text,
          attempt: 1,
          sourceHash: hash(text),
          configHash: "synthetic",
          chunk: {
            id: String(i),
            index: 0,
            start: 0,
            end: text.length,
            text,
            hash: hash(text),
          },
          payload,
        }),
      ),
    );
    const completed = results.filter(
      (r) => r.status === "fulfilled" && validRole("tag", r.value, payload),
    ).length;
    const report = {
      completed,
      requested: 64,
      seconds: (performance.now() - begin) / 1000,
      errors: results
        .filter((r) => r.status === "rejected")
        .map((r) => String(r.reason)),
      metrics: await workers.stats(),
      integrity: completed === 64,
    };
    await atomic(join(root, "work/report.json"), report);
    console.log(
      JSON.stringify({
        completed,
        requested: 64,
        seconds: report.seconds,
        integrity: report.integrity,
        errors: report.errors.slice(0, 1),
      }),
    );
    if (!report.integrity) process.exitCode = 1;
  } finally {
    await workers.close();
  }
}
