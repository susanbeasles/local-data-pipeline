import { Content } from "./content.ts";
import { review, type Review, type Receipt } from "./review.ts";
import { phase } from "./progress.ts";
import { load as loadExtractor, type Extension } from "./extractor.ts";
import { profile as validateProfile, accepts, type Profile } from "./profile.ts";
import { validRole, type Role } from "./roles.ts";
import { Jobs } from "./jobs.ts";
import { Stage, type Snapshot } from "./stage.ts";
import { Lock } from "./lock.ts";
import { WorkerFailure } from "./errors.ts";
import { proof } from "./proof.ts";
import {
  realpath,
  mkdir,
  readFile,
  open,
  unlink,
  lstat,
  readdir,
  readlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { fileHash } from "./seal.ts";
import { Store, hash, atomic, exportRecord } from "./store.ts";
import { source, discover, type Source, type Chunk } from "./source.ts";
export type Config = {
  input: string;
  work: string;
  chunkSize: number;
  concurrency: number;
  attempts: number;
  maxBytes: number;
  roles: string[];
  model: string;
  engine: "synthetic" | "mlx";
  timeoutMs?: number;
  enrichment?: { namespace: string };
  resume?: boolean;
  review?: Review;
  profile?: Profile;
  extractor?: Extension;
};
export type Request = {
  id: string;
  role: string;
  text: string;
  attempt: number;
  chunk: Chunk;
  sourceHash: string;
  configHash: string;
  payload?: import("./roles.ts").Payload;
};
export type Inference = (request: Request) => Promise<unknown>;
export function valid(value: unknown, text: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as any;
  return (
    Object.keys(r).sort().join(",") === "facts,summary,unknowns" &&
    typeof r.summary === "string" &&
    Array.isArray(r.unknowns) &&
    r.unknowns.every((x: unknown) => typeof x === "string") &&
    Array.isArray(r.facts) &&
    r.facts.every(
      (f: any) =>
        f &&
        typeof f.claim === "string" &&
        ((Object.keys(f).sort().join(",") === "anchorIds,claim" &&
          Array.isArray(f.anchorIds) &&
          f.anchorIds.length === 1 &&
          f.anchorIds[0] === 0) ||
          (Object.keys(f).sort().join(",") === "claim,end,start" &&
            Number.isSafeInteger(f.start) &&
            Number.isSafeInteger(f.end) &&
            f.start >= 0 &&
            f.end > f.start &&
            f.end <= text.length)),
    )
  );
}
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (e) {
    if ((e as any).code !== "ENOENT") throw e;
    return join(await canonical(resolve(path, "..")), path.split("/").at(-1)!);
  }
}
export async function boundaries(input: string, work: string) {
  input = await realpath(input);
  work = await canonical(resolve(work));
  if (input === work || work.startsWith(input + "/") || input.startsWith(work + "/"))
    throw Error("input/work overlap");
  return { input, work };
}
async function intact(path: string, expected: string) {
  try {
    return hash(await readFile(path)) === expected;
  } catch {
    return false;
  }
}
export async function run(config: Config, infer: Inference) {
  const paths = await boundaries(config.input, config.work);
  config = { ...config, ...paths };
  for (const [k, v] of Object.entries({
    chunkSize: config.chunkSize,
    concurrency: config.concurrency,
    attempts: config.attempts,
    maxBytes: config.maxBytes,
  }))
    if (!Number.isSafeInteger(v) || v < 1 || (k === "chunkSize" && v < 2))
      throw Error("invalid " + k);
  if (!config.roles.length || new Set(config.roles).size !== config.roles.length)
    throw Error("invalid roles");
  if (config.profile) {
    config.profile = validateProfile(config.profile);
    if (
      config.enrichment ||
      config.roles.join(",") !== config.profile.stages.map((s) => s.name).join(",")
    )
      throw Error("profile roles mismatch or incompatible graph enrichment");
  }
  const extractor = config.extractor
    ? await loadExtractor(config.extractor, config.input)
    : undefined;
  await mkdir(join(config.work, "state"), { recursive: true });
  const lock = await Lock.acquire(join(config.work, "state", "run.lock"));
  let store: Store;
  try {
    store = new Store(join(config.work, "state", "pipeline.sqlite"));
  } catch (e) {
    await lock.close();
    throw e;
  }
  const content = new Content(store.db);
  const db = store.db,
    generation = randomUUID(),
    started = performance.now();
  const configHash = hash(
    JSON.stringify({
      version: 1,
      model: config.model,
      roles: config.roles,
      chunkSize: config.chunkSize,
      engine: config.engine,
      enrichment: config.enrichment,
      profile: config.profile,
      extractor: config.extractor,
    }),
  );
  let active = 0,
    aborted = false;
  try {
    store.records.assertReady();
    if (config.profile) await phase(config.work, "profile-stages");
    for (const dir of ["staging", "output", "models"])
      await mkdir(join(config.work, dir), { recursive: true });
    store.transaction(() => {
      db.prepare(
        "UPDATE jobs SET state='pending',error='recovered interrupted attempt' WHERE state='running'",
      ).run();
      db.prepare("UPDATE attempts SET state='interrupted' WHERE state='running'").run();
    });
    for await (const path of discover(config.input)) {
      let s: Source;
      try {
        s = await source(config.input, path, config.maxBytes, config.chunkSize, extractor);
      } catch (e) {
        s = {
          id: hash(path.slice(config.input.length + 1)),
          path: path.slice(config.input.length + 1),
          hash: null,
          state: "failed",
          reason: String(e),
          chunks: [],
        };
      }
      const contentFile = join(config.work, "staging", s.id + ".content.jsonl");
      if (s.hash) {
        await content.capture(s.id, path, s.hash, contentFile);
        s.content = { hash: s.hash, kind: "file" };
      } else if ((await lstat(path)).isSymbolicLink()) {
        const saved = await content.link(s.id, await readlink(path), contentFile);
        s.content = { hash: saved.hash, kind: "symlink" };
      }
      const stage = join(config.work, "staging", s.id + ".json");
      s.chunkFile = join(config.work, "staging", s.id + ".jsonl");
      const stageHash = await Stage.write(stage, s, {
        roles: config.roles,
        enrichment: config.enrichment,
        profile: config.profile,
        configHash,
      });
      store.transaction(() => {
        store.records.ingest(s, {
          roles: config.roles,
          enrichment: config.enrichment,
          profile: config.profile,
          configHash,
        });
        db.prepare("INSERT OR REPLACE INTO sources VALUES(?,?,?,?,?,?,?,?)").run(
          s.id,
          s.path,
          s.hash,
          s.state,
          s.reason ?? null,
          stage,
          stageHash,
          generation,
        );
        if (s.state !== "pending") db.prepare("DELETE FROM jobs WHERE source=?").run(s.id);
        else {
          const ids = new Set<string>();
          for (const c of s.chunks)
            for (const role of config.roles) {
              const id = hash(c.id + ":" + role + ":" + configHash);
              ids.add(id);
              db.prepare(
                "INSERT OR IGNORE INTO jobs(id,source,chunk,role,config,state) VALUES(?,?,?,?,?,'pending')",
              ).run(id, s.id, c.index, role, configHash);
            }
          for (const j of db.prepare("SELECT id FROM jobs WHERE source=?").all(s.id))
            if (!ids.has(String(j.id))) db.prepare("DELETE FROM jobs WHERE id=?").run(j.id);
        }
      });
      // Corrupt completion cannot be reused. Artifacts are preserved in attempts.
      for (const j of db
        .prepare("SELECT * FROM jobs WHERE source=? AND state='completed'")
        .all(s.id))
        if (!store.records.intact(String(j.id), String(j.outputHash)))
          db.prepare("UPDATE jobs SET state='pending',error='output hash mismatch' WHERE id=?").run(
            j.id,
          );
    }
    db.prepare("DELETE FROM jobs WHERE source IN (SELECT id FROM sources WHERE generation<>?)").run(
      generation,
    );
    db.prepare("DELETE FROM sources WHERE generation<>?").run(generation);
    if (config.resume)
      db.prepare(
        "UPDATE jobs SET state='pending',error='explicit resume of failed attempt' WHERE state='failed'",
      ).run();
    if (config.enrichment || config.profile) {
      for (const job of db.prepare("SELECT * FROM jobs WHERE state!='completed'").all()) {
        const later = config.roles.slice(config.roles.indexOf(String(job.role)) + 1);
        for (const role of later)
          db.prepare(
            "UPDATE jobs SET state='pending',error='upstream invalidated' WHERE source=? AND chunk=? AND role=? AND state='completed'",
          ).run(job.source, job.chunk, role);
      }
    }

    const ceilings = new Map(
      db
        .prepare("SELECT id,attempt FROM jobs WHERE state!='completed'")
        .all()
        .map((j) => [String(j.id), Number(j.attempt) + config.attempts]),
    );
    let jobs = new Jobs(store, config.concurrency);
    async function worker() {
      while (!aborted) {
        const job = jobs.claim();
        if (!job) return;
        active++;
        try {
          const src = db.prepare("SELECT * FROM sources WHERE id=?").get(job.source)!;
          const data = store.records.read(job.source),
            chunk = store.records.chunk(job.source, Number(job.chunk));
          if (
            !chunk ||
            chunk.id !== data.chunks[Number(job.chunk)]?.id ||
            hash(chunk.text) !== chunk.hash
          )
            throw Error("chunk hash mismatch");
          const request: Request = {
            id: String(job.id),
            role: String(job.role),
            text: chunk.text,
            attempt: job.attempt,
            chunk,
            sourceHash: data.hash!,
            configHash,
          };
          if (config.enrichment || config.profile) {
            const prior: Record<string, unknown> = {};
            for (const role of config.roles.slice(0, config.roles.indexOf(job.role))) {
              const upstream = db
                .prepare("SELECT * FROM jobs WHERE source=? AND chunk=? AND role=?")
                .get(job.source, job.chunk, role);
              if (
                !upstream ||
                upstream.state !== "completed" ||
                !store.records.intact(String(upstream.id), String(upstream.outputHash))
              )
                throw Error("upstream stage unavailable: " + role);
              prior[role] = store.records.result(
                String(upstream.id),
                String(upstream.outputHash),
              ).result;
            }
            request.payload = {
              spans: [{ id: 0, text: chunk.text }],
              context: {
                trustedNamespace: config.enrichment?.namespace,
                sourceId: data.id,
                sourceHash: data.hash,
                chunkId: chunk.id,
                sourceName: data.path,
              },
              prior,
            };
          }
          await store.commit(() =>
            store.records.attempt(request.id, request.attempt, { request, model: config.model }),
          );
          const result = await infer(request);
          await store.commit(() =>
            store.records.attempt(request.id, request.attempt, {
              request,
              model: config.model,
              result,
              inference: proof(result),
            }),
          );
          await exportRecord(
            join(config.work, "state", "attempts", request.id, String(request.attempt) + ".json"),
            {
              request: {
                ...request,
                text: undefined,
                chunk: { ...request.chunk, text: undefined },
              },
              model: config.model,
              result,
              inference: proof(result),
            },
          );
          if (
            !(config.profile
              ? accepts(config.profile.stages.find((s) => s.name === job.role)!.schema, result)
              : config.enrichment
                ? validRole(job.role as Role, result, request.payload!)
                : valid(result, chunk.text))
          )
            throw Error("invalid inference schema/evidence");
          const output = join(config.work, "output", String(job.id) + ".json");
          const receipt = {
            job: job.id,
            source: job.source,
            sourceHash: data.hash,
            chunk: chunk.id,
            chunkHash: chunk.hash,
            role: job.role,
            inference: proof(result),
            payload: request.payload,
            model: config.model,
            configHash,
            attempt: job.attempt,
            result,
            evidence: {
              source: data.id,
              sourceHash: data.hash,
              chunk: chunk.id,
              chunkHash: chunk.hash,
              anchors: [{ id: 0, start: chunk.start, end: chunk.end }],
            },
          };
          const outputHash = hash(JSON.stringify(receipt) + "\n");
          await store.commit(() => {
            const storedHash = store.records.write(String(job.id), receipt);
            if (storedHash !== outputHash) throw Error("SQLite/export serialization mismatch");
            db.prepare("INSERT OR REPLACE INTO artifacts VALUES(?,?,?)").run(
              output,
              outputHash,
              job.id,
            );
            db.prepare(
              "UPDATE jobs SET state='completed',output=?,outputHash=?,error=NULL WHERE id=?",
            ).run(output, outputHash, job.id);
            db.prepare("UPDATE attempts SET state='completed' WHERE job=? AND attempt=?").run(
              job.id,
              job.attempt,
            );
          });
          await exportRecord(output, receipt);
        } catch (e) {
          if ((e as any)?.partial !== undefined)
            await exportRecord(
              join(config.work, "state", "attempts", job.id, String(job.attempt) + ".failed.json"),
              {
                role: job.role,
                error: String(e),
                partial: (e as any).partial,
                outputTokens: (e as any).outputTokens,
              },
            );
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
    const timer = setInterval(
      () =>
        console.log(
          JSON.stringify({
            type: "progress",
            active,
            ...db
              .prepare(
                "SELECT COUNT(*) jobs,SUM(state='completed') completed,SUM(state='failed') failed FROM jobs",
              )
              .get(),
            elapsedSeconds: (performance.now() - started) / 1000,
          }),
        ),
      5000,
    );
    try {
      for (const role of config.enrichment || config.profile ? config.roles : [undefined]) {
        if (aborted) break;
        for (;;) {
          if (config.review?.after.length && role) await phase(config.work, role, "running");
          for (const j of db
            .prepare("SELECT id,attempt FROM jobs WHERE role=? AND state!='completed'")
            .all(role ?? null))
            ceilings.set(String(j.id), Number(j.attempt) + config.attempts);
          jobs = new Jobs(store, config.concurrency, role);
          await Promise.all(Array.from({ length: config.concurrency }, worker));
          if (aborted || !role || !config.review?.after.includes(role)) break;
          const receipts = db
            .prepare("SELECT id,state,outputHash,attempt FROM jobs WHERE role=? ORDER BY id")
            .all(role) as Receipt[];
          const failures = db
            .prepare(
              "SELECT id,state,stageHash FROM sources WHERE state IN ('failed','invalid') ORDER BY id",
            )
            .all();
          receipts.push(
            ...failures.map((r) => ({
              id: "source:" + String(r.id),
              state: String(r.state),
              outputHash: r.stageHash,
              attempt: 0,
            })),
          );
          const decision = await review(config.work, role, configHash, receipts, config.resume);
          if (decision === "reject")
            throw Error(
              "Review rejected stage: " + role + "; use explicit resume after resolving review",
            );
          if (decision === "approve") break;
          if (failures.length)
            throw Error(
              "Source preparation failures require explicit resume after correcting input/configuration",
            );
          store.transaction(() => {
            for (const later of config.roles.slice(config.roles.indexOf(role)))
              db.prepare(
                "UPDATE jobs SET state='pending',error='operator requested stage retry' WHERE role=?",
              ).run(later);
          });
        }
      }
    } finally {
      clearInterval(timer);
    }
    for (const s of db.prepare("SELECT * FROM sources WHERE state='pending'").all()) {
      const totals = db
        .prepare("SELECT COUNT(*) total,SUM(state='completed') done FROM jobs WHERE source=?")
        .get(s.id)!;
      const complete = Number(totals.total) > 0 && totals.total === totals.done;
      db.prepare("UPDATE sources SET state=? WHERE id=?").run(
        complete ? "completed" : aborted ? "pending" : "failed",
        s.id,
      );
    }
    store.close();
    const report = await verify(config.work, config.input, Boolean(config.enrichment));
    report.elapsedSeconds = (performance.now() - started) / 1000;
    report.filesPerMinute = (report.completed * 60) / report.elapsedSeconds;
    await atomic(join(config.work, "state", "completion.json"), report);
    if (config.profile)
      await phase(
        config.work,
        report.integrity ? "completed" : "incomplete",
        report.integrity ? "completed" : "failed",
      );
    return report;
  } catch (error) {
    if (config.profile) await phase(config.work, "failed", "failed", undefined, String(error));
    throw error;
  } finally {
    try {
      store.close();
    } catch {}
    await lock.close();
  }
}
export async function verify(work: string, input?: string, chunksOnly = false) {
  work = await realpath(work);
  if (input) input = await realpath(input);
  const store = new Store(join(work, "state", "pipeline.sqlite")),
    db = store.db;
  const content = new Content(store.db);
  const extra: string[] = [];
  if (input) {
    const expected = new Set(
      db
        .prepare("SELECT path FROM sources")
        .all()
        .map((s) => String(s.path)),
    );
    for await (const path of discover(input)) {
      const name = path.slice(input.length + 1);
      if (!expected.has(name)) extra.push("unrecorded-source:" + name);
      else expected.delete(name);
    }
    for (const name of expected) extra.push("missing-source:" + name);
  }
  const counts: { [key: string]: number } = {
    completed: 0,
    failed: 0,
    invalid: 0,
    unsupported: 0,
    pending: 0,
    running: 0,
  };
  const exportErrors: string[] = [];
  const errors: string[] = [...extra],
    sources: string[] = [];
  try {
    for (const s of db.prepare("SELECT * FROM sources ORDER BY path").all()) {
      counts[String(s.state)]++;
      sources.push(String(s.id));
      // Optional exports remain integrity-checked when present, but never feed inference.
      if (
        s.stage &&
        (await lstat(String(s.stage)).then(
          () => true,
          (e) => {
            if (e.code === "ENOENT" || e.code === "ENOTDIR") return false;
            throw e;
          },
        ))
      )
        if (!(await intact(String(s.stage), String(s.stageHash))))
          exportErrors.push("staging-export:" + s.id);
      let data: import("./records.ts").Data;
      try {
        data = store.records.read(String(s.id));
      } catch (error) {
        errors.push("source-data:" + s.id + ":" + String(error));
        continue;
      }
      if (data.id !== s.id || data.path !== s.path || data.hash !== s.hash) {
        errors.push("source-attribution:" + s.id);
        continue;
      }
      if (!data.content) errors.push("content-unavailable:" + s.id);
      else
        try {
          await content.verify(String(s.id), data.content.hash);
        } catch (error) {
          errors.push("content-mirror:" + s.id + ":" + String(error));
        }
      if (data.chunkFile || data.chunkHash)
        errors.push("database-source-has-file-pointers:" + s.id);
      const chunkExport = join(work, "staging", String(s.id) + ".jsonl");
      try {
        const expected = createHash("sha256");
        for (let n = 0; n < data.chunks.length; n++) {
          const chunk = store.records.chunk(String(s.id), n);
          if (!chunk) throw Error("missing chunk");
          expected.update(
            JSON.stringify({
              source: data.id,
              sourceHash: data.hash,
              normalizedHash: data.normalizedHash,
              ...chunk,
            }) + "\n",
          );
        }
        if ((await fileHash(chunkExport)) !== expected.digest("hex"))
          throw Error("normalized JSONL hash mismatch");
      } catch (error) {
        errors.push("normalized-jsonl:" + s.id + ":" + String(error));
      }
      if (input && data.hash) {
        const path = join(input, data.path);
        try {
          if ((await realpath(path)) !== path || (await fileHash(path)) !== data.hash)
            errors.push("source-changed:" + s.id);
        } catch {
          errors.push("source-unavailable:" + s.id);
        }
      }
      if (
        Number(db.prepare("SELECT count(*) n FROM chunk_data WHERE source=?").get(s.id)!.n) !==
        data.chunks.length
      ) {
        errors.push("chunk-coverage:" + s.id);
        continue;
      }
      if (data.state !== "pending") continue;
      async function checkedChunk(index: number) {
        try {
          return store.records.chunk(String(s.id), index);
        } catch (error) {
          errors.push("chunk:" + s.id + ":" + index + ":" + String(error));
          return undefined;
        }
      }
      let end = 0;
      const normalized = createHash("sha256");
      for (let index = 0; index < data.chunks.length; index++) {
        const c = await checkedChunk(index);
        if (!c) {
          errors.push("missing-chunk:" + index);
          continue;
        }
        normalized.update(c.text);
        if (c.start !== end || c.end !== c.start + c.text.length || hash(c.text) !== c.hash)
          errors.push("chunk:" + c.id);
        end = c.end;
      }
      if (normalized.digest("hex") !== data.normalizedHash) errors.push("normalized:" + s.id);
      if (s.state === "completed") {
        const jobs = db.prepare("SELECT * FROM jobs WHERE source=?").all(s.id);
        for (const j of jobs) {
          if (j.state !== "completed" || !store.records.intact(String(j.id), String(j.outputHash)))
            errors.push("output:" + j.id);
          else {
            const result = store.records.result(String(j.id), String(j.outputHash));
            if (
              result.job !== j.id ||
              result.sourceHash !== s.hash ||
              result.chunk !== data.chunks[Number(j.chunk)]?.id ||
              !(data.profile
                ? accepts(
                    validateProfile(data.profile).stages.find((s) => s.name === j.role)!.schema,
                    result.result,
                  )
                : data.enrichment
                  ? validRole(j.role as Role, result.result, result.payload)
                  : valid(result.result, (await checkedChunk(Number(j.chunk)))?.text ?? ""))
            )
              errors.push("attribution:" + j.id);
          }
        }
        if (!Array.isArray(data.roles) || jobs.length !== data.chunks.length * data.roles.length)
          errors.push("missing-jobs:" + s.id);
        else
          for (const c of data.chunks)
            for (const role of data.roles) {
              const id = hash(c.id + ":" + role + ":" + data.configHash);
              if (!jobs.some((j) => j.id === id)) errors.push("missing-job:" + id);
            }
      }
    }
    for (const name of await readdir(join(work, "output")).catch((e) => {
      if (e.code === "ENOENT") return [];
      if (e.code === "ENOTDIR") {
        exportErrors.push("output-export-directory");
        return [];
      }
      throw e;
    })) {
      if (
        chunksOnly &&
        ["graph.json", "entities.jsonl", "groups.jsonl", "edges.jsonl"].includes(name)
      )
        continue;
      const path = join(work, "output", name);
      const a = db.prepare("SELECT * FROM artifacts WHERE path=?").get(path);
      if (!a) exportErrors.push("untracked-output:" + name);
      else if (!(await intact(path, String(a.hash)))) exportErrors.push("artifact-hash:" + name);
    }
    for (const a of db.prepare("SELECT * FROM artifacts").all())
      if (
        !(chunksOnly && (a.job === "graph" || a.job === "enrichment")) &&
        (await lstat(String(a.path)).then(
          () => true,
          (e) => {
            if (e.code === "ENOENT" || e.code === "ENOTDIR") return false;
            throw e;
          },
        )) &&
        !(await intact(String(a.path), String(a.hash)))
      )
        exportErrors.push("artifact-hash:" + a.path);
    return {
      exportErrors,
      completed: counts.completed,
      failed: counts.failed,
      invalid: counts.invalid,
      unsupported: counts.unsupported,
      pending: counts.pending,
      running: counts.running,
      discovered: sources.length,
      sources,
      errors,
      integrity:
        errors.length === 0 && counts.failed === 0 && counts.pending === 0 && counts.running === 0,
      elapsedSeconds: 0,
      filesPerMinute: 0,
    };
  } finally {
    store.close();
  }
}
