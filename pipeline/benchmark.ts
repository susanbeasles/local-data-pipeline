import { assets } from "./local.ts";
import { mkdir, mkdtemp, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, assertNetworkDenied } from "./sandbox.ts";
import { run, type Config } from "./run.ts";
import { pool, type Model } from "./mlx.ts";
import { assess } from "./assess.ts";
import { check, describe } from "./metrics.ts";
import { hash, atomic } from "./store.ts";
import { fileHash } from "./seal.ts";
const engine = process.argv[2] ?? "matrix",
  child = process.argv[3];
const batch = Number(process.argv[4] ?? 16),
  count = Number(process.argv[5] ?? 1);
const prefill = Number(process.argv[7] ?? batch);
const model: Model = {
  runtime: assets().runtime,
  base: assets().base,
  adapters: {
    summarize: join(import.meta.dirname, "../models/anchors-experiment"),
  },
  workers: count,
  prefillSize: prefill,
  budgetBytes: 32_000_000_000,
  memoryBytes: Math.floor(31_000_000_000 / count),
  timeoutMs: 180000,
  maxTokens: 256,
  batchSize: batch,
};
if (!child) {
  if (!["matrix", "mlx", "synthetic", "continuous"].includes(engine))
    throw Error("benchmark matrix|mlx|synthetic|continuous");
  const root = await mkdtemp(join(import.meta.dirname, "../state/workers-"));
  const input = join(root, "input");
  await mkdir(input);
  const perWindow =
    engine === "synthetic" ? 300 : engine === "continuous" ? 128 : 64;
  for (let w = 0; w < 3; w++) {
    const dir = join(input, String(w));
    await mkdir(dir);
    for (let i = 0; i < perWindow; i++)
      await writeFile(
        join(dir, `${i}.txt`),
        engine === "synthetic"
          ? i % 10 === 0
            ? "Synthetic log event 😀\r\n".repeat(12000)
            : "Synthetic text\r\n".repeat(512)
          : `Synthetic service ${101 + w * 100 + (engine === "continuous" ? i % 64 : i)} stores records locally. Network access is disabled.`,
      );
  }
  console.log(JSON.stringify({ type: "benchmark-path", root, engine, batch }));
  const reports = [];
  const cases =
    engine === "continuous"
      ? [
          { workers: 2, batch: 16, prefill: 16, name: "baseline" },
          { workers: 1, batch: 32, prefill: 4, name: "continuous-32" },
          { workers: 1, batch: 64, prefill: 4, name: "continuous-64" },
        ]
      : (engine === "matrix" ? [1, 2, 4] : [count]).map((n) => ({
          workers: n,
          batch,
          prefill: batch,
          name: `workers-${n}`,
        }));
  for (const candidate of cases) {
    const n = candidate.workers;
    const work = join(root, candidate.name);
    await mkdir(work);
    const status = await launch(
      input,
      work,
      import.meta.filename,
      [
        engine === "synthetic" ? "synthetic" : "mlx",
        work,
        String(candidate.batch),
        String(n),
        input,
        String(candidate.prefill),
      ],
      engine === "synthetic"
        ? undefined
        : {
            ...model,
            workers: n,
            batchSize: candidate.batch,
            prefillSize: candidate.prefill,
            memoryBytes: Math.floor(31_000_000_000 / n),
          },
    );
    let report: any;
    try {
      report = JSON.parse(await readFile(join(work, "benchmark.json"), "utf8"));
    } catch {
      report = {
        workers: n,
        stable: false,
        error: "benchmark terminated before completion",
      };
    }
    const resources =
      engine === "synthetic"
        ? null
        : JSON.parse(
            await readFile(join(work, "state/resources.json"), "utf8"),
          );
    report = describe({
      ...report,
      name: candidate.name,
      resources,
      exitCode: status,
    });
    report.stable =
      status === 0 &&
      report.integrity &&
      report.correctness &&
      report.sustained &&
      !resources?.budgetExceeded;
    reports.push(report);
    console.log(
      JSON.stringify({
        ...report,
        windows: undefined,
        resources: resources ? { ...resources, samples: undefined } : null,
      }),
    );
  }
  const stable = reports
    .filter((r) => r.stable)
    .sort((a, b) => b.filesPerMinute - a.filesPerMinute);
  const selection = stable[0]
    ? {
        workers: stable[0].workers,
        batchSize: stable[0].batchSize,
        filesPerMinute: stable[0].filesPerMinute,
      }
    : null;
  await atomic(join(root, "comparison.json"), {
    input,
    workload:
      engine === "continuous"
        ? "original 192 baseline fixture texts repeated twice as distinct source files; 384 complete files; source-keyed exact oracle"
        : "identical 192 held-out synthetic files; 3 windows of 64; all fields compared against exact expected outputs",
    reports,
    selection,
    target: 1000,
  });
  if (selection && engine !== "continuous") {
    await atomic(join(import.meta.dirname, "../config/residency.json"), {
      workers: selection.workers,
      batchSize: batch,
      budgetBytes: 32_000_000_000,
      memoryBytes: Math.floor(31_000_000_000 / selection.workers),
      concurrency: selection.workers * batch,
      evidence: join(root, "comparison.json"),
    });
  }
  if (!["synthetic", "continuous"].includes(engine)) await assess(root);
  console.log(JSON.stringify({ root, selection, target: 1000 }));
  if (!selection) process.exitCode = 1;
} else {
  await assertNetworkDenied();
  const work = child,
    input = process.argv[6];
  const workers = engine === "mlx" ? pool(model) : null;
  const modelHash =
    engine === "mlx"
      ? await fileHash(join(model.adapters.summarize, "adapters.safetensors"))
      : "deterministic-simulator-v1";
  const windows = [];
  let initialized = 0;
  const begin = performance.now();
  let correct = true;
  try {
    await workers?.ready;
    initialized = (performance.now() - begin) / 1000;
    for (let w = 0; w < 3; w++) {
      const cfg: Config = {
        input: join(input, String(w)),
        work: join(work, String(w)),
        engine: engine as "mlx" | "synthetic",
        model: modelHash,
        chunkSize: 6000,
        concurrency: engine === "mlx" ? count * batch : 4,
        attempts: 1,
        maxBytes: 64 * 1024 ** 2,
        roles: ["summarize"],
      };
      const report = await run(cfg, (r) =>
        workers
          ? workers.infer(r)
          : Promise.resolve({
              summary: "Synthetic simulator result",
              facts: [{ claim: "Synthetic fixture", anchorIds: [0] }],
              unknowns: [],
            }),
      );
      windows.push(report);
      if (engine === "mlx") {
        const expected = new Map(
          await Promise.all(
            (await readdir(cfg.input)).map(
              async (file) =>
                [
                  hash(file),
                  await readFile(join(cfg.input, file), "utf8"),
                ] as const,
            ),
          ),
        );
        const outputs = await Promise.all(
          (await readdir(join(cfg.work, "output"))).map(async (file) =>
            JSON.parse(await readFile(join(cfg.work, "output", file), "utf8")),
          ),
        );
        correct = correct && check(expected, outputs);
      }
    }
  } finally {
    await workers?.close();
  }
  const seconds = (performance.now() - begin) / 1000,
    completed = windows.reduce((n, r) => n + r.completed, 0),
    metrics = await workers?.stats();
  const outputTokens = metrics?.reduce((n, r) => n + r.outputTokens, 0) ?? 0;
  const report = {
    engine,
    workers: count,
    batchSize: batch,
    seconds,
    completed,
    filesPerMinute: (completed * 60) / seconds,
    generatedTokens: outputTokens,
    tokensPerSecond: outputTokens / seconds,
    metrics,
    prefillSize: prefill,
    promptTokens: metrics?.reduce((n, r) => n + r.inputTokens, 0) ?? 0,
    promptTokensPerSecond:
      (metrics?.reduce((n, r) => n + r.inputTokens, 0) ?? 0) /
      windows.reduce((n, r) => n + r.elapsedSeconds, 0),
    enginePromptPhaseTokensPerSecond:
      (metrics?.reduce((n, r) => n + (r.engine.promptTokens ?? 0), 0) ?? 0) /
      (metrics?.reduce((n, r) => n + (r.engine.promptSeconds ?? 0), 0) ?? 1),
    initializationSeconds: initialized,
    processingSeconds: windows.reduce((n, r) => n + r.elapsedSeconds, 0),
    sustained: windows.reduce((n, r) => n + r.elapsedSeconds, 0) >= 60,
    integrity:
      windows.every((w) => w.integrity) &&
      completed ===
        (
          await Promise.all(
            [0, 1, 2].map(
              async (w) => (await readdir(join(input, String(w)))).length,
            ),
          )
        ).reduce((n, c) => n + c, 0),
    correctness: correct,
    semanticScope:
      engine === "mlx"
        ? "narrow learned synthetic schema; not comprehensive production role acceptance"
        : "simulated inference",
    windows,
  };
  await atomic(join(work, "benchmark.json"), report);
  if (!report.integrity || !report.correctness) process.exitCode = 1;
}
