/** Reattach verified completed receipts after job-identity reconciliation; never runs inference. */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Store, hash } from "./store.ts";
import { Lock } from "./lock.ts";
import { validRole, type Role } from "./roles.ts";
export async function recover(work: string) {
  const lock = await Lock.acquire(join(work, "state/run.lock"));
  const store = new Store(join(work, "state/pipeline.sqlite"));
  let restored = 0;
  try {
    const rows = store.db.prepare("SELECT job,digest FROM results ORDER BY job").all();
    const ready: {
      r: ReturnType<Store["records"]["result"]>;
      n: number;
      output: string;
      digest: string;
    }[] = [];
    for (const row of rows) {
      const r = store.records.result(String(row.job), String(row.digest));
      const chunks = store.db
        .prepare("SELECT n FROM chunk_data WHERE source=? AND json_extract(body,'$.id')=?")
        .all(r.source, r.chunk);
      if (chunks.length !== 1) throw Error("completed receipt chunk coverage mismatch");
      const n = Number(chunks[0]!.n),
        chunk = store.records.chunk(r.source, n);
      const source = store.db.prepare("SELECT hash FROM sources WHERE id=?").get(r.source);
      const attempt = store.db
        .prepare("SELECT state FROM attempts WHERE job=? AND attempt=?")
        .get(r.job, r.attempt);
      if (
        !chunk ||
        source?.hash !== r.sourceHash ||
        chunk.hash !== r.chunkHash ||
        hash(chunk.id + ":" + r.role + ":" + r.configHash) !== r.job ||
        attempt?.state !== "completed" ||
        !validRole(r.role as Role, r.result, r.payload)
      )
        throw Error("completed receipt provenance mismatch");
      const output = join(work, "output", r.job + ".json");
      if (hash(await readFile(output)) !== row.digest)
        throw Error("completed output hash mismatch");
      ready.push({ r, n, output, digest: String(row.digest) });
    }
    store.transaction(() => {
      for (const { r, n, output, digest } of ready) {
        const old = store.db.prepare("SELECT state,outputHash FROM jobs WHERE id=?").get(r.job);
        if (old?.state === "completed" && old.outputHash === digest) continue;
        store.db
          .prepare(
            "INSERT OR REPLACE INTO jobs(id,source,chunk,role,config,state,attempt,output,outputHash,error) VALUES(?,?,?,?,?,'completed',?,?,?,NULL)",
          )
          .run(r.job, r.source, n, r.role, r.configHash, r.attempt, output, digest);
        restored++;
      }
    });
    return { verified: ready.length, restored };
  } finally {
    store.close();
    await lock.close();
  }
}
if (process.argv[1] === import.meta.filename)
  console.log(JSON.stringify(await recover(resolve(process.argv[2]!))));
