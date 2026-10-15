import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  readdir,
  realpath,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { configure, command } from "../studio.ts";
import { randomUUID } from "node:crypto";
import { Dataset } from "../dataset.ts";
import { spawn } from "node:child_process";
import { once } from "node:events";

async function fixture(t: TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "studio-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const raw = join(base, "raw");
  await mkdir(raw);
  const db = new DatabaseSync(join(raw, "source.sqlite"));
  db.exec(
    "CREATE TABLE records(id TEXT PRIMARY KEY, value TEXT); INSERT INTO records VALUES('one','alpha'),('two','beta')",
  );
  db.close();
  const path = join(base, "studio.json");
  const config = {
    format: "studio/1",
    state: "operator",
    sources: [
      { id: "raw", name: "Synthetic", kind: "sqlite", root: raw, database: "source.sqlite" },
    ],
    providers: [],
  };
  await writeFile(path, JSON.stringify(config));
  return { base, raw, path, config };
}

test("bridge preserves source bytes while capturing, linking and running immutable validation stages", async (t) => {
  const f = await fixture(t),
    config = await configure(f.path),
    before = await readFile(join(f.raw, "source.sqlite"));
  const page = (await command(config, "page", { source: "raw", table: "records" })) as any;
  assert.equal(page.rows.length, 2);
  const revision = (await command(config, "capture", {
    source: "raw",
    table: "records",
    name: "Review",
    keys: page.rows.map((r: any) => r.key),
  })) as any;
  const data = (await command(config, "dataset-page", { revision: revision.id })) as any;
  const [a, b] = data.records;
  await command(config, "annotate", { id: a.id, values: { tags: ["review"], rating: 4 } });
  await command(config, "link", { from: a.id, to: b.id, kind: "supports" });
  assert.equal(((await command(config, "links", { id: b.id })) as any).links.length, 1);
  const saved = (await command(config, "flow-save", {
    name: "Approved",
    steps: [{ op: "set", path: "$.reviewed", value: true }],
  })) as any;
  assert.equal(((await command(config, "flows")) as any).flows[0].id, saved.id);
  const edited = (await command(config, "edit", {
    revision: revision.id,
    id: a.id,
    body: { reviewed: true },
  })) as any;
  assert.notEqual(edited.id, revision.id);
  assert.equal(((await command(config, "verify", { revision: edited.id })) as any).intact, true);
  const original = (await command(config, "dataset-page", { revision: revision.id })) as any;
  assert.equal(original.records[0].body.reviewed, undefined);
  assert.deepEqual(await readFile(join(f.raw, "source.sqlite")), before);
  assert.deepEqual((await readdir(f.raw)).sort(), ["source.sqlite"]);
});

test("configuration rejects state below pointer-selected source before making directories", async (t) => {
  const f = await fixture(t);
  const pointer = join(f.base, "pointer.json");
  await writeFile(pointer, JSON.stringify({ root: f.raw }));
  const registration = join(f.base, "registered");
  await mkdir(registration);
  f.config.sources[0].root = registration;
  Object.assign(f.config.sources[0], { pointer });
  f.config.state = join(f.raw, "new-state");
  await writeFile(f.path, JSON.stringify(f.config));
  await assert.rejects(configure(f.path), /disjoint|overlap/);
  assert.equal((await readdir(f.raw)).includes("new-state"), false);
});

test("detached local import and pause-correct-resume preserve source and complete mirrors", async (t) => {
  const f = await fixture(t),
    config = await configure(f.path),
    before = await readFile(join(f.raw, "source.sqlite"));
  const job = (await command(config, "import-table", {
    source: "raw",
    table: "records",
    name: "Full table",
  })) as any;
  async function until(check: () => Promise<any>) {
    for (let n = 0; n < 160; n++) {
      const value = await check();
      if (value) return value;
      await delay(50);
    }
    const logs = await readdir(join(config.state, "workers"));
    const diagnostic = await Promise.all(
      logs
        .filter((n) => n.endsWith(".log"))
        .map((n) => readFile(join(config.state, "workers", n), "utf8")),
    );
    assert.fail("synthetic background worker timed out: " + diagnostic.join("\n").slice(-3000));
  }
  const imported = await until(async () => {
    const jobs = ((await command(config, "imports")) as any).imports;
    return jobs.find((v: any) => v.id === job.id && v.state === "completed");
  });
  assert.equal(imported.processed, 2);
  assert.equal(
    ((await command(config, "verify", { revision: imported.revision })) as any).records,
    2,
  );
  const saved = await readFile(join(config.state, "workers", job.id + "-config.json"), "utf8");
  assert.equal(JSON.parse(saved).sources[0].pointer, undefined);
  const run = (await command(config, "flow-start", {
    revision: imported.revision,
    steps: [
      { op: "check", path: "$.approved", type: "boolean", required: true, onFailure: "quarantine" },
    ],
    pauseOnFailure: true,
  })) as any;
  await until(async () =>
    ((await command(config, "datasets")) as any).runs.find(
      (r: any) => r.id === run.id && r.state === "paused",
    ),
  );
  const failure = ((await command(config, "failures", { id: run.id })) as any).failures[0];
  await command(config, "correct", {
    id: run.id,
    record: failure.recordId,
    body: { approved: true },
  });
  await command(config, "flow-resume", { id: run.id });
  await until(async () =>
    ((await command(config, "datasets")) as any).runs.find(
      (r: any) => r.id === run.id && r.state === "paused" && r.cursor === 1,
    ),
  );
  const next = ((await command(config, "failures", { id: run.id })) as any).failures.find(
    (x: any) => x.recordId !== failure.recordId,
  );
  await command(config, "correct", { id: run.id, record: next.recordId, body: { approved: true } });
  await command(config, "flow-resume", { id: run.id });
  const completed = await until(async () =>
    ((await command(config, "datasets")) as any).runs.find(
      (r: any) => r.id === run.id && r.state === "completed",
    ),
  );
  assert.equal(
    ((await command(config, "verify", { revision: completed.revision })) as any).records,
    2,
  );
  assert.deepEqual(await readFile(join(f.raw, "source.sqlite")), before);
  assert.deepEqual((await readdir(f.raw)).sort(), ["source.sqlite"]);
});

test("managed directory aliases cannot write outside operator state", async (t) => {
  const f = await fixture(t),
    config = await configure(f.path);
  await symlink(f.raw, join(config.state, "flows"));
  await assert.rejects(
    command(config, "flow-save", { name: "Unsafe", steps: [] }),
    /alias|symlink|boundary/,
  );
  assert.deepEqual((await readdir(f.raw)).sort(), ["source.sqlite"]);
});

test("invalid worker identities and assistance packets fail closed", async (t) => {
  const f = await fixture(t),
    config = await configure(f.path);
  await assert.rejects(
    command(config, "flow-resume", { id: "../../raw/source.sqlite" }),
    /unknown|invalid/,
  );
  const help = (await command(config, "assist", {
    project: "Local pipeline",
    field: "collector.accepted",
    value: 2,
    definition: "Committed collector response count",
    provenance: "synthetic fixture",
  })) as any;
  assert.equal(help.suggestions.length, 3);
  assert.match(help.prompt, /Committed collector response/);
  assert.ok(help.prompt.length < 12289);
});

async function waitFor(check: () => Promise<any>) {
  for (let n = 0; n < 160; n++) {
    const value = await check();
    if (value) return value;
    await delay(50);
  }
  assert.fail("worker did not finish");
}

test("concurrent import resumes admit one worker and publish one revision", async (t) => {
  const f = await fixture(t),
    config = await configure(f.path),
    id = randomUUID();
  await mkdir(join(config.state, "imports"));
  await writeFile(
    join(config.state, "imports", id + ".json"),
    JSON.stringify({
      id,
      state: "failed",
      name: "Concurrent",
      source: "raw",
      table: "records",
      processed: 0,
      created: new Date().toISOString(),
    }),
  );
  const results = await Promise.allSettled([
    command(config, "import-resume", { id }),
    command(config, "import-resume", { id }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  const completed = await waitFor(async () =>
    ((await command(config, "imports")) as any).imports.find(
      (r: any) => r.id === id && r.state === "completed",
    ),
  );
  assert.equal(completed.processed, 2);
  assert.equal(
    ((await command(config, "verify", { revision: completed.revision })) as any).records,
    2,
  );
  assert.equal(((await command(config, "datasets")) as any).revisions.length, 1);
  const db = new DatabaseSync(join(config.state, "workers", "leases.sqlite"));
  const lease = db.prepare("SELECT * FROM leases WHERE id=?").get(id)!;
  db.close();
  assert.ok(["running", "done"].includes(String(lease.status)));
  assert.match(String(lease.proof), /:/);
});

test("concurrent flow resumes retain one lease and one result publication", async (t) => {
  const f = await fixture(t),
    config = await configure(f.path),
    page = (await command(config, "page", { source: "raw", table: "records" })) as any;
  const revision = (await command(config, "capture", {
    source: "raw",
    table: "records",
    name: "Flow input",
    keys: page.rows.map((r: any) => r.key),
  })) as any;
  const data = new Dataset(join(config.state, "datasets"), { observer: config.observer }),
    run = data.start(revision.id, [{ op: "set", path: "$.ready", value: true }]);
  data.pause(run.id);
  data.close();
  const results = await Promise.allSettled([
    command(config, "flow-resume", { id: run.id }),
    command(config, "flow-resume", { id: run.id }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const completed = await waitFor(async () =>
    ((await command(config, "datasets")) as any).runs.find(
      (r: any) => r.id === run.id && r.state === "completed",
    ),
  );
  assert.equal(
    ((await command(config, "verify", { revision: completed.revision })) as any).records,
    2,
  );
  assert.equal(
    ((await command(config, "datasets")) as any).revisions.filter((r: any) => r.run === run.id)
      .length,
    1,
  );
});

test("worker lease aliases reject writes before touching a source database", async (t) => {
  const f = await fixture(t),
    config = await configure(f.path),
    before = await readFile(join(f.raw, "source.sqlite"));
  await symlink(join(f.raw, "source.sqlite"), join(config.state, "workers", "leases.sqlite"));
  await assert.rejects(
    command(config, "import-table", { source: "raw", table: "records", name: "Aliased lease" }),
    /alias/,
  );
  assert.deepEqual(await readFile(join(f.raw, "source.sqlite")), before);
});

test("unpublished startup token expires before dataset creation", async (t) => {
  const f = await fixture(t),
    config = await configure(f.path),
    id = randomUUID(),
    token = randomUUID(),
    snapshot = join(config.state, "workers", id + "-config.json");
  await writeFile(snapshot, JSON.stringify({ ...config, providers: [] }));
  const child = spawn(
    "/usr/bin/sandbox-exec",
    [
      "-p",
      `(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (subpath ${JSON.stringify(config.state)}))`,
      process.execPath,
      new URL("../studio.ts", import.meta.url).pathname,
      "import-worker",
      snapshot,
      id,
    ],
    {
      env: {
        PATH: "/usr/bin:/bin",
        HOME: config.state,
        TMPDIR: config.state,
        STUDIO_SANDBOX: "1",
        STUDIO_TOKEN: token,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const [code] = await once(child, "exit");
  assert.equal(code, 1);
  await assert.rejects(readFile(join(config.state, "datasets", "dataset.sqlite")), /ENOENT/);
});

test("worker snapshots preserve pointer-selected custom SQLite filenames", async (t) => {
  const f = await fixture(t),
    control = join(f.base, "control");
  await mkdir(control);
  const pointer = join(control, "current.json");
  await writeFile(pointer, JSON.stringify({ root: f.raw, database: "source.sqlite" }));
  Object.assign(f.config.sources[0], { root: control, pointer });
  delete (f.config.sources[0] as { database?: string }).database;
  await writeFile(f.path, JSON.stringify(f.config));
  const config = await configure(f.path),
    job = (await command(config, "import-table", {
      source: "raw",
      table: "records",
      name: "Pointer",
    })) as any;
  const imported = await waitFor(async () =>
    ((await command(config, "imports")) as any).imports.find(
      (r: any) => r.id === job.id && r.state === "completed",
    ),
  );
  assert.equal(imported.processed, 2);
  const snapshot = JSON.parse(
    await readFile(join(config.state, "workers", job.id + "-config.json"), "utf8"),
  );
  assert.equal(snapshot.sources[0].database, join(f.raw, "source.sqlite"));
});

test("bridge pages failure and outcome audits with explicit totals", async (t) => {
  const f = await fixture(t),
    config = await configure(f.path),
    page = (await command(config, "page", { source: "raw", table: "records" })) as any;
  const revision = (await command(config, "capture", {
    source: "raw",
    table: "records",
    name: "Audit",
    keys: page.rows.map((r: any) => r.key),
  })) as any;
  const data = new Dataset(join(config.state, "datasets"), { observer: config.observer });
  const run = await data.run(
    revision.id,
    [{ op: "check", path: "$.approved", required: true, onFailure: "quarantine" }],
    { pauseOnFailure: false },
  );
  data.close();
  const failures = (await command(config, "failures", { id: run.id, offset: 1, limit: 1 })) as any;
  assert.equal(failures.failures.length, 1);
  assert.equal(failures.total, 2);
  assert.equal(failures.offset, 1);
  assert.equal(failures.more, false);
  const outcomes = (await command(config, "outcomes", { id: run.id, offset: 0, limit: 1 })) as any;
  assert.equal(outcomes.outcomes.length, 1);
  assert.equal(outcomes.total, 2);
  assert.equal(outcomes.more, true);
  await assert.rejects(command(config, "outcomes", { id: run.id, limit: 1001 }), /bounds/);
});
