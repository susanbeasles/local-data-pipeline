/// <reference types="emscripten" />
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { digest, type Database, type Result, type Sql } from "../metadata.ts";
import { Registry, type Budget, type Definition, type Policy } from "../workflow.ts";
import { dispatch } from "../platform-client.ts";
import { Platform, serve } from "../platform.ts";

const budget: Budget = {
  cpuMs: 10_000,
  memoryBytes: 1024 ** 2,
  storageBytes: 1024 ** 2,
  timeMs: 30_000,
  tokens: 0,
  costMicros: 0,
  concurrency: 1,
};

async function fixture(t: { after(fn: () => unknown): void }, schema = true) {
  const root = await mkdtemp(join(tmpdir(), "platform-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pg = new PGlite();
  t.after(() => pg.close());
  const wrap = (client: {
    query<T>(query: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows?: number }>;
  }): Sql => ({
    async query<T extends Record<string, unknown>>(
      query: string,
      params: readonly unknown[] = [],
    ): Promise<Result<T>> {
      const result = await client.query<T>(query, [...params]);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  });
  const database: Database = {
    ...wrap(pg),
    transaction: (fn) => pg.transaction((tx) => fn(wrap(tx))),
  };
  const scope = { workspace: randomUUID(), project: randomUUID(), principal: randomUUID() };
  if (schema) {
    await pg.exec(await readFile(new URL("../platform.sql", import.meta.url), "utf8"));
    await database.query("INSERT INTO platform.workspaces(id,name,slug) VALUES($1,'Platform',$2)", [
      scope.workspace,
      scope.workspace,
    ]);
    await database.query(
      "INSERT INTO platform.principals(id,kind,identity_ref) VALUES($1,'service_account',$2)",
      [scope.principal, scope.principal],
    );
    await database.query(
      "INSERT INTO platform.memberships(workspace_id,principal_id) VALUES($1,$2)",
      [scope.workspace, scope.principal],
    );
    await database.query(
      "INSERT INTO platform.projects(workspace_id,id,name) VALUES($1,$2,'Platform')",
      [scope.workspace, scope.project],
    );
    for (const permission of ["view", "configure", "publish", "execute"])
      await database.query(
        "INSERT INTO platform.grants(workspace_id,project_id,principal_id,permission) VALUES($1,$2,$3,$4)",
        [scope.workspace, scope.project, scope.principal, permission],
      );
  }
  const owner = { workspace: scope.workspace, project: scope.project, owner: scope.principal };
  const policy: Policy = { scope: owner, budget, grants: [], capabilities: [] };
  const registry = new Registry();
  const contract = registry.registerContract({
    id: "integer",
    version: 1,
    scope: owner,
    kind: "record",
    format: "json",
    schema: { type: "integer" },
  });
  const adapter = registry.registerAdapter(
    {
      id: "source",
      version: 1,
      scope: owner,
      artifact: digest("platform source"),
      capabilities: [],
    },
    () => ({ out: [4, 7] }),
  );
  const type = registry.registerType({
    id: "source",
    version: 1,
    scope: owner,
    category: "capture",
    adapter,
    config: { type: "object", properties: {}, required: [], additionalProperties: false },
    capabilities: [],
    ports: { inputs: {}, outputs: { out: { contract, required: true, cardinality: "many" } } },
    bindings: {},
  });
  const workflow: Definition = {
    format: "workflow/1",
    id: "operator",
    version: 1,
    scope: owner,
    name: "Operator flow",
    budget,
    stages: [{ id: "main", name: "Main", budget }],
    steps: [{ id: "source", stage: "main", type, config: {}, pins: {}, budget }],
    edges: [],
  };
  const config = {
    format: "platform/1",
    state: join(root, "state"),
    scope,
    policy,
    database: { environment: "PLATFORM_TEST_DATABASE" },
    catalog: [],
  };
  const document = { format: "platform-definition/1", registry: registry.manifest(), workflow };
  return { root, pg, database, scope, policy, registry, workflow, config, document };
}

test("operator commands preview, publish and execute the same durable JSON graph", async (t) => {
  const f = await fixture(t);
  const platform = await Platform.open(f.config, { database: f.database, registry: f.registry });
  t.after(() => platform.close());
  await assert.rejects(
    dispatch(platform, "work", { worker: "native" }),
    /unsupported native platform action/,
  );
  const preview = (await dispatch(platform, "preview", f.document)) as {
    digest: string;
    plan: { steps: unknown[] };
  };
  assert.match(preview.digest, /^[a-f0-9]{64}$/);
  assert.equal(preview.plan.steps.length, 1);
  assert.equal(
    (await f.database.query("SELECT count(*)::integer n FROM platform.workflow_versions")).rows[0]
      .n,
    0,
  );
  const version = (await dispatch(platform, "publish", f.document)) as { id: string; hash: string };
  assert.equal(version.hash, preview.digest);
  assert.equal(((await dispatch(platform, "flows", {})) as unknown[]).length, 1);
  const run = (await dispatch(platform, "run", {
    version: version.id,
    batch: { key: "operator" },
  })) as { id: string };
  await dispatch(platform, "pause", { run: run.id });
  assert.equal(
    ((await dispatch(platform, "status", { run: run.id })) as { status: string }).status,
    "paused",
  );
  assert.equal(await platform.command("work", { worker: "operator" }), null);
  await dispatch(platform, "resume", { run: run.id });
  assert.equal(
    ((await platform.command("work", { worker: "operator" })) as { status: string }).status,
    "completed",
  );
  const status = (await dispatch(platform, "status", { run: run.id })) as {
    status: string;
    artifacts: { uri: string }[];
  };
  assert.equal(status.status, "completed");
  assert.equal(await readFile(new URL(status.artifacts[0].uri), "utf8"), "4\n7\n");
  await assert.rejects(
    dispatch(platform, "run", { version: version.id, batch: { mode: "stream" } }),
    /unsupported.*mode/,
  );
  await platform.close();
  const reopened = await Platform.open(f.config, { database: f.database, registry: f.registry });
  t.after(() => reopened.close());
  assert.equal(
    ((await reopened.command("status", { run: run.id })) as { status: string }).status,
    "completed",
  );
});

test("operator bridge enforces request shape and size while returning actual command results", async (t) => {
  const f = await fixture(t),
    platform = await Platform.open(f.config, { database: f.database, registry: f.registry });
  t.after(() => platform.close());
  let output = "";
  await serve(
    platform,
    Readable.from([JSON.stringify({ action: "publish", input: f.document })]),
    (value) => {
      output += value;
    },
  );
  const version = JSON.parse(output) as { id: string };
  assert.match(version.id, /^[a-f0-9-]{36}$/);
  output = "";
  await serve(
    platform,
    Readable.from([JSON.stringify({ action: "flows", input: {} })]),
    (value) => {
      output += value;
    },
  );
  assert.equal(JSON.parse(output)[0].id, version.id);
  await assert.rejects(
    serve(platform, Readable.from([" ".repeat(2 * 1024 ** 2 + 1)]), () => undefined),
    /2 MiB|bound/,
  );
  await assert.rejects(
    serve(
      platform,
      Readable.from(['{"action":"flows","input":{},"grant":"administer"}']),
      () => undefined,
    ),
    /fields/,
  );
});

test("opening the platform requires an existing schema and never migrates implicitly", async (t) => {
  const f = await fixture(t, false);
  await assert.rejects(
    Platform.open(f.config, { database: f.database, registry: f.registry }),
    /schema|migration|ready/i,
  );
  assert.equal(
    (
      await f.pg.query(
        "SELECT schema_name FROM information_schema.schemata WHERE schema_name='platform'",
      )
    ).rows.length,
    0,
  );
  assert.equal(existsSync(f.config.state), false);
});

test("source roots and symlink targets cannot overlap operator writes", async (t) => {
  const f = await fixture(t),
    source = join(f.root, "source");
  await mkdir(source);
  const bad = {
    ...f.config,
    state: join(source, "state"),
    catalog: [{ id: "source", name: "Source", kind: "sqlite", root: source }],
  };
  await assert.rejects(
    Platform.open(bad, { database: f.database, registry: f.registry }),
    /overlap/,
  );
  assert.equal(existsSync(bad.state), false);
  const link = join(f.root, "alias");
  await symlink(source, link);
  await assert.rejects(
    Platform.open(
      { ...bad, state: join(link, "state") },
      { database: f.database, registry: f.registry },
    ),
    /overlap/,
  );
  assert.equal(existsSync(join(source, "state")), false);
  await mkdir(f.config.state);
  await symlink(source, join(f.config.state, "artifacts"));
  await assert.rejects(
    Platform.open(
      { ...f.config, catalog: bad.catalog },
      { database: f.database, registry: f.registry },
    ),
    /escape|overlap/,
  );
  assert.equal(existsSync(join(f.config.state, "datasets")), false);
});

test("operator configuration rejects secrets, foreign policy scope and unknown fields", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    Platform.open(
      { ...f.config, database: { url: "postgres://user:secret@example.invalid/db" } },
      { database: f.database, registry: f.registry },
    ),
    /database.*fields/,
  );
  await assert.rejects(
    Platform.open(
      { ...f.config, policy: { ...f.policy, scope: { ...f.policy.scope, owner: randomUUID() } } },
      { database: f.database, registry: f.registry },
    ),
    /scope/,
  );
  await assert.rejects(
    Platform.open(
      { ...f.config, grant: "administer" },
      { database: f.database, registry: f.registry },
    ),
    /configuration.*fields/,
  );
  await assert.rejects(
    Platform.open({ ...f.config, database: { environment: "MISSING_PLATFORM_DATABASE" } }),
    /environment.*missing|not configured/,
  );
});

test("commands preserve database authorization and reject arbitrary command dispatch", async (t) => {
  const f = await fixture(t),
    platform = await Platform.open(f.config, { database: f.database, registry: f.registry });
  t.after(() => platform.close());
  await assert.rejects(
    platform.command("exec", { command: "anything" }),
    /unsupported.*action|unknown.*action/,
  );
  await f.database.query("DELETE FROM platform.grants WHERE permission='view'");
  await assert.rejects(platform.command("sources", {}), /permission.*view/);
  await assert.rejects(platform.command("preview", f.document), /permission.*view/);
  await f.database.query("DELETE FROM platform.grants WHERE permission='configure'");
  await assert.rejects(platform.command("publish", f.document), /permission.*configure/);
});

test("catalog commands read registered synthetic SQLite tables through the actual catalog", async (t) => {
  const f = await fixture(t),
    source = join(f.root, "source");
  await mkdir(source);
  const sqlite = new DatabaseSync(join(source, "source.sqlite"));
  sqlite.exec(
    "CREATE TABLE items(id TEXT PRIMARY KEY,body TEXT); INSERT INTO items VALUES('one','synthetic')",
  );
  sqlite.close();
  const config = {
    ...f.config,
    catalog: [
      { id: "source", name: "Synthetic", kind: "sqlite", root: source, database: "source.sqlite" },
    ],
  };
  const platform = await Platform.open(config, { database: f.database, registry: f.registry });
  t.after(() => platform.close());
  const tables = (await platform.command("tables", { source: "source" })) as {
    name: string;
    count: number;
  }[];
  assert.equal(tables.find((table) => table.name === "items")?.count, 1);
  const page = (await platform.command("page", {
    source: "source",
    table: "items",
    options: { limit: 1 },
  })) as { total: number; rows: { key: string; value: { body: string } }[] };
  assert.equal(page.total, 1);
  assert.equal(page.rows[0].value.body, "synthetic");
  const record = (await platform.command("record", {
    source: "source",
    table: "items",
    key: page.rows[0].key,
  })) as { sqlite: { body: string } };
  assert.equal(record.sqlite.body, "synthetic");
  assert.equal(((await platform.command("sources", {})) as { id: string }[])[0].id, "source");
  await assert.rejects(
    platform.command("page", { source: "unregistered", table: "items" }),
    /unknown source/i,
  );
});

test("CLI rejects a remote database binding without printing its credential", async (t) => {
  const f = await fixture(t),
    file = join(f.root, "operator config.json");
  await writeFile(file, JSON.stringify(f.config));
  const result = await new Promise<{ code: number | null; stdout: string }>((done, reject) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../platform.ts", import.meta.url)), file],
      {
        env: {
          ...process.env,
          PLATFORM_TEST_DATABASE: "postgres://synthetic:must-never-print@example.invalid/platform",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", (code) => done({ code, stdout }));
    child.stdin.end(JSON.stringify({ action: "health", input: {} }));
  });
  assert.equal(result.code, 1);
  assert.match(JSON.parse(result.stdout).error.message, /loopback/);
  assert.equal(result.stdout.includes("must-never-print"), false);
});

test("resident model configuration requires packaged roles and stays lazy during read commands", async (t) => {
  const f = await fixture(t);
  const model = {
    runtime: join(f.root, "runtime"),
    base: join(f.root, "model"),
    package: join(f.root, "package"),
    adapters: {},
    timeoutMs: 30_000,
    maxTokens: 128,
    batchSize: 64,
    memoryBytes: 1024 ** 3,
    budgetBytes: 4 * 1024 ** 3,
  };
  const config = { ...f.config, model, modelKey: "synthetic" };
  await assert.rejects(
    Platform.open(
      { ...config, model: { ...model, roleMode: "inline" } },
      { database: f.database, registry: f.registry },
    ),
    /packaged/,
  );
  await assert.rejects(
    Platform.open(
      { ...config, model: { ...model, adapters: { role: "/unused" } } },
      { database: f.database, registry: f.registry },
    ),
    /learned adapters/,
  );
  const platform = await Platform.open(config, { database: f.database, registry: f.registry });
  t.after(() => platform.close());
  assert.equal(((await platform.command("health", {})) as { model: boolean }).model, true);
  assert.equal(((await platform.command("flows", {})) as unknown[]).length, 0);
});

test("default platform construction registers the actual standard capability library", async (t) => {
  const f = await fixture(t),
    platform = await Platform.open(f.config, { database: f.database });
  t.after(() => platform.close());
  const manifest = (await platform.command("registry", {})) as {
    types: { id: string }[];
    contracts: { id: string }[];
  };
  assert.deepEqual(
    manifest.types.map((type) => type.id),
    ["dataset.capture", "dataset.transform", "dataset.verify", "model.infer"],
  );
  assert.deepEqual(
    manifest.contracts.map((contract) => contract.id),
    ["dataset.jsonl", "dataset.sqlite"],
  );
});

test("persistent workers stop after a committed checkpoint and keep durable progress", async (t) => {
  const f = await fixture(t),
    platform = await Platform.open(f.config, { database: f.database, registry: f.registry });
  t.after(() => platform.close());
  const version = (await platform.command("publish", f.document)) as { id: string };
  const run = (await platform.command("run", { version: version.id })) as { id: string };
  const controller = new AbortController();
  const states: string[] = [];
  const result = await platform.worker({
    worker: "persistent",
    signal: controller.signal,
    onWork(work) {
      states.push(work.status);
      controller.abort();
    },
  });
  assert.equal(result.processed, 1);
  assert.deepEqual(states, ["completed"]);
  assert.equal(
    ((await platform.command("status", { run: run.id })) as { status: string }).status,
    "completed",
  );
  assert.equal(
    (await f.database.query("SELECT count(*)::integer n FROM platform.checkpoints")).rows[0].n,
    1,
  );
});

test("an idle persistent worker responds to stop without claiming a task", async (t) => {
  const f = await fixture(t),
    platform = await Platform.open(f.config, { database: f.database, registry: f.registry });
  t.after(() => platform.close());
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 25);
  const result = await platform.worker({ worker: "idle", signal: controller.signal });
  assert.equal(result.processed, 0);
  assert.equal(result.stopped, "signal");
  await assert.rejects(platform.worker({ worker: "idle", limit: 0 }), /limit/);
});
