/** Compare true multi-row prefill with identical dynamic payloads and packaged roles. */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pool, type Model } from "./mlx.ts";
import { fixture } from "./schedule-benchmark.ts";
import { proof } from "./proof.ts";
import { validRole } from "./roles.ts";
import { assertNetworkDenied } from "./sandbox.ts";
import { atomic, hash } from "./store.ts";
if (process.argv[1] === import.meta.filename) {
  await assertNetworkDenied();
  const work = resolve(process.argv[2]!);
  const model = JSON.parse(await readFile(join(work, "model.json"), "utf8")) as Model;
  const workers = pool(model);
  try {
    await workers.ready;
    await workers.infer(fixture(999));
    const count = 32,
      outputs: unknown[] = new Array(count);
    let cursor = 0;
    const started = performance.now();
    await Promise.all(
      Array.from({ length: 16 }, async () => {
        for (;;) {
          const i = cursor++;
          if (i >= count) return;
          const request = fixture(i);
          const result = await workers.infer(request);
          if (!validRole("tag", result, request.payload!)) throw Error("invalid benchmark output");
          outputs[i] = result;
        }
      }),
    );
    const seconds = (performance.now() - started) / 1000;
    let input = 0,
      output = 0;
    for (const result of outputs)
      for (const phase of (
        proof(result) as { phases?: { inputTokens: number; outputTokens: number }[] } | undefined
      )?.phases ?? []) {
        input += phase.inputTokens;
        output += phase.outputTokens;
      }
    const engines = await workers.ready;
    const report = {
      prefill: model.prefillSize,
      requests: count,
      seconds,
      stageJobsPerMinute: (count * 60) / seconds,
      inputTokens: input,
      inputTokensPerSecond: input / seconds,
      outputTokens: output,
      outputTokensPerSecond: output / seconds,
      valid: true,
      outputHashes: outputs.map((v) => hash(JSON.stringify(v))),
      metrics: engines.map((w) => w.metrics),
      scope:
        "Synthetic Tag only, 16 application requests and 64 decode slots; no full-source or six-stage throughput claim",
    };
    await atomic(join(work, "benchmark.json"), report);
    console.log(JSON.stringify({ ...report, outputHashes: undefined, metrics: undefined }));
  } finally {
    await workers.close();
  }
}
