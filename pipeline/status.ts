import { DatabaseSync } from "node:sqlite";
import { readFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { order } from "./roles.ts";
type Counts = {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
};
const zero = (): Counts => ({
  total: 0,
  pending: 0,
  running: 0,
  completed: 0,
  failed: 0,
});
async function present(path: string) {
  try {
    await access(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
async function json(path: string): Promise<any> {
  return (await present(path))
    ? JSON.parse(await readFile(path, "utf8"))
    : undefined;
}
function inspect(path: string, generation?: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=1000; BEGIN");
    const where = generation ? "WHERE config=?" : "",
      args = generation ? [generation] : [];
    const columns =
      "count(*) total,coalesce(sum(state='pending'),0) pending,coalesce(sum(state='running'),0) running,coalesce(sum(state='completed'),0) completed,coalesce(sum(state='failed'),0) failed";
    const counts = db
      .prepare(`SELECT ${columns} FROM jobs ${where}`)
      .get(...args) as Counts;
    const roles = db
      .prepare(
        `SELECT role,${columns} FROM jobs ${where} GROUP BY role ORDER BY role LIMIT 6`,
      )
      .all(...args);
    const failures = db
      .prepare(
        `SELECT id,role,attempt,error FROM jobs WHERE state='failed' ${generation ? "AND config=?" : ""} ORDER BY id LIMIT 5`,
      )
      .all(...args);
    db.exec("COMMIT");
    return { counts, roles, failures };
  } finally {
    db.close();
  }
}
export async function status(work: string) {
  work = resolve(work);
  const phase = await json(join(work, "state", "phase.json"));
  let alive = false;
  if (
    phase?.state === "running" &&
    Number.isSafeInteger(phase.pid) &&
    phase.pid > 0
  ) {
    try {
      process.kill(phase.pid, 0);
      alive = true;
    } catch (e) {
      alive = (e as NodeJS.ErrnoException).code === "EPERM";
    }
  }
  const corePath = join(work, "state", "pipeline.sqlite"),
    graphPath = join(work, "state", "graph.sqlite");
  const core = (await present(corePath))
    ? inspect(corePath)
    : { counts: zero(), roles: [], failures: [] };
  const graph = (await present(graphPath))
    ? inspect(graphPath, phase?.generation)
    : { counts: zero(), roles: [], failures: [] };
  const jobs = Object.fromEntries(
    Object.keys(zero()).map((key) => [
      key,
      core.counts[key as keyof Counts] + graph.counts[key as keyof Counts],
    ]),
  ) as Counts;
  const benchmark = await json(join(work, "benchmark.json"));
  const qualityErrors: string[] = benchmark?.qualityErrors ?? [];
  return {
    work,
    phase:
      phase?.state === "running"
        ? alive
          ? phase.phase
          : "interrupted"
        : qualityErrors.length
          ? "acceptance-failed"
          : (phase?.phase ?? (jobs.total ? "checkpointed" : "not-started")),
    alive,
    resume: !alive && jobs.pending + jobs.running + jobs.failed > 0,
    jobs,
    percent: jobs.total
      ? Math.round((jobs.completed * 10000) / jobs.total) / 100
      : 0,
    roles: [...core.roles, ...graph.roles].sort(
      (a, b) =>
        order.indexOf(String(a.role) as (typeof order)[number]) -
        order.indexOf(String(b.role) as (typeof order)[number]),
    ),
    failures: [...core.failures, ...graph.failures].slice(0, 5),
    graphScope: phase?.generation
      ? "current generation"
      : "all checkpoint history",
    qualityErrors,
    updatedAt: phase?.at,
  };
}
if (process.argv[1] === import.meta.filename) {
  const work = process.argv[2];
  if (!work)
    throw Error("Usage: node pipeline/status.ts /absolute/work [--watch]");
  do {
    console.log(JSON.stringify(await status(work), null, 2));
    if (!process.argv.includes("--watch")) break;
    await new Promise((ok) => setTimeout(ok, 2000));
  } while (true);
}
