import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { run, verify, boundaries, type Config, type Inference } from "./run.ts";
import { disposition } from "./disposition.ts";
import { graph } from "./graph.ts";
import { order } from "./roles.ts";
import { Lock } from "./lock.ts";
import { atomic } from "./store.ts";
import { phase } from "./progress.ts";
export async function enrich(config: Config, infer: Inference) {
  if (
    config.roles.join(",") !== order.join(",") ||
    !config.enrichment?.namespace?.trim()
  )
    throw Error(
      "enrichment requires all six ordered roles and explicit namespace",
    );
  const paths = await boundaries(config.input, config.work);
  config = { ...config, ...paths };
  await mkdir(join(config.work, "state"), { recursive: true });
  const lock = await Lock.acquire(join(config.work, "state", "enrich.lock"));
  const started = performance.now();
  try {
    await phase(config.work, "chunk-stages");
    const chunks = await run({ ...config, roles: order.slice(0, 4) }, infer);
    const relations = chunks.integrity
      ? await graph(config, infer)
      : {
          generation: undefined,
          entities: 0,
          candidates: 0,
          jobs: 0,
          completed: 0,
          failed: 0,
          pending: 0,
          errors: ["chunk stages incomplete"],
          integrity: false,
        };
    const files = await disposition(config, relations);
    const sourceProof = relations.integrity
      ? await verify(config.work, config.input)
      : chunks;
    const integrity =
      chunks.integrity && relations.integrity && sourceProof.integrity;
    const completed = files.counts.completed,
      seconds = (performance.now() - started) / 1000;
    const report = {
      completed,
      files,
      failed: files.counts.failed,
      pending: files.counts.pending + files.counts.running,
      unsupported: files.counts.unsupported,
      invalid: files.counts.invalid,
      discovered: chunks.discovered,
      integrity,
      seconds,
      filesPerMinute: (completed * 60) / seconds,
      chunks,
      graph: relations,
      stages: order,
    };
    await atomic(join(config.work, "state", "enrichment-report.json"), report);
    await phase(
      config.work,
      integrity ? "completed" : "incomplete",
      integrity ? "completed" : "failed",
      relations.generation,
    );
    return report;
  } catch (error) {
    await phase(config.work, "failed", "failed", undefined, String(error));
    throw error;
  } finally {
    await lock.close();
  }
}
