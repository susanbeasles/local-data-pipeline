import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { proof } from "./proof.ts";

type Total = {
  role: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  unknown: number;
  milliseconds: number;
};
function tokens(value: unknown): [number, number] | undefined {
  if (!value || typeof value !== "object") return;
  const phases = (value as { phases?: unknown }).phases;
  if (!Array.isArray(phases) || !phases.length) return;
  let input = 0,
    output = 0;
  for (const phase of phases) {
    if (
      !phase ||
      !Number.isSafeInteger(phase.inputTokens) ||
      phase.inputTokens < 0 ||
      !Number.isSafeInteger(phase.outputTokens) ||
      phase.outputTokens < 0
    )
      return;
    input += phase.inputTokens;
    output += phase.outputTokens;
    if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output)) return;
  }
  return [input, output];
}
/** Local metadata only. Returned model calls are distinct from validated completed files. */
export class Usage {
  db: DatabaseSync;
  readonly model: string;
  readonly config: string;
  constructor(path: string, model: string, config: string) {
    this.model = model;
    this.config = config;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS usage (
        id TEXT PRIMARY KEY, model TEXT NOT NULL, config TEXT NOT NULL,
        job TEXT NOT NULL, role TEXT NOT NULL, attempt INTEGER NOT NULL,
        started INTEGER NOT NULL, milliseconds REAL, state TEXT NOT NULL,
        input_tokens INTEGER, output_tokens INTEGER);
      CREATE INDEX IF NOT EXISTS usage_role ON usage(model,config,role);`);
  }
  async measure<T>(
    job: string,
    role: string,
    attempt: number,
    infer: () => Promise<T>,
    config = this.config,
  ): Promise<T> {
    const id = randomUUID(),
      start = performance.now();
    this.db
      .prepare(
        "INSERT INTO usage(id,model,config,job,role,attempt,started,state) VALUES(?,?,?,?,?,?,?,'running')",
      )
      .run(id, this.model, config, job, role, attempt, Date.now());
    let state = "failed",
      counts: [number, number] | undefined;
    try {
      const result = await infer();
      counts = tokens(proof(result));
      state = "returned";
      return result;
    } finally {
      // Interrupted calls retain running state and NULL counts across restart.
      // Missing/failed proof is unknown, never represented as zero tokens.
      this.db
        .prepare(
          "UPDATE usage SET milliseconds=?,state=?,input_tokens=?,output_tokens=? WHERE id=?",
        )
        .run(performance.now() - start, state, counts?.[0] ?? null, counts?.[1] ?? null, id);
    }
  }
  totals(): Total[] {
    return this.db
      .prepare(
        `SELECT role,count(*) calls,coalesce(sum(input_tokens),0) inputTokens,
      coalesce(sum(output_tokens),0) outputTokens,sum(input_tokens IS NULL) unknown,
      coalesce(sum(milliseconds),0) milliseconds FROM usage WHERE model=? AND config=? GROUP BY role ORDER BY role`,
      )
      .all(this.model, this.config) as Total[];
  }
  close() {
    this.db.close();
  }
}

/** Read-only aggregates; no source text, prompts, or generated content is loaded. */
export function usage(work: string) {
  const path = join(work, "state", "usage.sqlite");
  if (!existsSync(path))
    return { available: false, reason: "This run predates usage instrumentation." };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=1000");
    const history = db
      .prepare(
        `SELECT model,config,role,count(*) calls,
      sum(state='returned') returned,sum(state='failed') failed,sum(state='running') interruptedOrActive,
      sum(input_tokens IS NULL) unknown,coalesce(sum(input_tokens),0) inputTokens,
      coalesce(sum(output_tokens),0) outputTokens,coalesce(sum(milliseconds),0) callMilliseconds,
      min(started) firstCall,max(started) lastCall,
      avg(CASE WHEN state='returned' THEN input_tokens END) meanInput,
      avg(CASE WHEN state='returned' THEN output_tokens END) meanOutput,
      count(CASE WHEN state='returned' AND input_tokens IS NOT NULL THEN 1 END) samples
      FROM usage GROUP BY model,config,role ORDER BY lastCall DESC LIMIT 100`,
      )
      .all();
    const phasePath = join(work, "state/phase.json");
    const generation = existsSync(phasePath)
      ? JSON.parse(readFileSync(phasePath, "utf8")).generation
      : undefined;
    const planned: { role: string; config: string; pending: number }[] = [];
    for (const name of ["pipeline.sqlite", "graph.sqlite"]) {
      if (name === "graph.sqlite" && typeof generation !== "string") continue;
      const file = join(work, "state", name);
      if (!existsSync(file)) continue;
      const jobs = new DatabaseSync(file, { readOnly: true });
      try {
        jobs.exec("PRAGMA busy_timeout=1000");
        planned.push(
          ...(jobs
            .prepare(
              "SELECT role,config,count(*) pending FROM jobs WHERE state IN ('pending','running')" +
                (name === "graph.sqlite" ? " AND config=?" : "") +
                " GROUP BY role,config",
            )
            .all(...(name === "graph.sqlite" ? [generation] : [])) as typeof planned),
        );
      } finally {
        jobs.close();
      }
    }
    const forecast = planned.map((stage) => {
      const sample = db
        .prepare(
          `SELECT model,avg(input_tokens) meanInput,avg(output_tokens) meanOutput,count(*) samples
        FROM usage WHERE role=? AND config=? AND state='returned' AND input_tokens IS NOT NULL
        GROUP BY model ORDER BY max(started) DESC LIMIT 1`,
        )
        .get(stage.role, stage.config);
      const known = sample && Number(sample.samples) > 0;
      return {
        ...stage,
        inputTokens: known ? Math.ceil(stage.pending * Number(sample.meanInput)) : null,
        outputTokens: known ? Math.ceil(stage.pending * Number(sample.meanOutput)) : null,
        samples: sample?.samples ?? 0,
        basis: known
          ? "Historical successful calls; excludes future retries"
          : "Unknown: no matching measured history",
      };
    });
    return {
      available: true,
      history,
      forecast,
      limitations: [
        "Forecasts are estimates, not tokenizer counts or output caps.",
        "Unmaterialized graph work and graph generations without an active scope are unknown and excluded.",
        "Call duration includes queue wait; summed concurrent durations are not wall time.",
        "Returned calls are not validated completed files.",
        "Missing failed/interrupted token counts are unknown; totals are lower bounds.",
      ],
    };
  } finally {
    db.close();
  }
}
