import { join, dirname } from "node:path";
import { mkdir, open, rename } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { Store } from "./store.ts";
import type { Config } from "./run.ts";
export async function disposition(
  config: Config,
  relations: { generation?: string; integrity: boolean },
) {
  const core = new Store(join(config.work, "state", "pipeline.sqlite")),
    graph = relations.generation
      ? new Store(join(config.work, "state", "graph.sqlite"))
      : null;
  core.db.exec(
    "CREATE TABLE IF NOT EXISTS dispositions(id TEXT PRIMARY KEY,sourceHash TEXT,state TEXT NOT NULL,model TEXT NOT NULL,body TEXT NOT NULL)",
  );
  const path = join(config.work, "output", "files.jsonl");
  await mkdir(dirname(path), { recursive: true });
  const temp = path + "." + randomUUID() + ".tmp",
    f = await open(temp, "wx", 0o600),
    digest = createHash("sha256");
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
    for (const source of core.db
      .prepare("SELECT * FROM sources ORDER BY path")
      .iterate()) {
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
          else if (
            Number(proof.completed ?? 0) !==
            Number(proof.candidates) * 2
          )
            state = "pending";
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
            Number(proof.candidates) === 0
              ? "no entity-pair candidates"
              : "adjudicated pairs",
        },
      };
      const text = JSON.stringify(row),
        line = text + "\n";
      await f.writeFile(line);
      digest.update(line);
      count++;
      counts[state]++;
      core.transaction(() =>
        core.db
          .prepare("INSERT OR REPLACE INTO dispositions VALUES(?,?,?,?,?)")
          .run(source.id, source.hash, state, config.model, text),
      );
    }
    await f.sync();
    await f.close();
    await rename(temp, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    const hash = digest.digest("hex");
    core.transaction(() =>
      core.db
        .prepare("INSERT OR REPLACE INTO artifacts VALUES(?,?,?)")
        .run(path, hash, "enrichment"),
    );
    return { path, hash, count, counts };
  } finally {
    try {
      await f.close();
    } catch {}
    graph?.close();
    core.close();
  }
}
