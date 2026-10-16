import { outsideProject } from "./storage.ts";
/** Local handbook preparation, checkpointed authoring and portable publication. */
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, lstat, realpath, readdir, statfs } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Lock } from "./lock.ts";
import { atomic, publish, hash } from "./store.ts";
import { fileHash } from "./seal.ts";
import { boundaries, run, type Inference } from "./run.ts";
import { verifyHandoff } from "./handoff.ts";
import { assertNetworkDenied, launch } from "./sandbox.ts";
import { modelVersion, pool, bounds, type Model } from "./mlx.ts";
import { pack, inspect } from "./package.ts";
import { Usage } from "./usage.ts";
import {
  bookProfile,
  validateBook,
  checkDraft,
  type Book,
  type Packet,
  type Excerpt,
  type Origin,
  type Draft,
} from "./book-data.ts";
import { renderBook, type Chapter } from "./book-view.ts";
export type Prepared = {
  format: "engineering-book/1";
  title: string;
  topics: number;
  config: Book;
  database: string;
  packets: Record<string, string>;
  profile: string;
  coverage: Record<string, unknown>;
  created: string;
};
type Candidate = Omit<Excerpt, "id"> & { score: number; document: string };
async function canonical(path: string) {
  const p = resolve(path);
  if ((await realpath(p)) !== p) throw Error("aliased handbook path");
  return p;
}
async function intakeReader(path: string) {
  await canonical(path);
  const wal = await lstat(path + "-wal").catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "ENOENT") throw e;
    return null;
  });
  const closed = !wal || wal.size === 0,
    before = closed ? await fileHash(path) : null;
  const uri = pathToFileURL(path);
  uri.search = closed ? "mode=ro&immutable=1" : "mode=ro";
  const db = new DatabaseSync(uri.href, { readOnly: true });
  return {
    db,
    verify: async () => {
      if (
        closed &&
        ((await fileHash(path)) !== before || (await lstat(path + "-wal").catch(() => null))?.size)
      )
        throw Error("closed source database changed while reading");
    },
  };
}
async function load(root: string): Promise<Prepared> {
  return JSON.parse(await readFile(join(root, "prepared.json"), "utf8"));
}
function* fields(value: unknown, pointer = ""): Generator<{ pointer: string; text: string }> {
  if (typeof value === "string") {
    yield { pointer, text: value };
    return;
  }
  if (!value || typeof value !== "object") return;
  if (!Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    if (v.encoding === "base64" && typeof v.data === "string" && typeof v.hash === "string") {
      const bytes = Buffer.from(v.data, "base64");
      if (hash(bytes) !== v.hash) throw Error("embedded artifact hash mismatch");
      try {
        yield {
          pointer: pointer + "/decoded",
          text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        };
      } catch (e) {
        if (!(e instanceof TypeError)) throw e;
      }
      return;
    }
  }
  for (const [key, child] of Object.entries(value))
    yield* fields(child, pointer + "/" + key.replaceAll("~", "~0").replaceAll("/", "~1"));
}
function candidate(
  text: string,
  origin: Origin,
  keywords: string[],
  characters: number,
): Candidate | undefined {
  const lower = text.toLowerCase();
  let first = -1,
    score = 0;
  for (const term of keywords) {
    const needle = term.toLowerCase();
    let at = lower.indexOf(needle),
      hits = 0;
    if (at >= 0 && (first < 0 || at < first)) first = at;
    while (at >= 0 && hits < 10) {
      hits++;
      at = lower.indexOf(needle, at + needle.length);
    }
    if (hits) score += 10 + Math.log2(hits + 1);
  }
  if (first < 0) return;
  let start = Math.max(0, first - Math.floor(characters / 3)),
    end = Math.min(text.length, start + characters);
  start = Math.max(0, end - characters);
  // Keep Unicode surrogate pairs whole, with offsets into the exact decoded source field.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]!)) start--;
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end++;
  const excerpt = text.slice(start, end);
  return {
    text: excerpt,
    start,
    end,
    hash: hash(excerpt),
    origin,
    score,
    document: origin.name + ":" + origin.record,
  };
}
export async function prepareBook(value: Book) {
  const config = validateBook(value);
  config.output = resolve(config.output);
  await outsideProject(config.output);
  for (const s of config.sources) {
    const p = await boundaries(resolve(s.path), config.output);
    s.path = await canonical(p.input);
    config.output = p.work;
  }
  const existing = await lstat(config.output).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "ENOENT") throw e;
    return null;
  });
  if (existing) throw Error("handbook output already exists; use draft/publish to resume");
  const disk = await statfs(dirname(config.output));
  if (disk.bavail * disk.bsize < 3 * 1024 ** 3) throw Error("handbook disk reserve reached");
  await mkdir(join(config.output, "state"), { recursive: true, mode: 0o700 });
  await mkdir(join(config.output, "input"), { mode: 0o700 });
  const db = new DatabaseSync(join(config.output, "state/book.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;CREATE TABLE documents(id TEXT PRIMARY KEY,body TEXT NOT NULL,digest TEXT NOT NULL);CREATE TABLE packets(id TEXT PRIMARY KEY,body TEXT NOT NULL,digest TEXT NOT NULL);CREATE TABLE coverage(name TEXT PRIMARY KEY,body TEXT NOT NULL);",
  );
  const coverage: Record<string, unknown> = {},
    top = new Map(config.topics.map((t) => [t.id, [] as Candidate[]])),
    matched = new Map(config.topics.map((t) => [t.id, new Set<string>()]));
  const insert = db.prepare("INSERT INTO documents VALUES(?,?,?)");
  let documents = 0;
  const take = (
    text: string,
    origin: Origin,
    body: string,
    segments?: Iterable<{ pointer: string; text: string }>,
  ) => {
    const id = hash(origin.name + ":" + origin.record);
    insert.run(id, body, hash(body + "\n"));
    documents++;
    const items = segments ? [...segments] : [{ pointer: "", text }];
    for (const t of config.topics) {
      let best: Candidate | undefined;
      for (const f of items) {
        const c = candidate(
          f.text,
          { ...origin, ...(f.pointer ? { pointer: f.pointer } : {}) },
          t.keywords,
          config.characters ?? 3000,
        );
        if (c && (!best || c.score > best.score)) best = c;
      }
      if (!best) continue;
      matched.get(t.id)!.add(id);
      const list = top.get(t.id)!;
      // Exact copies are not independent evidence. Retain the first stable provenance.
      const duplicate = list.findIndex((c) => c.hash === best!.hash);
      if (duplicate >= 0) {
        if (list[duplicate]!.score >= best.score) continue;
        list.splice(duplicate, 1);
      }
      list.push(best);
      list.sort((a, b) => b.score - a.score || a.document.localeCompare(b.document, "en"));
      const own = list.filter((c) => c.origin.name === origin.name);
      if (own.length > (config.excerpts ?? 12)) list.splice(list.indexOf(own.at(-1)!), 1);
    }
  };
  try {
    db.exec("BEGIN");
    for (const s of config.sources) {
      if (s.kind === "handoff") {
        const proof = await verifyHandoff(s.path),
          reader = new DatabaseSync(join(s.path, "documents.sqlite"), { readOnly: true });
        let captured = 0;
        try {
          reader.exec("BEGIN");
          for (const row of reader
            .prepare("SELECT body FROM documents ORDER BY repo,path")
            .iterate()) {
            const body = String(row.body),
              r = JSON.parse(body);
            if (
              typeof r.text !== "string" ||
              hash(Buffer.from(r.base64, "base64")) !== r.hash ||
              !Buffer.from(r.text).equals(Buffer.from(r.base64, "base64"))
            )
              throw Error("source document integrity mismatch");
            take(
              r.text,
              {
                kind: s.kind,
                name: s.name,
                record: r.id,
                path: r.repo + "/" + r.path,
                hash: r.hash,
              },
              body,
            );
            captured++;
          }
          reader.exec("COMMIT");
        } finally {
          reader.close();
        }
        coverage[s.name] = {
          kind: s.kind,
          captured,
          unsupported: proof.unsupported,
          selectedInventoryComplete: proof.complete,
          scope: "Registered source snapshot only. Revision metadata does not prove deployment.",
        };
      } else {
        const source = await intakeReader(join(s.path, "state/intake.sqlite")),
          reader = source.db;
        let captured = 0;
        try {
          reader.exec("BEGIN");
          const counts = Object.fromEntries(
            reader
              .prepare("SELECT state,count(*) n FROM jobs GROUP BY state")
              .all()
              .map((r) => [String(r.state), Number(r.n)]),
          );
          for (const row of reader
            .prepare(
              "SELECT r.* FROM receipts r JOIN jobs j ON j.id=r.id WHERE j.state='accepted' ORDER BY r.id",
            )
            .iterate()) {
            const receipt = String(row.receipt),
              r = JSON.parse(receipt),
              response = String(row.response);
            if (s.repositories) {
              const repo = /^\/repos\/[^/]+\/([^/?]+)(?:[/?]|$)/i.exec(
                String(r.task?.inputs?.path),
              );
              if (!repo || !s.repositories.some((n) => n.toLowerCase() === repo[1]!.toLowerCase()))
                continue;
            }
            if (
              hash(receipt) !== row.digest ||
              r.task?.id !== row.id ||
              r.error !== null ||
              JSON.stringify(r.response) !== response ||
              row.published !== 1
            )
              throw Error("provider receipt integrity mismatch");
            const mirror = join(s.path, "staging", String(row.id) + ".jsonl");
            await canonical(mirror);
            if ((await fileHash(mirror)) !== hash(response + "\n"))
              throw Error("provider mirror integrity mismatch");
            take(
              response,
              {
                kind: s.kind,
                name: s.name,
                record: String(row.id),
                path:
                  String(r.task.kind) +
                  "/" +
                  String(r.task.scope) +
                  "/" +
                  String(r.task.name) +
                  "/" +
                  String(row.id),
                hash: hash(response),
              },
              receipt,
              fields(r.response),
            );
            captured++;
          }
          coverage[s.name] = {
            kind: s.kind,
            ...counts,
            captured,
            scope:
              "Committed accepted receipts at this SQLite snapshot. Counts do not prove beginning-of-time provider coverage.",
          };
          reader.exec("COMMIT");
          await source.verify();
        } finally {
          reader.close();
        }
      }
      db.prepare("INSERT INTO coverage VALUES(?,?)").run(s.name, JSON.stringify(coverage[s.name]));
    }
    const packets: Record<string, string> = {};
    for (const t of config.topics) {
      const ranked = top.get(t.id)!,
        list: Candidate[] = [],
        seen = new Set<string>();
      const choose = (c: Candidate | undefined) => {
        if (c && !seen.has(c.hash) && list.length < (config.excerpts ?? 12)) {
          list.push(c);
          seen.add(c.hash);
        }
      };
      for (const source of config.sources)
        choose(ranked.find((c) => c.origin.name === source.name));
      for (const c of ranked) choose(c);
      const n = matched.get(t.id)!.size;
      const packet: Packet = {
        topic: t,
        evidence: list.map(({ score: _, document: __, ...e }, i) => ({ ...e, id: "e" + i })),
        scope: {
          matched: n,
          selected: list.length,
          omitted: Math.max(0, n - list.length),
          method:
            "Case-insensitive keyword retrieval, one excerpt per source record, exact excerpt deduplication, bounded ranked context. Not exhaustive dependency or historical analysis.",
        },
      };
      const body = JSON.stringify(packet);
      db.prepare("INSERT INTO packets VALUES(?,?,?)").run(t.id, body, hash(body + "\n"));
      packets[t.id] = hash(body + "\n");
      // Empty topics remain in the book but must never be sent for speculative generation.
      if (packet.evidence.length)
        await atomic(join(config.output, "input", t.id + ".jsonl"), body + "\n", true);
    }
    db.exec("COMMIT;PRAGMA wal_checkpoint(TRUNCATE);PRAGMA journal_mode=DELETE");
    const database = await fileHash(join(config.output, "state/book.sqlite"));
    const profile = bookProfile();
    await atomic(join(config.output, "profile.json"), profile);
    await publish(
      join(config.output, "evidence.jsonl"),
      (function* () {
        for (const row of db.prepare("SELECT body FROM packets ORDER BY id").iterate())
          yield String(row.body) + "\n";
      })(),
    );
    const prepared: Prepared = {
      format: "engineering-book/1",
      title: config.title,
      topics: config.topics.length,
      config,
      database,
      packets,
      profile: await fileHash(join(config.output, "profile.json")),
      coverage,
      created: new Date().toISOString(),
    };
    await atomic(join(config.output, "prepared.json"), prepared);
    return {
      topics: config.topics.length,
      documents,
      matched: Object.fromEntries([...matched].map(([id, set]) => [id, set.size])),
      scope: "Prepared evidence and questions; no chapters authored yet.",
    };
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    await atomic(join(config.output, "failure.json"), { phase: "prepare", error: String(e) });
    throw e;
  } finally {
    db.close();
  }
}
async function packets(root: string) {
  const p = await load(root);
  if (
    p.format !== "engineering-book/1" ||
    (await fileHash(join(root, "state/book.sqlite"))) !== p.database ||
    (await fileHash(join(root, "profile.json"))) !== p.profile
  )
    throw Error("handbook prepared artifact hash mismatch");
  if (
    JSON.stringify(JSON.parse(await readFile(join(root, "profile.json"), "utf8"))) !==
    JSON.stringify(bookProfile())
  )
    throw Error("author profile differs from prepared snapshot");
  const db = new DatabaseSync(join(root, "state/book.sqlite"), { readOnly: true }),
    result: Packet[] = [];
  try {
    for (const row of db.prepare("SELECT id,body,digest FROM packets ORDER BY id").iterate()) {
      const body = String(row.body);
      if (hash(body + "\n") !== row.digest || row.digest !== p.packets[String(row.id)])
        throw Error("handbook packet integrity mismatch");
      const packet = JSON.parse(body) as Packet;
      if (
        packet.evidence.length &&
        (await readFile(join(root, "input", packet.topic.id + ".jsonl"), "utf8")) !== body + "\n"
      )
        throw Error("handbook SQLite/JSONL packet mismatch");
      for (const e of packet.evidence)
        if (hash(e.text) !== e.hash || e.end - e.start !== e.text.length)
          throw Error("handbook excerpt integrity mismatch");
      result.push(packet);
    }
    if (result.length !== p.topics) throw Error("handbook topic coverage mismatch");
    const expected = result
      .filter((r) => r.evidence.length)
      .map((r) => r.topic.id + ".jsonl")
      .sort();
    if (JSON.stringify((await readdir(join(root, "input"))).sort()) !== JSON.stringify(expected))
      throw Error("unexpected handbook input");
    const mirror = (await readFile(join(root, "evidence.jsonl"), "utf8")).trimEnd().split("\n");
    if (
      mirror.length !== result.length ||
      mirror.some((line, i) => line !== JSON.stringify(result[i]))
    )
      throw Error("handbook evidence mirror mismatch");
    return { prepared: p, packets: result };
  } finally {
    db.close();
  }
}
export async function runBook(root: string, infer: Inference, model: string) {
  root = await canonical(root);
  const snapshot = await packets(root),
    byId = new Map(snapshot.packets.map((p) => [p.topic.id, p]));
  await mkdir(join(root, "run/state"), { recursive: true });
  const lock = await Lock.acquire(join(root, "run/state/book.lock"));
  try {
    const path = join(root, "run/state/author.json"),
      binding =
        JSON.stringify({
          model,
          profile: snapshot.prepared.profile,
          prepared: await fileHash(join(root, "prepared.json")),
        }) + "\n";
    const prior = await readFile(path, "utf8").catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
      return null;
    });
    if (prior !== null && prior !== binding)
      throw Error("author configuration changed; create a new edition");
    if (prior === null) await atomic(path, binding, true);
    return await run(
      {
        input: join(root, "input"),
        work: join(root, "run"),
        roles: ["author"],
        model,
        engine: model.startsWith("synthetic") ? "synthetic" : "mlx",
        chunkSize: 2_000_000,
        concurrency: 1,
        attempts: 3,
        maxBytes: 8 * 1024 ** 2,
        resume: true,
        profile: bookProfile(),
      },
      async (r) => {
        const packet = JSON.parse(r.text) as Packet,
          expected = byId.get(packet.topic.id);
        if (!expected || JSON.stringify(packet) !== JSON.stringify(expected))
          throw Error("author request does not match sealed packet");
        const result = await infer(r);
        checkDraft(packet, result);
        return result;
      },
    );
  } finally {
    await lock.close();
  }
}
export async function publishBook(root: string) {
  const snapshot = await packets(root),
    chapters: Chapter[] = [];
  let reader: DatabaseSync | undefined;
  try {
    if (await lstat(join(root, "run/state/pipeline.sqlite")).catch(() => null))
      reader = new DatabaseSync(join(root, "run/state/pipeline.sqlite"), { readOnly: true });
    for (const packet of snapshot.packets) {
      let draft: Draft | undefined,
        state = packet.evidence.length ? "Authoring pending" : "No matching evidence";
      if (reader) {
        const row = reader
          .prepare(
            "SELECT j.*,r.body,r.digest FROM jobs j JOIN results r ON r.job=j.id WHERE j.source=? AND j.role='author' AND j.state='completed'",
          )
          .get(hash(packet.topic.id + ".jsonl"));
        if (row) {
          const body = String(row.body);
          if (hash(body + "\n") !== row.digest || row.digest !== row.outputHash)
            throw Error("author result integrity mismatch");
          const receipt = JSON.parse(body);
          if (receipt.sourceHash !== snapshot.prepared.packets[packet.topic.id])
            throw Error("author source binding mismatch");
          checkDraft(packet, receipt.result);
          draft = receipt.result;
          state = "Model draft · review required";
        }
      }
      chapters.push({ packet, draft, state });
    }
  } finally {
    reader?.close();
  }
  const artifacts = await renderBook(
    join(root, "site"),
    snapshot.prepared.title,
    chapters,
    snapshot.prepared.coverage,
  );
  const report = {
    format: "engineering-book-report/1",
    integrity: true,
    complete: false,
    reviewed: 0,
    drafted: chapters.filter((c) => c.draft).length,
    gaps: chapters.filter((c) => !c.draft).length,
    topics: chapters.length,
    created: new Date().toISOString(),
    prepared: await fileHash(join(root, "prepared.json")),
    database: snapshot.prepared.database,
    artifacts,
    scope:
      "Citations mechanically validated; interpretation, all-time source coverage and deployment truth require review.",
  };
  await atomic(join(root, "report.json"), report);
  await verifyBook(root);
  return report;
}
export async function verifyBook(root: string) {
  await packets(root);
  const r = JSON.parse(await readFile(join(root, "report.json"), "utf8"));
  if (
    r.prepared !== (await fileHash(join(root, "prepared.json"))) ||
    r.complete !== false ||
    r.reviewed !== 0
  )
    throw Error("book report integrity mismatch");
  for (const [name, digest] of Object.entries(r.artifacts)) {
    if (
      !/^[a-z0-9-]+\.html$/.test(name) ||
      typeof digest !== "string" ||
      (await fileHash(join(root, "site", name))) !== digest
    )
      throw Error("book page artifact hash mismatch");
  }
  return { integrity: true, drafted: r.drafted, topics: r.topics, reviewed: 0, complete: false };
}
async function resolveConfig(path: string) {
  const value = validateBook(JSON.parse(await readFile(path, "utf8")) as Book),
    base = dirname(path);
  value.output = resolve(base, value.output);
  for (const s of value.sources) s.path = resolve(base, s.path);
  return value;
}
async function main() {
  const [command, arg, modelPath] = process.argv.slice(2);
  if (!arg)
    throw Error(
      "Usage: node pipeline/book.ts prepare CONFIG | draft ROOT MODEL.json | publish ROOT | verify ROOT",
    );
  if (command === "prepare" || command === "--prepare") {
    const config = await resolveConfig(resolve(arg));
    for (const s of config.sources) await boundaries(s.path, config.output);
    if (command === "--prepare") {
      await assertNetworkDenied();
      console.log(JSON.stringify(await prepareBook(config)));
    } else {
      const policy =
        '(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (literal "/dev/null"))(allow file-write* (subpath ' +
        JSON.stringify(config.output) +
        "))" +
        config.sources
          .map((s) => "(deny file-write* (subpath " + JSON.stringify(s.path) + "))")
          .join("");
      const child = spawn(
        "/usr/bin/sandbox-exec",
        ["-p", policy, process.execPath, import.meta.filename, "--prepare", resolve(arg)],
        {
          stdio: "inherit",
          env: {
            PATH: "/usr/bin:/bin",
            HOME: config.output,
            TMPDIR: config.output,
            NODE_DISABLE_COMPILE_CACHE: "1",
          },
        },
      );
      process.exitCode = await new Promise<number>((ok, no) => {
        child.once("error", no);
        child.once("exit", (c) => ok(c ?? 1));
      });
    }
  } else if (command === "publish" || command === "verify")
    console.log(
      JSON.stringify(
        await (command === "publish" ? publishBook(resolve(arg)) : verifyBook(resolve(arg))),
      ),
    );
  else if (command === "draft" || command === "--draft") {
    const root = await canonical(arg);
    await packets(root);
    if (!modelPath) throw Error("explicit local model configuration required");
    const model = JSON.parse(await readFile(resolve(modelPath), "utf8")) as Model;
    for (const key of ["runtime", "base", "package"] as const)
      if (model[key]) model[key] = resolve(dirname(resolve(modelPath)), model[key]!);
    if (
      !model.package ||
      model.roleMode !== "packaged" ||
      Object.keys(model.adapters).length ||
      bounds(model).count !== 1
    )
      throw Error("book requires one packaged local model with unchanged weights");
    if (command === "draft") {
      await boundaries(join(root, "input"), model.package);
      await boundaries(model.base, root);
      await boundaries(model.runtime, root);
      const manifest = await lstat(join(model.package, "manifest.json")).catch(
        (e: NodeJS.ErrnoException) => {
          if (e.code !== "ENOENT") throw e;
          return null;
        },
      );
      if (!manifest) await pack(model.base, model.package, bookProfile());
      const version = (await inspect(model.package, model.base)).identity;
      await atomic(join(root, "model.json"), model);
      await atomic(join(root, "model-identity.json"), {
        version,
        weightChanges: false,
        package: model.package,
      });
      process.exitCode = await launch(
        join(root, "input"),
        join(root, "run"),
        import.meta.filename,
        ["--draft", root, join(root, "model.json")],
        model,
      );
      await publishBook(root);
    } else {
      await assertNetworkDenied();
      const version = await modelVersion(model, ["author"]),
        workers = pool(model),
        usage = new Usage(join(root, "run/state/usage.sqlite"), version, "handbook");
      try {
        await workers.ready;
        const r = await runBook(
          root,
          (r) => usage.measure(r.id, r.role, r.attempt, () => workers.infer(r), r.configHash),
          version,
        );
        console.log(
          JSON.stringify({
            integrity: r.integrity,
            completed: r.completed,
            failed: r.failed,
            pending: r.pending,
          }),
        );
        if (!r.integrity) process.exitCode = 1;
      } finally {
        await workers.close();
        usage.close();
      }
    }
  } else throw Error("unknown book command");
}
if (process.argv[1] === import.meta.filename) {
  process.umask(0o077);
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : "book failed");
    process.exitCode = 1;
  });
}
