/// <reference types="emscripten" />
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { Metadata, Files, digest, type Database, type Sql, type Result } from "../metadata.ts";
import {
  Registry,
  type Budget,
  type Definition,
  type Handler,
  type Policy,
  type Port,
  type Ref,
} from "../workflow.ts";
import { Definitions } from "../definitions.ts";
import { Execution } from "../execution.ts";

const budget: Budget = {
  cpuMs: 10000,
  memoryBytes: 1024 ** 2,
  storageBytes: 1024 ** 2,
  timeMs: 30000,
  tokens: 1000,
  costMicros: 1000,
  concurrency: 1,
};
const capacity: Budget = {
  ...budget,
  cpuMs: 100000,
  memoryBytes: 16 * 1024 ** 2,
  storageBytes: 16 * 1024 ** 2,
  timeMs: 300000,
  tokens: 10000,
  costMicros: 10000,
  concurrency: 8,
};
async function fixture(t: { after(fn: () => unknown): void }, handlers: Record<string, Handler>) {
  const pg = new PGlite();
  t.after(() => pg.close());
  await pg.exec(await readFile(new URL("../platform.sql", import.meta.url), "utf8"));
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
  const db: Database = { ...wrap(pg), transaction: (fn) => pg.transaction((tx) => fn(wrap(tx))) };
  const scope = { workspace: randomUUID(), project: randomUUID(), principal: randomUUID() };
  await db.query("INSERT INTO platform.workspaces(id,name,slug) VALUES($1,'Execution',$2)", [
    scope.workspace,
    scope.workspace,
  ]);
  await db.query(
    "INSERT INTO platform.principals(id,kind,identity_ref) VALUES($1,'service_account',$2)",
    [scope.principal, scope.principal],
  );
  await db.query("INSERT INTO platform.memberships(workspace_id,principal_id) VALUES($1,$2)", [
    scope.workspace,
    scope.principal,
  ]);
  await db.query("INSERT INTO platform.projects(workspace_id,id,name) VALUES($1,$2,'Execution')", [
    scope.workspace,
    scope.project,
  ]);
  for (const permission of ["view", "configure", "execute", "publish"])
    await db.query(
      "INSERT INTO platform.grants(workspace_id,project_id,principal_id,permission) VALUES($1,$2,$3,$4)",
      [scope.workspace, scope.project, scope.principal, permission],
    );
  const root = await mkdtemp(join(tmpdir(), "execution-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadata = new Metadata(db, scope, new Files(root));
  const domain = { workspace: scope.workspace, project: scope.project, owner: scope.principal };
  const policy: Policy = { scope: domain, capabilities: [], budget: capacity, grants: [] };
  const registry = new Registry();
  const contract = registry.registerContract({
    id: "record",
    version: 1,
    scope: domain,
    kind: "record",
    format: "json",
    schema: { type: "integer" },
  });
  const port = (cardinality: Port["cardinality"] = "many"): Port => ({
    contract,
    required: true,
    cardinality,
  });
  const types: Record<string, Ref> = {};
  for (const [key, handler] of Object.entries(handlers)) {
    const adapter = registry.registerAdapter(
      { id: key, version: 1, scope: domain, artifact: digest("trusted " + key), capabilities: [] },
      handler,
    );
    types[key] = registry.registerType({
      id: key,
      version: 1,
      scope: domain,
      category: "transform",
      config: { type: "object", properties: {}, required: [], additionalProperties: false },
      adapter,
      capabilities: [],
      bindings: {},
      ports: { inputs: key === "source" ? {} : { in: port() }, outputs: { out: port() } },
    });
  }
  const definition: Definition = {
    format: "workflow/1",
    id: "durable",
    version: 1,
    scope: domain,
    name: "Durable batch",
    budget: capacity,
    stages: [{ id: "main", name: "Main", budget: capacity }],
    steps: Object.keys(handlers).map((id) => ({
      id,
      stage: "main",
      type: types[id],
      config: {},
      pins: {},
      budget,
    })),
    edges: [],
  };
  const definitions = new Definitions(metadata, registry, policy);
  return { db, scope, root, metadata, registry, policy, definition, definitions };
}

test("two engines run a SQL dependency DAG and publish immutable JSONL with lineage", async (t) => {
  const f = await fixture(t, {
    source: () => ({ out: [1, 2] }),
    left: ({ inputs }) => ({ out: inputs.in.map((n) => Number(n) * 10) }),
    right: ({ inputs }) => ({ out: inputs.in.map((n) => Number(n) * 100) }),
    join: ({ inputs, charge }) => {
      charge({ tokens: 3 });
      return { out: [inputs.in.reduce<number>((sum, n) => sum + Number(n), 0)] };
    },
  });
  f.definition.edges = [
    { id: "sl", from: { step: "source", port: "out" }, to: { step: "left", port: "in" } },
    { id: "sr", from: { step: "source", port: "out" }, to: { step: "right", port: "in" } },
    { id: "lj", from: { step: "left", port: "out" }, to: { step: "join", port: "in" } },
    { id: "rj", from: { step: "right", port: "out" }, to: { step: "join", port: "in" } },
  ];
  const version = await f.definitions.publish({
    format: "platform-definition/1",
    registry: f.registry.manifest(),
    workflow: f.definition,
  });
  const a = new Execution(f.metadata, f.registry, f.root, { policy: f.policy });
  const b = new Execution(f.metadata, f.registry, f.root, { policy: f.policy });
  const run = await a.start(version.id, { key: "fixture" });
  const first = await Promise.all([a.work("a"), b.work("b")]);
  assert.equal(first.filter(Boolean).length, 1);
  await Promise.all([a.drain("a"), b.drain("b")]);
  const status = await a.status(run.id);
  assert.equal(status.status, "completed");
  assert.deepEqual(
    status.tasks.map((task) => task.status),
    ["completed", "completed", "completed", "completed"],
  );
  const rows = (
    await f.db.query(
      "SELECT a.uri,a.bytes,a.checksum FROM platform.artifacts a JOIN platform.bindings b ON b.artifact_id=a.id AND b.direction='output' JOIN platform.step_runs s ON s.id=b.step_run_id WHERE s.run_id=$1 AND s.step_key='join'",
      [run.id],
    )
  ).rows;
  assert.equal(rows.length, 1);
  assert.equal(await readFile(fileURLToPath(String(rows[0].uri)), "utf8"), "330\n");
  assert.equal((await stat(fileURLToPath(String(rows[0].uri)))).mode & 0o222, 0);
  assert.equal(
    (await f.db.query("SELECT count(*)::integer n FROM platform.checkpoints")).rows[0].n,
    4,
  );
  assert.equal((await f.db.query("SELECT count(*)::integer n FROM platform.lineage")).rows[0].n, 4);
  assert.equal(
    (
      await f.db.query(
        "SELECT sum(quantity)::integer n FROM platform.usage WHERE resource='tokens'",
      )
    ).rows[0].n,
    3,
  );
  assert.equal(
    (
      await f.db.query(
        "SELECT count(*)::integer n FROM platform.dataset_versions WHERE state='published'",
      )
    ).rows[0].n,
    4,
  );
});

test("failed handlers retry from SQL attempts and blocked quality gates expose no output", async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    source: () => {
      if (++calls === 1) throw Error("synthetic failure");
      return { out: [7] };
    },
  });
  const version = await f.definitions.publish({
    format: "platform-definition/1",
    registry: f.registry.manifest(),
    workflow: f.definition,
  });
  const a = new Execution(f.metadata, f.registry, f.root, { policy: f.policy });
  const run = await a.start(version.id, { maxAttempts: 2 });
  assert.equal((await a.work("first"))?.status, "retry");
  const b = new Execution(f.metadata, f.registry, f.root, { policy: f.policy });
  await b.drain("second");
  assert.equal((await b.status(run.id)).status, "completed");
  assert.deepEqual(
    (await f.db.query("SELECT status FROM platform.attempts ORDER BY started_at")).rows.map(
      (row) => row.status,
    ),
    ["failed", "completed"],
  );
  const gated = await a.start(version.id, {});
  await f.db.query(
    "INSERT INTO platform.quality_results(workspace_id,project_id,step_run_id,key,blocking,passed,observed,expected) SELECT workspace_id,project_id,id,'gate',true,false,'{}','{}' FROM platform.step_runs WHERE run_id=$1",
    [gated.id],
  );
  await a.drain("gated");
  assert.equal((await a.status(gated.id)).status, "failed");
  assert.equal(
    (
      await f.db.query(
        "SELECT count(*)::integer n FROM platform.artifacts a JOIN platform.step_runs s ON s.id=a.step_run_id WHERE s.run_id=$1",
        [gated.id],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await f.db.query("SELECT count(*)::integer n FROM platform.checkpoints WHERE run_id=$1", [
        gated.id,
      ])
    ).rows[0].n,
    0,
  );
});

test("concurrent starts with one batch key return one durable run and reject changed parameters", async (t) => {
  const f = await fixture(t, { source: () => ({ out: [1] }) });
  const version = await f.definitions.publish({
    format: "platform-definition/1",
    registry: f.registry.manifest(),
    workflow: f.definition,
  });
  const a = new Execution(f.metadata, f.registry, f.root, { policy: f.policy });
  const b = new Execution(f.metadata, f.registry, f.root, { policy: f.policy });
  const starts = await Promise.all([
    a.start(version.id, { key: "stable", parameters: { limit: 4 } }),
    b.start(version.id, { key: "stable", parameters: { limit: 4 } }),
  ]);
  assert.equal(starts[0].id, starts[1].id);
  assert.equal((await f.db.query("SELECT count(*)::integer n FROM platform.tasks")).rows[0].n, 1);
  await assert.rejects(
    b.start(version.id, { key: "stable", parameters: { limit: 5 } }),
    /different parameters/,
  );
});

test("failed attempts retain charged usage with execute permission alone", async (t) => {
  const f = await fixture(t, {
    source: ({ charge }) => {
      charge({ tokens: 5 });
      throw Error("charged failure");
    },
  });
  const version = await f.definitions.publish({
    format: "platform-definition/1",
    registry: f.registry.manifest(),
    workflow: f.definition,
  });
  const execution = new Execution(f.metadata, f.registry, f.root, { policy: f.policy });
  await f.db.query(
    "DELETE FROM platform.grants WHERE permission IN ('view','configure','publish')",
  );
  await execution.start(version.id, { maxAttempts: 1 });
  const result = await execution.work("limited-worker");
  assert.equal(result?.status, "failed");
  assert.equal(
    (
      await f.db.query(
        "SELECT sum(quantity)::integer n FROM platform.usage WHERE resource='tokens'",
      )
    ).rows[0].n,
    5,
  );
});

test("oversized packets never register output datasets or checkpoints", async (t) => {
  const f = await fixture(t, { source: () => ({ out: [12345] }) });
  const version = await f.definitions.publish({
    format: "platform-definition/1",
    registry: f.registry.manifest(),
    workflow: f.definition,
  });
  const execution = new Execution(f.metadata, f.registry, f.root, {
    policy: f.policy,
    packetBytes: 2,
  });
  const run = await execution.start(version.id, { maxAttempts: 1 });
  const result = await execution.work("bounded");
  assert.match(result?.error ?? "", /artifact handle/);
  assert.equal((await execution.status(run.id)).status, "failed");
  for (const table of [
    "datasets",
    "dataset_versions",
    "representations",
    "artifacts",
    "checkpoints",
  ])
    assert.equal(
      (await f.db.query("SELECT count(*)::integer n FROM platform." + table)).rows[0].n,
      0,
    );
});

test("resuming a paused run whose active task finished records completion", async (t) => {
  let entered!: () => void, release!: () => void;
  const active = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, {
    source: async () => {
      entered();
      await ready;
      return { out: [4] };
    },
  });
  const version = await f.definitions.publish({
    format: "platform-definition/1",
    registry: f.registry.manifest(),
    workflow: f.definition,
  });
  const execution = new Execution(f.metadata, f.registry, f.root, { policy: f.policy });
  const run = await execution.start(version.id, {});
  const work = execution.work("active");
  await active;
  await execution.pause(run.id);
  release();
  await work;
  assert.equal((await execution.status(run.id)).status, "paused");
  await execution.resume(run.id);
  assert.equal((await execution.status(run.id)).status, "completed");
});

test("a replacement engine fences a crashed attempt and pause survives engine replacement", async (t) => {
  const f = await fixture(t, { source: () => ({ out: [9] }) });
  const version = await f.definitions.publish({
    format: "platform-definition/1",
    registry: f.registry.manifest(),
    workflow: f.definition,
  });
  const a = new Execution(f.metadata, f.registry, f.root, { policy: f.policy });
  const run = await a.start(version.id, {});
  await a.pause(run.id);
  const b = new Execution(f.metadata, f.registry, f.root, { policy: f.policy });
  assert.equal(await b.work("paused"), undefined);
  assert.equal((await b.status(run.id)).status, "paused");
  await b.resume(run.id);
  const lease = await f.metadata.lease("crashed", 30);
  assert.ok(lease);
  await f.db.query(
    "UPDATE platform.tasks SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [lease.id],
  );
  await b.drain("replacement");
  assert.equal((await b.status(run.id)).status, "completed");
  assert.deepEqual(
    (await f.db.query("SELECT status,fence FROM platform.attempts ORDER BY fence")).rows.map(
      (row) => [row.status, Number(row.fence)],
    ),
    [
      ["expired", 1],
      ["completed", 2],
    ],
  );
  await assert.rejects(f.metadata.commit(lease, { key: "stale", artifacts: [] }), /fenc|lease/);
  await assert.rejects(a.start(version.id, { mode: "streaming" } as never), /batch|unsupported/i);
});

test("downstream execution rejects corrupted committed bytes instead of using cached packets", async (t) => {
  const f = await fixture(t, {
    source: () => ({ out: [1] }),
    next: ({ inputs }) => ({ out: inputs.in.map((value) => Number(value) + 1) }),
  });
  f.definition.edges = [
    { id: "next", from: { step: "source", port: "out" }, to: { step: "next", port: "in" } },
  ];
  const version = await f.definitions.publish({
    format: "platform-definition/1",
    registry: f.registry.manifest(),
    workflow: f.definition,
  });
  const first = new Execution(f.metadata, f.registry, f.root, { policy: f.policy });
  const run = await first.start(version.id, { maxAttempts: 1 });
  assert.equal((await first.work("source"))?.status, "completed");
  const artifact = (await first.status(run.id)).artifacts[0];
  const path = fileURLToPath(artifact.uri);
  await chmod(path, 0o600);
  await writeFile(path, "8\n");
  await chmod(path, 0o400);
  const second = new Execution(f.metadata, f.registry, f.root, { policy: f.policy });
  const result = await second.work("reader");
  assert.equal(result?.status, "failed");
  assert.match(result?.error ?? "", /integrity|checksum/);
  assert.equal((await second.status(run.id)).artifacts.length, 1);
});

test("an expired live handler cannot duplicate a replacement worker's output", async (t) => {
  let entered!: () => void,
    release!: () => void,
    calls = 0;
  const active = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, {
    source: async () => {
      if (++calls === 1) {
        entered();
        await waiting;
        return { out: [1] };
      }
      return { out: [2] };
    },
  });
  const version = await f.definitions.publish({
    format: "platform-definition/1",
    registry: f.registry.manifest(),
    workflow: f.definition,
  });
  const first = new Execution(f.metadata, f.registry, f.root, { policy: f.policy });
  const second = new Execution(f.metadata, f.registry, f.root, { policy: f.policy });
  const run = await first.start(version.id, {});
  const stale = first.work("stale");
  await active;
  await f.db.query(
    "UPDATE platform.tasks SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE run_id=$1",
    [run.id],
  );
  assert.equal((await second.work("replacement"))?.status, "completed");
  release();
  assert.equal((await stale)?.status, "failed");
  const state = await second.status(run.id);
  assert.equal(state.status, "completed");
  assert.equal(state.artifacts.length, 1);
  assert.equal(await readFile(fileURLToPath(state.artifacts[0].uri), "utf8"), "2\n");
  assert.equal(
    (await f.db.query("SELECT count(*)::integer n FROM platform.dataset_versions")).rows[0].n,
    1,
  );
});
