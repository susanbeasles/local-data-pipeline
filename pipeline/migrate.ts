import { readFile, realpath, access, lstat, readlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { Content } from "./content.ts";
import { boundaries } from "./run.ts";
import { Store, hash } from "./store.ts";
import { Stage, type Snapshot } from "./stage.ts";
import { fileHash } from "./seal.ts";
import { Lock } from "./lock.ts";
import type { Source, Chunk } from "./source.ts";
import type { Config } from "./run.ts";
/** Explicit verified import of old generated JSON/JSONL; never performs inference. */
export async function migrate(work: string, input?: string) {
  work = await realpath(work);
  if (input) input = (await boundaries(input, work)).input;
  const enrich = await Lock.acquire(join(work, "state/enrich.lock"));
  let lock: Awaited<ReturnType<typeof Lock.acquire>> | undefined;
  const counts = { sources: 0, chunks: 0, results: 0 };
  const stores: Store[] = [];
  try {
    lock = await Lock.acquire(join(work, "state/run.lock"));
    async function contained(path: string) {
      const actual = await realpath(path);
      if (actual !== path || !actual.startsWith(work + sep))
        throw Error("legacy data path escapes work directory");
      return actual;
    }
    const core = new Store(join(work, "state/pipeline.sqlite"));
    stores.push(core);
    const stages = new Stage(1),
      content = new Content(core.db);
    for (const row of core.db.prepare("SELECT * FROM sources ORDER BY id").iterate()) {
      const file = await contained(String(row.stage));
      const data = (await stages.read(String(row.id), file, String(row.stageHash))) as Snapshot &
        Pick<Config, "roles" | "enrichment" | "profile"> & { configHash: string };
      if (data.id !== row.id || data.path !== row.path || data.hash !== row.hash)
        throw Error("legacy source attribution mismatch");
      if (!data.chunkFile || !data.chunkHash) throw Error("missing legacy JSONL");
      await contained(data.chunkFile);
      if ((await fileHash(data.chunkFile)) !== data.chunkHash)
        throw Error("legacy JSONL hash mismatch");
      const chunks: Chunk[] = [],
        normalized = createHash("sha256");
      let end = 0;
      for (let n = 0; n < data.chunks.length; n++) {
        const chunk = await Stage.chunk(data, n);
        if (
          !chunk ||
          chunk.index !== n ||
          chunk.start !== end ||
          chunk.end !== chunk.start + chunk.text.length ||
          hash(chunk.text) !== chunk.hash
        )
          throw Error("legacy chunk coverage/hash mismatch");
        chunks.push(chunk);
        normalized.update(chunk.text);
        end = chunk.end;
      }
      if (data.state === "pending" && normalized.digest("hex") !== data.normalizedHash)
        throw Error("legacy normalized content hash mismatch");
      if (!data.content) {
        if (!input)
          throw Error(
            "Original input path required for complete byte retention: node pipeline/migrate.ts /work /input",
          );
        const path = resolve(input, data.path);
        if (!path.startsWith(input + sep)) throw Error("legacy source path escapes input");
        const destination = join(work, "staging", String(data.id) + ".content.jsonl");
        if (data.hash) {
          await content.capture(data.id, path, data.hash, destination);
          data.content = { hash: data.hash, kind: "file" };
        } else if ((await lstat(path)).isSymbolicLink()) {
          const saved = await content.link(data.id, await readlink(path), destination);
          data.content = { hash: saved.hash, kind: "symlink" };
        } else throw Error("protected/unreadable source has no complete content; import blocked");
      }
      await content.verify(data.id, data.content.hash);
      core.transaction(() =>
        core.records.ingest({ ...data, chunks } as Source, {
          roles: data.roles,
          enrichment: data.enrichment,
          profile: data.profile,
          configHash: data.configHash,
        }),
      );
      counts.sources++;
      counts.chunks += chunks.length;
    }
    try {
      await access(join(work, "state/graph.sqlite"));
      stores.push(new Store(join(work, "state/graph.sqlite")));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    for (const store of stores) {
      for (const job of store.db
        .prepare("SELECT * FROM jobs WHERE state='completed' ORDER BY id")
        .iterate()) {
        const file = await contained(String(job.output)),
          raw = await readFile(file);
        if (hash(raw) !== job.outputHash) throw Error("legacy result hash mismatch: " + job.id);
        const receipt = JSON.parse(raw.toString("utf8"));
        if (
          receipt.job !== job.id ||
          receipt.role !== job.role ||
          receipt.configHash !== job.config ||
          receipt.attempt !== job.attempt
        )
          throw Error("legacy result attribution mismatch: " + job.id);
        store.transaction(() => {
          if (store.records.write(String(job.id), receipt) !== job.outputHash)
            throw Error("legacy result serialization mismatch");
        });
        counts.results++;
      }
    }
    // Publish readiness only after every source and completed result has passed import.
    for (const store of stores)
      store.transaction(() => store.db.exec("UPDATE data_schema SET state='ready' WHERE id=1"));
    return { ...counts, inferenceCalls: 0 };
  } finally {
    for (const store of stores) store.close();
    await lock?.close();
    await enrich.close();
  }
}
if (process.argv[1] === import.meta.filename) {
  if (!process.argv[2])
    throw Error("Usage: node pipeline/migrate.ts /absolute/work [/absolute/input]");
  console.log(
    JSON.stringify(
      await migrate(
        resolve(process.argv[2]),
        process.argv[3] ? resolve(process.argv[3]) : undefined,
      ),
    ),
  );
}
