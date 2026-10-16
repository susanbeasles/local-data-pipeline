import { DatabaseSync } from "node:sqlite";
import { open, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
export const hash = (v: string | Uint8Array) =>
  createHash("sha256").update(v).digest("hex");
export async function atomic(path: string, value: unknown, raw = false) {
  await mkdir(dirname(path), { recursive: true });
  const temp = path + "." + randomUUID() + ".tmp",
    f = await open(temp, "wx", 0o600);
  try {
    await f.writeFile(raw ? String(value) : JSON.stringify(value) + "\n");
    await f.sync();
  } finally {
    await f.close();
  }
  await rename(temp, path);
  const d = await open(dirname(path), "r");
  try {
    await d.sync();
  } finally {
    await d.close();
  }
}
export class Store {
  db: DatabaseSync;
  private writes: {
    write: () => void;
    resolve: () => void;
    reject: (e: unknown) => void;
  }[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,path TEXT NOT NULL,hash TEXT,state TEXT NOT NULL,reason TEXT,stage TEXT,stageHash TEXT,generation TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,source TEXT NOT NULL,chunk INTEGER NOT NULL,role TEXT NOT NULL,config TEXT NOT NULL,state TEXT NOT NULL,attempt INTEGER NOT NULL DEFAULT 0,output TEXT,outputHash TEXT,error TEXT);
CREATE INDEX IF NOT EXISTS jobs_schedule ON jobs(state,source,chunk,role);
CREATE INDEX IF NOT EXISTS jobs_source ON jobs(source);
CREATE TABLE IF NOT EXISTS artifacts(path TEXT PRIMARY KEY,hash TEXT NOT NULL,job TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS attempts(job TEXT,attempt INTEGER,state TEXT,error TEXT,time TEXT,PRIMARY KEY(job,attempt));`);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  commit(write: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      this.writes.push({ write, resolve, reject });
      if (!this.timer)
        this.timer = setTimeout(() => {
          this.timer = undefined;
          const batch = this.writes;
          this.writes = [];
          try {
            this.transaction(() => {
              for (const item of batch) item.write();
            });
            for (const item of batch) item.resolve();
          } catch (e) {
            for (const item of batch) item.reject(e);
          }
        }, 10);
    });
  }
  close() {
    if (this.writes.length) throw Error("uncommitted state writes");
    this.db.close();
  }
}
