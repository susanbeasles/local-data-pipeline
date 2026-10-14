import { DatabaseSync } from "node:sqlite";
import { mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { hash } from "./store.ts";
import { phase } from "./progress.ts";
export type Review = { after: string[] };
export type Decision = "approve" | "retry" | "reject";
export type Receipt = { id: string; state: string; outputHash: unknown; attempt: unknown };
function open(work: string) {
  const db = new DatabaseSync(join(work, "state/review.sqlite"));
  db.exec(
    `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS gates(id TEXT PRIMARY KEY, role TEXT NOT NULL, complete INTEGER NOT NULL, state TEXT NOT NULL, at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS decisions(id INTEGER PRIMARY KEY,gate TEXT NOT NULL,decision TEXT NOT NULL,at TEXT NOT NULL);`,
  );
  return db;
}
export async function gates(work: string) {
  try {
    await access(join(work, "state/review.sqlite"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const db = new DatabaseSync(join(work, "state/review.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT * FROM gates ORDER BY at DESC LIMIT 100").all();
  } finally {
    db.close();
  }
}
export function decide(work: string, id: string, decision: Decision) {
  if (!/^[a-f0-9]{64}$/.test(id) || !["approve", "retry", "reject"].includes(decision))
    throw Error("invalid review decision");
  const db = open(work);
  try {
    db.exec("BEGIN IMMEDIATE");
    const gate = db.prepare("SELECT * FROM gates WHERE id=?").get(id);
    if (!gate || gate.state !== "waiting") throw Error("review is no longer waiting");
    if (decision === "approve" && !gate.complete)
      throw Error("incomplete stage cannot be approved");
    const at = new Date().toISOString();
    db.prepare("UPDATE gates SET state=?,at=? WHERE id=?").run(decision, at, id);
    db.prepare("INSERT INTO decisions(gate,decision,at) VALUES(?,?,?)").run(id, decision, at);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    db.close();
  }
}
export async function review(
  work: string,
  role: string,
  scope: string,
  receipts: Receipt[],
  resume = false,
  generation?: string,
): Promise<Decision> {
  await mkdir(join(work, "state"), { recursive: true });
  const id = hash(
    JSON.stringify({
      role,
      scope,
      receipts: receipts.slice().sort((a, b) => a.id.localeCompare(b.id)),
    }),
  );
  const db = open(work);
  try {
    db.prepare("INSERT OR IGNORE INTO gates VALUES(?,?,?,'waiting',?)").run(
      id,
      role,
      receipts.every((r) => r.state === "completed") ? 1 : 0,
      new Date().toISOString(),
    );
    if (resume)
      db.prepare("UPDATE gates SET state='waiting' WHERE id=? AND state IN ('reject','retry')").run(
        id,
      );
    await phase(work, "review:" + role, "running", generation);
    for (;;) {
      const state = String(db.prepare("SELECT state FROM gates WHERE id=?").get(id)!.state);
      if (state === "approve" || state === "retry" || state === "reject") return state;
      await new Promise((r) => setTimeout(r, 200));
    }
  } finally {
    db.close();
  }
}
