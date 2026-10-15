import { join } from "node:path";
import { Store, publish } from "./store.ts";
import type { Config } from "./run.ts";
export async function disposition(
  config: Config,
  relations: { generation?: string; integrity: boolean },
) {
  const core = new Store(join(config.work, "state", "pipeline.sqlite")),
    graph = relations.generation ? new Store(join(config.work, "state", "graph.sqlite")) : null;
  core.db.exec(
    "CREATE TABLE IF NOT EXISTS dispositions(id TEXT PRIMARY KEY,sourceHash TEXT,state TEXT NOT NULL,model TEXT NOT NULL,body TEXT NOT NULL)",
  );
  const path = join(config.work, "output", "files.jsonl");
  const counts: Record<string, number> = {
    completed: 0,
    failed: 0,
    pending: 0,
    running: 0,
    invalid: 0,
    unsupported: 0,
  };
  let count = 0;
  try {
    for (const source of core.db.prepare("SELECT * FROM sources ORDER BY path").iterate()) {
      let state = String(source.state),
        proof: any = { candidates: 0, completed: 0, failed: 0, pending: 0 };
      if (state === "completed") {
        if (graph) {
          proof = graph.db
            .prepare(
              `SELECT count(DISTINCT c.id) candidates,sum(j.state='completed') completed,sum(j.state='failed') failed,sum(j.state='pending' OR j.state='running') pending FROM candidates c JOIN entities a ON a.id=c.first JOIN entities b ON b.id=c.second JOIN jobs j ON j.source=c.id WHERE c.generation=? AND (a.source=? OR b.source=?)`,
            )
            .get(relations.generation!, source.id, source.id)!;
          if (Number(proof.failed ?? 0) > 0) state = "failed";
          else if (Number(proof.completed ?? 0) !== Number(proof.candidates) * 2) state = "pending";
        } else state = "pending";
      }
      const chunks = core.db
        .prepare(
          "SELECT id,chunk,role,state,attempt,output,outputHash,error FROM jobs WHERE source=? ORDER BY chunk,role",
        )
        .all(source.id);
      const row = {
        source: source.id,
        path: source.path,
        sourceHash: source.hash,
        state,
        reason: source.reason,
        model: config.model,
        chunks,
        graph: {
          ...proof,
          generation: relations.generation,
          disposition:
            Number(proof.candidates) === 0 ? "no entity-pair candidates" : "adjudicated pairs",
        },
      };
      const text = JSON.stringify(row);
      count++;
      counts[state]++;
      core.transaction(() =>
        core.db
          .prepare("INSERT OR REPLACE INTO dispositions VALUES(?,?,?,?,?)")
          .run(source.id, source.hash, state, config.model, text),
      );
    }
    let hash: string | null = null;
    const exportErrors: string[] = [];
    function* rows() {
      for (const row of core.db
        .prepare("SELECT d.body FROM dispositions d JOIN sources s ON s.id=d.id ORDER BY s.path")
        .iterate())
        yield String(row.body) + "\n";
    }
    try {
      hash = await publish(path, rows());
      core.transaction(() =>
        core.db
          .prepare("INSERT OR REPLACE INTO artifacts VALUES(?,?,?)")
          .run(path, hash!, "enrichment"),
      );
    } catch (error) {
      exportErrors.push(String(error));
      console.error(
        JSON.stringify({ type: "export-failed", kind: "disposition", error: String(error) }),
      );
    }
    return { path, hash, count, counts, exportErrors };
  } finally {
    graph?.close();
    core.close();
  }
}
