/** Lossless preprocessing archive. Factored values are NOT inference-ready until context hydration is qualified. */
import { DatabaseSync } from "node:sqlite";
import { mkdir, lstat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { createReadStream } from "node:fs";
import { JsonValues, type JsonNode, type Json } from "./json-values.ts";
import { Content } from "./content.ts";
import { Lock } from "./lock.ts";
import { atomic, hash, publish } from "./store.ts";
import { fileHash } from "./seal.ts";
import { boundaries } from "./run.ts";
import { discover } from "./source.ts";
import { launch, assertNetworkDenied } from "./sandbox.ts";
async function* lines(file: string, max = 64 * 1024 ** 2) {
  let pending = Buffer.alloc(0);
  for await (const chunk of createReadStream(file, { highWaterMark: 65536 })) {
    pending = Buffer.concat([pending, chunk]);
    let end;
    while ((end = pending.indexOf(10)) >= 0) {
      if (end > max) throw Error("JSONL line budget exceeded");
      yield new TextDecoder("utf8", { fatal: true }).decode(pending.subarray(0, end));
      pending = pending.subarray(end + 1);
    }
    if (pending.length > max) throw Error("JSONL line budget exceeded");
  }
  if (pending.length) yield new TextDecoder("utf8", { fatal: true }).decode(pending);
}
export async function normalize(input: string, work: string) {
  ({ input, work } = await boundaries(input, work));
  await mkdir(join(work, "state"), { recursive: true, mode: 0o700 });
  await mkdir(join(work, "archive"), { recursive: true });
  await mkdir(join(work, "staging"), { recursive: true });
  const lock = await Lock.acquire(join(work, "state/normalization.lock"));
  const db = new DatabaseSync(join(work, "state/normalization.sqlite"));
  try {
    db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS binding(input TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS normalization_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,path TEXT NOT NULL,digest TEXT NOT NULL,bytes INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS roots(id TEXT PRIMARY KEY,source TEXT NOT NULL,line INTEGER NOT NULL,body TEXT NOT NULL,digest TEXT NOT NULL,node TEXT);
 CREATE TABLE IF NOT EXISTS nodes(id TEXT PRIMARY KEY,body TEXT NOT NULL,digest TEXT NOT NULL);`);
    const binding = db.prepare("SELECT input FROM binding").get();
    if (binding && binding.input !== input) throw Error("checkpoint input changed");
    if (!binding) db.prepare("INSERT INTO binding VALUES(?)").run(input);
    db.prepare("INSERT OR IGNORE INTO normalization_meta VALUES('started',?)").run(
      String(Date.now()),
    );
    const started = Number(
      db.prepare("SELECT value FROM normalization_meta WHERE key='started'").get()!.value,
    );
    await atomic(join(work, "report.json"), {
      integrity: false,
      state: "preparing",
      inferenceReady: false,
      started,
    });
    const content = new Content(db, work, "brotli"),
      values = new JsonValues(),
      seen = new Set<string>();
    let originalBytes = 0;
    for await (const file of discover(input)) {
      const info = await lstat(file);
      if (!info.isFile() || !file.endsWith(".jsonl"))
        throw Error("normalization supports regular JSONL sources only");
      const path = relative(input, file),
        id = hash(path),
        digest = await fileHash(file);
      seen.add(id);
      originalBytes += info.size;
      const prior = db.prepare("SELECT digest FROM sources WHERE id=?").get(id);
      if (prior && prior.digest !== digest)
        throw Error("source changed; create a new dataset revision");
      await content.capture(id, file, digest, join(work, "archive", id + ".jsonl"));
      db.prepare("INSERT OR IGNORE INTO sources VALUES(?,?,?,?)").run(id, path, digest, info.size);
      let line = 0;
      for await (const text of lines(file)) {
        const number = line++;
        if (!text.trim()) continue;
        let value: Json;
        try {
          value = JSON.parse(text) as Json;
        } catch {
          throw Error("invalid JSONL at source " + id + " line " + number);
        }
        values.index(value);
        const root = hash(id + ":" + number),
          digest = hash(text),
          old = db.prepare("SELECT digest,body FROM roots WHERE id=?").get(root);
        if (old && (old.digest !== digest || old.body !== text))
          throw Error("source record changed");
        db.prepare("INSERT OR IGNORE INTO roots VALUES(?,?,?,?,?,NULL)").run(
          root,
          id,
          number,
          text,
          digest,
        );
      }
      if ((await fileHash(file)) !== digest) throw Error("source changed during normalization");
      if (seen.size % 100 === 0)
        await atomic(join(work, "progress.json"), { state: "indexing", sources: seen.size });
    }
    if (Number(db.prepare("SELECT count(*) n FROM sources").get()!.n) !== seen.size)
      throw Error("source inventory changed");
    for (const row of db
      .prepare("SELECT id,body,digest FROM roots ORDER BY source,line")
      .iterate()) {
      if (hash(String(row.body)) !== row.digest) throw Error("corrupt original record");
      const node = values.add(JSON.parse(String(row.body)) as Json);
      values.expand(node.id);
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const item of values.nodes.values()) {
          const body = JSON.stringify(item),
            digest = hash(body + "\n"),
            old = db.prepare("SELECT body,digest FROM nodes WHERE id=?").get(item.id);
          if (old && (old.body !== body || old.digest !== digest))
            throw Error("corrupt or inconsistent normalized value");
          db.prepare("INSERT OR IGNORE INTO nodes VALUES(?,?,?)").run(item.id, body, digest);
        }
        db.prepare("UPDATE roots SET node=? WHERE id=?").run(node.id, row.id);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      values.nodes.clear();
    }
    // Reconstruct from persisted values independently of the transformation's object graph.
    for (const row of db.prepare("SELECT node FROM roots ORDER BY source,line").iterate()) {
      const restored = new JsonValues();
      const load = (id: string, parents = new Set<string>()) => {
        if (parents.has(id)) throw Error("cyclic normalized value");
        if (restored.nodes.has(id)) return;
        const record = db.prepare("SELECT body,digest FROM nodes WHERE id=?").get(id);
        if (!record || hash(String(record.body) + "\n") !== record.digest)
          throw Error("corrupt or missing normalized value");
        const node = JSON.parse(String(record.body)) as JsonNode;
        if (node.id !== id) throw Error("normalized identity mismatch");
        restored.nodes.set(id, node);
        const next = new Set(parents);
        next.add(id);
        for (const child of Object.values(node.links)) load(child, next);
      };
      load(String(row.node));
      restored.expand(String(row.node));
    }
    const artifact = join(work, "staging/values.jsonl");
    const digest = await publish(
      artifact,
      (function* () {
        for (const r of db.prepare("SELECT body FROM nodes ORDER BY id").iterate())
          yield String(r.body) + "\n";
      })(),
    );
    const sourceMap = join(work, "staging/roots.jsonl");
    const rootHash = await publish(
      sourceMap,
      (function* () {
        for (const r of db
          .prepare("SELECT id,source,line,digest,node FROM roots ORDER BY source,line")
          .iterate())
          yield JSON.stringify(r) + "\n";
      })(),
    );
    for (const row of db.prepare("SELECT id,path,digest FROM sources ORDER BY path").iterate()) {
      await content.verify(String(row.id), String(row.digest));
      if ((await fileHash(join(input, String(row.path)))) !== row.digest)
        throw Error("source changed before certification");
    }
    if ((await fileHash(artifact)) !== digest || (await fileHash(sourceMap)) !== rootHash)
      throw Error("normalized JSONL export hash mismatch");
    const inventoryHash = hash(
      JSON.stringify(db.prepare("SELECT id,path,digest,bytes FROM sources ORDER BY path").all()),
    );
    const result = {
      integrity: true,
      inventoryHash,
      rootHash,
      started,
      preparationSeconds: (Date.now() - started) / 1000,
      sources: seen.size,
      roots: Number(db.prepare("SELECT count(*) n FROM roots").get()!.n),
      values: Number(db.prepare("SELECT count(*) n FROM nodes").get()!.n),
      originalBytes,
      valueBytes: (await lstat(artifact)).size,
      valueHash: digest,
      inferenceReady: false,
      scope:
        "Exact original SQLite/JSONL preservation and hash-verified factoring; inference context integration is not qualified",
      completed: new Date().toISOString(),
    };
    await atomic(join(work, "report.json"), result);
    await atomic(join(work, "progress.json"), { state: "completed", ...result });
    return result;
  } catch (e) {
    await atomic(join(work, "report.json"), {
      integrity: false,
      state: "failed",
      inferenceReady: false,
      error: e instanceof Error ? e.message : "normalization failed",
    });
    throw e;
  } finally {
    db.close();
    await lock.close();
  }
}
if (process.argv[1] === import.meta.filename) {
  const inside = process.argv[2] === "--inside",
    offset = inside ? 3 : 2,
    input = resolve(process.argv[offset] ?? ""),
    work = resolve(process.argv[offset + 1] ?? "");
  if (!process.argv[offset] || !process.argv[offset + 1])
    throw Error("Usage: node pipeline/normalize.ts INPUT WORK");
  if (!inside)
    process.exitCode = await launch(input, work, import.meta.filename, ["--inside", input, work]);
  else {
    await assertNetworkDenied();
    console.log(JSON.stringify(await normalize(input, work)));
  }
}
