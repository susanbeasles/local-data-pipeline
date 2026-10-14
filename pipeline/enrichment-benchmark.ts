import { assets } from "./local.ts";
/** Same weights, role instructions, schemas and synthetic inputs; packaging is the sole comparison. */
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { launch, assertNetworkDenied } from "./sandbox.ts";
import { pool, modelVersion, type Model } from "./mlx.ts";
import { enrich } from "./enrich.ts";
import { order } from "./roles.ts";
import { atomic } from "./store.ts";
import type { Config } from "./run.ts";
import {
  acceptance,
  type Entity,
  type Group,
  type Edge,
} from "./acceptance.ts";
const child = process.argv[2],
  mode = (process.argv[3] ?? "packaged") as "inline" | "packaged";
const model: Model = {
  runtime: assets().runtime,
  base: assets().base,
  package: assets().package,
  adapters: {},
  roleMode: mode,
  workers: 1,
  batchSize: 64,
  prefillSize: 4,
  memoryBytes: 31_000_000_000,
  budgetBytes: 32_000_000_000,
  timeoutMs: 180000,
  maxTokens: 1600,
};
if (!child) {
  const root = await mkdtemp(join(import.meta.dirname, "../state/enrichment-")),
    input = join(root, "input");
  await mkdir(input);
  await writeFile(
    join(input, "a.txt"),
    "Alpha is a component. Alpha stores records locally. Network access is disabled.",
  );
  await writeFile(
    join(input, "b.txt"),
    "Beta is a component. Beta reads records from Alpha. Network access is disabled.",
  );
  console.log(JSON.stringify({ type: "enrichment-benchmark", root }));
  const results = [];
  for (const roleMode of ["inline", "packaged"] as const) {
    const work = join(root, roleMode);
    await mkdir(work);
    const status = await launch(
      input,
      work,
      import.meta.filename,
      [root, roleMode],
      { ...model, roleMode },
    );
    let result: any;
    try {
      result = JSON.parse(await readFile(join(work, "benchmark.json"), "utf8"));
    } catch {
      result = {
        mode: roleMode,
        integrity: false,
        error: "terminated before benchmark report",
      };
    }
    const resources = JSON.parse(
      await readFile(join(work, "state/resources.json"), "utf8"),
    );
    results.push({ ...result, resources, exitCode: status });
    console.log(
      JSON.stringify({
        ...result,
        resources: { ...resources, samples: undefined },
        report: undefined,
      }),
    );
  }
  const signatures = (result: any, field: string) =>
    result.metrics
      ?.flatMap((m: any) => m.traces)
      .map((t: any) => t.role + ":" + t[field])
      .sort();
  const equality = {
    fixedInstructions:
      JSON.stringify(signatures(results[0], "systemHash")) ===
      JSON.stringify(signatures(results[1], "systemHash")),
    dynamicRequests:
      JSON.stringify(signatures(results[0], "inputHash")) ===
      JSON.stringify(signatures(results[1], "inputHash")),
    outputs:
      JSON.stringify(signatures(results[0], "resultHash")) ===
      JSON.stringify(signatures(results[1], "resultHash")),
  };
  await atomic(join(root, "comparison.json"), {
    base: model.base,
    weightChanges: false,
    adapter: null,
    batchSize: 64,
    prefillSize: 4,
    input,
    equality,
    results,
  });
  if (
    results.some(
      (r) => r.exitCode !== 0 || !r.integrity || r.qualityErrors?.length,
    )
  )
    process.exitCode = 1;
} else {
  await assertNetworkDenied();
  const work = join(child, mode),
    workers = pool(model),
    started = performance.now();
  try {
    await workers.ready;
    const cfg: Config = {
      input: join(child, "input"),
      work,
      roles: order,
      engine: "mlx",
      model: await modelVersion(model, order),
      enrichment: { namespace: "fixture" },
      chunkSize: 6000,
      concurrency: 64,
      attempts: 1,
      maxBytes: 64 * 1024 ** 2,
    };
    const report = await enrich(cfg, (r) => workers.infer(r));
    const metrics = await workers.stats(),
      seconds = (performance.now() - started) / 1000;
    const rows = async <T>(name: string): Promise<T[]> =>
      (await readFile(join(work, "output", name + ".jsonl"), "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as T);
    const qualityErrors = acceptance(
      await rows<Entity>("entities"),
      await rows<Group>("groups"),
      await rows<Edge>("edges"),
    );
    const result = {
      mode,
      seconds,
      completed: report.completed,
      filesPerMinute: (report.completed * 60) / seconds,
      promptPrefillTokens: metrics.reduce(
        (n, r) => n + (r.engine.promptTokens ?? 0),
        0,
      ),
      initialSystemPrefillTokens: metrics.reduce(
        (n, r) => n + Number(r.initialization.systemPrefillTokens ?? 0),
        0,
      ),
      generatedTokens: metrics.reduce((n, r) => n + r.outputTokens, 0),
      generatedTokensPerSecond:
        metrics.reduce((n, r) => n + r.outputTokens, 0) / seconds,
      metrics,
      integrity: report.integrity,
      qualityErrors,
      report,
    };
    await atomic(join(work, "benchmark.json"), result);
    if (!report.integrity || qualityErrors.length) process.exitCode = 1;
  } finally {
    await workers.close();
  }
}
