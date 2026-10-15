import { DatabaseSync } from "node:sqlite";
import { chmod, mkdir, open, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, parse, relative } from "node:path";
import { atomic, hash } from "./store.ts";

export type Task = {
  id: string;
  name: string;
  cloudId: string;
  inputs: Record<string, unknown>;
  kind: string;
  scope: string;
  entity?: string;
};
type Receipt = { task: Task; response: unknown; children: Task[]; error: string | null };
type Row = { id: string; receipt: string; digest: string; response: string };
function encode(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) throw Error("receipt must contain JSON data");
  return text;
}
function validate(task: Task) {
  if (!/^[a-f0-9]{64}$/.test(task.id)) throw Error("invalid task identifier");
}

/** Reject aliases in existing ancestors as well as the target itself. */
async function unaliased(path: string): Promise<void> {
  const absolute = resolve(path),
    base = parse(absolute).root;
  let current = base;
  for (const part of relative(base, absolute).split("/")) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || (!info.isDirectory() && info.nlink > 1))
        throw Error("aliased intake path");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Local, durable connector receipts and an atomic child-task queue. */
export class Intake {
  private root: string;
  private db: DatabaseSync;
  private constructor(root: string, db: DatabaseSync) {
    this.root = root;
    this.db = db;
  }
  static async open(root: string): Promise<Intake> {
    root = resolve(root);
    const path = join(root, "state", "intake.sqlite");
    // Preflight every existing component before changing any permissions.
    const targets = [
      root,
      join(root, "state"),
      join(root, "staging"),
      path,
      path + "-wal",
      path + "-shm",
      path + "-journal",
    ];
    for (const target of targets) await unaliased(target);
    for (const directory of [root, join(root, "state"), join(root, "staging")]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }
    if ((await realpath(root)) !== root) throw Error("aliased intake root");
    for (const directory of [root, join(root, "state"), join(root, "staging")]) {
      await chmod(directory, 0o700);
    }
    // Create privately before SQLite opens the file and its sidecars.
    const file = await open(
      path,
      constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    await file.chmod(0o600);
    await file.close();
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, task TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY REFERENCES jobs(id), receipt TEXT NOT NULL, digest TEXT NOT NULL, response TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0);`);
    return new Intake(root, db);
  }
  private transaction(action: () => void) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      action();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private insert(task: Task) {
    validate(task);
    const text = encode(task);
    const prior = this.db.prepare("SELECT task FROM jobs WHERE id=?").get(task.id);
    if (prior && prior.task !== text) throw Error("task identifier collision");
    this.db.prepare("INSERT OR IGNORE INTO jobs(id,task) VALUES(?,?)").run(task.id, text);
  }
  seed(tasks: Task[]): void {
    this.transaction(() => {
      for (const task of tasks) this.insert(task);
    });
  }
  pending(limit = 10): Task[] {
    if (!Number.isSafeInteger(limit) || limit < 0) throw Error("invalid task limit");
    return this.db
      .prepare("SELECT task FROM jobs WHERE state='pending' ORDER BY rowid LIMIT ?")
      .all(limit)
      .map((row) => JSON.parse(String(row.task)) as Task);
  }
  async accept(task: Task, response: unknown, children: Task[]): Promise<void> {
    await this.receive({ task, response, children, error: null });
  }
  async fail(task: Task, response: unknown, error: string): Promise<void> {
    await this.receive({ task, response, children: [], error });
  }
  private async receive(receipt: Receipt): Promise<void> {
    validate(receipt.task);
    const text = encode(receipt),
      response = encode(receipt.response),
      digest = hash(text);
    this.transaction(() => {
      this.insert(receipt.task);
      const prior = this.db.prepare("SELECT * FROM receipts WHERE id=?").get(receipt.task.id) as
        | Row
        | undefined;
      if (prior) {
        this.inspect(prior);
        if (prior.receipt !== text) throw Error("conflicting receipt");
        return;
      }
      for (const child of receipt.children) this.insert(child);
      this.db
        .prepare("INSERT INTO receipts(id,receipt,digest,response) VALUES(?,?,?,?)")
        .run(receipt.task.id, text, digest, response);
      this.db
        .prepare("UPDATE jobs SET state=? WHERE id=?")
        .run(receipt.error === null ? "accepted" : "failed", receipt.task.id);
    });
    await this.recover();
  }
  private inspect(row: Row) {
    validate({ id: row.id } as Task);
    if (hash(row.receipt) !== row.digest) throw Error("corrupt receipt");
    const receipt = JSON.parse(row.receipt) as Receipt;
    if (receipt.task.id !== row.id || encode(receipt.response) !== row.response)
      throw Error("corrupt receipt");
  }
  async recover(): Promise<void> {
    for (;;) {
      const rows = this.db
        .prepare("SELECT * FROM receipts WHERE published=0 ORDER BY rowid LIMIT 100")
        .all() as Row[];
      if (!rows.length) return;
      for (const row of rows) {
        this.inspect(row);
        await atomic(join(this.root, "staging", row.id + ".jsonl"), row.response + "\n", true);
        this.db
          .prepare("UPDATE receipts SET published=1 WHERE id=? AND digest=?")
          .run(row.id, row.digest);
      }
    }
  }
  async verify(): Promise<{ receipts: number; mirrors: number }> {
    const missing = this.db
      .prepare(
        "SELECT jobs.id FROM jobs LEFT JOIN receipts ON jobs.id=receipts.id WHERE jobs.state IN ('accepted','failed') AND receipts.id IS NULL LIMIT 1",
      )
      .get();
    const orphan = this.db
      .prepare(
        "SELECT receipts.id FROM receipts LEFT JOIN jobs ON receipts.id=jobs.id WHERE jobs.id IS NULL LIMIT 1",
      )
      .get();
    if (missing || orphan) throw Error("inconsistent receipt ownership");
    const counts = { receipts: 0, mirrors: 0 };
    for (const value of this.db.prepare("SELECT * FROM receipts ORDER BY rowid").iterate()) {
      const row = value as Row;
      this.inspect(row);
      counts.receipts++;
      const mirror = join(this.root, "staging", row.id + ".jsonl");
      await unaliased(mirror);
      const file = await open(mirror, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const digest = createHash("sha256");
        for await (const chunk of file.createReadStream({ autoClose: false })) digest.update(chunk);
        if (digest.digest("hex") !== hash(row.response + "\n"))
          throw Error("corrupt receipt mirror");
        counts.mirrors++;
      } finally {
        await file.close();
      }
    }
    return counts;
  }
  status() {
    const counts = { pending: 0, accepted: 0, failed: 0, unpublished: 0 };
    for (const row of this.db.prepare("SELECT state,COUNT(*) n FROM jobs GROUP BY state").all()) {
      counts[row.state as "pending" | "accepted" | "failed"] = Number(row.n);
    }
    counts.unpublished = Number(
      this.db.prepare("SELECT COUNT(*) n FROM receipts WHERE published=0").get()!.n,
    );
    return counts;
  }
  close(): void {
    this.db.close();
  }
}
