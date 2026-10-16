import { Store } from "./store.ts";
export type Job = {
  id: string;
  source: string;
  chunk: number;
  role: string;
  attempt: number;
};
export class Jobs {
  private leases: Job[] = [];
  private store: Store;
  private capacity: number;
  private role?: string;
  private config?: string;
  constructor(store: Store, capacity: number, role?: string, config?: string) {
    this.config = config;
    this.role = role;
    this.store = store;
    this.capacity = capacity;
  }
  claim(): Job | undefined {
    if (!this.leases.length) {
      const db = this.store.db;
      this.leases = this.store.transaction(() => {
        const rows = db
          .prepare(
            "SELECT * FROM jobs WHERE state='pending' AND (? IS NULL OR role=?) AND (? IS NULL OR config=?) ORDER BY source,chunk,role LIMIT ?",
          )
          .all(
            this.role ?? null,
            this.role ?? null,
            this.config ?? null,
            this.config ?? null,
            this.capacity,
          ) as Job[];
        return rows.map((j) => {
          const attempt = Number(j.attempt) + 1;
          db.prepare(
            "UPDATE jobs SET state='running',attempt=? WHERE id=?",
          ).run(attempt, j.id);
          db.prepare("INSERT INTO attempts VALUES(?,?,'running',NULL,?)").run(
            j.id,
            attempt,
            new Date().toISOString(),
          );
          return { ...j, attempt };
        });
      });
    }
    return this.leases.shift();
  }
}
