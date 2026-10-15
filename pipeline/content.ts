import type { DatabaseSync } from "node:sqlite";
import { open, lstat, statfs, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { brotliCompressSync, brotliDecompressSync, constants as codecs } from "node:zlib";
import { statfsSync, createReadStream } from "node:fs";
import { hash, publish } from "./store.ts";
/** Lossless original bytes, independent of normalization and model-readable text. */
export class Content {
  db: DatabaseSync;
  root?: string;
  codec: "none" | "brotli";
  private coded: boolean;
  constructor(db: DatabaseSync, root?: string, codec: "none" | "brotli" = "none") {
    this.db = db;
    this.codec = codec;
    this.root = root && resolve(root);
    db.exec(`
 CREATE TABLE IF NOT EXISTS content_blobs(hash TEXT PRIMARY KEY,bytes INTEGER NOT NULL,parts INTEGER NOT NULL,complete INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS content_blocks(hash TEXT NOT NULL,n INTEGER NOT NULL,data BLOB NOT NULL,digest TEXT NOT NULL,codec TEXT NOT NULL DEFAULT 'none',PRIMARY KEY(hash,n));
 CREATE TABLE IF NOT EXISTS content_sources(source TEXT PRIMARY KEY,hash TEXT NOT NULL,jsonl TEXT NOT NULL,jsonlHash TEXT NOT NULL);
 `);
    this.coded = db.prepare("PRAGMA table_info(content_blocks)").all().some(row => row.name === "codec");
    if (codec === "brotli" && !this.coded) { db.exec("ALTER TABLE content_blocks ADD COLUMN codec TEXT NOT NULL DEFAULT 'none'"); this.coded = true; }
  }
  private encode(data: Buffer): {data: Buffer; codec: "none" | "brotli"} {
    if (this.codec === "brotli") {
      const encoded = brotliCompressSync(data, { params: { [codecs.BROTLI_PARAM_QUALITY]: 4 } });
      if (encoded.length < data.length) return { data: encoded, codec: "brotli" };
    }
    return { data, codec: "none" };
  }
  private block(digest: string, n: number, data: Buffer) {
    const encoded = this.encode(data);
    if (this.coded) this.db.prepare("INSERT OR REPLACE INTO content_blocks(hash,n,data,digest,codec) VALUES(?,?,?,?,?)").run(digest,n,encoded.data,hash(data),encoded.codec);
    else this.db.prepare("INSERT OR REPLACE INTO content_blocks(hash,n,data,digest) VALUES(?,?,?,?)").run(digest,n,data,hash(data));
  }
  async capture(source: string, path: string, expected: string, jsonl: string) {
    if (!/^[a-f0-9]{64}$/.test(expected)) throw Error("invalid content hash");
    const info = await lstat(path);
    if (!info.isFile()) throw Error("content capture requires a regular source");
    const known = this.db.prepare("SELECT complete FROM content_blobs WHERE hash=?").get(expected);
    const disk = await statfs(dirname(jsonl));
    const required = (this.codec === "brotli" ? Math.min(Number(info.size), 1024 ** 2) * 2.6 : Number(info.size) * (known?.complete ? 1.5 : 2.6)) + 1024 ** 3;
    if (disk.bavail * disk.bsize < required)
      throw Error("insufficient disk for complete SQLite and JSONL content mirrors");
    if (!known?.complete) {
      this.db.prepare("INSERT OR IGNORE INTO content_blobs VALUES(?,0,0,0)").run(expected);
      const file = await open(path, "r"),
        digest = createHash("sha256");
      let bytes = 0,
        n = 0;
      try {
        for await (const block of file.createReadStream({ highWaterMark: 1024 * 1024 })) {
          digest.update(block);
          bytes += block.length;
          if (this.codec === "brotli") { const free = await statfs(dirname(jsonl)); if (free.bavail * free.bsize < block.length * 2.6 + 1024 ** 3) throw Error("insufficient disk for next complete content block"); }
          this.block(expected, n++, block);
        }
      } finally {
        await file.close();
      }
      const after = await lstat(path);
      if (
        digest.digest("hex") !== expected ||
        info.size !== after.size ||
        info.ino !== after.ino ||
        info.mtimeMs !== after.mtimeMs ||
        bytes !== info.size
      )
        throw Error("source content hash changed during capture");
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare("DELETE FROM content_blocks WHERE hash=? AND n>=?").run(expected, n);
        this.db
          .prepare("UPDATE content_blobs SET bytes=?,parts=?,complete=1 WHERE hash=?")
          .run(bytes, n, expected);
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    }
    return this.mirror(source, expected, jsonl);
  }
  async link(source: string, target: string, jsonl: string) {
    const bytes = Buffer.from(target, "utf8"),
      digest = hash(bytes);
    this.block(digest, 0, bytes);
    this.db
      .prepare("INSERT OR IGNORE INTO content_blobs VALUES(?,?,1,1)")
      .run(digest, bytes.length);
    return this.mirror(source, digest, jsonl);
  }
  private async mirror(source: string, expected: string, jsonl: string) {
    const meta = this.db
      .prepare("SELECT bytes,parts FROM content_blobs WHERE hash=? AND complete=1")
      .get(expected)!;
    const self = this;
    function* rows() {
      yield JSON.stringify({
        kind: "content",
        source,
        hash: expected,
        bytes: meta.bytes,
        parts: meta.parts,
        encoding: "base64",
      }) + "\n";
      let n = 0;
      for (const block of self.parts(expected)) {
        const encoded = self.encode(block);
        if (self.codec === "brotli") { const free = statfsSync(dirname(jsonl)); if (free.bavail * free.bsize < encoded.data.length * 1.5 + 1024 ** 3) throw Error("insufficient disk for next JSONL content block"); }
        yield JSON.stringify({
          kind: "bytes",
          source,
          hash: expected,
          index: n++,
          base64: encoded.data.toString("base64"),
          ...(encoded.codec === "none" ? {} : { codec: encoded.codec }),
          digest: hash(block),
        }) + "\n";
      }
    }
    const exported = await publish(jsonl, rows());
    this.db
      .prepare("INSERT OR REPLACE INTO content_sources VALUES(?,?,?,?)")
      .run(source, expected, this.root ? relative(this.root, jsonl) : jsonl, exported);
    return {
      hash: expected,
      bytes: Number(meta.bytes),
      parts: Number(meta.parts),
      jsonlHash: exported,
    };
  }
  *parts(digest: string): Generator<Buffer> {
    const meta = this.db
      .prepare("SELECT bytes,parts FROM content_blobs WHERE hash=? AND complete=1")
      .get(digest);
    if (!meta) throw Error("missing complete content");
    const whole = createHash("sha256");
    let n = 0,
      bytes = 0;
    for (const row of this.db
      .prepare("SELECT n,data,digest" + (this.coded ? ",codec" : "") + " FROM content_blocks WHERE hash=? ORDER BY n")
      .iterate(digest)) {
      const encoded = Buffer.from(row.data as Uint8Array);
      if (row.codec !== undefined && row.codec !== "none" && row.codec !== "brotli") throw Error("unsupported content codec");
      const data = row.codec === "brotli" ? brotliDecompressSync(encoded, { maxOutputLength: 1024 ** 2 }) : encoded;
      if (row.n !== n++ || hash(data) !== row.digest)
        throw Error("content block hash/coverage mismatch");
      whole.update(data);
      bytes += data.length;
      yield data;
    }
    if (n !== meta.parts || bytes !== meta.bytes || whole.digest("hex") !== digest)
      throw Error("complete content hash/coverage mismatch");
  }
  read(digest: string, limit = 16 * 1024 * 1024) {
    const row = this.db
      .prepare("SELECT bytes FROM content_blobs WHERE hash=? AND complete=1")
      .get(digest);
    if (!row || Number(row.bytes) > limit)
      throw Error("content read exceeds limit; use bounded parts");
    return Buffer.concat([...this.parts(digest)]);
  }
  async verify(source: string, digest: string) {
    const row = this.db
      .prepare("SELECT hash,jsonl,jsonlHash FROM content_sources WHERE source=?")
      .get(source);
    if (!row || row.hash !== digest) throw Error("missing source content mirror");
    for (const _part of this.parts(digest)) {
    }
    const path = this.root ? resolve(this.root, String(row.jsonl)) : String(row.jsonl);
    if (this.root && !path.startsWith(this.root + sep))
      throw Error("content mirror escapes archive");
    if (this.root && !(await realpath(path)).startsWith(this.root + sep)) throw Error("content JSONL alias escapes archive");
    const meta = this.db.prepare("SELECT bytes,parts FROM content_blobs WHERE hash=? AND complete=1").get(digest)!;
    const serialized = createHash("sha256"), whole = createHash("sha256");
    let lines = 0, count = 0, bytes = 0, length = 0;
    let pieces: Buffer[] = [];
    const consume = (line: Buffer) => {
      const item = JSON.parse(line.toString("utf8"));
      if (item.source !== source || item.hash !== digest) throw Error("JSONL source identity mismatch");
      if (lines++ === 0) {
        if (item.kind !== "content" || item.encoding !== "base64" || item.bytes !== meta.bytes || item.parts !== meta.parts) throw Error("JSONL header mismatch");
        return;
      }
      if (item.kind !== "bytes" || item.index !== count++ || typeof item.base64 !== "string") throw Error("JSONL block coverage mismatch");
      const encoded = Buffer.from(item.base64, "base64");
      if (encoded.toString("base64") !== item.base64 || (item.codec !== undefined && item.codec !== "none" && item.codec !== "brotli")) throw Error("invalid JSONL block encoding");
      const decoded = item.codec === "brotli" ? brotliDecompressSync(encoded, {maxOutputLength: 1024 ** 2}) : encoded;
      if (decoded.length > 1024 ** 2 || hash(decoded) !== item.digest) throw Error("JSONL block hash mismatch");
      bytes += decoded.length; whole.update(decoded);
    };
    for await (const chunk of createReadStream(path, {highWaterMark: 64 * 1024})) {
      serialized.update(chunk);
      let start = 0, end: number;
      while ((end = chunk.indexOf(10, start)) !== -1) {
        const part = chunk.subarray(start, end); length += part.length;
        if (length > 2 * 1024 ** 2) throw Error("JSONL line exceeds bounded content record");
        pieces.push(part); consume(pieces.length === 1 ? pieces[0] : Buffer.concat(pieces, length));
        pieces = []; length = 0; start = end + 1;
      }
      if (start < chunk.length) { pieces.push(chunk.subarray(start)); length += chunk.length - start; }
      if (length > 2 * 1024 ** 2) throw Error("JSONL line exceeds bounded content record");
    }
    if (length || !lines || count !== meta.parts || bytes !== meta.bytes || whole.digest("hex") !== digest || serialized.digest("hex") !== row.jsonlHash) throw Error("content JSONL hash/coverage mismatch");
  }
}
