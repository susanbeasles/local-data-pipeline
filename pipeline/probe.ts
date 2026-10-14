import { assets } from "./local.ts";
/** Controlled synthetic arrival probe; no production configuration or data access. */
import { mkdir, mkdtemp, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, assertNetworkDenied } from "./sandbox.ts";
import { pool, type Model } from "./mlx.ts";
import { run, type Config } from "./run.ts";
import { check, describe } from "./metrics.ts";
import { hash, atomic } from "./store.ts";
const model: Model = {
  runtime: assets().runtime,
  base: assets().base,
  adapters: {
    summarize: join(import.meta.dirname, "../models/anchors-experiment"),
  },
  workers: 1,
  batchSize: 4,
  prefillSize: 1,
  memoryBytes: 31_000_000_000,
  budgetBytes: 32_000_000_000,
  timeoutMs: 180000,
  maxTokens: 256,
};
const root = process.argv[2];
if (!root) {
  const path = await mkdtemp(join(import.meta.dirname, "../state/refill-"));
  await mkdir(join(path, "input"));
  await mkdir(join(path, "work"));
  for (let i = 0; i < 4; i++)
    await writeFile(
      join(path, "input", `${i}.txt`),
      `Synthetic service ${101 + i} stores records locally. Network access is disabled.`,
    );
  console.log(JSON.stringify({ type: "refill-path", root: path }));
  process.exitCode = await launch(
    join(path, "input"),
    join(path, "work"),
    import.meta.filename,
    [path],
    model,
  );
} else {
  await assertNetworkDenied();
  const workers = pool(model);
  let arrived = 0;
  try {
    await workers.ready;
    const cfg: Config = {
      input: join(root, "input"),
      work: join(root, "work"),
      chunkSize: 6000,
      concurrency: 4,
      attempts: 1,
      maxBytes: 1024,
      roles: ["summarize"],
      model: "synthetic-refill-proof",
      engine: "mlx",
    };
    const report = await run(cfg, async (r) => {
      if (arrived++ >= 2)
        await new Promise((resolve) => setTimeout(resolve, 100));
      return workers.infer(r);
    });
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
    const metrics = await workers.stats();
    const proof = describe({
      report,
      metrics,
      correctness: check(expected, outputs),
      admissionDelayMs: 100,
      refills: metrics[0].engine.refills,
    });
    proof.passed = report.integrity && proof.correctness && proof.refills > 0;
    await atomic(join(cfg.work, "proof.json"), proof);
    console.log(JSON.stringify(proof));
    if (!proof.passed) process.exitCode = 1;
  } finally {
    await workers.close();
  }
}
