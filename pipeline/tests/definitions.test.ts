/// <reference types="emscripten" />
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  Files,
  Metadata,
  digest,
  type Database,
  type Sql,
  type Result,
  type Scope,
} from "../metadata.ts";
import { Registry, type Budget, type Definition, type Policy, type Resource } from "../workflow.ts";
import { Definitions } from "../definitions.ts";

const hash = "a".repeat(64);
const budget: Budget = {
  cpuMs: 100,
  memoryBytes: 1_000_000,
  storageBytes: 10_000,
  timeMs: 1_000,
  tokens: 0,
  costMicros: 0,
  concurrency: 1,
};
const schema = { type: "object", properties: {}, required: [], additionalProperties: false };

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
      const result = await client.query<T>(query, [...params]);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  });
  const db: Database = { ...wrap(pg), transaction: (fn) => pg.transaction((tx) => fn(wrap(tx))) };
  const scope: Scope = { workspace: randomUUID(), project: randomUUID(), principal: randomUUID() };
  await db.query("INSERT INTO platform.workspaces(id,name,slug) VALUES($1,'Test',$2)", [
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
  await db.query("INSERT INTO platform.projects(workspace_id,id,name) VALUES($1,$2,'Fixture')", [
    scope.workspace,
    scope.project,
  ]);
  for (const permission of ["view", "configure", "publish", "execute"])
    await db.query(
      "INSERT INTO platform.grants(workspace_id,project_id,principal_id,permission) VALUES($1,$2,$3,$4)",
      [scope.workspace, scope.project, scope.principal, permission],
    );
  const owner = { workspace: scope.workspace, project: scope.project, owner: scope.principal };
  const policy: Policy = {
    scope: owner,
    budget,
    grants: [],
    capabilities: ["model.invoke", "prompt.read", "rule.read", "resource.read", "data.read"],
  };
  const trusted = new Registry();
  const contract = trusted.registerContract({
    id: "record",
    version: 1,
    scope: owner,
    kind: "record",
    format: "json",
    schema,
  });
  const adapter = trusted.registerAdapter(
    { id: "local", version: 1, scope: owner, artifact: hash, capabilities: [] },
    () => ({ out: [{}] }),
  );
  const type = trusted.registerType({
    id: "map",
    version: 1,
    scope: owner,
    category: "map",
    config: schema,
    adapter,
    capabilities: [],
    ports: { inputs: {}, outputs: { out: { contract, required: true, cardinality: "one" } } },
    bindings: {},
  });
  const workflow: Definition = {
    format: "workflow/1",
    id: "demo",
    version: 1,
    scope: owner,
    name: "Demo",
    budget,
    stages: [{ id: "main", name: "Main", budget }],
    steps: [{ id: "map", stage: "main", type, config: {}, pins: {}, budget }],
    edges: [],
  };
  const root = await mkdtemp(join(tmpdir(), "definitions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadata = new Metadata(db, scope, new Files(root));
  const definitions = new Definitions(metadata, trusted, policy);
  const document = () => ({
    format: "platform-definition/1",
    registry: trusted.manifest(),
    workflow: structuredClone(workflow),
  });
  const resource = (id: string, kind: Resource["kind"], body: Resource["body"]) =>
    trusted.registerResource({ id, kind, body, scope: owner, version: 1 });
  const count = async (table: string) =>
    (await db.query("SELECT count(*)::integer n FROM platform." + table)).rows[0].n;
  return {
    pg,
    db,
    root,
    scope,
    owner,
    policy,
    trusted,
    contract,
    adapter,
    workflow,
    metadata,
    definitions,
    document,
    resource,
    count,
  };
}

test("JSON publication provisions normalized registries and reopens immutable releases with trusted handlers", async (t) => {
  const f = await fixture(t);
  const document = JSON.parse(JSON.stringify(f.document()));
  const saved = await f.definitions.publish(document);
  assert.match(saved.id, /^[a-f0-9-]{36}$/);
  assert.equal(await f.count("contracts"), 1);
  assert.equal(await f.count("adapters"), 1);
  assert.equal(await f.count("step_types"), 1);
  assert.equal(await f.count("steps"), 1);
  assert.equal(await f.count("ports"), 1);
  assert.deepEqual(await f.definitions.publish(document), saved);
  const opened = await f.definitions.open(saved.id);
  const run = await opened.workflow.run(opened.registry);
  assert.equal(run.state, "completed");
  assert.deepEqual(await f.definitions.list(), [
    {
      id: saved.id,
      workflow: "demo",
      version: 1,
      name: "Demo",
      hash: saved.hash,
      status: "published",
    },
  ]);
  const persisted = (
    await f.db.query(
      "SELECT execution_policy,compiled_release FROM platform.workflow_versions WHERE id=$1",
      [saved.id],
    )
  ).rows[0];
  assert.deepEqual(
    (persisted.execution_policy as { registry: unknown }).registry,
    document.registry,
  );
  assert.equal((persisted.compiled_release as { digest: string }).digest, saved.hash);
});

test("resource bodies provision model, prompt, rule, schema and published dataset relationships", async (t) => {
  const f = await fixture(t),
    dataset = randomUUID(),
    revision = randomUUID();
  await f.db.query(
    "INSERT INTO platform.datasets(workspace_id,project_id,id,key,name,kind,identity_strategy) VALUES($1,$2,$3,'input','Input','records','{}')",
    [f.scope.workspace, f.scope.project, dataset],
  );
  await f.db.query(
    "INSERT INTO platform.dataset_versions(workspace_id,project_id,dataset_id,id,number,content_hash,manifest_uri,record_count,byte_count,state) VALUES($1,$2,$3,$4,1,$5,'file:///synthetic',0,0,'published')",
    [f.scope.workspace, f.scope.project, dataset, revision, hash],
  );
  f.resource("model", "model", {
    provider: "local",
    model: "synthetic",
    capabilities: ["text"],
    modalities: ["text"],
    parameters: {},
    context: { tokens: 1024 },
  });
  f.resource("prompt", "prompt", {
    template: "Classify {{text}}",
    variables: { text: "string" },
    contract: f.contract,
  });
  f.resource("rule", "rule", {
    language: "json-logic",
    expression: { "==": [1, 1] },
    input: f.contract,
    output: f.contract,
    config: {},
  });
  f.resource("schema", "schema", { type: "json-schema", schema, compatibility: {} });
  f.resource("input", "dataset", { revision });
  await f.definitions.publish(f.document());
  assert.equal(await f.count("resources"), 5);
  for (const table of ["models", "prompts", "logic", "schemas", "dataset_resources"])
    assert.equal(await f.count(table), 1);
  assert.equal(
    (await f.db.query("SELECT model_key FROM platform.models")).rows[0].model_key,
    "synthetic",
  );
  assert.equal(
    (await f.db.query("SELECT revision_id FROM platform.dataset_resources")).rows[0].revision_id,
    revision,
  );
});

test("a missing publication grant rolls back every provisioned registry and workflow row", async (t) => {
  const f = await fixture(t);
  await f.db.query("DELETE FROM platform.grants WHERE permission='publish'");
  await assert.rejects(f.definitions.publish(f.document()), /permission.*publish/);
  for (const table of [
    "contracts",
    "adapters",
    "step_types",
    "workflows",
    "workflow_versions",
    "audit",
  ])
    assert.equal(await f.count(table), 0);
});

test("bad graphs and unsupported resource bodies leave no provisioned rows", async (t) => {
  const f = await fixture(t),
    invalid = f.document();
  invalid.workflow.steps[0].stage = "missing";
  await assert.rejects(f.definitions.publish(invalid), /stage/i);
  f.resource("model", "model", { endpoint: "https://unapproved.invalid", command: "execute" });
  await assert.rejects(f.definitions.publish(f.document()), /model.*fields|model body/);
  for (const table of ["contracts", "adapters", "step_types", "resources", "workflows"])
    assert.equal(await f.count(table), 0);
});

test("documents cannot grant authority, cross scope or install adapter execution paths", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.definitions.publish({ ...f.document(), policy: f.policy }), /fields/);
  const foreign = f.document();
  foreign.workflow.scope.project = randomUUID();
  await assert.rejects(f.definitions.publish(foreign), /scope|authoriz/);
  const bad = JSON.parse(JSON.stringify(f.document()));
  bad.registry.adapters[0].module = "/tmp/arbitrary.ts";
  await assert.rejects(f.definitions.publish(bad), /fields|adapter/);
  assert.equal(await f.count("adapters"), 0);
});

test("registry versions and workflow versions cannot be rebound to changed contents", async (t) => {
  const f = await fixture(t),
    saved = await f.definitions.publish(f.document());
  const changed = f.document();
  changed.workflow.name = "Changed";
  await assert.rejects(f.definitions.publish(changed), /immutable|version/);
  const second = JSON.parse(JSON.stringify(f.document()));
  second.workflow.version = 2;
  (second.registry.contracts as unknown as { kind: string }[])[0].kind = "different";
  await assert.rejects(f.definitions.publish(second), /immutable|digest|reference/);
  assert.equal(await f.count("workflow_versions"), 1);
  assert.equal((await f.definitions.open(saved.id)).workflow.digest, saved.hash);
});

test("read access requires view permission and does not require configure permission", async (t) => {
  const f = await fixture(t),
    saved = await f.definitions.publish(f.document());
  await f.db.query("DELETE FROM platform.grants WHERE permission IN ('configure','publish')");
  assert.equal((await f.definitions.list()).length, 1);
  assert.equal((await f.definitions.open(saved.id)).workflow.digest, saved.hash);
  await assert.rejects(f.definitions.publish(f.document()), /permission.*configure/);
  await f.db.query("DELETE FROM platform.grants WHERE permission='view'");
  await assert.rejects(f.definitions.list(), /permission.*view/);
  await assert.rejects(f.definitions.open(saved.id), /permission.*view/);
});

test("dataset, artifact and connection pins require existing scoped published resources", async (t) => {
  for (const kind of ["dataset", "artifact", "connection"] as const) {
    const f = await fixture(t);
    f.resource("missing", kind, { [kind === "dataset" ? "revision" : kind]: randomUUID() });
    await assert.rejects(f.definitions.publish(f.document()), /unknown|published|active|scope/);
    assert.equal(await f.count("resources"), 0);
    assert.equal(await f.count("contracts"), 0);
  }
});

test("artifact resources bind a committed receipt without manufacturing artifact records", async (t) => {
  const f = await fixture(t),
    first = await f.definitions.publish(f.document());
  const dataset = randomUUID(),
    revision = randomUUID(),
    representation = randomUUID();
  await f.db.query(
    "INSERT INTO platform.datasets(workspace_id,project_id,id,key,name,kind,identity_strategy) VALUES($1,$2,$3,'output','Output','records','{}')",
    [f.scope.workspace, f.scope.project, dataset],
  );
  await f.db.query(
    "INSERT INTO platform.dataset_versions(workspace_id,project_id,dataset_id,id,number,content_hash,manifest_uri,record_count,byte_count,state) VALUES($1,$2,$3,$4,1,$5,'file:///synthetic',1,4,'published')",
    [f.scope.workspace, f.scope.project, dataset, revision, hash],
  );
  await f.db.query(
    "INSERT INTO platform.representations(workspace_id,project_id,revision_id,id,format,format_version) VALUES($1,$2,$3,$4,'json','1')",
    [f.scope.workspace, f.scope.project, revision, representation],
  );
  const run = await f.metadata.run(first.id, { mode: "batch", configuration: hash });
  await f.metadata.queue(run.id, "map", { key: "synthetic" });
  const lease = await f.metadata.lease("test", 30);
  assert.ok(lease);
  const artifact = randomUUID(),
    path = join(f.root, "artifact");
  await writeFile(path, "safe");
  await f.metadata.commit(lease, {
    key: "result",
    artifacts: [
      {
        id: artifact,
        representation,
        port: "out",
        uri: pathToFileURL(path).href,
        bytes: 4,
        checksum: digest("safe"),
        mediaType: "text/plain",
      },
    ],
  });
  f.resource("prior", "artifact", { artifact });
  const next = f.document();
  next.workflow.version = 2;
  await f.definitions.publish(next);
  assert.equal(await f.count("artifacts"), 1);
  assert.equal(
    (await f.db.query("SELECT artifact_id FROM platform.artifact_resources")).rows[0].artifact_id,
    artifact,
  );
});

test("credentialed connection references require secret-use permission inside the publication transaction", async (t) => {
  const f = await fixture(t);
  await f.definitions.publish(f.document());
  const connection = randomUUID(),
    credential = randomUUID();
  await f.db.query(
    "INSERT INTO platform.connector_types(workspace_id,key,version,digest,kind,configuration_schema,operations,authentication,capabilities,adapter_key,adapter_version) VALUES($1,'local',1,$2,'local','{}',ARRAY['read'],ARRAY['reference'],'[]','local',1)",
    [f.scope.workspace, hash],
  );
  await f.db.query(
    "INSERT INTO platform.credentials(workspace_id,id,provider,secret_ref,access_policy) VALUES($1,$2,'local','vault:synthetic','{}')",
    [f.scope.workspace, credential],
  );
  await f.db.query(
    "INSERT INTO platform.connections(workspace_id,id,connector_key,connector_version,name,configuration,credential_id,status) VALUES($1,$2,'local',1,'Synthetic','{}',$3,'active')",
    [f.scope.workspace, connection, credential],
  );
  f.resource("source", "connection", { connection });
  const next = f.document();
  next.workflow.version = 2;
  await assert.rejects(f.definitions.publish(next), /permission.*secret-use/);
  assert.equal(await f.count("resources"), 0);
  assert.equal(await f.count("workflow_versions"), 1);
  await f.db.query(
    "INSERT INTO platform.grants(workspace_id,project_id,principal_id,permission) VALUES($1,$2,$3,'secret-use')",
    [f.scope.workspace, f.scope.project, f.scope.principal],
  );
  await f.definitions.publish(next);
  assert.equal(
    (await f.db.query("SELECT connection_id FROM platform.connection_resources")).rows[0]
      .connection_id,
    connection,
  );
});

test("reusing a resource identity with different contents rejects the complete new version", async (t) => {
  const f = await fixture(t);
  f.resource("prompt", "prompt", { template: "Original", variables: {}, contract: f.contract });
  await f.definitions.publish(f.document());
  const changed = JSON.parse(JSON.stringify(f.document()));
  changed.workflow.version = 2;
  changed.registry.resources[0].body.template = "Changed";
  await assert.rejects(f.definitions.publish(changed), /immutable.*resources/);
  assert.equal(await f.count("workflow_versions"), 1);
  assert.equal(
    (await f.db.query("SELECT template FROM platform.prompts")).rows[0].template,
    "Original",
  );
});

test("publication snapshots pure JSON and rejects accessors without invoking them", async (t) => {
  const f = await fixture(t),
    document = JSON.parse(JSON.stringify(f.document()));
  const pending = f.definitions.publish(document);
  document.workflow.name = "Mutated";
  const saved = await pending;
  assert.equal((await f.definitions.open(saved.id)).workflow.definition.name, "Demo");
  let touched = false;
  const accessor = Object.defineProperty({}, "format", {
    enumerable: true,
    get() {
      touched = true;
      return "platform-definition/1";
    },
  });
  await assert.rejects(f.definitions.publish(accessor), /accessors/);
  assert.equal(touched, false);
});
