import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, appendFile, mkdir, symlink, stat, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Dataset, validateSteps, type Step } from "../dataset.ts";

const item = (id: string, body: unknown, source = "fixture") => ({
  id,
  source,
  key: "human:" + id,
  body,
});
async function fixture(t: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(join(tmpdir(), "dataset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const shape = {
  type: "object",
  properties: { name: { type: "string", minLength: 1 }, score: { type: "integer", minimum: 0 } },
  required: ["name", "score"],
  additionalProperties: false,
};

test('an explicitly keyed dataset operation recovers one run and refuses changed rules',async t=>{
 const data=new Dataset(await fixture(t));t.after(()=>data.close());
 const revision=await data.capture('Input',[item('one',{text:'hello'})]),id='12345678-1234-4123-8123-123456789abc';
 const rules:Step[]=[{op:'set',path:'$.reviewed',value:true}];
 const first=data.start(revision.id,rules,{id}),again=data.start(revision.id,rules,{id});assert.equal(first.id,again.id);
 await data.execute(first.id);assert.equal(data.start(revision.id,rules,{id}).state,'completed');
 assert.throws(()=>data.start(revision.id,[],{id}),/different|identity|parameters/);
 assert.equal(data.runs().length,1);
});

test('audit review pages failures and outcomes without loading the entire run',async t=>{
 const data=new Dataset(await fixture(t));t.after(()=>data.close());
 const revision=await data.capture('Audit',Array.from({length:7},(_,i)=>item(String(i),{value:i})));
 const run=await data.run(revision.id,[{op:'check',path:'$.required',required:true,onFailure:'quarantine'}],{pauseOnFailure:false});
 const page=data.review(run.id,'outcomes',{offset:2,limit:3});assert.equal(page.total,7);assert.equal(page.more,true);assert.equal(page.records.length,3);assert.equal(page.records[0].recordId,'2');
 assert.equal(data.review(run.id,'failures',{offset:6,limit:3}).records.length,1);
 assert.throws(()=>data.review(run.id,'outcomes',{limit:1001}),/bound/);
});

test("capture preserves complete original data, identities, searchable annotations and typed links across restart", async (t) => {
  const root = await fixture(t);
  let data = new Dataset(root);
  const body = { text: "alpha ".repeat(40_000), nested: { value: 7 } };
  const revision = await data.capture("Selected", [
    item("source/table/a", body),
    item("source/table/b", { text: "beta" }, "other"),
  ]);
  data.annotate("source/table/a", {
    tags: ["review"],
    keywords: ["needle"],
    summary: "Selected record",
    category: "guide",
    rating: 4,
  });
  data.link("source/table/a", "source/table/b", "supports");
  assert.throws(() => data.link("missing", "source/table/b", "supports"), /unknown record/);
  data.close();
  data = new Dataset(root);
  t.after(() => data.close());
  const page = data.page(revision.id, {
    query: "selected",
    source: "fixture",
    tag: "review",
    keyword: "needle",
    category: "guide",
    rating: 4,
  });
  assert.equal(page.total, 1);
  assert.equal(page.records[0].key, "human:source/table/a");
  assert.deepEqual(page.records[0].body, body);
  assert.deepEqual(page.records[0].original, body);
  assert.deepEqual(data.links("source/table/b"), [
    { from: "source/table/a", to: "source/table/b", kind: "supports" },
  ]);
  assert.equal((await readFile(revision.path, "utf8")).split("\n").filter(Boolean).length, 2);
  assert.deepEqual(await data.verify(revision.id), {
    records: 2,
    bytes: revision.bytes,
    hash: revision.hash,
    intact: true,
  });
  assert.throws(() => data.page(revision.id, { limit: 0 }), /bounds/);
  assert.throws(() => data.annotate("source/table/a", { rating: 6 }), /rating/);
  await assert.rejects(
    data.capture("collision", [item("source/table/a", {}, "wrong")]),
    /identity/,
  );
});

test("JSON stages retain every disposition and create an immutable child with edited content", async (t) => {
  const data = new Dataset(await fixture(t));
  t.after(() => data.close());
  const revision = await data.capture("Raw", [
    item("a", { name: "same", keep: true, secret: "x" }),
    item("b", { name: "same", keep: true, secret: "y" }),
    item("c", { name: "drop", keep: false, secret: "z" }),
    item("d", { name: "blocked", keep: true, secret: "z" }),
  ]);
  const steps: Step[] = [
    { op: "include", path: "$.keep", equals: true },
    { op: "exclude", path: "/name", equals: "blocked" },
    { op: "dedupe", paths: ["$.name"] },
    { op: "remove", path: "/secret" },
    { op: "set", path: "$.nested.score", value: 3 },
  ];
  const run = await data.run(revision.id, JSON.parse(JSON.stringify(steps)));
  assert.equal(run.state, "completed");
  assert.deepEqual(run.report, {
    processed: 4,
    accepted: 1,
    excluded: 2,
    duplicate: 1,
    quarantined: 0,
    failed: 0,
    corrected: 0,
  });
  const output = data.page(run.revision!).records;
  assert.deepEqual(
    output.map((r) => [r.id, r.body]),
    [["a", { name: "same", keep: true, nested: { score: 3 } }]],
  );
  assert.equal((data.page(revision.id).records[0].body as any).secret, "x");
  assert.equal((output[0].original as any).secret, "x");
  assert.deepEqual(
    data.outcomes(run.id).map((r) => r.state),
    ["accepted", "duplicate", "excluded", "excluded"],
  );
  const edited = await data.edit(run.revision!, "a", { changed: true });
  assert.deepEqual(data.page(edited.id).records[0].body, { changed: true });
  assert.deepEqual(data.page(run.revision!).records[0].body, {
    name: "same",
    keep: true,
    nested: { score: 3 },
  });
});

test("pause, restart, correction and resume match a fresh corrected run without replay or duplication", async (t) => {
  const root = await fixture(t);
  let data = new Dataset(root);
  const raw = await data.capture("Raw", [
    item("a", { name: "first", score: 1 }),
    item("b", { name: "broken", score: -1 }),
    item("c", { name: "third", score: 3 }),
  ]);
  const steps: Step[] = [
    { op: "set", path: "$.score", value: 2 },
    { op: "remove", path: "$.score" },
    { op: "validate", schema: shape },
  ];
  // A failure after mutations is corrected at the original input, then all stages run again.
  const validation: Step[] = [
    { op: "validate", schema: shape },
    { op: "dedupe", paths: ["/name"] },
  ];
  const paused = await data.run(raw.id, validation);
  assert.equal(paused.state, "paused");
  assert.equal(paused.cursor, 1);
  assert.equal(paused.report.accepted, 1);
  assert.deepEqual(
    data.failures(paused.id).map((f) => [f.recordId, f.step, f.state]),
    [["b", 0, "open"]],
  );
  data.close();
  data = new Dataset(root);
  t.after(() => data.close());
  await assert.rejects(data.resume(paused.id), /correct|unresolved/);
  data.correct(paused.id, "b", { name: "fixed", score: 2 });
  const resumed = await data.resume(paused.id);
  assert.equal(resumed.state, "completed");
  assert.equal(resumed.cursor, 3);
  assert.equal(resumed.report.accepted, 3);
  assert.equal(resumed.report.corrected, 1);
  assert.equal(data.failures(paused.id)[0].state, "resolved");
  assert.equal((data.page(raw.id).records[1].body as any).score, -1);
  const fresh = await data.capture("Fixed inputs", [
    item("a", { name: "first", score: 1 }),
    item("b", { name: "fixed", score: 2 }),
    item("c", { name: "third", score: 3 }),
  ]);
  const clean = await data.run(fresh.id, validation);
  assert.equal(data.revision(clean.revision!).hash, data.revision(resumed.revision!).hash);
  assert.deepEqual(
    data.page(resumed.revision!).records.map((r) => r.id),
    ["a", "b", "c"],
  );
  assert.equal(data.outcomes(paused.id).length, 3);
  assert.equal((await data.run(raw.id, steps, { pauseOnFailure: false })).report.failed, 3);
  assert.equal((await data.verify(resumed.revision!)).intact, true);
});

test("quarantine continues and retains rejected bodies with diagnostics", async (t) => {
  const data = new Dataset(await fixture(t));
  t.after(() => data.close());
  const raw = await data.capture("Raw", [
    item("a", { name: "ok", score: 1 }),
    item("b", { name: "bad", score: -1 }),
  ]);
  const run = await data.run(raw.id, [{ op: "validate", schema: shape, onFailure: "quarantine" }], {
    pauseOnFailure: false,
  });
  assert.equal(run.report.quarantined, 1);
  assert.equal(data.page(run.revision!).total, 1);
  assert.deepEqual(data.failures(run.id)[0].body, { name: "bad", score: -1 });
  assert.equal(data.failures(run.id)[0].state, "quarantined");
  assert.match(data.failures(run.id)[0].reason, /score.*minimum 0/);
  assert.equal(data.outcomes(run.id)[1].state, "quarantined");
});

test("unsafe paths, invalid JSON and duplicate captures fail before any publication", async (t) => {
  const data = new Dataset(await fixture(t));
  t.after(() => data.close());
  await assert.rejects(data.capture("Bad", [item("a", { value: undefined })]), /JSON/);
  await assert.rejects(data.capture("Bad", [item("a", {}), item("a", {})]), /duplicate/);
  assert.equal(data.revisions().length, 0);
  const raw = await data.capture("Raw", [item("a", {})]);
  await assert.rejects(
    data.run(raw.id, [{ op: "set", path: "$.__proto__.polluted", value: true }]),
    /unsafe/,
  );
  assert.equal(data.runs().length, 0);
});

test("integrity checks detect damaged JSONL and SQLite content", async (t) => {
  const root = await fixture(t);
  const data = new Dataset(root);
  t.after(() => data.close());
  const raw = await data.capture("Raw", [item("a", { safe: true })]);
  await appendFile(raw.path, "{}\n");
  await assert.rejects(data.verify(raw.id), /integrity/);
  const db = new DatabaseSync(join(root, "dataset.sqlite"));
  db.prepare("UPDATE revision_items SET body=? WHERE revision=?").run('{"safe":false}', raw.id);
  db.close();
  assert.throws(() => data.page(raw.id), /integrity/);
});

test("streamed imports publish all records atomically and retain no partial revision on iterator failure", async (t) => {
  const data = new Dataset(await fixture(t));
  t.after(() => data.close());
  async function* records() {
    for (let i = 0; i < 120; i++) yield item("stream/" + i, { n: i, text: "complete " + i });
  }
  const revision = await data.capture("Stream", records());
  assert.equal(revision.count, 120);
  assert.equal(data.page(revision.id, { offset: 100, limit: 100 }).records.length, 20);
  assert.equal((await data.verify(revision.id)).records, 120);
  async function* broken() {
    yield item("partial", { keep: true });
    throw Error("synthetic input interruption");
  }
  await assert.rejects(data.capture("Broken stream", broken()), /input interruption/);
  assert.equal(data.revisions().length, 1);
  assert.throws(() => data.annotate("partial", { tags: ["lost"] }), /unknown record/);
});

test("a manual pause checkpoints between records and an unclaimed paused worker cannot start", async (t) => {
  const root = await fixture(t);
  let data = new Dataset(root);
  const revision = await data.capture("Pause", [item("a", {}), item("b", {}), item("c", {})]);
  const queued = data.start(revision.id, []);
  data.pause(queued.id);
  assert.equal((await data.execute(queued.id)).cursor, 0);
  const execution = data.resume(queued.id);
  data.pause(queued.id);
  const paused = await execution;
  assert.equal(paused.state, "paused");
  assert.equal(paused.cursor, 1);
  assert.equal(paused.report.accepted, 1);
  assert.equal(paused.revision, undefined);
  data.close();
  data = new Dataset(root);
  t.after(() => data.close());
  const done = await data.resume(queued.id);
  assert.equal(done.report.accepted, 3);
  assert.deepEqual(
    data.page(done.revision!).records.map((r) => r.id),
    ["a", "b", "c"],
  );
});

test("setting an array JSON path can append nested objects without holes", async (t) => {
  const data = new Dataset(await fixture(t));
  t.after(() => data.close());
  const revision = await data.capture("Array", [item("a", {})]);
  const run = await data.run(revision.id, [
    { op: "set", path: "$.items[0].name", value: "first" },
    { op: "set", path: "/items/1", value: { name: "second" } },
    { op: "remove", path: "$.items[0]" },
  ]);
  assert.equal(run.state, "completed");
  assert.deepEqual(data.page(run.revision!).records[0].body, { items: [{ name: "second" }] });
});

test(
  "a killed detached worker resumes its committed prefix with identical complete output",
  { timeout: 20_000 },
  async (t) => {
    const root = await fixture(t);
    let data = new Dataset(root);
    function* records() {
      for (let i = 0; i < 1000; i++) yield item("worker/" + i, { n: i });
    }
    const revision = await data.capture("Worker", records());
    const run = data.start(revision.id, [{ op: "set", path: "$.ready", value: true }]);
    data.close();
    const module = new URL("../dataset.ts", import.meta.url).href;
    const code = `import {Dataset} from ${JSON.stringify(module)}; const data=new Dataset(${JSON.stringify(root)}); const work=data.execute(${JSON.stringify(run.id)}); process.stdout.write(${JSON.stringify("checkpoint")}); await work; data.close();`;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", code], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let error = "";
    child.stderr.on("data", (chunk) => {
      error += String(chunk);
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    const exit = once(child, "exit");
    const [message] = await Promise.race([
      once(child.stdout, "data"),
      exit.then(() => {
        throw Error("worker exited before checkpoint: " + error);
      }),
    ]);
    assert.match(String(message), /checkpoint/);
    child.kill("SIGKILL");
    await exit;
    assert.equal(error, "");
    data = new Dataset(root);
    t.after(() => data.close());
    const interrupted = data.runs().find((r) => r.id === run.id)!;
    assert.ok(interrupted.cursor > 0 && interrupted.cursor < 1000);
    const prefix = data.outcomes(run.id);
    const audit = new DatabaseSync(join(root, "dataset.sqlite"));
    audit.exec(
      "CREATE TABLE replay(n INTEGER); CREATE TRIGGER replay_update AFTER UPDATE ON run_items BEGIN INSERT INTO replay VALUES(old.n); END;",
    );
    const done = await data.resume(run.id);
    assert.equal(done.state, "completed");
    assert.equal(done.report.accepted, 1000);
    assert.deepEqual(data.outcomes(run.id).slice(0, prefix.length), prefix);
    assert.equal(audit.prepare("SELECT count(*) n FROM replay").get()!.n, 0);
    audit.close();
    assert.equal((await data.verify(done.revision!)).records, 1000);
    const clean = await data.run(revision.id, run.steps);
    assert.equal(data.revision(done.revision!).hash, data.revision(clean.revision!).hash);
  },
);

test("stable IDs keep equal human keys in separate source tables distinct", async (t) => {
  const data = new Dataset(await fixture(t));
  t.after(() => data.close());
  const revision = await data.capture("Tables", [
    { id: "source/people/42", source: "source", key: "42", body: { name: "person" } },
    { id: "source/posts/42", source: "source", key: "42", body: { name: "post" } },
  ]);
  assert.deepEqual(
    data.page(revision.id).records.map((r) => [r.id, r.key]),
    [
      ["source/people/42", "42"],
      ["source/posts/42", "42"],
    ],
  );
});

test("field checks accept unrelated fields and resume corrected required values", async (t) => {
  const data = new Dataset(await fixture(t));
  t.after(() => data.close());
  const revision = await data.capture("Fields", [
    item("a", { id: "good", extra: true }),
    item("b", { extra: true }),
    item("c", { id: "next", extra: true }),
  ]);
  const run = await data.run(revision.id, [
    { op: "check", path: "$.id", required: true, type: "string", minLength: 3 },
  ]);
  assert.equal(run.state, "paused");
  assert.equal(run.cursor, 1);
  assert.equal(data.failures(run.id)[0].recordId, "b");
  assert.match(data.failures(run.id)[0].reason, /id.*required/);
  data.correct(run.id, "b", { id: "fixed", extra: true });
  const done = await data.resume(run.id);
  assert.equal(done.report.accepted, 3);
  assert.deepEqual(data.page(done.revision!).records[1].body, { id: "fixed", extra: true });
});

test("field checks quarantine short values and distinguish optional missing fields", async (t) => {
  const data = new Dataset(await fixture(t));
  t.after(() => data.close());
  const revision = await data.capture("Fields", [
    item("a", { value: "é🙂" }),
    item("b", { value: "x" }),
    item("c", {}),
  ]);
  const run = await data.run(
    revision.id,
    [{ op: "check", path: "/value", type: "string", minLength: 2, onFailure: "quarantine" }],
    { pauseOnFailure: false },
  );
  assert.equal(run.report.accepted, 2);
  assert.equal(run.report.quarantined, 1);
  assert.equal(data.failures(run.id)[0].recordId, "b");
  assert.match(data.failures(run.id)[0].reason, /minLength 2/);
  const bad = await data.capture("Type", [item("d", { value: 12 })]);
  const checked = await data.run(bad.id, [{ op: "check", path: "/value", type: "string" }]);
  assert.equal(checked.state, "paused");
  assert.match(data.failures(checked.id)[0].reason, /string/);
});

test("saved stages reject malformed field checks before any run starts", () => {
  const invalid: unknown[] = [
    [{ op: "check", path: "$.id", type: ["string"] }],
    [{ op: "check", path: "$.id", required: "true" }],
    [{ op: "check", path: "$.id", minLength: -1 }],
    [{ op: "check", path: "$.id", type: "number", minLength: 1 }],
    [{ op: "check", path: "$.id", pattern: ".*" }],
    [{ op: "check", path: "$.id", onFailure: ["quarantine"] }],
    [{ op: "check", path: "$.__proto__.id" }],
    [{ op: "unknown" }],
  ];
  for (const steps of invalid) assert.throws(() => validateSteps(steps));
  const input = [{ op: "check", path: "$.id", required: true }];
  const output = validateSteps(input);
  input[0].path = "$.changed";
  assert.equal((output[0] as any).path, "$.id");
});

test("an object field check rejects null", async (t) => {
  const data = new Dataset(await fixture(t));
  t.after(() => data.close());
  const revision = await data.capture("Null", [item("a", { value: null })]);
  const run = await data.run(revision.id, [{ op: "check", path: "/value", type: "object" }]);
  assert.equal(run.state, "paused");
  assert.match(data.failures(run.id)[0].reason, /object/);
});

test("stable imports reuse a saved prefix and reject changed or truncated replay inputs", async (t) => {
  const root = await fixture(t),
    id = "a3333333-3333-4333-8333-333333333333";
  let data = new Dataset(root);
  async function* interrupted() {
    yield item("a", { n: 1 });
    yield item("b", { n: 2 });
    throw Error("interrupted import");
  }
  await assert.rejects(data.capture("Resume", interrupted(), { id }), /interrupted import/);
  data.close();
  data = new Dataset(root);
  t.after(() => data.close());
  await assert.rejects(
    data.capture("Resume", [item("a", { n: 99 }), item("b", { n: 2 })], { id }),
    /prefix|replay/,
  );
  await assert.rejects(data.capture("Resume", [item("a", { n: 1 })], { id }), /prefix|replay/);
  const audit = new DatabaseSync(join(root, "dataset.sqlite"));
  t.after(() => audit.close());
  audit.exec(
    "CREATE TABLE draft_replay(n INTEGER); CREATE TRIGGER draft_insert AFTER INSERT ON draft_items BEGIN INSERT INTO draft_replay VALUES(new.n); END; CREATE TRIGGER draft_update AFTER UPDATE ON draft_items BEGIN INSERT INTO draft_replay VALUES(old.n); END;",
  );
  const records = [item("a", { n: 1 }), item("b", { n: 2 }), item("c", { n: 3 })];
  const revision = await data.capture("Resume", records, { id });
  assert.equal(revision.id, "rev-" + id);
  assert.deepEqual(
    audit
      .prepare("SELECT n FROM draft_replay")
      .all()
      .map((r) => r.n),
    [2],
  );
  const repeated = await data.capture("Resume", records, { id });
  assert.deepEqual(repeated, revision);
  assert.equal(data.revisions().length, 1);
  await assert.rejects(
    data.capture("Resume", [item("a", { n: 99 }), item("b", { n: 2 }), item("c", { n: 3 })], {
      id,
    }),
    /prefix|replay/,
  );
  assert.equal((await data.verify(revision.id)).records, 3);
});

test("a stable import recovers publication after the mirror was written but the revision commit failed", async (t) => {
  const root = await fixture(t),
    id = "b3333333-3333-4333-8333-333333333333";
  let data = new Dataset(root);
  const db = new DatabaseSync(join(root, "dataset.sqlite"));
  db.exec(
    "CREATE TRIGGER block_publication BEFORE INSERT ON revisions BEGIN SELECT RAISE(ABORT,'synthetic publication interruption'); END;",
  );
  const records = [item("a", { complete: true }), item("b", { complete: true })];
  await assert.rejects(data.capture("Publish", records, { id }), /publication interruption/);
  assert.ok(
    (await readFile(join(root, "revisions", "rev-" + id + ".jsonl"), "utf8")).includes("complete"),
  );
  assert.equal(data.revisions().length, 0);
  db.exec("DROP TRIGGER block_publication");
  db.close();
  data.close();
  data = new Dataset(root);
  t.after(() => data.close());
  const revision = await data.capture("Publish", records, { id });
  assert.equal(revision.id, "rev-" + id);
  assert.equal((await data.verify(revision.id)).records, 2);
  assert.deepEqual(await data.capture("Publish", records, { id }), revision);
});

test(
  "a killed import resumes its durable prefix without rewriting or duplicating records",
  { timeout: 20_000 },
  async (t) => {
    const root = await fixture(t),
      id = "c3333333-3333-4333-8333-333333333333";
    const module = new URL("../dataset.ts", import.meta.url).href;
    const code = `import {Dataset} from ${JSON.stringify(module)}; const data=new Dataset(${JSON.stringify(root)}); async function* records(){for(let i=0;i<40;i++)yield {id:'import/'+i,source:'fixture',key:'human:'+i,body:{n:i}};process.stdout.write('checkpoint');await new Promise(()=>{setInterval(()=>{},1000)});}await data.capture('Killed import',records(),{id:${JSON.stringify(id)}});`;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", code], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let error = "";
    child.stderr.on("data", (chunk) => {
      error += String(chunk);
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    const exit = once(child, "exit");
    await Promise.race([
      once(child.stdout, "data"),
      exit.then(() => {
        throw Error("import exited before checkpoint: " + error);
      }),
    ]);
    child.kill("SIGKILL");
    await exit;
    assert.equal(error, "");
    const data = new Dataset(root);
    t.after(() => data.close());
    const audit = new DatabaseSync(join(root, "dataset.sqlite"));
    t.after(() => audit.close());
    assert.equal(audit.prepare("SELECT count(*) n FROM draft_items").get()!.n, 40);
    audit.exec(
      "CREATE TABLE import_insert(n INTEGER); CREATE TRIGGER import_insert AFTER INSERT ON draft_items BEGIN INSERT INTO import_insert VALUES(new.n); END;",
    );
    function* records() {
      for (let i = 0; i < 100; i++)
        yield { id: "import/" + i, source: "fixture", key: "human:" + i, body: { n: i } };
    }
    const revision = await data.capture("Killed import", records(), { id });
    assert.equal(revision.id, "rev-" + id);
    assert.equal((await data.verify(revision.id)).records, 100);
    assert.equal(
      audit.prepare("SELECT min(n) first,count(*) n FROM import_insert").get()!.first,
      40,
    );
    assert.equal(audit.prepare("SELECT count(*) n FROM import_insert").get()!.n, 60);
  },
);

test("storage aliases are rejected before creating tables or changing source permissions", async (t) => {
  const root = await fixture(t),
    source = join(root, "source");
  await mkdir(source);
  const target = join(source, "data.sqlite"),
    original = new DatabaseSync(target);
  original.exec(
    "CREATE TABLE source_marker(value TEXT); INSERT INTO source_marker VALUES('original')",
  );
  original.close();
  const before = (await stat(target)).mode;
  await symlink(source, join(root, "alias"));
  assert.throws(() => new Dataset(join(root, "alias")), /symbolic|alias/);
  assert.throws(() => new Dataset(join(root, "alias", "new-child")), /symbolic|alias/);
  await assert.rejects(lstat(join(source, "new-child")), /ENOENT/);
  const operator = join(root, "operator");
  await mkdir(operator);
  await symlink(target, join(operator, "dataset.sqlite"));
  assert.throws(() => new Dataset(operator), /symbolic|alias/);
  assert.equal((await stat(target)).mode, before);
  const verified = new DatabaseSync(target, { readOnly: true });
  assert.deepEqual(
    verified
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name),
    ["source_marker"],
  );
  verified.close();
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const folder = join(root, "sidecar" + suffix);
    await mkdir(folder);
    await symlink(target, join(folder, "dataset.sqlite" + suffix));
    assert.throws(() => new Dataset(folder), /symbolic|alias/);
    await assert.rejects(lstat(join(folder, "dataset.sqlite")), /ENOENT/);
  }
  const revisionRoot = join(root, "revision-alias");
  await mkdir(revisionRoot);
  await symlink(source, join(revisionRoot, "revisions"));
  assert.throws(() => new Dataset(revisionRoot), /symbolic|alias/);
  await assert.rejects(lstat(join(revisionRoot, "dataset.sqlite")), /ENOENT/);
});

test("a stale owner with an unrelated live reused PID does not block resume", async (t) => {
  const root = await fixture(t),
    data = new Dataset(root);
  t.after(() => data.close());
  const revision = await data.capture("Owner", [item("a", {})]),
    run = data.start(revision.id, []);
  const child = spawn(process.execPath, ["--eval", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  const db = new DatabaseSync(join(root, "dataset.sqlite"));
  db.prepare("UPDATE runs SET owner=? WHERE id=?").run(
    JSON.stringify({ pid: child.pid, token: "stale", proof: "unrelated-birth-and-command" }),
    run.id,
  );
  db.close();
  const done = await data.resume(run.id);
  assert.equal(done.state, "completed");
  assert.equal(done.report.accepted, 1);
  assert.equal(child.exitCode, null);
});
