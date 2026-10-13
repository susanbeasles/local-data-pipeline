import { readFile, readdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { atomic, hash } from "./store.ts";
import { check } from "./metrics.ts";
/** Reconcile persisted synthetic benchmark evidence without repeating inference. */
export async function assess(
  path: string,
  selectionPath = join(import.meta.dirname, "../config/residency.json"),
) {
  const root = await realpath(path),
    state = await realpath(join(import.meta.dirname, "../state"));
  if (!root.startsWith(state + sep + "workers-"))
    throw Error("only project synthetic worker benchmarks can be assessed");
  const file = join(root, "comparison.json"),
    comparison = JSON.parse(await readFile(file, "utf8"));
  if (comparison.input !== join(root, "input"))
    throw Error("synthetic input boundary mismatch");
  for (const report of comparison.reports) {
    let correct = true;
    try {
      for (let w = 0; w < 3; w++) {
        const input = join(root, "input", String(w)),
          output = join(root, `workers-${report.workers}`, String(w), "output");
        const expected = new Map(
          await Promise.all(
            (await readdir(input)).map(
              async (name) =>
                [
                  hash(name),
                  await readFile(join(input, name), "utf8"),
                ] as const,
            ),
          ),
        );
        const outputs = await Promise.all(
          (await readdir(output)).map(async (name) =>
            JSON.parse(await readFile(join(output, name), "utf8")),
          ),
        );
        correct = correct && check(expected, outputs);
      }
    } catch (error) {
      correct = false;
      report.assessmentError = String(error);
    }
    report.correctness = correct;
    report.correctnessScope =
      "every result field compared against expected fixture keyed by source identity";
    report.processingSeconds = (
      Array.isArray(report.windows) ? report.windows : []
    ).reduce(
      (n: number, w: { elapsedSeconds: number }) => n + w.elapsedSeconds,
      0,
    );
    report.sustained = report.processingSeconds >= 60;
    report.stable =
      report.exitCode === 0 &&
      report.integrity &&
      correct &&
      report.sustained &&
      report.resources?.peakFootprintBytes > 0 &&
      report.resources.peakFootprintBytes <= 32_000_000_000 &&
      !report.resources.budgetExceeded;
    report.targetMet = report.stable && report.filesPerMinute >= 1000;
  }
  const best = comparison.reports
    .filter((r: any) => r.stable)
    .sort((a: any, b: any) => b.filesPerMinute - a.filesPerMinute)[0];
  comparison.selection = best
    ? {
        workers: best.workers,
        batchSize: best.batchSize,
        filesPerMinute: best.filesPerMinute,
      }
    : null;
  comparison.assessment =
    "source-keyed fixture oracle; sustained time excludes model initialization and post-run validation";
  await atomic(file, comparison);
  if (best)
    await atomic(selectionPath, {
      workers: best.workers,
      batchSize: best.batchSize,
      budgetBytes: 32_000_000_000,
      memoryBytes: Math.floor(31_000_000_000 / best.workers),
      concurrency: best.workers * best.batchSize,
      evidence: file,
    });
  return comparison;
}
if (process.argv[1] === import.meta.filename) {
  const report = await assess(process.argv[2]);
  console.log(
    JSON.stringify({
      selection: report.selection,
      results: report.reports.map((r: any) => ({
        workers: r.workers,
        filesPerMinute: r.filesPerMinute,
        tokensPerSecond: r.tokensPerSecond,
        processingSeconds: r.processingSeconds,
        correctness: r.correctness,
        integrity: r.integrity,
        stable: r.stable,
        peakBytes: r.resources.peakFootprintBytes,
        gpuMeanPercent: r.resources.gpuMeanPercent,
      })),
    }),
  );
}
