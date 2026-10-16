import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { Source, Chunk } from "./source.ts";
import type { Config } from "./run.ts";
const digest = (body: string) =>
  createHash("sha256")
    .update(body + "\n")
    .digest("hex");
export type Data = Omit<Source, "chunks"> & {
  chunks: Omit<Chunk, "text">[];
  roles: string[];
  configHash: string;
  enrichment?: Config["enrichment"];
  profile?: Config["profile"];
};
/** SQLite owns inference data. Paths in provenance never resolve model inputs. */
export class Records {
  db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`
 CREATE TABLE IF NOT EXISTS source_data(id TEXT PRIMARY KEY,body TEXT NOT NULL CHECK(json_valid(body)),digest TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS chunk_data(source TEXT NOT NULL,n INTEGER NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),digest TEXT NOT NULL,PRIMARY KEY(source,n));
 CREATE TABLE IF NOT EXISTS results(job TEXT PRIMARY KEY,body TEXT NOT NULL CHECK(json_valid(body)),digest TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS attempt_data(job TEXT NOT NULL,n INTEGER NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),digest TEXT NOT NULL,PRIMARY KEY(job,n));
 CREATE TABLE IF NOT EXISTS data_schema(id INTEGER PRIMARY KEY CHECK(id=1),state TEXT NOT NULL);
 INSERT OR IGNORE INTO data_schema SELECT 1,CASE WHEN EXISTS(SELECT 1 FROM jobs WHERE state='completed') THEN 'needs-import' ELSE 'ready' END;
 CREATE VIRTUAL TABLE IF NOT EXISTS chunk_search USING fts5(source UNINDEXED,n UNINDEXED,text);
 CREATE VIEW IF NOT EXISTS model_data AS SELECT source,n,json_extract(body,'$.text') text,json_extract(body,'$.hash') hash,body FROM chunk_data;
 `);
  }
  assertReady() {
    if (this.db.prepare("SELECT state FROM data_schema WHERE id=1").get()?.state !== "ready")
      throw Error(
        "Legacy file-backed checkpoint requires explicit import before inference: node pipeline/migrate.ts /absolute/work; completed jobs were not rescheduled",
      );
  }
  failure(job: string, n: number, error: unknown, partial?: unknown, outputTokens?: unknown) {
    const row = this.db
      .prepare("SELECT body,digest FROM attempt_data WHERE job=? AND n=?")
      .get(job, n);
    const value = row ? this.decode(row, "attempt " + job + ":" + n) : { job, attempt: n };
    this.attempt(job, n, {
      ...value,
      error: String(error),
      ...(partial === undefined ? {} : { partial }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
    });
  }
  ingest(
    source: Source,
    context: Pick<Config, "roles" | "enrichment" | "profile"> & { configHash: string },
  ) {
    const { chunks, chunkFile: _file, chunkHash: _hash, ...rest } = source;
    const body = JSON.stringify({
      ...rest,
      chunks: chunks.map(({ text: _text, ...metadata }) => metadata),
      ...context,
    });
    const prior = this.db.prepare("SELECT body,digest FROM source_data WHERE id=?").get(source.id);
    {
      const rows = this.db
        .prepare("SELECT n,body,digest FROM chunk_data WHERE source=? ORDER BY n")
        .all(source.id);
      if (
        rows.length === chunks.length &&
        rows.every((row, i) => {
          const expected = JSON.stringify(chunks[i]);
          return (
            row.n === chunks[i]!.index && row.body === expected && row.digest === digest(expected)
          );
        })
      ) {
        if (prior?.body !== body || prior.digest !== digest(body))
          this.db
            .prepare("INSERT OR REPLACE INTO source_data VALUES(?,?,?)")
            .run(source.id, body, digest(body));
        return;
      }
    }
    this.db
      .prepare("INSERT OR REPLACE INTO source_data VALUES(?,?,?)")
      .run(source.id, body, digest(body));
    this.db.prepare("DELETE FROM chunk_data WHERE source=?").run(source.id);
    this.db.prepare("DELETE FROM chunk_search WHERE source=?").run(source.id);
    const insert = this.db.prepare("INSERT INTO chunk_data VALUES(?,?,?,?)");
    for (const chunk of chunks) {
      const row = JSON.stringify(chunk);
      insert.run(source.id, chunk.index, row, digest(row));
      this.db
        .prepare("INSERT INTO chunk_search(source,n,text) VALUES(?,?,?)")
        .run(source.id, chunk.index, chunk.text);
    }
  }
  read(id: string): Data {
    return this.decode(
      this.db.prepare("SELECT body,digest FROM source_data WHERE id=?").get(id),
      "source " + id,
    ) as Data;
  }
  chunk(source: string, n: number): Chunk | undefined {
    const row = this.db
      .prepare("SELECT body,digest FROM chunk_data WHERE source=? AND n=?")
      .get(source, n);
    if (!row) return undefined;
    const chunk = this.decode(row, "chunk " + source + ":" + n) as Chunk;
    if (chunk.index !== n || createHash("sha256").update(chunk.text).digest("hex") !== chunk.hash)
      throw Error("SQLite chunk hash/identity mismatch");
    return chunk;
  }
  write(job: string, value: unknown) {
    const body = JSON.stringify(value);
    this.db.prepare("INSERT OR REPLACE INTO results VALUES(?,?,?)").run(job, body, digest(body));
    return digest(body);
  }
  attempt(job: string, n: number, value: unknown) {
    const body = JSON.stringify(value);
    this.db
      .prepare("INSERT OR REPLACE INTO attempt_data VALUES(?,?,?,?)")
      .run(job, n, body, digest(body));
  }
  result(job: string, expected?: string): any {
    const row = this.db.prepare("SELECT body,digest FROM results WHERE job=?").get(job);
    if (expected && row?.digest !== expected) throw Error("SQLite result hash mismatch");
    const value = this.decode(row, "result " + job);
    if (value.job !== job) throw Error("SQLite result identity mismatch");
    return value;
  }
  intact(job: string, expected: string) {
    try {
      this.result(job, expected);
      return true;
    } catch {
      return false;
    }
  }
  private decode(row: Record<string, unknown> | undefined, label: string): any {
    if (!row || typeof row.body !== "string") throw Error("missing SQLite " + label);
    if (digest(row.body) !== row.digest) throw Error("SQLite data hash mismatch: " + label);
    return JSON.parse(row.body);
  }
}

/** Read-only, bounded UI access to the same result bytes that inference consumes. */
export function receipt(db: DatabaseSync, job: string, expected: string, limit: number) {
  const row = db
    .prepare("SELECT digest,length(CAST(body AS BLOB)) bytes FROM results WHERE job=?")
    .get(job);
  if (!row) throw Error("SQLite receipt missing; legacy checkpoints require explicit import");
  if (Number(row.bytes) > limit) throw Error("SQLite receipt exceeds preview limit");
  const data = db.prepare("SELECT body FROM results WHERE job=?").get(job)!;
  if (typeof data.body !== "string" || row.digest !== expected || digest(data.body) !== expected)
    throw Error("SQLite receipt integrity mismatch");
  const value = JSON.parse(data.body);
  if (value.job !== job) throw Error("SQLite receipt identity mismatch");
  return value;
}

/** Paged, indexed retrieval returns actual verified content, not filesystem references. */
export function search(db: DatabaseSync, query: string, limit = 10, offset = 0) {
  if (
    !query.trim() ||
    query.length > 4096 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 1_000_000
  )
    throw Error("invalid content query bounds");
  const rows = db
    .prepare(
      `SELECT c.source,c.n,c.body,c.digest,bm25(chunk_search) rank FROM chunk_search JOIN chunk_data c ON c.source=chunk_search.source AND c.n=chunk_search.n WHERE chunk_search MATCH ? ORDER BY rank,c.source,c.n LIMIT ? OFFSET ?`,
    )
    .all(query, limit + 1, offset);
  const more = rows.length > limit;
  return {
    offset,
    more,
    records: rows.slice(0, limit).map((row) => {
      if (typeof row.body !== "string" || digest(row.body) !== row.digest)
        throw Error("retrieval data integrity mismatch");
      return { source: row.source, index: row.n, rank: row.rank, chunk: JSON.parse(row.body) };
    }),
  };
}
