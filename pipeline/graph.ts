import { review, type Receipt } from "./review.ts";
import { mkdir, open, rename, statfs } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Store, atomic, hash, exportRecord } from "./store.ts";
import { fileHash } from "./seal.ts";
import { Jobs } from "./jobs.ts";
import { validRole, type Payload, type Role } from "./roles.ts";
import { WorkerFailure } from "./errors.ts";
import { phase } from "./progress.ts";
import { proof } from "./proof.ts";
import type { Config, Inference, Request } from "./run.ts";
export type Entity = {
  id: string;
  name: string;
  kind: string;
  namespace: string;
  source: string;
  sourceHash: string;
  chunk: string;
  producer: { job: string; hash: string; model: string };
  claims: unknown[];
  evidence: Record<string, unknown>[];
};
async function intact(path: string, digest: string) {
  try {
    return (await fileHash(path)) === digest;
  } catch {
    return false;
  }
}
async function jsonl(path: string, rows: Iterable<unknown> | AsyncIterable<unknown>) {
  await mkdir(dirname(path), { recursive: true });
  const temp = path + "." + randomUUID() + ".tmp",
    f = await open(temp, "wx", 0o600),
    digest = createHash("sha256");
  let count = 0;
  try {
    for await (const row of rows) {
      const line = JSON.stringify(row) + "\n";
      await f.writeFile(line);
      digest.update(line);
      count++;
    }
    await f.sync();
  } finally {
    await f.close();
  }
  await rename(temp, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  return { path, hash: digest.digest("hex"), count };
}
export async function graph(config: Config, infer: Inference) {
  const core = new Store(join(config.work, "state", "pipeline.sqlite")),
    store = new Store(join(config.work, "state", "graph.sqlite")),
    db = store.db;
  let aborted = false,
    active = 0;
  db.exec(`CREATE TABLE IF NOT EXISTS entities(id TEXT PRIMARY KEY,source TEXT NOT NULL,body TEXT NOT NULL,hash TEXT NOT NULL,generation TEXT);
 CREATE TABLE IF NOT EXISTS candidates(id TEXT PRIMARY KEY,first TEXT NOT NULL,second TEXT NOT NULL,inputHash TEXT NOT NULL,generation TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS entity_generation ON entities(generation,id);CREATE INDEX IF NOT EXISTS pair_generation ON candidates(generation,id);`);
  try {
    core.records.assertReady();
    store.records.assertReady();
    const signatures: string[] = [];
    for (const row of core.db
      .prepare(
        "SELECT * FROM jobs WHERE role='knowledge' AND state='completed' ORDER BY source,chunk",
      )
      .all()) {
      if (!core.records.intact(String(row.id), String(row.outputHash)))
        throw Error("knowledge output integrity mismatch");
      const receipt = core.records.result(String(row.id), String(row.outputHash));
      if (!validRole("knowledge", receipt.result, receipt.payload))
        throw Error("invalid knowledge producer");
      const refs = new Map<string, string>(
        receipt.result.entities.map((e: any) => [
          e.id,
          hash(["entity", receipt.source, receipt.sourceHash, receipt.chunk, e.id].join(":")),
        ]),
      );
      const names = new Map<string, string>(
        receipt.result.entities.map((e: any) => [e.id, e.name]),
      );
      for (const entity of receipt.result.entities) {
        const id = hash(
          ["entity", receipt.source, receipt.sourceHash, receipt.chunk, entity.id].join(":"),
        );
        const claims = receipt.result.claims
          .filter((c: any) => c.subject === entity.id)
          .map((c: any) => ({
            ...c,
            subject: id,
            object: names.get(c.object) ?? c.object,
            ...(refs.has(c.object) ? { target: refs.get(c.object) } : {}),
          }));
        const ids = [
          ...new Set<number>(
            claims
              .flatMap((c: any) => c.anchorIds)
              .concat(receipt.payload.spans.map((s: any) => s.id)),
          ),
        ];
        const evidence = ids.map((anchorId) => ({
          id: hash(id + ":" + anchorId),
          member: id,
          source: receipt.source,
          sourceHash: receipt.sourceHash,
          chunk: receipt.chunk,
          anchorId,
          start: receipt.evidence.anchors.find((a: any) => a.id === anchorId).start,
          end: receipt.evidence.anchors.find((a: any) => a.id === anchorId).end,
          text: receipt.payload.spans.find((s: any) => s.id === anchorId).text,
        }));
        const body: Entity = {
          ...entity,
          id,
          source: receipt.source,
          sourceHash: receipt.sourceHash,
          chunk: receipt.chunk,
          producer: {
            job: receipt.job,
            hash: String(row.outputHash),
            model: receipt.model,
          },
          claims,
          evidence,
        };
        const text = JSON.stringify(body),
          digest = hash(text);
        signatures.push(id + ":" + digest);
        db.prepare(
          "INSERT INTO entities VALUES(?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET source=excluded.source,body=excluded.body,hash=excluded.hash,generation=NULL",
        ).run(id, receipt.source, text, digest);
      }
    }
    const generation = hash(
      JSON.stringify({
        model: config.model,
        namespace: config.enrichment!.namespace,
        entities: signatures.sort(),
        version: 1,
      }),
    );
    store.transaction(() => {
      for (const signature of signatures) {
        const id = signature.slice(0, 64);
        db.prepare("UPDATE entities SET generation=? WHERE id=?").run(generation, id);
      }
    });
    await phase(config.work, "candidates", "running", generation);
    let pairs = 0;
    for (const first of db
      .prepare("SELECT * FROM entities WHERE generation=? ORDER BY id")
      .iterate(generation)) {
      for (const second of db
        .prepare("SELECT * FROM entities WHERE generation=? AND id>? ORDER BY id")
        .iterate(generation, first.id)) {
        const id = hash(["pair", generation, first.id, second.id].join(":")),
          inputHash = hash(String(first.hash) + ":" + String(second.hash));
        store.transaction(() => {
          db.prepare("INSERT OR IGNORE INTO candidates VALUES(?,?,?,?,?)").run(
            id,
            first.id,
            second.id,
            inputHash,
            generation,
          );
          for (const role of ["reconcile", "connect"])
            db.prepare(
              "INSERT OR IGNORE INTO jobs(id,source,chunk,role,config,state) VALUES(?,?,0,?,?,'pending')",
            ).run(hash(id + ":" + role), id, role, generation);
        });
        pairs++;
        if (pairs % 1000 === 0) {
          const disk = await statfs(config.work);
          if (Number(disk.bavail) * Number(disk.bsize) < 3 * 1024 ** 3)
            throw Error("graph checkpoint retained: insufficient disk reserve");
          console.log(
            JSON.stringify({
              type: "candidate-progress",
              pairs,
              entities: signatures.length,
            }),
          );
        }
      }
    }
    store.transaction(() => {
      if (config.resume)
        db.prepare(
          "UPDATE jobs SET state='pending',error='explicit resume of failed graph attempt' WHERE config=? AND state='failed'",
        ).run(generation);
      db.prepare(
        "UPDATE jobs SET state='pending',error='recovered interrupted graph attempt' WHERE state='running'",
      ).run();
      db.prepare("UPDATE attempts SET state='interrupted' WHERE state='running'").run();
    });
    for (const job of db
      .prepare("SELECT * FROM jobs WHERE config=? AND state='completed'")
      .all(generation))
      if (!store.records.intact(String(job.id), String(job.outputHash)))
        db.prepare(
          "UPDATE jobs SET state='pending',error='graph output integrity mismatch' WHERE id=?",
        ).run(job.id);
    for (const job of db
      .prepare("SELECT * FROM jobs WHERE config=? AND role='reconcile' AND state!='completed'")
      .all(generation))
      db.prepare(
        "UPDATE jobs SET state='pending',error='reconciliation invalidated' WHERE source=? AND role='connect' AND state='completed'",
      ).run(job.source);
    const ceilings = new Map(
      db
        .prepare("SELECT id,attempt FROM jobs WHERE config=? AND state!='completed'")
        .all(generation)
        .map((j) => [String(j.id), Number(j.attempt) + config.attempts]),
    );
    const timer = setInterval(
      () =>
        console.log(
          JSON.stringify({
            type: "graph-progress",
            active,
            ...db
              .prepare(
                "SELECT count(*) jobs,sum(state='completed') completed,sum(state='failed') failed FROM jobs WHERE config=?",
              )
              .get(generation),
          }),
        ),
      5000,
    );
    try {
      for (const role of ["reconcile", "connect"] as const) {
        if (aborted) break;
        await phase(config.work, role, "running", generation);
        for (;;) {
          for (const j of db
            .prepare("SELECT id,attempt FROM jobs WHERE config=? AND role=? AND state!='completed'")
            .all(generation, role))
            ceilings.set(String(j.id), Number(j.attempt) + config.attempts);
          const jobs = new Jobs(store, config.concurrency, role, generation);
          async function work() {
            while (!aborted) {
              const job = jobs.claim();
              if (!job) return;
              // Archived jobs are not scheduled in a new generation.
              const meta = db.prepare("SELECT config FROM jobs WHERE id=?").get(job.id)!;
              if (meta.config !== generation) {
                store.transaction(() => {
                  db.prepare(
                    "UPDATE jobs SET state='failed',error='superseded generation' WHERE id=?",
                  ).run(job.id);
                  db.prepare(
                    "UPDATE attempts SET state='failed',error='superseded generation' WHERE job=? AND attempt=?",
                  ).run(job.id, job.attempt);
                });
                continue;
              }
              active++;
              try {
                const pair = db.prepare("SELECT * FROM candidates WHERE id=?").get(job.source)!;
                const members = [pair.first, pair.second].map(
                  (id) =>
                    JSON.parse(
                      String(db.prepare("SELECT body FROM entities WHERE id=?").get(id)!.body),
                    ) as Entity,
                );
                if (hash(members.map((m) => hash(JSON.stringify(m))).join(":")) !== pair.inputHash)
                  throw Error("candidate producer hash mismatch");
                const evidence = members
                  .flatMap((m) => m.evidence)
                  .map((proof, spanId) => ({ ...proof, spanId })) as {
                  id: string;
                  member: string;
                  text: string;
                  spanId: number;
                  [key: string]: unknown;
                }[];
                const prior: Record<string, unknown> = {};
                if (role === "connect") {
                  const parent = db
                    .prepare("SELECT * FROM jobs WHERE source=? AND role='reconcile'")
                    .get(job.source)!;
                  if (
                    parent.state !== "completed" ||
                    !store.records.intact(String(parent.id), String(parent.outputHash))
                  )
                    throw Error("upstream reconciliation unavailable");
                  prior.reconcile = store.records.result(
                    String(parent.id),
                    String(parent.outputHash),
                  ).result;
                }
                const payload: Payload = {
                  spans: evidence.map((proof) => ({
                    id: proof.spanId,
                    text: proof.text,
                  })),
                  context: {
                    trustedNamespace: config.enrichment!.namespace,
                    candidates: { members, evidence },
                    independentEvidence: members[0].sourceHash !== members[1].sourceHash,
                  },
                  prior,
                };
                const request: Request = {
                  id: job.id,
                  role,
                  text: "",
                  attempt: job.attempt,
                  sourceHash: String(pair.inputHash),
                  configHash: generation,
                  chunk: {
                    id: job.source,
                    index: 0,
                    start: 0,
                    end: 0,
                    text: "",
                    hash: hash(""),
                  } as any,
                  payload,
                };
                await store.commit(() =>
                  store.records.attempt(job.id, job.attempt, { request, model: config.model }),
                );
                const result = await infer(request);
                await store.commit(() =>
                  store.records.attempt(job.id, job.attempt, {
                    request,
                    model: config.model,
                    result,
                    inference: proof(result),
                  }),
                );
                await exportRecord(
                  join(
                    config.work,
                    "state",
                    "graph",
                    "attempts",
                    job.id,
                    String(job.attempt) + ".json",
                  ),
                  {
                    candidate: job.source,
                    request,
                    result,
                    inference: proof(result),
                    model: config.model,
                  },
                );
                if (!validRole(role, result, payload))
                  throw Error("invalid graph role response/evidence");
                const output = join(config.work, "state", "graph", "results", job.id + ".json");
                const receipt = {
                  job: job.id,
                  candidate: job.source,
                  inputHash: pair.inputHash,
                  role,
                  inference: proof(result),
                  model: config.model,
                  configHash: generation,
                  attempt: job.attempt,
                  payload,
                  result,
                };
                const digest = hash(JSON.stringify(receipt) + "\n");
                await store.commit(() => {
                  if (store.records.write(String(job.id), receipt) !== digest)
                    throw Error("SQLite/export serialization mismatch");
                  db.prepare("INSERT OR REPLACE INTO artifacts VALUES(?,?,?)").run(
                    output,
                    digest,
                    job.id,
                  );
                  db.prepare(
                    "UPDATE jobs SET state='completed',output=?,outputHash=?,error=NULL WHERE id=?",
                  ).run(output, digest, job.id);
                  db.prepare("UPDATE attempts SET state='completed' WHERE job=? AND attempt=?").run(
                    job.id,
                    job.attempt,
                  );
                });
                await exportRecord(output, receipt);
              } catch (e) {
                const fatal = e instanceof WorkerFailure;
                if (fatal) aborted = true;
                store.transaction(() => {
                  store.records.failure(
                    String(job.id),
                    job.attempt,
                    e,
                    (e as any)?.partial,
                    (e as any)?.outputTokens,
                  );
                  db.prepare("UPDATE jobs SET state=?,error=? WHERE id=?").run(
                    fatal || job.attempt < (ceilings.get(job.id) ?? config.attempts)
                      ? "pending"
                      : "failed",
                    String(e),
                    job.id,
                  );
                  db.prepare("UPDATE attempts SET state=?,error=? WHERE job=? AND attempt=?").run(
                    fatal ? "interrupted" : "failed",
                    String(e),
                    job.id,
                    job.attempt,
                  );
                });
              } finally {
                active--;
              }
            }
          }
          await Promise.all(Array.from({ length: config.concurrency }, work));
          if (aborted || !config.review?.after.includes(role)) break;
          const receipts = db
            .prepare(
              "SELECT id,state,outputHash,attempt FROM jobs WHERE config=? AND role=? ORDER BY id",
            )
            .all(generation, role) as Receipt[];
          const decision = await review(
            config.work,
            role,
            generation,
            receipts,
            config.resume,
            generation,
          );
          if (decision === "reject") throw Error("Review rejected stage: " + role);
          if (decision === "approve") break;
          store.transaction(() =>
            db
              .prepare(
                "UPDATE jobs SET state='pending',error='operator requested stage retry' WHERE config=? AND (role=? OR ?='reconcile')",
              )
              .run(generation, role, role),
          );
        }
      }
    } finally {
      clearInterval(timer);
    }
    const errors: string[] = [];
    for (const job of db.prepare("SELECT * FROM jobs WHERE config=?").all(generation)) {
      if (
        job.state !== "completed" ||
        !store.records.intact(String(job.id), String(job.outputHash))
      ) {
        errors.push("graph-job:" + job.id);
        continue;
      }
      const receipt = store.records.result(String(job.id), String(job.outputHash));
      if (
        receipt.job !== job.id ||
        receipt.configHash !== generation ||
        receipt.role !== job.role ||
        receipt.model !== config.model ||
        !validRole(job.role as Role, receipt.result, receipt.payload)
      )
        errors.push("graph-attribution:" + job.id);
    }
    const stats = db
      .prepare(
        "SELECT count(*) jobs,sum(state='completed') completed,sum(state='failed') failed,sum(state='pending' OR state='running') pending FROM jobs WHERE config=?",
      )
      .get(generation)!;
    if (Number(stats.jobs) !== pairs * 2) errors.push("candidate-coverage");
    const report = {
      generation,
      entities: signatures.length,
      candidates: pairs,
      policy: "all unordered entity occurrence pairs; original entities/evidence retained",
      jobs: Number(stats.jobs),
      completed: Number(stats.completed ?? 0),
      failed: Number(stats.failed ?? 0),
      pending: Number(stats.pending ?? 0),
      errors,
      exportErrors: [] as string[],
      integrity: errors.length === 0,
    };
    if (report.integrity) {
      try {
        function* entities() {
          for (const row of db
            .prepare("SELECT body FROM entities WHERE generation=? ORDER BY id")
            .iterate(generation))
            yield JSON.parse(String(row.body));
        }
        const entityFile = await jsonl(join(config.work, "output", "entities.jsonl"), entities());
        async function* results(role: Role, key: string) {
          for (const row of db
            .prepare("SELECT id,outputHash FROM jobs WHERE config=? AND role=? ORDER BY id")
            .iterate(generation, role)) {
            const receipt = store.records.result(String(row.id), String(row.outputHash));
            for (const value of receipt.result[key])
              yield {
                ...value,
                candidate: receipt.candidate,
                producer: {
                  job: receipt.job,
                  model: receipt.model,
                  attempt: receipt.attempt,
                },
              };
          }
        }
        const groupFile = await jsonl(
            join(config.work, "output", "groups.jsonl"),
            results("reconcile", "groups"),
          ),
          edgeFile = await jsonl(
            join(config.work, "output", "edges.jsonl"),
            results("connect", "edges"),
          );
        await atomic(join(config.work, "output", "graph.json"), {
          ...report,
          entities: entityFile,
          groups: groupFile,
          edges: edgeFile,
        });
        for (const file of [
          entityFile,
          groupFile,
          edgeFile,
          {
            path: join(config.work, "output", "graph.json"),
            hash: await fileHash(join(config.work, "output", "graph.json")),
          },
        ])
          core.transaction(() =>
            core.db
              .prepare("INSERT OR REPLACE INTO artifacts VALUES(?,?,?)")
              .run(file.path, file.hash, "graph"),
          );
      } catch (error) {
        report.exportErrors.push(String(error));
        console.error(
          JSON.stringify({ type: "export-failed", kind: "graph", error: String(error) }),
        );
      }
    }
    await atomic(join(config.work, "state", "graph-report.json"), report);
    return report;
  } finally {
    store.close();
    core.close();
  }
}
