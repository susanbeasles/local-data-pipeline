import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { Catalog } from "../catalog.ts";
import { Dataset } from "../dataset.ts";
import { library } from "../capabilities.ts";
import { Workflow, type Budget, type Definition, type Policy, type Context } from "../workflow.ts";

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "capabilities-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const raw = join(root, "raw");
  await mkdir(raw);
  const db = new DatabaseSync(join(raw, "data.sqlite"));
  db.exec(
    "CREATE TABLE docs(id TEXT PRIMARY KEY,text TEXT); INSERT INTO docs VALUES('a','alpha'),('b','alpha'),('c','beta')",
  );
  db.close();
  const dataset = new Dataset(join(root, "operator/datasets"));
  t.after(() => dataset.close());
  const catalog = new Catalog(
    [{ id: "fixture", name: "Synthetic", kind: "sqlite", root: raw, database: "data.sqlite" }],
    join(root, "operator"),
  );
  const scope = { workspace: randomUUID(), project: randomUUID(), owner: randomUUID() },
    connection = randomUUID();
  const lib = await library(scope, { catalog, dataset, connections: { [connection]: "fixture" } });
  const source = lib.registry.registerResource({
    id: "source",
    version: 1,
    scope,
    kind: "connection",
    body: { connection },
  });
  const small: Budget = {
      cpuMs: 10000,
      memoryBytes: 1024 ** 2,
      storageBytes: 1024 ** 2,
      timeMs: 30000,
      tokens: 0,
      costMicros: 0,
      concurrency: 1,
    },
    large = {
      ...small,
      cpuMs: 100000,
      memoryBytes: 8 * 1024 ** 2,
      storageBytes: 8 * 1024 ** 2,
      timeMs: 120000,
    };
  const policy: Policy = {
    scope,
    capabilities: ["data.read", "data.write", "resource.read"],
    budget: large,
    grants: [],
  };
  return { root, raw, dataset, catalog, scope, connection, lib, source, small, large, policy };
}

test("real catalog capture and revision transforms consume either SQLite or JSONL ports", async (t) => {
  const f = await fixture(t),
    before = await readFile(join(f.raw, "data.sqlite"));
  const definition: Definition = {
    format: "workflow/1",
    id: "review",
    version: 1,
    scope: f.scope,
    name: "Review",
    budget: f.large,
    stages: [{ id: "main", name: "Main", budget: f.large }],
    steps: [
      {
        id: "capture",
        stage: "main",
        type: f.lib.types["dataset.capture"],
        config: { table: "docs", name: "Captured" },
        pins: { source: f.source },
        budget: f.small,
      },
      {
        id: "clean",
        stage: "main",
        type: f.lib.types["dataset.transform"],
        config: {
          name: "Clean",
          steps: JSON.stringify([
            { op: "dedupe", paths: ["$.text"] },
            { op: "set", path: "$.reviewed", value: true },
          ]),
          pauseOnFailure: true,
        },
        pins: {},
        budget: f.small,
      },
      {
        id: "audit",
        stage: "main",
        type: f.lib.types["dataset.verify"],
        config: {},
        pins: {},
        budget: f.small,
      },
    ],
    edges: [
      {
        id: "one",
        from: { step: "capture", port: "sqlite" },
        to: { step: "clean", port: "sqlite" },
      },
      { id: "two", from: { step: "clean", port: "jsonl" }, to: { step: "audit", port: "jsonl" } },
    ],
  };
  const workflow = Workflow.publish(definition, f.lib.registry, f.policy),
    run = await workflow.run(f.lib.registry);
  assert.equal(run.state, "completed");
  const handle = run.outputs.audit.jsonl[0] as { revision: string; count: number; hash: string };
  assert.equal(handle.count, 2);
  assert.equal((await f.dataset.verify(handle.revision)).intact, true);
  assert.equal(
    f.dataset.page(handle.revision).records[0].body &&
      (f.dataset.page(handle.revision).records[0].body as any).reviewed,
    true,
  );
  assert.deepEqual(await readFile(join(f.raw, "data.sqlite")), before);
  assert.equal(f.dataset.revisions().length, 2);
});

test("handler retries reuse the same complete dataset operation and unknown bindings fail", async (t) => {
  const f = await fixture(t);
  const type = f.lib.registry.type(f.lib.types["dataset.capture"]),
    handler = f.lib.registry.executor(type.adapter as any);
  const context = {
    run: randomUUID(),
    step: "capture",
    config: { table: "docs", name: "Full" },
    pins: { source: { body: { connection: f.connection } } },
    budget: f.small,
    signal: new AbortController().signal,
  } as unknown as Context;
  const first = await handler(context),
    second = await handler(context);
  assert.deepEqual(first, second);
  assert.equal(f.dataset.revisions().length, 1);
  await assert.rejects(
    Promise.resolve().then(() =>
      handler({
        ...context,
        pins: { source: { body: { connection: randomUUID() } } },
      } as unknown as Context),
    ),
    /connection|binding/,
  );
});

test("model operators fail closed without an admitted resident local model", async (t) => {
  const f = await fixture(t),
    type = f.lib.registry.type(f.lib.types["model.infer"]),
    handler = f.lib.registry.executor(type.adapter as any);
  await assert.rejects(
    Promise.resolve().then(() =>
      handler({
        config: { role: "tag", payload: "$.payload" },
        pins: {},
        inputs: {},
        signal: new AbortController().signal,
      } as unknown as Context),
    ),
    /resident|model/,
  );
});

import { annotate } from "../proof.ts";
import { order, type Role } from "../roles.ts";
import type { Request } from "../run.ts";
const answers: Record<Role, unknown> = {
  tag: { tags: ["synthetic"] },
  classify: {
    namespace: "fixture",
    system: "fixture",
    kind: "guide",
    domain: "documentation",
    lifecycle: "current",
    sensitivity: "internal",
    history: "reference",
    function: "guide",
    confidence: "explicit",
    unknowns: [],
  },
  summarize: { summary: "Synthetic fixture", facts: [], unknowns: [] },
  knowledge: { entities: [], claims: [], unknowns: [] },
  reconcile: { groups: [], unknowns: [] },
  connect: { edges: [], unknowns: [] },
};
function measured(request: Request) {
  return annotate(structuredClone(answers[request.role as Role]), {
    id: request.id,
    role: request.role,
    phases: [
      { phase: "presence", inputTokens: 7, outputTokens: 2 },
      { phase: "extract", inputTokens: 11, outputTokens: 3 },
    ],
  });
}
async function modelFixture(t: TestContext, infer: (request: Request) => Promise<unknown>) {
  const f = await fixture(t);
  const lib = await library(f.scope, {
    catalog: f.catalog,
    dataset: f.dataset,
    infer,
    modelKey: "fixture",
    concurrency: 2,
  });
  const revision = await f.dataset.capture(
    "Synthetic payloads",
    ["a", "b", "c"].map((id) => ({
      id,
      source: "synthetic",
      key: id,
      body: {
        payload: {
          spans: [{ id: 0, text: id }],
          context: { trustedNamespace: "fixture", candidates: { members: [], evidence: [] } },
        },
      },
    })),
  );
  const budget = { ...f.large, tokens: 1000, concurrency: 2 };
  const handler = lib.registry.executor(lib.registry.type(lib.types["model.infer"]).adapter!);
  const charges: number[] = [];
  const context = {
    run: randomUUID(),
    step: "infer",
    workflow: { digest: "a".repeat(64) },
    config: { role: "tag", payload: "$.payload", name: "Enriched" },
    pins: { model: { body: { provider: "mlx", model: "fixture" } } },
    inputs: { jsonl: [{ revision: revision.id, count: revision.count, hash: revision.hash }] },
    budget,
    signal: new AbortController().signal,
    charge: (value: { tokens?: number }) => charges.push(value.tokens!),
  } as unknown as Context;
  return { ...f, lib, revision, budget, handler, context, charges };
}

test("all six model adapters retain measured tokens and attributable outcomes in an ordered graph", async (t) => {
  const requests: Request[] = [];
  const f = await modelFixture(t, async (request) => {
    requests.push(request);
    return measured(request);
  });
  const seed = f.lib.registry.registerAdapter(
    {
      id: "fixture.seed",
      version: 1,
      scope: f.scope,
      artifact: "b".repeat(64),
      capabilities: ["data.read"],
    },
    () => ({
      jsonl: [{ revision: f.revision.id, count: f.revision.count, hash: f.revision.hash }],
    }),
  );
  const seedType = f.lib.registry.registerType({
    id: "fixture.seed",
    version: 1,
    scope: f.scope,
    category: "fixture",
    adapter: seed,
    capabilities: ["data.read"],
    bindings: {},
    config: { type: "object", properties: {}, required: [], additionalProperties: false },
    ports: {
      inputs: {},
      outputs: { jsonl: { contract: f.lib.contracts.jsonl, required: true, cardinality: "one" } },
    },
  });
  const model = f.lib.registry.registerResource({
    id: "fixture.model",
    version: 1,
    scope: f.scope,
    kind: "model",
    body: { provider: "mlx", model: "fixture" },
  });
  const total = {
    ...f.budget,
    cpuMs: 1000000,
    memoryBytes: 64 * 1024 ** 2,
    storageBytes: 64 * 1024 ** 2,
    timeMs: 1000000,
    tokens: 10000,
    concurrency: 2,
  };
  const definition: Definition = {
    format: "workflow/1",
    id: "six-roles",
    version: 1,
    scope: f.scope,
    name: "Synthetic six roles",
    budget: total,
    stages: [{ id: "main", name: "Main", budget: total }],
    steps: [
      {
        id: "seed",
        stage: "main",
        type: seedType,
        config: {},
        pins: {},
        budget: { ...f.budget, memoryBytes: 65536 },
      },
      ...order.map((role) => ({
        id: role,
        stage: "main",
        type: f.lib.types["model.infer"],
        config: { role, payload: "$.payload", name: role },
        pins: { model },
        budget: { ...f.budget, memoryBytes: 65536 },
      })),
    ],
    edges: order.map((role, index) => ({
      id: role,
      from: { step: index ? order[index - 1] : "seed", port: "jsonl" },
      to: { step: role, port: "jsonl" },
    })),
  };
  const workflow = Workflow.publish(definition, f.lib.registry, {
    ...f.policy,
    budget: total,
    capabilities: ["data.read", "data.write", "model.invoke"],
  });
  const result = await workflow.run(f.lib.registry);
  assert.equal(result.state, "completed", JSON.stringify(result));
  assert.equal(requests.length, 18);
  const handle = result.outputs.connect.jsonl[0] as { revision: string };
  for (const record of f.dataset.page(handle.revision).records) {
    const body = record.body as any;
    assert.deepEqual(Object.keys(body.enrichment).sort(), [...order].sort());
    for (const role of order) {
      assert.deepEqual(body.enrichment[role], answers[role]);
      assert.equal(body.inference[role].tokens, 23);
      assert.equal(body.inference[role].proof.role, role);
    }
  }
  for (const step of result.steps.filter((step) => step.step !== "seed"))
    assert.equal(step.usage.tokens, 69);
  assert.equal(result.usage.tokens, 414);
});

test("model retry reuses verified prefix and complete revisions without repeating inference", async (t) => {
  let calls = 0,
    interrupt = true;
  const f = await modelFixture(t, async (request) => {
    calls++;
    if (interrupt && calls === 2) throw Error("interrupted fixture");
    return measured(request);
  });
  const context = { ...f.context, budget: { ...f.budget, concurrency: 1 } };
  await assert.rejects(Promise.resolve(f.handler(context)), /interrupted fixture/);
  assert.deepEqual(f.charges, [23]);
  interrupt = false;
  const first = await f.handler(context);
  assert.equal(calls, 4);
  assert.deepEqual(f.charges, [23, 23, 23]);
  assert.deepEqual(await f.handler(context), first);
  assert.equal(calls, 4);
  await assert.rejects(
    Promise.resolve(
      f.handler({ ...context, workflow: { ...context.workflow, digest: "c".repeat(64) } }),
    ),
    /provenance mismatch/,
  );
});

test("model callbacks require measured proof and charge invalid role outputs before failing", async (t) => {
  const f = await modelFixture(t, async () => ({ tags: [] }));
  await assert.rejects(Promise.resolve(f.handler(f.context)), /measured inference proof/);
  assert.deepEqual(f.charges, []);
  const g = await modelFixture(t, async (request) =>
    annotate(
      { invalid: true },
      { id: request.id, role: request.role, phases: [{ inputTokens: 9, outputTokens: 2 }] },
    ),
  );
  await assert.rejects(Promise.resolve(g.handler(g.context)), /packaged role contract/);
  assert.deepEqual(g.charges, [11, 11]);
  const before = g.charges.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(g.charges.length, before);
});

test("model checkpoints reject altered saved rows and changed pinned input before replay", async (t) => {
  let calls = 0;
  const f = await modelFixture(t, async (request) => {
    if (++calls === 2) throw Error("fixture stop");
    return measured(request);
  });
  const context = { ...f.context, budget: { ...f.budget, concurrency: 1 } };
  await assert.rejects(Promise.resolve(f.handler(context)), /fixture stop/);
  const changed = await f.dataset.capture("Changed synthetic input", [
    {
      id: "a",
      source: "synthetic",
      key: "a",
      body: { payload: { spans: [{ id: 0, text: "altered" }] } },
    },
  ]);
  await assert.rejects(
    Promise.resolve(
      f.handler({
        ...context,
        inputs: { jsonl: [{ revision: changed.id, count: changed.count, hash: changed.hash }] },
      }),
    ),
    /provenance mismatch/,
  );
  assert.equal(calls, 2);
  const database = new DatabaseSync(join(f.dataset.root, "dataset.sqlite"));
  database.prepare("UPDATE draft_items SET body=? WHERE id='a'").run('{"changed":true}');
  database.close();
  await assert.rejects(Promise.resolve(f.handler(context)), /integrity|digest/);
  assert.equal(calls, 2);
});
