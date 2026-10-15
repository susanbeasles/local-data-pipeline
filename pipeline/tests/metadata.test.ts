/// <reference types="emscripten" />
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { Workflow, Registry, type Budget } from "../workflow.ts";
import {
  Metadata,
  Files,
  digest,
  type Database,
  type Sql,
  type Result,
  type Scope,
} from "../metadata.ts";

// These execute PostgreSQL itself through PGlite. They are not a separate-server
// or multi-process concurrency/load test.
async function fixture(t: { after(fn: () => unknown): void }) {
  const pg = new PGlite();
  t.after(() => pg.close());
  await pg.exec(await readFile(new URL("../platform.sql", import.meta.url), "utf8"));
  const wrap = (client: {
    query<T>(query: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows?: number }>;
  }): Sql => ({
    async query<T extends { [key: string]: unknown }>(
      query: string,
      params: readonly unknown[] = [],
    ): Promise<Result<T>> {
      const r = await client.query<T>(query, [...params]);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
  });
  const db: Database = { ...wrap(pg), transaction: (fn) => pg.transaction((tx) => fn(wrap(tx))) };
  const scope: Scope = { workspace: randomUUID(), project: randomUUID(), principal: randomUUID() };
  await db.query("INSERT INTO platform.workspaces(id,name,slug) VALUES($1,$2,$3)", [
    scope.workspace,
    "Test",
    scope.workspace,
  ]);
  await db.query("INSERT INTO platform.principals(id,kind,identity_ref) VALUES($1,$2,$3)", [
    scope.principal,
    "service_account",
    "synthetic",
  ]);
  await db.query("INSERT INTO platform.memberships(workspace_id,principal_id) VALUES($1,$2)", [
    scope.workspace,
    scope.principal,
  ]);
  await db.query("INSERT INTO platform.projects(workspace_id,id,name) VALUES($1,$2,$3)", [
    scope.workspace,
    scope.project,
    "Fixture",
  ]);
  for (const permission of ["view", "configure", "execute", "publish"])
    await db.query(
      "INSERT INTO platform.grants(workspace_id,project_id,principal_id,permission) VALUES($1,$2,$3,$4)",
      [scope.workspace, scope.project, scope.principal, permission],
    );
  const root = await mkdtemp(join(tmpdir(), "metadata-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadata = new Metadata(db, scope, new Files(root));
  return { pg, db, scope, metadata, root };
}
const h = "a".repeat(64);
async function seed(f: Awaited<ReturnType<typeof fixture>>) {
  const { db, scope } = f,
    p = [scope.workspace, scope.project];
  await db.query(
    `INSERT INTO platform.contracts(workspace_id,key,version,digest,kind,schema_body) VALUES($1,'records',1,$2,'records','{}')`,
    [scope.workspace, h],
  );
  await db.query(
    `INSERT INTO platform.adapters(workspace_id,key,version,digest,runtime,artifact_uri,artifact_digest,capabilities,isolation) VALUES($1,'fixture',1,$2,'process','file:///synthetic',$2,'[]','{"filesystem":"none"}')`,
    [scope.workspace, h],
  );
  await db.query(
    `INSERT INTO platform.step_types(workspace_id,key,version,digest,adapter_key,adapter_version,category,configuration_schema,input_ports,output_ports,modes) VALUES($1,'map',1,$2,'fixture',1,'transform','{}','{}','{}',ARRAY['batch'])`,
    [scope.workspace, h],
  );
  await db.query(
    `INSERT INTO platform.workflows(workspace_id,project_id,id,name,owner_id) VALUES($1,$2,'demo','Demo',$3)`,
    [...p, scope.principal],
  );
  const version = randomUUID();
  await db.query(
    `INSERT INTO platform.workflow_versions(workspace_id,project_id,workflow_id,id,number,definition_hash,definition,execution_policy,resource_policy,created_by) VALUES($1,$2,'demo',$3,1,$4,'{}','{"mode":"batch"}','{"concurrency":1}',$5)`,
    [...p, version, h, scope.principal],
  );
  await db.query(
    `INSERT INTO platform.stages(workspace_id,project_id,version_id,key,name) VALUES($1,$2,$3,'main','Main')`,
    [...p, version],
  );
  await db.query(
    `INSERT INTO platform.steps(workspace_id,project_id,version_id,key,stage_key,type_key,type_version,type_digest,configuration) VALUES($1,$2,$3,'map','main','map',1,$4,'{}')`,
    [...p, version, h],
  );
  await db.query(
    `INSERT INTO platform.ports(workspace_id,project_id,version_id,step_key,key,direction,contract_key,contract_version,contract_digest,required) VALUES($1,$2,$3,'map','out','output','records',1,$4,true)`,
    [...p, version, h],
  );
  await f.metadata.publish(version);
  const run = await f.metadata.run(version, { mode: "batch", configuration: h });
  const task = await f.metadata.queue(run.id, "map", {
    key: "partition-0",
    partition: "0",
    maxAttempts: 3,
  });
  const dataset = randomUUID(),
    revision = randomUUID(),
    representation = randomUUID();
  await db.query(
    `INSERT INTO platform.datasets(workspace_id,project_id,id,key,name,kind,identity_strategy) VALUES($1,$2,$3,'output','Output','records','{"kind":"source-key"}')`,
    [...p, dataset],
  );
  await db.query(
    `INSERT INTO platform.dataset_versions(workspace_id,project_id,dataset_id,id,number,content_hash,manifest_uri,record_count,byte_count) VALUES($1,$2,$3,$4,1,$5,'file:///manifest',1,3)`,
    [...p, dataset, revision, h],
  );
  await db.query(
    `INSERT INTO platform.representations(workspace_id,project_id,revision_id,id,format,format_version) VALUES($1,$2,$3,$4,'jsonl','1')`,
    [...p, revision, representation],
  );
  return { version, run, task, dataset, revision, representation };
}

test("PostgreSQL migration enforces tenant references and published graph immutability", async (t) => {
  const f = await fixture(t),
    s = await seed(f),
    other = randomUUID();
  await assert.rejects(
    f.db.query(`UPDATE platform.steps SET configuration='{"changed":true}' WHERE version_id=$1`, [
      s.version,
    ]),
    /immutable|published/,
  );
  await assert.rejects(
    f.db.query("DELETE FROM platform.workflow_versions WHERE id=$1", [s.version]),
    /immutable|published/,
  );
  await assert.rejects(
    f.db.query(
      `INSERT INTO platform.steps(workspace_id,project_id,version_id,key,stage_key,type_key,type_version,type_digest,configuration) VALUES($1,$2,$3,'bad','main','map',1,$4,'{}')`,
      [f.scope.workspace, other, s.version, h],
    ),
    /foreign key|published/,
  );
  const unauth = new Metadata(f.db, { ...f.scope, principal: randomUUID() }, new Files(f.root));
  await assert.rejects(unauth.lease("untrusted", 30), /permission/);
});

test("SQL leases fence expired attempts and commit artifacts, checkpoint and task atomically", async (t) => {
  const f = await fixture(t),
    s = await seed(f);
  const first = await f.metadata.lease("worker-a", 30);
  assert.ok(first);
  assert.equal(first.fence, 1);
  assert.equal(await f.metadata.lease("worker-b", 30), undefined);
  await f.db.query(
    `UPDATE platform.tasks SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
    [s.task.id],
  );
  const second = await f.metadata.lease("worker-b", 30);
  assert.ok(second);
  assert.equal(second.fence, 2);
  const path = join(f.root, "output.jsonl");
  await writeFile(path, "{}\n");
  const output = {
    key: "commit-0",
    artifacts: [
      {
        id: randomUUID(),
        representation: s.representation,
        port: "out",
        uri: pathToFileURL(path).href,
        bytes: 3,
        checksum: digest("{}\n"),
        mediaType: "application/x-ndjson",
      },
    ],
    checkpoint: { cursor: { offset: 1 } },
  };
  await assert.rejects(f.metadata.commit(first, output), /lease|fenc/);
  const committed = await f.metadata.commit(second, output);
  assert.equal(committed.artifacts.length, 1);
  assert.deepEqual(await f.metadata.commit(second, output), committed);
  assert.equal(
    (await f.db.query("SELECT count(*)::integer n FROM platform.artifacts")).rows[0].n,
    1,
  );
  assert.equal(
    (await f.db.query("SELECT count(*)::integer n FROM platform.checkpoints")).rows[0].n,
    1,
  );
  assert.equal(
    (await f.db.query("SELECT status FROM platform.tasks WHERE id=$1", [s.task.id])).rows[0].status,
    "completed",
  );
  await assert.rejects(f.metadata.commit(second, { ...output, key: "other" }), /commit|idempot/);
  await assert.rejects(
    f.db.query("UPDATE platform.artifacts SET uri='file:///changed'"),
    /immutable/,
  );
});

test("failed physical verification and a blocking quality gate publish no artifact or cursor", async (t) => {
  const f = await fixture(t),
    s = await seed(f),
    lease = await f.metadata.lease("worker", 30);
  assert.ok(lease);
  const path = join(f.root, "output");
  await writeFile(path, "actual");
  const output = {
    key: "output",
    artifacts: [
      {
        id: randomUUID(),
        representation: s.representation,
        port: "out",
        uri: pathToFileURL(path).href,
        bytes: 6,
        checksum: h,
        mediaType: "text/plain",
      },
    ],
    checkpoint: { cursor: { offset: 1 } },
  };
  await assert.rejects(f.metadata.commit(lease, output), /checksum|integrity/);
  output.artifacts[0].checksum = digest("actual");
  await f.db.query(
    `INSERT INTO platform.quality_results(workspace_id,project_id,step_run_id,key,blocking,passed,observed,expected) VALUES($1,$2,$3,'required',true,false,'{}','{}')`,
    [f.scope.workspace, f.scope.project, lease.stepRun],
  );
  await assert.rejects(f.metadata.commit(lease, output), /quality/);
  assert.equal(
    (await f.db.query("SELECT count(*)::integer n FROM platform.artifacts")).rows[0].n,
    0,
  );
  assert.equal(
    (await f.db.query("SELECT count(*)::integer n FROM platform.checkpoints")).rows[0].n,
    0,
  );
  await f.metadata.fail(lease, { code: "quality", message: "synthetic rejection" }, 0);
  const retry = await f.metadata.lease("worker", 30);
  assert.ok(retry);
  assert.equal(retry.fence, 2);
});

async function clone(f: Awaited<ReturnType<typeof fixture>>, source: string, number: number) {
  const next = randomUUID(),
    p = [f.scope.workspace, f.scope.project, next, source];
  await f.db.query(
    `INSERT INTO platform.workflow_versions(workspace_id,project_id,workflow_id,id,number,definition_hash,definition,execution_policy,resource_policy,created_by) SELECT workspace_id,project_id,workflow_id,$3,$5,definition_hash,definition,execution_policy,resource_policy,created_by FROM platform.workflow_versions WHERE workspace_id=$1 AND project_id=$2 AND id=$4`,
    [...p, number],
  );
  await f.db.query(
    `INSERT INTO platform.stages(workspace_id,project_id,version_id,key,name) SELECT workspace_id,project_id,$3,key,name FROM platform.stages WHERE workspace_id=$1 AND project_id=$2 AND version_id=$4`,
    p,
  );
  await f.db.query(
    `INSERT INTO platform.steps(workspace_id,project_id,version_id,key,stage_key,type_key,type_version,type_digest,configuration) SELECT workspace_id,project_id,$3,key,stage_key,type_key,type_version,type_digest,configuration FROM platform.steps WHERE workspace_id=$1 AND project_id=$2 AND version_id=$4`,
    p,
  );
  await f.db.query(
    `INSERT INTO platform.ports(workspace_id,project_id,version_id,step_key,key,direction,contract_key,contract_version,contract_digest,required) SELECT workspace_id,project_id,$3,step_key,key,direction,contract_key,contract_version,contract_digest,required FROM platform.ports WHERE workspace_id=$1 AND project_id=$2 AND version_id=$4`,
    p,
  );
  return next;
}

test("publication rejects required gaps, incompatible contracts and cycles without altering historical runs", async (t) => {
  const f = await fixture(t),
    s = await seed(f),
    gap = await clone(f, s.version, 2),
    p = [f.scope.workspace, f.scope.project, gap];
  await f.db.query(
    `INSERT INTO platform.ports(workspace_id,project_id,version_id,step_key,key,direction,contract_key,contract_version,contract_digest,required) VALUES($1,$2,$3,'map','in','input','records',1,$4,true)`,
    [...p, h],
  );
  await assert.rejects(f.metadata.publish(gap), /required input/);
  assert.equal(
    (await f.db.query("SELECT version_id FROM platform.runs WHERE id=$1", [s.run.id])).rows[0]
      .version_id,
    s.version,
  );
  const cycle = await clone(f, s.version, 3),
    c = [f.scope.workspace, f.scope.project, cycle];
  await f.db.query(
    `INSERT INTO platform.steps(workspace_id,project_id,version_id,key,stage_key,type_key,type_version,type_digest,configuration) VALUES($1,$2,$3,'next','main','map',1,$4,'{}')`,
    [...c, h],
  );
  for (const step of ["map", "next"])
    await f.db.query(
      `INSERT INTO platform.ports(workspace_id,project_id,version_id,step_key,key,direction,contract_key,contract_version,contract_digest) VALUES($1,$2,$3,$4,'in','input','records',1,$5)`,
      [...c, step, h],
    );
  await f.db.query(
    `INSERT INTO platform.ports(workspace_id,project_id,version_id,step_key,key,direction,contract_key,contract_version,contract_digest) VALUES($1,$2,$3,'next','out','output','records',1,$4)`,
    [...c, h],
  );
  await f.db.query(
    `INSERT INTO platform.edges(workspace_id,project_id,version_id,key,source_step,source_port,target_step,target_port) VALUES($1,$2,$3,'forward','map','out','next','in'),($1,$2,$3,'back','next','out','map','in')`,
    c,
  );
  await assert.rejects(f.metadata.publish(cycle), /cycle/);
  await f.db.query(`DELETE FROM platform.edges WHERE version_id=$1 AND key='back'`, [cycle]);
  await f.db.query(
    `UPDATE platform.ports SET required=false WHERE version_id=$1 AND step_key='map' AND direction='input'`,
    [cycle],
  );
  await f.db.query(
    `INSERT INTO platform.contracts(workspace_id,key,version,digest,kind,schema_body) VALUES($1,'other',1,$2,'records','{}')`,
    [f.scope.workspace, h],
  );
  await f.db.query(
    `UPDATE platform.ports SET contract_key='other' WHERE version_id=$1 AND step_key='next' AND direction='input'`,
    [cycle],
  );
  await assert.rejects(f.metadata.publish(cycle), /incompatible/);
});

test("failure after artifact inserts rolls back artifact, bindings, checkpoint, event and task together", async (t) => {
  const f = await fixture(t),
    s = await seed(f),
    lease = await f.metadata.lease("worker", 30);
  assert.ok(lease);
  const path = join(f.root, "output");
  await writeFile(path, "safe");
  const output = {
    key: "commit",
    artifacts: [
      {
        id: randomUUID(),
        representation: s.representation,
        port: "out",
        uri: pathToFileURL(path).href,
        bytes: 4,
        checksum: digest("safe"),
        mediaType: "text/plain",
      },
    ],
    checkpoint: { cursor: { offset: 1 } },
  };
  await f.pg.exec(
    `CREATE FUNCTION platform.fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic commit failure'; END $$; CREATE TRIGGER fail_commit BEFORE INSERT ON platform.checkpoints FOR EACH ROW EXECUTE FUNCTION platform.fail_commit();`,
  );
  await assert.rejects(f.metadata.commit(lease, output), /synthetic commit failure/);
  for (const table of ["commits", "artifacts", "bindings", "checkpoints"])
    assert.equal(
      (await f.db.query("SELECT count(*)::integer n FROM platform." + table)).rows[0].n,
      0,
    );
  assert.equal(
    (await f.db.query("SELECT status FROM platform.tasks WHERE id=$1", [s.task.id])).rows[0].status,
    "leased",
  );
  await f.pg.exec("DROP TRIGGER fail_commit ON platform.checkpoints");
  await f.metadata.commit(lease, output);
  const audit = await f.metadata.verifyAudit();
  assert.ok(audit.count >= 4);
  assert.match(audit.head, /^[a-f0-9]{64}$/);
  await assert.rejects(f.db.query(`UPDATE platform.audit SET summary='{}'`), /immutable/);
});

test("tenant-scoped artifact references reject a foreign project and usage retains failed attempt costs", async (t) => {
  const f = await fixture(t),
    s = await seed(f),
    lease = await f.metadata.lease("worker", 30);
  assert.ok(lease);
  const other = randomUUID();
  await f.db.query("INSERT INTO platform.projects(workspace_id,id,name) VALUES($1,$2,$3)", [
    f.scope.workspace,
    other,
    "Other",
  ]);
  const dataset = randomUUID(),
    revision = randomUUID(),
    representation = randomUUID();
  await f.db.query(
    `INSERT INTO platform.datasets(workspace_id,project_id,id,key,name,kind,identity_strategy) VALUES($1,$2,$3,'other','Other','records','{}')`,
    [f.scope.workspace, other, dataset],
  );
  await f.db.query(
    `INSERT INTO platform.dataset_versions(workspace_id,project_id,dataset_id,id,number,content_hash,manifest_uri,record_count,byte_count) VALUES($1,$2,$3,$4,1,$5,'file:///other',1,4)`,
    [f.scope.workspace, other, dataset, revision, h],
  );
  await f.db.query(
    `INSERT INTO platform.representations(workspace_id,project_id,revision_id,id,format,format_version) VALUES($1,$2,$3,$4,'jsonl','1')`,
    [f.scope.workspace, other, revision, representation],
  );
  const path = join(f.root, "output");
  await writeFile(path, "safe");
  await assert.rejects(
    f.metadata.commit(lease, {
      key: "foreign",
      artifacts: [
        {
          id: randomUUID(),
          representation,
          port: "out",
          uri: pathToFileURL(path).href,
          bytes: 4,
          checksum: digest("safe"),
          mediaType: "text/plain",
        },
      ],
    }),
    /foreign key/,
  );
  await f.metadata.fail(lease, { code: "retry", message: "synthetic retry" });
  await f.metadata.usage(lease.attempt, {
    id: randomUUID(),
    resource: "tokens",
    quantity: 17,
    unit: "token",
    actualCost: 0.01,
    currency: "USD",
    pricingVersion: "fixture-1",
  });
  const next = await f.metadata.lease("worker", 30);
  assert.ok(next);
  assert.equal(next.fence, 2);
  assert.equal(
    (
      await f.db.query("SELECT quantity::text FROM platform.usage WHERE attempt_id=$1", [
        lease.attempt,
      ])
    ).rows[0].quantity,
    "17",
  );
  await assert.rejects(f.metadata.heartbeat(lease), /fenc/);
});

test("commit retries return their durable receipt after artifact storage becomes unavailable", async (t) => {
  const f = await fixture(t),
    s = await seed(f),
    lease = await f.metadata.lease("worker", 30);
  assert.ok(lease);
  const path = join(f.root, "output");
  await writeFile(path, "safe");
  const output = {
    key: "once",
    artifacts: [
      {
        id: randomUUID(),
        representation: s.representation,
        port: "out",
        uri: pathToFileURL(path).href,
        bytes: 4,
        checksum: digest("safe"),
        mediaType: "text/plain",
      },
    ],
  };
  const receipt = await f.metadata.commit(lease, output);
  await rm(path);
  assert.deepEqual(await f.metadata.commit(lease, output), receipt);
  const denied = new Metadata(f.db, { ...f.scope, principal: randomUUID() }, new Files(f.root));
  await assert.rejects(denied.commit(lease, output), /permission/);
});

test("step enumeration stays open until sealed and final commit completes the run", async (t) => {
  const f = await fixture(t),
    s = await seed(f);
  const first = await f.metadata.lease("worker", 30);
  assert.ok(first);
  const path = join(f.root, "first");
  await writeFile(path, "one");
  await f.metadata.commit(first, {
    key: "one",
    artifacts: [
      {
        id: randomUUID(),
        representation: s.representation,
        port: "out",
        uri: pathToFileURL(path).href,
        bytes: 3,
        checksum: digest("one"),
        mediaType: "text/plain",
      },
    ],
  });
  assert.equal(
    (await f.db.query("SELECT status FROM platform.step_runs WHERE id=$1", [first.stepRun])).rows[0]
      .status,
    "running",
  );
  await f.metadata.queue(s.run.id, "map", { key: "partition-1", partition: "1" });
  await f.metadata.seal(s.run.id, "map");
  await assert.rejects(f.metadata.queue(s.run.id, "map", { key: "late" }), /sealed|accepting/);
  const second = await f.metadata.lease("worker", 30);
  assert.ok(second);
  const next = join(f.root, "second");
  await writeFile(next, "two");
  await f.metadata.commit(second, {
    key: "two",
    artifacts: [
      {
        id: randomUUID(),
        representation: s.representation,
        port: "out",
        uri: pathToFileURL(next).href,
        bytes: 3,
        checksum: digest("two"),
        mediaType: "text/plain",
      },
    ],
  });
  assert.equal(
    (await f.db.query("SELECT status FROM platform.runs WHERE id=$1", [s.run.id])).rows[0].status,
    "completed",
  );
});

test("compiled workflow releases become normalized immutable PostgreSQL definitions", async (t) => {
  const f = await fixture(t),
    scope = { workspace: f.scope.workspace, project: f.scope.project, owner: f.scope.principal },
    registry = new Registry();
  const budget: Budget = {
    cpuMs: 100,
    memoryBytes: 1_000_000,
    storageBytes: 10_000,
    timeMs: 1000,
    tokens: 0,
    costMicros: 0,
    concurrency: 1,
  };
  const schema = { type: "object", properties: {}, required: [], additionalProperties: false };
  const contract = registry.registerContract({
    id: "record",
    version: 1,
    scope,
    kind: "record",
    format: "json",
    schema,
  });
  const adapter = registry.registerAdapter(
    { id: "local", version: 1, scope, artifact: h, capabilities: [] },
    () => ({ out: [{}] }),
  );
  const ports = {
    inputs: {},
    outputs: { out: { contract, required: true, cardinality: "one" as const } },
  };
  const type = registry.registerType({
    id: "map",
    version: 1,
    scope,
    category: "map",
    config: schema,
    adapter,
    capabilities: [],
    ports,
    bindings: {},
  });
  await f.db.query(
    `INSERT INTO platform.contracts(workspace_id,key,version,digest,kind,schema_body) VALUES($1,'record',1,$2,'record',$3::jsonb)`,
    [f.scope.workspace, contract.digest, JSON.stringify(schema)],
  );
  await f.db.query(
    `INSERT INTO platform.adapters(workspace_id,key,version,digest,runtime,artifact_uri,artifact_digest,capabilities,isolation) VALUES($1,'local',1,$2,'process','file:///synthetic',$2,'[]','{"filesystem":"none"}')`,
    [f.scope.workspace, adapter.digest],
  );
  await f.db.query(
    `INSERT INTO platform.step_types(workspace_id,key,version,digest,adapter_key,adapter_version,category,configuration_schema,input_ports,output_ports,modes) VALUES($1,'map',1,$2,'local',1,'map',$3::jsonb,'{}',$4::jsonb,ARRAY['batch'])`,
    [f.scope.workspace, type.digest, JSON.stringify(schema), JSON.stringify(ports.outputs)],
  );
  const definition = {
    format: "workflow/1",
    id: "compiled",
    version: 1,
    scope,
    name: "Compiled",
    budget,
    stages: [{ id: "main", name: "Main", budget }],
    steps: [{ id: "map", stage: "main", type, config: {}, pins: {}, budget }],
    edges: [],
  };
  const policy = { scope, capabilities: [], budget, grants: [] };
  const workflow = Workflow.publish(definition, registry, policy);
  const saved = await f.metadata.define(workflow);
  assert.equal(saved.hash, workflow.digest);
  assert.deepEqual(await f.metadata.define(workflow), saved);
  assert.equal(
    (
      await f.db.query("SELECT count(*)::integer n FROM platform.ports WHERE version_id=$1", [
        saved.id,
      ])
    ).rows[0].n,
    1,
  );
  await f.metadata.publish(saved.id);
  const run = await f.metadata.run(saved.id, { mode: "batch", configuration: h });
  assert.equal(
    (
      await f.db.query("SELECT count(*)::integer n FROM platform.step_runs WHERE run_id=$1", [
        run.id,
      ])
    ).rows[0].n,
    1,
  );
  const changed = Workflow.publish({ ...definition, name: "Changed" }, registry, policy);
  await assert.rejects(f.metadata.define(changed), /version|immutable/);
});

test("caller mutation during artifact verification cannot change the committed descriptor or idempotency hash", async (t) => {
  const f = await fixture(t),
    s = await seed(f),
    lease = await f.metadata.lease("worker", 30);
  assert.ok(lease);
  const path = join(f.root, "verified");
  await writeFile(path, "safe");
  let release!: () => void, ready!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    verified = new Promise<void>((r) => (ready = r));
  const files = new Files(f.root),
    metadata = new Metadata(f.db, f.scope, {
      async verify(artifact) {
        await files.verify(artifact);
        ready();
        await gate;
      },
    });
  const output = {
    key: "safe",
    artifacts: [
      {
        id: randomUUID(),
        representation: s.representation,
        port: "out",
        uri: pathToFileURL(path).href,
        bytes: 4,
        checksum: digest("safe"),
        mediaType: "text/plain",
      },
    ],
  };
  const original = structuredClone(output),
    pending = metadata.commit(lease, output);
  await verified;
  output.key = "tampered";
  output.artifacts[0] = {
    ...output.artifacts[0],
    uri: "file:///not-verified",
    bytes: 999,
    checksum: h,
  };
  release();
  const receipt = await pending;
  assert.equal(receipt.key, "safe");
  const saved = (await f.db.query("SELECT uri,bytes::integer,checksum FROM platform.artifacts"))
    .rows[0];
  assert.deepEqual(saved, {
    uri: original.artifacts[0].uri,
    bytes: 4,
    checksum: original.artifacts[0].checksum,
  });
  assert.deepEqual(await metadata.commit(lease, original), receipt);
});

test("a composed metadata transaction rolls back direct registry rows when publication fails", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.metadata.transaction(async (metadata, sql) => {
      await sql.query(
        `INSERT INTO platform.contracts(workspace_id,key,version,digest,kind,schema_body) VALUES($1,'temporary',1,$2,'record','{}')`,
        [f.scope.workspace, h],
      );
      await metadata.publish(randomUUID());
    }),
    /unknown workflow/,
  );
  assert.equal(
    (await f.db.query("SELECT count(*)::integer n FROM platform.contracts")).rows[0].n,
    0,
  );
});
