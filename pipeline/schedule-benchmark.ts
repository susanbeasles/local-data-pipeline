/** Identical synthetic prompts; application concurrency is the only variable. */
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pool, type Model } from "./mlx.ts";
import { proof } from "./proof.ts";
import { assertNetworkDenied } from "./sandbox.ts";
import { validRole } from "./roles.ts";
import { hash, atomic } from "./store.ts";
import type { Request } from "./run.ts";
export function fixture(index: number): Request {
  const line =
    'import { DatabaseSync } from "node:sqlite";\nconst db = new DatabaseSync(":memory:");\ndb.exec("CREATE TABLE records(id TEXT PRIMARY KEY, body TEXT)");\n';
  const text = line.repeat(40);
  const chunk = { id: hash(text), index: 0, start: 0, end: text.length, text, hash: hash(text) };
  return {
    id: hash("fixture:" + index),
    role: "tag",
    attempt: 1,
    text,
    chunk,
    sourceHash: hash(text),
    configHash: "synthetic-scheduling",
    payload: {
      spans: [{ id: 0, text }],
      context: { trustedNamespace: "fixture", languageHint: "TypeScript", syntax: "code" },
      prior: {},
    },
  };
}
if (process.argv[1] === import.meta.filename) {
  await assertNetworkDenied();
  const root = resolve(process.argv[2]!);
  const model = JSON.parse(await readFile(join(root, "model.json"), "utf8")) as Model;
  const workers = pool(model),
    reports = [];
  try {
    await workers.ready;
    await workers.infer(fixture(999));
    for (const concurrency of [4, 16]) {
      let cursor = 0;
      const outputs: unknown[] = new Array(16);
      const started = performance.now();
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          for (;;) {
            const i = cursor++;
            if (i >= 16) return;
            outputs[i] = await workers.infer(fixture(concurrency * 100 + i));
          }
        }),
      );
      const seconds = (performance.now() - started) / 1000;
      let input = 0,
        output = 0;
      for (const result of outputs) {
        if (!validRole("tag", result, { spans: [], context: {}, prior: {} }))
          throw Error("invalid synthetic tag result");
        for (const p of (
          proof(result) as { phases?: { inputTokens: number; outputTokens: number }[] } | undefined
        )?.phases ?? []) {
          input += p.inputTokens;
          output += p.outputTokens;
        }
      }
      const report = {
        concurrency,
        requests: 16,
        seconds,
        stageJobsPerMinute: (16 * 60) / seconds,
        inputTokens: input,
        inputTokensPerSecond: input / seconds,
        outputTokens: output,
        outputTokensPerSecond: output / seconds,
        valid: true,
        outputHashes: outputs.map((v) => hash(JSON.stringify(v))),
      };
      reports.push(report);
      await atomic(join(root, "comparison.json"), {
        reports,
        scope: "Synthetic Tag stage only; not full six-stage file throughput",
        finished: false,
      });
      console.log(JSON.stringify({ ...report, outputHashes: undefined }));
    }
    const sameOutputs =
      JSON.stringify(reports[0]!.outputHashes) === JSON.stringify(reports[1]!.outputHashes);
    const best = sameOutputs && reports[1]!.seconds < reports[0]!.seconds * 0.95 ? 16 : 4;
    await atomic(join(root, "comparison.json"), {
      reports,
      sameOutputs,
      best,
      finished: true,
      scope: "Synthetic Tag stage only; not full six-stage file throughput",
    });
  } finally {
    await workers.close();
  }
}
