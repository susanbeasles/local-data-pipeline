import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { Catalog, type Source } from "../catalog.ts";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

async function fixture(t: TestContext, kind: Source["kind"] = "intake") {
  const base = await mkdtemp(join(tmpdir(), "catalog-test-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "source"),
    state = join(base, "operator");
  await mkdir(join(root, "state"), { recursive: true });
  await mkdir(join(root, "staging"));
  const database = join(root, "state", "intake.sqlite");
  const db = new DatabaseSync(database);
  t.after(() => db.close());
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE jobs(id TEXT PRIMARY KEY,task TEXT,state TEXT); CREATE TABLE receipts(id TEXT PRIMARY KEY,receipt TEXT,digest TEXT,response TEXT,published INTEGER)",
  );
  const source: Source = { id: "fixture", name: "Fixture", kind, root, database };
  return { base, root, state, database, db, source, catalog: new Catalog([source], state) };
}

function accept(db: DatabaseSync, id: string, response: unknown) {
  const body = JSON.stringify(response),
    receipt = JSON.stringify({ task: { id }, response, children: [], error: null });
  db.prepare("INSERT INTO jobs VALUES(?,?,'accepted')").run(id, JSON.stringify({ id }));
  db.prepare("INSERT INTO receipts VALUES(?,?,?,?,1)").run(id, receipt, digest(receipt), body);
  return body + "\n";
}

test("source counts refresh from committed SQLite while old checkpoint totals stay qualified", async (t) => {
  const { root, db, catalog } = await fixture(t);
  accept(db, "one", [1, 2, 3]);
  await writeFile(
    join(root, "progress.json"),
    JSON.stringify({
      state: "running",
      accepted: 999,
      requests: 42,
      updated: "2001-01-01T00:00:00.000Z",
    }),
  );
  const first = (await catalog.sources())[0];
  assert.equal(first.metrics.find((m) => m.id === "table.receipts.rows")?.value, 1);
  assert.equal(first.stale, true);
  assert.equal(first.alive, null);
  assert.equal(first.phase, "running");
  const checkpoint = first.metrics.find((m) => m.id === "checkpoint.accepted")!;
  assert.equal(checkpoint.value, 999);
  assert.match(checkpoint.meaning, /checkpoint/i);
  assert.match(checkpoint.meaning, /response|request/i);
  assert.match(checkpoint.meaning, /file/i);
  assert.equal(checkpoint.origin.file, join(root, "progress.json"));
  assert.ok(checkpoint.observedAt && checkpoint.actions.length);
  accept(db, "two", { ok: true });
  const second = (await catalog.sources())[0];
  assert.equal(second.metrics.find((m) => m.id === "table.receipts.rows")?.value, 2);
  assert.equal(second.updatedAt, "2001-01-01T00:00:00.000Z");
  assert.ok(second.ageSeconds! > 1000);
});

test("live pointers refresh roots and process birth plus command prevents PID reuse", async (t) => {
  const { base, root, source, state, database } = await fixture(t);
  const pointer = join(base, "active.json"),
    owner = join(base, "owner.json");
  const line = execFileSync(
    "/bin/ps",
    ["-p", String(process.pid), "-o", "lstart=,stat=,command="],
    { encoding: "utf8" },
  ).trim();
  const match = /^(.{24})\s+(\S+)\s+(.+)$/.exec(line)!;
  await writeFile(owner, JSON.stringify({ pid: process.pid, birth: match[1], command: match[3] }));
  await writeFile(pointer, JSON.stringify({ root, processFile: owner }));
  await writeFile(
    join(root, "progress.json"),
    JSON.stringify({ updatedAt: new Date().toISOString(), state: "running" }),
  );
  const catalog = new Catalog([{ ...source, database: undefined, pointer }], state);
  assert.equal((await catalog.sources())[0].alive, true);
  await writeFile(
    owner,
    JSON.stringify({ pid: process.pid, birth: "different process birth", command: match[3] }),
  );
  const reused = (await catalog.sources())[0];
  assert.equal(reused.alive, false);
  assert.match(reused.errors.join(" "), /identity/i);
  const next = join(base, "next");
  await mkdir(join(next, "state"), { recursive: true });
  const second = new DatabaseSync(join(next, "state", "intake.sqlite"));
  second.exec("CREATE TABLE fresh(id INTEGER PRIMARY KEY); INSERT INTO fresh VALUES(1)");
  second.close();
  await writeFile(pointer, JSON.stringify({ work: next }));
  assert.equal((await catalog.sources())[0].root, next);
  assert.deepEqual(
    (await catalog.tables("fixture")).map((v) => v.name),
    ["fresh"],
  );
  assert.ok((await stat(database)).isFile());
});

test("a live PID without identity remains unknown and a missing process is dead", async (t) => {
  const { source, root, state } = await fixture(t);
  const processFile = join(root, "owner.json");
  const catalog = new Catalog([{ ...source, processFile }], state);
  await writeFile(processFile, JSON.stringify({ pid: process.pid }));
  const uncertain = (await catalog.sources())[0];
  assert.equal(uncertain.alive, null);
  assert.match(uncertain.errors.join(" "), /identity/i);
  await writeFile(
    processFile,
    JSON.stringify({ pid: 2147483647, birth: "absent", command: "fixture" }),
  );
  assert.equal((await catalog.sources())[0].alive, false);
});

test("production control pointers resolve the selected partition config without caching", async (t) => {
  const { base, root, source, state } = await fixture(t);
  const pointer = join(base, "production.json"),
    progress = join(base, "progress.json"),
    config = join(base, "config.json");
  await writeFile(config, JSON.stringify({ work: root }));
  await writeFile(
    pointer,
    JSON.stringify({ configs: { alpha: config }, controllerPid: 2147483647 }),
  );
  await writeFile(progress, JSON.stringify({ pile: "alpha", phase: "paused" }));
  const catalog = new Catalog([{ ...source, database: undefined, pointer, progress }], state);
  const status = (await catalog.sources())[0];
  assert.equal(status.root, root);
  assert.equal(status.phase, "paused");
  assert.equal(status.alive, false);
});

test("generic browsing quotes identifiers, escapes literal searches and preserves composite keys", async (t) => {
  const { db, catalog } = await fixture(t, "sqlite");
  db.exec(
    'CREATE TABLE "odd"" table"(tenant TEXT,id INTEGER,label TEXT,PRIMARY KEY(tenant,id)) WITHOUT ROWID',
  );
  const insert = db.prepare('INSERT INTO "odd"" table" VALUES(?,?,?)');
  insert.run("a", 2, "100% literal");
  insert.run("a", 1, "plain");
  insert.run("b", 1, "under_score");
  const info = (await catalog.tables("fixture")).find((v) => v.name === 'odd" table')!;
  assert.deepEqual(info.key, ["tenant", "id"]);
  assert.equal(info.count, 3);
  const page = await catalog.page("fixture", 'odd" table', { limit: 1, offset: 1 });
  assert.equal(page.total, 3);
  assert.equal(page.rows[0].value.label, "100% literal");
  const row = await catalog.record("fixture", 'odd" table', page.rows[0].key);
  assert.equal(row.sqlite.id, 2);
  assert.equal(row.id, page.rows[0].id);
  assert.equal(row.jsonl.status, "unavailable");
  assert.equal((await catalog.page("fixture", 'odd" table', { query: "%" })).total, 1);
  assert.equal((await catalog.page("fixture", 'odd" table', { query: "_" })).total, 1);
  assert.equal((await catalog.page("fixture", 'odd" table', { query: "' OR 1=1 --" })).total, 0);
  await assert.rejects(catalog.page("fixture", "jobs; DROP TABLE jobs", {}), /table/i);
  await assert.rejects(catalog.record("fixture", 'odd" table', "invalid"), /key/i);
  await assert.rejects(catalog.record("fixture", "jobs", page.rows[0].key), /key/i);
  await assert.rejects(catalog.page("fixture", "jobs", { limit: 10001 }), /bound/i);
  assert.equal((await catalog.tables("fixture")).find((v) => v.name === "jobs")?.count, 0);
});

test("intake explorer compares the actual response file, detects corruption and never rebuilds missing mirrors", async (t) => {
  const { db, root, catalog } = await fixture(t);
  const line = accept(db, "one", { records: [1, 2] });
  const file = join(root, "staging", "one.jsonl");
  await writeFile(file, line);
  const key = (await catalog.page("fixture", "receipts", {})).rows[0].key;
  const matched = await catalog.record("fixture", "receipts", key);
  assert.equal(matched.jsonl.status, "match");
  assert.deepEqual(matched.jsonl.value, { records: [1, 2] });
  assert.equal(matched.sqlite.response, '{"records":[1,2]}');
  assert.equal(matched.digest.jsonl, digest(line));
  await writeFile(file, '{"records":[999]}\n');
  assert.equal((await catalog.record("fixture", "receipts", key)).jsonl.status, "mismatch");
  await writeFile(file, "not-json\n");
  assert.equal((await catalog.record("fixture", "receipts", key)).jsonl.status, "mismatch");
  await rm(file);
  assert.equal((await catalog.record("fixture", "receipts", key)).jsonl.status, "missing");
  await assert.rejects(readFile(file), { code: "ENOENT" });
  await writeFile(file, line);
  db.prepare("UPDATE receipts SET digest='corrupt' WHERE id='one'").run();
  const corrupt = await catalog.record("fixture", "receipts", key);
  assert.equal(corrupt.digest.valid, false);
  assert.equal(corrupt.jsonl.status, "mismatch");
});

test("row previews and mirrors report byte bounds without claiming incomplete integrity", async (t) => {
  const { db, source, root, state } = await fixture(t);
  const line = accept(db, "large", { body: "x".repeat(8192) });
  await writeFile(join(root, "staging", "large.jsonl"), line);
  db.exec("CREATE TABLE binaries(id INTEGER PRIMARY KEY,data BLOB)");
  db.prepare("INSERT INTO binaries VALUES(1,?)").run(Buffer.alloc(8192, 7));
  const catalog = new Catalog([source], state, { previewBytes: 1024, mirrorBytes: 1024 });
  const page = await catalog.page("fixture", "receipts", {});
  assert.equal(page.rows[0].truncated, true);
  assert.ok(JSON.stringify(page.rows[0].value).length < 2000);
  const record = await catalog.record("fixture", "receipts", page.rows[0].key);
  assert.equal(record.truncated, true);
  assert.equal(record.jsonl.status, "limited");
  assert.match(record.jsonl.reason!, /bound|limit/i);
  const binary = await catalog.page("fixture", "binaries", {});
  assert.equal(binary.rows[0].truncated, true);
  assert.ok(JSON.stringify(binary.rows[0].value).length < 2000);
});

test("mirror paths cannot escape through identifiers, stored paths, or symlinks", async (t) => {
  const { db, root, base, catalog } = await fixture(t);
  const outside = join(base, "outside.jsonl");
  await writeFile(outside, '{"secret":"synthetic"}\n');
  accept(db, "../../outside", {});
  let key = (await catalog.page("fixture", "receipts", {})).rows[0].key;
  const escape = await catalog.record("fixture", "receipts", key);
  assert.equal(escape.jsonl.status, "unavailable");
  assert.equal(escape.jsonl.value, undefined);
  accept(db, "link", {});
  await symlink(outside, join(root, "staging", "link.jsonl"));
  key = (await catalog.page("fixture", "receipts", { query: "link" })).rows[0].key;
  assert.equal((await catalog.record("fixture", "receipts", key)).jsonl.status, "unavailable");
  db.exec(
    "CREATE TABLE content_sources(source TEXT PRIMARY KEY,hash TEXT,jsonl TEXT,jsonlHash TEXT)",
  );
  db.prepare("INSERT INTO content_sources VALUES('content','digest',?,?)").run(
    outside,
    digest('{"secret":"synthetic"}\n'),
  );
  key = (await catalog.page("fixture", "content_sources", {})).rows[0].key;
  const stored = await catalog.record("fixture", "content_sources", key);
  assert.equal(stored.jsonl.status, "unavailable");
  assert.equal(stored.jsonl.value, undefined);
});

test("git and inventory adapters read actual JSONL and report a bounded scan as limited", async (t) => {
  const { db, root, source, state } = await fixture(t, "git");
  db.exec(
    "CREATE TABLE objects(oid TEXT,part INTEGER,kind TEXT,record TEXT,PRIMARY KEY(oid,part)); CREATE TABLE entries(path TEXT PRIMARY KEY,body TEXT,digest TEXT)",
  );
  const first = JSON.stringify({ oid: "abc", part: 0, kind: "blob", data: "Zmlyc3Q=" });
  const second = JSON.stringify({ oid: "def", part: 0, kind: "blob", data: "c2Vjb25k" });
  db.prepare("INSERT INTO objects VALUES('abc',0,'blob',?)").run(first);
  db.prepare("INSERT INTO objects VALUES('def',0,'blob',?)").run(second);
  await writeFile(join(root, "objects.jsonl"), first + "\n" + second + "\n");
  const catalog = new Catalog([source], state);
  let key = (await catalog.page("fixture", "objects", { offset: 1 })).rows[0].key;
  assert.equal((await catalog.record("fixture", "objects", key)).jsonl.status, "match");
  const bounded = new Catalog([source], state, { mirrorLines: 1 });
  assert.equal((await bounded.record("fixture", "objects", key)).jsonl.status, "limited");
  const entry = '{"path":"file.txt","kind":"file","bytes":12}';
  db.prepare("INSERT INTO entries VALUES('file.txt',?,?)").run(entry, digest(entry));
  await writeFile(join(root, "inventory.jsonl"), entry + "\n");
  key = (await catalog.page("fixture", "entries", {})).rows[0].key;
  assert.deepEqual((await catalog.record("fixture", "entries", key)).jsonl.value, {
    path: "file.txt",
    kind: "file",
    bytes: 12,
  });
});

test("content mirror metadata verifies its actual artifact digest and identity", async (t) => {
  const { db, root, catalog } = await fixture(t, "personal");
  db.exec(
    "CREATE TABLE content_sources(source TEXT PRIMARY KEY,hash TEXT,jsonl TEXT,jsonlHash TEXT)",
  );
  const content =
    JSON.stringify({
      kind: "content",
      source: "original",
      hash: "abc",
      bytes: 0,
      parts: 0,
      encoding: "base64",
    }) + "\n";
  await writeFile(join(root, "content.jsonl"), content);
  db.prepare("INSERT INTO content_sources VALUES('original','abc','content.jsonl',?)").run(
    digest(content),
  );
  const key = (await catalog.page("fixture", "content_sources", {})).rows[0].key;
  assert.equal((await catalog.record("fixture", "content_sources", key)).jsonl.status, "match");
  await writeFile(join(root, "content.jsonl"), content.replace("original", "other"));
  assert.equal((await catalog.record("fixture", "content_sources", key)).jsonl.status, "mismatch");
});

test("missing sources stay visible without creating databases or source directories", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "catalog-missing-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "absent");
  const catalog = new Catalog(
    [{ id: "missing", name: "Missing", kind: "sqlite", root, database: "missing.sqlite" }],
    join(base, "state"),
  );
  const value = (await catalog.sources())[0];
  assert.equal(value.alive, null);
  assert.equal(value.updatedAt, null);
  assert.ok(value.errors.length);
  await assert.rejects(stat(root), { code: "ENOENT" });
  await assert.rejects(catalog.tables("missing"), /unavailable|missing|ENOENT/i);
  assert.throws(
    () => new Catalog([{ id: "bad", name: "Bad", kind: "sqlite", root }], join(root, "operator")),
    /overlap/i,
  );
});

test("source database escapes are refused and stale key tokens cannot select a new live root", async (t) => {
  const { root, state, source, base, catalog, db } = await fixture(t);
  db.exec("CREATE TABLE plain(label TEXT); INSERT INTO plain VALUES('first')");
  const page = await catalog.page("fixture", "plain", {});
  const key = page.rows[0].key;
  assert.equal((await catalog.record("fixture", "plain", key)).sqlite.label, "first");
  const escaped = new Catalog([{ ...source, database: join(base, "outside.sqlite") }], state);
  await assert.rejects(escaped.tables("fixture"), /escape|outside/i);
  const other = join(base, "other");
  await mkdir(other);
  const alternate = new DatabaseSync(join(other, "alternate.sqlite"));
  alternate.exec("CREATE TABLE plain(label TEXT); INSERT INTO plain VALUES('second')");
  alternate.close();
  const switched = new Catalog([{ ...source, root: other, database: "alternate.sqlite" }], state);
  await assert.rejects(switched.record("fixture", "plain", key), /key/i);
  assert.equal(root, source.root);
});

test("dataset capture streams every full row beyond preview and page bounds with binary values intact", async (t) => {
  const { db, source, state } = await fixture(t, "sqlite");
  db.exec("CREATE TABLE documents(id INTEGER PRIMARY KEY,body TEXT,data BLOB,large INTEGER)");
  const insert = db.prepare("INSERT INTO documents VALUES(?,?,?,?)");
  for (let id = 1; id <= 125; id++)
    insert.run(id, "x".repeat(4096), Buffer.from([0, 255, id]), 9223372036854775807n);
  const catalog = new Catalog([source], state, { previewBytes: 256 });
  const first = (await catalog.page("fixture", "documents", { limit: 1 })).rows[0];
  assert.equal(first.truncated, true);
  let count = 0;
  for await (const record of catalog.records("fixture", "documents")) {
    count++;
    assert.equal(record.sqlite.body, "x".repeat(4096));
    assert.deepEqual(record.sqlite.data, {
      encoding: "base64",
      bytes: 3,
      base64: Buffer.from([0, 255, count]).toString("base64"),
    });
    assert.equal(record.sqlite.large, "9223372036854775807");
    if (count === 1) assert.equal(record.key, first.key);
  }
  assert.equal(count, 125);
  const iterator = catalog.records("fixture", "documents");
  await iterator.next();
  await iterator.return(undefined);
  db.prepare("UPDATE documents SET body='after close' WHERE id=1").run();
  assert.equal(
    (await catalog.page("fixture", "documents", { limit: 1 })).rows[0].value.body,
    "after close",
  );
});

test("pointer roots cannot overlap operator state directly or through a directory alias", async (t) => {
  const { source, state, base } = await fixture(t);
  await mkdir(state);
  const pointer = join(base, "active.json");
  const catalog = new Catalog([{ ...source, pointer }], state);
  await writeFile(pointer, JSON.stringify({ root: state }));
  await assert.rejects(catalog.tables("fixture"), /overlap/i);
  const alias = join(base, "alias");
  await symlink(state, alias);
  await writeFile(pointer, JSON.stringify({ root: alias }));
  await assert.rejects(catalog.tables("fixture"), /overlap/i);
});

test("receipt integrity includes stored response and task identity, not only its digest", async (t) => {
  const { db, root, catalog } = await fixture(t);
  const line = accept(db, "one", { ok: true });
  await writeFile(join(root, "staging", "one.jsonl"), line);
  const key = (await catalog.page("fixture", "receipts", {})).rows[0].key;
  const inconsistent = JSON.stringify({
    task: { id: "other" },
    response: { ok: true },
    children: [],
    error: null,
  });
  db.prepare("UPDATE receipts SET receipt=?,digest=? WHERE id='one'").run(
    inconsistent,
    digest(inconsistent),
  );
  const view = await catalog.record("fixture", "receipts", key);
  assert.equal(view.digest.valid, false);
  assert.equal(view.jsonl.status, "mismatch");
});

test("nullable SQLite primary keys still address each physical record uniquely", async (t) => {
  const { db, catalog } = await fixture(t, "sqlite");
  db.exec(
    "CREATE TABLE nullable(id TEXT PRIMARY KEY,value TEXT); INSERT INTO nullable VALUES(NULL,'first'),(NULL,'second')",
  );
  const page = await catalog.page("fixture", "nullable", {});
  assert.notEqual(page.rows[0].key, page.rows[1].key);
  assert.equal(
    (await catalog.record("fixture", "nullable", page.rows[1].key)).sqlite.value,
    "second",
  );
});

test("mirror digests use actual bytes and reject incomplete JSONL framing", async (t) => {
  const { db, root, catalog } = await fixture(t);
  const line = accept(db, "one", { ok: true });
  await writeFile(join(root, "staging", "one.jsonl"), line.trimEnd());
  const key = (await catalog.page("fixture", "receipts", {})).rows[0].key;
  const view = await catalog.record("fixture", "receipts", key);
  assert.equal(view.jsonl.status, "mismatch");
  assert.equal(view.digest.jsonl, digest(line.trimEnd()));
});

test("corrupt SQLite mirror payload types retain the verification byte bound", async (t) => {
  const { db, root, source, state } = await fixture(t);
  accept(db, "one", {});
  db.prepare("UPDATE receipts SET response=? WHERE id='one'").run(Buffer.alloc(8192, 1));
  await writeFile(join(root, "staging", "one.jsonl"), "{}\n");
  const catalog = new Catalog([source], state, { mirrorBytes: 1024 });
  const key = (await catalog.page("fixture", "receipts", {})).rows[0].key;
  assert.equal((await catalog.record("fixture", "receipts", key)).jsonl.status, "limited");
});

test("unfamiliar checkpoint fields retain typed values, provenance and qualified meanings", async (t) => {
  const { root, catalog } = await fixture(t);
  await writeFile(
    join(root, "progress.json"),
    JSON.stringify({
      updated: new Date().toISOString(),
      downloaded: 17,
      complete: false,
      states: { preserved: 9 },
      diagnostic: "synthetic content excluded from metrics",
    }),
  );
  const metrics = (await catalog.sources())[0].metrics;
  assert.equal(metrics.find((metric) => metric.id === "checkpoint.downloaded")?.value, 17);
  assert.equal(metrics.find((metric) => metric.id === "checkpoint.complete")?.value, false);
  const nested = metrics.find((metric) => metric.id === "checkpoint.states.preserved")!;
  assert.equal(nested.value, 9);
  assert.equal(nested.origin.field, "states.preserved");
  assert.match(nested.meaning, /checkpoint/i);
  assert.equal(
    metrics.some((metric) => metric.id === "checkpoint.diagnostic"),
    false,
  );
});

test("special SQLite column names remain own data fields without changing preview prototypes", async (t) => {
  const { db, catalog } = await fixture(t, "sqlite");
  db.exec(
    'CREATE TABLE special(id INTEGER PRIMARY KEY,"__proto__" BLOB,"constructor" TEXT,"toString" TEXT)',
  );
  db.prepare("INSERT INTO special VALUES(1,?,'constructor value','string value')").run(
    Buffer.from([0, 255]),
  );
  const page = await catalog.page("fixture", "special", {});
  const value = page.rows[0].value;
  assert.equal(Object.hasOwn(value, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(value), null);
  assert.deepEqual(value.__proto__, { encoding: "base64", bytes: 2, base64: "AP8=" });
  assert.equal(value.constructor, "constructor value");
  const view = await catalog.record("fixture", "special", page.rows[0].key);
  assert.equal(Object.hasOwn(view.sqlite, "__proto__"), true);
  assert.equal(JSON.parse(JSON.stringify(view.sqlite)).__proto__.base64, "AP8=");
});

test("record comparison preserves one SQLite snapshot and rejects a match after live commits", async (t) => {
  const { db, catalog, root } = await fixture(t);
  const initial = accept(db, "one", { value: "before" });
  const prior = db.prepare("SELECT receipt,digest FROM receipts WHERE id='one'").get()!;
  const file = join(root, "staging", "one.jsonl");
  await writeFile(file, initial);
  const key = (await catalog.page("fixture", "receipts", {})).rows[0].key;
  const prepare = DatabaseSync.prototype.prepare;
  let committed = false;
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql);
    if (sql.includes(' FROM "receipts" WHERE ')) {
      const get = statement.get;
      statement.get = function (...args: unknown[]) {
        const row = Reflect.apply(get, this, args);
        if (!committed) {
          committed = true;
          const response = { value: "after" },
            body = JSON.stringify(response);
          const receipt = JSON.stringify({
            task: { id: "one" },
            response,
            children: [],
            error: null,
          });
          db.prepare("UPDATE receipts SET response=?,receipt=?,digest=? WHERE id='one'").run(
            body,
            receipt,
            digest(receipt),
          );
          writeFileSync(file, body + "\n");
        }
        return row;
      };
    }
    return statement;
  });
  const view = await catalog.record("fixture", "receipts", key);
  assert.equal(committed, true);
  assert.equal(view.sqlite.response, '{"value":"before"}');
  assert.equal(view.digest.expected, prior.digest);
  assert.equal(view.jsonl.status, "limited");
  assert.match(view.jsonl.reason!, /SQLite.*chang|database.*chang/i);
  assert.equal(view.truncated, true);
});
