import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  Registry,
  Workflow,
  type Definition,
  type Scope,
  type Budget,
  type Policy,
  type Ref,
  type Json,
  type Handler,
  type Port,
  type Schema,
} from "../workflow.ts";

const scope: Scope = { workspace: "workspace", project: "project", owner: "operator" };
const small: Budget = {
  cpuMs: 1000,
  memoryBytes: 1024 ** 2,
  storageBytes: 16384,
  timeMs: 1000,
  tokens: 100,
  costMicros: 1000,
  concurrency: 1,
};
const large: Budget = {
  cpuMs: 100000,
  memoryBytes: 16 * 1024 ** 2,
  storageBytes: 1024 ** 2,
  timeMs: 100000,
  tokens: 10000,
  costMicros: 100000,
  concurrency: 10,
};
const policy: Policy = {
  scope,
  capabilities: ["data.read", "data.write", "model.invoke", "prompt.read", "rule.read"],
  budget: large,
  grants: [],
};
const empty: Schema = { type: "object", properties: {}, required: [], additionalProperties: false };
const record: Schema = {
  type: "object",
  properties: { id: { type: "string" }, text: { type: "string" } },
  required: ["id", "text"],
  additionalProperties: false,
};
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const clone = <T>(value: T): T => structuredClone(value);
const port = (contract: Ref, cardinality: Port["cardinality"] = "one", required = true): Port => ({
  contract,
  cardinality,
  required,
});

export function fixture() {
  const registry = new Registry();
  const json = registry.registerContract({
    id: "record",
    version: 1,
    scope,
    kind: "record",
    format: "json",
    schema: record,
  });
  const text = registry.registerContract({
    id: "text",
    version: 1,
    scope,
    kind: "record",
    format: "jsonl",
    schema: { type: "string" },
  });
  const summarySchema: Schema = {
    type: "object",
    properties: {
      ids: { type: "array", items: { type: "string" } },
      count: { type: "integer", minimum: 0 },
    },
    required: ["ids", "count"],
    additionalProperties: false,
  };
  const summary = registry.registerContract({
    id: "summary",
    version: 1,
    scope,
    kind: "summary",
    format: "json",
    schema: summarySchema,
  });
  const count = registry.registerContract({
    id: "count",
    version: 1,
    scope,
    kind: "count",
    format: "json",
    schema: { type: "integer", minimum: 0 },
  });
  const report = registry.registerContract({
    id: "report",
    version: 1,
    scope,
    kind: "report",
    format: "json",
    schema: {
      type: "object",
      properties: { summary: summarySchema, representations: { type: "integer" } },
      required: ["summary", "representations"],
      additionalProperties: false,
    },
  });
  const adapter = (id: string, capabilities: Policy["capabilities"], handler: Handler) =>
    registry.registerAdapter(
      { id, version: 1, scope, artifact: hash("synthetic trusted adapter: " + id), capabilities },
      handler,
    );
  const sourceAdapter = adapter("fixture-reader", ["data.read"], ({ pins }) => ({
    json: [pins.source.body],
    text: [JSON.stringify(pins.source.body) + "\n"],
  }));
  const source = registry.registerType({
    id: "fixture-source",
    version: 1,
    scope,
    category: "ingest",
    config: empty,
    adapter: sourceAdapter,
    capabilities: ["data.read"],
    ports: { inputs: {}, outputs: { json: port(json), text: port(text) } },
    bindings: { source: { kind: "dataset", required: true } },
  });
  const inferAdapter = adapter(
    "fixture-inference",
    ["model.invoke", "prompt.read", "rule.read"],
    ({ inputs, pins, charge }) => {
      assert.equal(
        pins.model.body && (pins.model.body as Record<string, Json>).provider,
        "synthetic",
      );
      charge({ tokens: 10, costMicros: 0 });
      const ids = inputs.records.map((row) => (row as Record<string, Json>).id);
      return { summary: [{ ids, count: ids.length }] };
    },
  );
  const infer = registry.registerType({
    id: "fixture-infer",
    version: 1,
    scope,
    category: "infer",
    config: empty,
    adapter: inferAdapter,
    capabilities: ["model.invoke", "prompt.read", "rule.read"],
    ports: { inputs: { records: port(json, "many") }, outputs: { summary: port(summary) } },
    bindings: {
      model: { kind: "model", required: true },
      prompt: { kind: "prompt", required: true },
      rule: { kind: "rule", required: true },
    },
  });
  const auditAdapter = adapter("fixture-audit", [], ({ inputs }) => ({
    count: [inputs.records.length],
  }));
  const audit = registry.registerType({
    id: "fixture-audit",
    version: 1,
    scope,
    category: "aggregate",
    config: empty,
    adapter: auditAdapter,
    capabilities: [],
    ports: { inputs: { records: port(text, "many") }, outputs: { count: port(count) } },
    bindings: {},
  });
  const publishAdapter = adapter("fixture-publish", ["data.write"], ({ inputs }) => ({
    report: [{ summary: inputs.summary[0], representations: inputs.count[0] }],
  }));
  const publish = registry.registerType({
    id: "fixture-publish",
    version: 1,
    scope,
    category: "publish",
    config: empty,
    adapter: publishAdapter,
    capabilities: ["data.write"],
    ports: {
      inputs: { summary: port(summary), count: port(count) },
      outputs: { report: port(report) },
    },
    bindings: {},
  });
  const model = registry.registerResource({
    id: "fixture-model",
    version: 1,
    scope,
    kind: "model",
    body: { provider: "synthetic", name: "deterministic-fixture" },
  });
  const prompt = registry.registerResource({
    id: "fixture-prompt",
    version: 1,
    scope,
    kind: "prompt",
    body: { text: "Synthetic metadata only; no provider is invoked." },
  });
  const rule = registry.registerResource({
    id: "fixture-rule",
    version: 1,
    scope,
    kind: "rule",
    body: { minimum: 1 },
  });
  const definition: Definition = {
    format: "workflow/1",
    id: "five-sources",
    version: 1,
    scope,
    name: "Synthetic dual representations",
    budget: large,
    stages: [
      { id: "ingest", name: "Ingest", budget: large },
      { id: "analyze", name: "Analyze", budget: large },
      { id: "publish", name: "Publish", budget: large },
    ],
    steps: [],
    edges: [],
  };
  for (let n = 1; n <= 5; n++) {
    const id = "read-" + n;
    const data = registry.registerResource({
      id: "source-" + n,
      version: 1,
      scope,
      kind: "dataset",
      body: { id: "source-" + n, text: "synthetic " + n },
    });
    definition.steps.push({
      id,
      stage: "ingest",
      type: source,
      config: {},
      pins: { source: data },
      budget: small,
    });
    definition.edges.push(
      { id: "json-" + n, from: { step: id, port: "json" }, to: { step: "infer", port: "records" } },
      { id: "text-" + n, from: { step: id, port: "text" }, to: { step: "audit", port: "records" } },
    );
  }
  definition.steps.push(
    {
      id: "infer",
      stage: "analyze",
      type: infer,
      config: {},
      pins: { model, prompt, rule },
      budget: small,
    },
    { id: "audit", stage: "analyze", type: audit, config: {}, pins: {}, budget: small },
    { id: "publish", stage: "publish", type: publish, config: {}, pins: {}, budget: small },
  );
  definition.edges.push(
    {
      id: "summary",
      from: { step: "infer", port: "summary" },
      to: { step: "publish", port: "summary" },
    },
    { id: "count", from: { step: "audit", port: "count" }, to: { step: "publish", port: "count" } },
  );
  return {
    registry,
    definition: clone(definition),
    policy,
    json,
    source,
    sourceAdapter,
    infer,
    inferAdapter,
    summary,
    model,
    prompt,
    rule,
    adapter,
  };
}

test("five synthetic sources fan out to two representations and fan in through registered inference and publication", async () => {
  const { registry, definition } = fixture();
  const workflow = Workflow.publish(definition, registry, policy);
  assert.deepEqual(workflow.plan.stages, ["ingest", "analyze", "publish"]);
  assert.deepEqual(workflow.plan.levels, [
    ["read-1", "read-2", "read-3", "read-4", "read-5"],
    ["audit", "infer"],
    ["publish"],
  ]);
  const run = await workflow.run(registry);
  assert.equal(run.state, "completed");
  assert.equal(run.steps.length, 8);
  assert.equal(run.usage.tokens, 10);
  assert.deepEqual(run.outputs.publish.report, [
    {
      summary: { ids: ["source-1", "source-2", "source-3", "source-4", "source-5"], count: 5 },
      representations: 5,
    },
  ]);
  assert.ok(
    run.steps.every((step) => step.workflow.digest === workflow.digest && step.run === run.id),
  );
  assert.deepEqual(
    JSON.parse(String(run.outputs["read-1"].text[0])),
    run.outputs["read-1"].json[0],
  );
});

test("publication canonicalizes order, freezes all definition state and restores only a verified release", () => {
  const { registry, definition } = fixture();
  const workflow = Workflow.publish(definition, registry, policy);
  const reordered = clone(definition);
  reordered.steps.reverse();
  reordered.edges.reverse();
  reordered.stages.reverse();
  assert.equal(Workflow.publish(reordered, registry, policy).digest, workflow.digest);
  assert.deepEqual(Workflow.publish(reordered, registry, policy).plan, workflow.plan);
  definition.name = "mutated caller";
  definition.steps[0].config = { changed: true };
  assert.equal(workflow.definition.name, "Synthetic dual representations");
  assert.ok(Object.isFrozen(workflow.definition.steps[0].pins.source));
  assert.throws(
    () => (workflow.definition.steps as unknown as { push(v: unknown): void }).push({}),
    TypeError,
  );
  const reopened = Workflow.open(JSON.parse(JSON.stringify(workflow.release)), registry, policy);
  assert.equal(reopened.digest, workflow.digest);
  const corrupt = JSON.parse(JSON.stringify(workflow.release));
  corrupt.definition.name = "corrupt";
  assert.throws(() => Workflow.open(corrupt, registry, policy), /digest|integrity/i);
  const badPlan = JSON.parse(JSON.stringify(workflow.release));
  badPlan.plan.steps.reverse();
  assert.throws(() => Workflow.open(badPlan, registry, policy), /plan|integrity/i);
});

test("registries add a new operation without changing compiler or runner dispatch", async () => {
  const { registry, definition, json, adapter } = fixture();
  const executor = adapter("fixture-custom", [], ({ inputs, config }) => ({
    records: inputs.records.map((row) => ({
      ...(row as Record<string, Json>),
      text: (config as { prefix: string }).prefix + (row as { text: string }).text,
    })),
  }));
  const custom = registry.registerType({
    id: "custom-prefix",
    version: 3,
    scope,
    category: "my-domain-operation",
    config: {
      type: "object",
      properties: { prefix: { type: "string", minLength: 1 } },
      required: ["prefix"],
      additionalProperties: false,
    },
    adapter: executor,
    capabilities: [],
    ports: { inputs: { records: port(json, "many") }, outputs: { records: port(json, "many") } },
    bindings: {},
  });
  definition.steps.push({
    id: "custom",
    stage: "ingest",
    type: custom,
    config: { prefix: "new: " },
    pins: {},
    budget: small,
  });
  definition.edges = definition.edges.filter((edge) => edge.id !== "json-1");
  definition.edges.push(
    {
      id: "custom-in",
      from: { step: "read-1", port: "json" },
      to: { step: "custom", port: "records" },
    },
    {
      id: "custom-out",
      from: { step: "custom", port: "records" },
      to: { step: "infer", port: "records" },
    },
  );
  const run = await Workflow.publish(definition, registry, policy).run(registry);
  assert.equal(run.state, "completed");
  assert.deepEqual(run.outputs.custom.records, [{ id: "source-1", text: "new: synthetic 1" }]);
});

test("unknown versions, forged digests and unauthorized scope references cannot publish", () => {
  const { registry, definition } = fixture();
  const missing = clone(definition);
  missing.steps[0].type.version = 99;
  assert.throws(() => Workflow.publish(missing, registry, policy), /reference|version/i);
  const forged = clone(definition);
  forged.steps[0].type.digest = "f".repeat(64);
  assert.throws(() => Workflow.publish(forged, registry, policy), /digest|reference/i);
  const foreign = registry.registerResource({
    id: "foreign",
    version: 1,
    scope: { ...scope, project: "other", owner: "other" },
    kind: "dataset",
    body: { id: "foreign", text: "synthetic" },
  });
  definition.steps[0].pins.source = foreign;
  assert.throws(() => Workflow.publish(definition, registry, policy), /scope|authorized/i);
  assert.ok(Workflow.publish(definition, registry, { ...policy, grants: [foreign] }));
  const tenant = registry.registerResource({
    id: "tenant",
    version: 1,
    scope: { ...scope, workspace: "other" },
    kind: "dataset",
    body: { id: "foreign", text: "synthetic" },
  });
  definition.steps[0].pins.source = tenant;
  assert.throws(
    () => Workflow.publish(definition, registry, { ...policy, grants: [tenant] }),
    /workspace|scope|authorized/i,
  );
});

test("definition identity, duplicate steps, stage references and edge endpoints are validated", () => {
  const { registry, definition } = fixture();
  for (const mutate of [
    (d: Definition) => {
      d.id = "../escape";
    },
    (d: Definition) => {
      d.version = 0;
    },
    (d: Definition) => {
      d.steps.push(clone(d.steps[0]));
    },
    (d: Definition) => {
      d.steps[0].stage = "missing";
    },
    (d: Definition) => {
      d.edges[0].from.step = "another-version-step";
    },
    (d: Definition) => {
      d.edges[0].from.port = "missing";
    },
  ]) {
    const invalid = clone(definition);
    mutate(invalid);
    assert.throws(() => Workflow.publish(invalid, registry, policy));
  }
});

test("required inputs, exact contract versions, port cardinality and duplicate routes are checked", () => {
  const { registry, definition } = fixture();
  const required = clone(definition);
  required.edges = required.edges.filter((edge) => edge.id !== "summary");
  assert.throws(() => Workflow.publish(required, registry, policy), /required|input/i);
  const incompatible = clone(definition);
  incompatible.edges[0].from.port = "text";
  assert.throws(() => Workflow.publish(incompatible, registry, policy), /contract|type/i);
  const duplicate = clone(definition);
  duplicate.edges.push({ ...duplicate.edges[0], id: "duplicate-route" });
  assert.throws(() => Workflow.publish(duplicate, registry, policy), /duplicate|route/i);
  const cardinality = clone(definition);
  const extra = clone(cardinality.steps.find((step) => step.id === "infer")!);
  extra.id = "infer-extra";
  cardinality.steps.push(extra);
  cardinality.edges.push(
    {
      id: "extra-input",
      from: { step: "read-1", port: "json" },
      to: { step: extra.id, port: "records" },
    },
    {
      id: "extra-summary",
      from: { step: extra.id, port: "summary" },
      to: { step: "publish", port: "summary" },
    },
  );
  assert.throws(() => Workflow.publish(cardinality, registry, policy), /cardinality|one/i);
});

test("unknown capabilities, undeclared bindings, wrong pin kinds and invalid configurations are denied", () => {
  const { registry, definition, sourceAdapter, source, model } = fixture();
  assert.throws(
    () =>
      registry.registerAdapter(
        {
          id: "unsafe",
          version: 1,
          scope,
          artifact: hash("fixture"),
          capabilities: ["shell.exec"] as unknown as Policy["capabilities"],
        },
        () => ({}),
      ),
    /capabilit/i,
  );
  const undeclared = clone(definition);
  undeclared.steps[0].pins.secret = model;
  assert.throws(() => Workflow.publish(undeclared, registry, policy), /binding|pin/i);
  const wrongKind = clone(definition);
  wrongKind.steps[0].pins.source = model;
  assert.throws(() => Workflow.publish(wrongKind, registry, policy), /kind|binding|pin/i);
  const config = clone(definition);
  config.steps[0].config = { arbitrary: "not permitted" };
  assert.throws(() => Workflow.publish(config, registry, policy), /config/i);
  assert.throws(
    () => Workflow.publish(definition, registry, { ...policy, capabilities: [] }),
    /capabilit/i,
  );
  assert.throws(
    () =>
      registry.registerType({
        id: "hidden-read",
        version: 1,
        scope,
        category: "custom",
        config: empty,
        adapter: sourceAdapter,
        capabilities: [],
        ports: { inputs: {}, outputs: {} },
        bindings: {},
      }),
    /capabilit/i,
  );
  assert.throws(() => registry.registerType({ ...registry.type(source), version: 0 }), /version/i);
});

test("step cycles and stage cycles fail even if individual stage feedback uses different steps", () => {
  const { registry, definition, json, source, adapter } = fixture();
  const executor = adapter("fixture-echo", [], ({ inputs }) => ({ record: inputs.record }));
  const echo = registry.registerType({
    id: "fixture-echo",
    version: 1,
    scope,
    category: "map",
    config: empty,
    adapter: executor,
    capabilities: [],
    ports: { inputs: { record: port(json) }, outputs: { record: port(json) } },
    bindings: {},
  });
  const base = clone(definition);
  base.stages = [{ id: "a", name: "A", budget: large }];
  base.steps = ["first", "second"].map((id) => ({
    id,
    stage: "a",
    type: echo,
    config: {},
    pins: {},
    budget: small,
  }));
  base.edges = [
    {
      id: "forward",
      from: { step: "first", port: "record" },
      to: { step: "second", port: "record" },
    },
    { id: "back", from: { step: "second", port: "record" }, to: { step: "first", port: "record" } },
  ];
  assert.throws(() => Workflow.publish(base, registry, policy), /cycle/i);
  base.stages.push({ id: "b", name: "B", budget: large });
  base.steps = [
    clone(definition.steps[0]),
    { id: "middle", stage: "b", type: echo, config: {}, pins: {}, budget: small },
    { id: "last", stage: "a", type: echo, config: {}, pins: {}, budget: small },
  ];
  base.steps[0].stage = "a";
  base.steps[0].type = source;
  base.edges = [
    { id: "a-b", from: { step: "read-1", port: "json" }, to: { step: "middle", port: "record" } },
    { id: "b-a", from: { step: "middle", port: "record" }, to: { step: "last", port: "record" } },
  ];
  assert.throws(() => Workflow.publish(base, registry, policy), /stage.*cycle|cycle.*stage/i);
});

test("resource allocations stay within step, stage, workflow and policy budgets", () => {
  const { registry, definition } = fixture();
  const excessive = clone(definition);
  excessive.steps[0].budget.memoryBytes = large.memoryBytes + 1;
  assert.throws(() => Workflow.publish(excessive, registry, policy), /budget/i);
  const summed = clone(definition);
  summed.stages.find((stage) => stage.id === "ingest")!.budget.cpuMs = 4999;
  assert.throws(() => Workflow.publish(summed, registry, policy), /budget/i);
  const denied = clone(definition);
  denied.budget.tokens = large.tokens + 1;
  assert.throws(() => Workflow.publish(denied, registry, policy), /budget/i);
  const malformed = clone(definition);
  malformed.steps[0].budget.tokens = -1;
  assert.throws(() => Workflow.publish(malformed, registry, policy), /budget/i);
});

test("invalid adapter outputs retain a failed attempt and stop downstream publication", async () => {
  const { registry, definition, source, adapter } = fixture();
  const bad = adapter("fixture-bad-output", ["data.read"], () => ({
    json: [{ unexpected: "retained synthetic failure" }],
    text: [],
  }));
  const badType = registry.registerType({
    ...registry.type(source),
    id: "fixture-bad-source",
    adapter: bad,
  });
  definition.steps[0].type = badType;
  const run = await Workflow.publish(definition, registry, policy).run(registry);
  assert.equal(run.state, "failed");
  assert.equal(run.steps[0].state, "failed");
  assert.deepEqual(run.steps[0].rejected, {
    json: [{ unexpected: "retained synthetic failure" }],
    text: [],
  });
  assert.match(run.steps[0].error!, /contract|required/i);
  assert.equal(Object.hasOwn(run.outputs, "publish"), false);
});

test("runtime enforces accounting and output bounds without claiming a synthetic adapter is a model", async () => {
  const { registry, definition, source, adapter } = fixture();
  const excessive = adapter("fixture-cost", ["data.read"], ({ pins, charge }) => {
    charge({ tokens: 101 });
    return { json: [pins.source.body], text: [pins.source.body] };
  });
  const badType = registry.registerType({
    ...registry.type(source),
    id: "fixture-cost-source",
    adapter: excessive,
  });
  definition.steps[0].type = badType;
  const run = await Workflow.publish(definition, registry, policy).run(registry);
  assert.equal(run.state, "failed");
  assert.match(run.steps[0].error!, /budget|tokens/i);
  assert.equal(run.steps[0].adapter.id, "fixture-cost");
  assert.equal(run.workflow.digest, Workflow.publish(definition, registry, policy).digest);
});

test("registry copies freeze resources and refuses rebinding an existing version", () => {
  const registry = new Registry();
  const body = { text: "original" };
  const pin = registry.registerResource({ id: "prompt", version: 1, scope, kind: "prompt", body });
  body.text = "caller changed";
  assert.deepEqual(registry.resource(pin).body, { text: "original" });
  assert.ok(Object.isFrozen(registry.resource(pin).body));
  assert.throws(
    () =>
      registry.registerResource({
        id: "prompt",
        version: 1,
        scope,
        kind: "prompt",
        body: { text: "rebound" },
      }),
    /version|duplicate|registered/i,
  );
  assert.throws(
    () => Workflow.publish({ format: "workflow/1", evaluate: () => true }, registry, policy),
    /JSON|field|definition/i,
  );
});

test("JSON registry manifests resolve only exact trusted executor definitions", async () => {
  const { registry, definition } = fixture();
  const manifest = JSON.parse(JSON.stringify(registry.manifest()));
  const loaded = Registry.open(manifest, registry);
  assert.equal(
    (await Workflow.publish(JSON.parse(JSON.stringify(definition)), loaded, policy).run(loaded))
      .state,
    "completed",
  );
  manifest.adapters.find(
    (adapter: { capabilities: string[] }) => adapter.capabilities.length,
  ).capabilities = [];
  assert.throws(() => Registry.open(manifest, registry), /digest|reference|trusted|executor/i);
  const pure = JSON.parse(JSON.stringify(registry.manifest()));
  pure.adapters[0].artifact = hash("unregistered code");
  assert.throws(() => Registry.open(pure, registry), /digest|reference|trusted|executor/i);
});

test("a many-output contract cannot feed a one-input port without an explicit selection adapter", () => {
  const { registry, definition, source } = fixture();
  const many = registry.registerType({
    ...registry.type(source),
    id: "many-source",
    ports: {
      inputs: {},
      outputs: {
        ...registry.type(source).ports.outputs,
        json: { ...registry.type(source).ports.outputs.json, cardinality: "many" },
      },
    },
  });
  definition.steps[0].type = many;
  const infer = definition.steps.find((step) => step.id === "infer")!;
  const one = registry.registerType({
    ...registry.type(infer.type),
    id: "single-infer",
    ports: {
      inputs: {
        records: { ...registry.type(infer.type).ports.inputs.records, cardinality: "one" },
      },
      outputs: registry.type(infer.type).ports.outputs,
    },
  });
  infer.type = one;
  definition.edges = definition.edges.filter(
    (edge) => !edge.id.startsWith("json-") || edge.id === "json-1",
  );
  assert.throws(() => Workflow.publish(definition, registry, policy), /cardinality|many|one/i);
});

test("resource bindings cannot conceal connection or model access behind a capability-free adapter", () => {
  const registry = new Registry();
  const adapter = registry.registerAdapter(
    { id: "reader", version: 1, scope, artifact: hash("fixture"), capabilities: [] },
    () => ({}),
  );
  assert.throws(
    () =>
      registry.registerType({
        id: "secret-read",
        version: 1,
        scope,
        category: "custom",
        config: empty,
        adapter,
        capabilities: [],
        ports: { inputs: {}, outputs: {} },
        bindings: { secret: { kind: "connection", required: true } },
      }),
    /capabilit/i,
  );
  assert.throws(
    () => registry.registerResource({ id: "empty", version: 1, scope, kind: "dataset" } as never),
    /body|JSON|resource/i,
  );
});

test("artifact-handle packets represent a large immutable dataset without materializing its records", async () => {
  const registry = new Registry();
  const refSchema: Schema = {
    type: "object",
    properties: {
      id: { type: "string" },
      version: { type: "integer", minimum: 1 },
      digest: { type: "string", minLength: 64 },
    },
    required: ["id", "version", "digest"],
    additionalProperties: false,
  };
  const contract = registry.registerContract({
    id: "artifact-handle",
    version: 1,
    scope,
    kind: "artifact-handle",
    format: "json",
    schema: {
      type: "object",
      properties: {
        dataset: refSchema,
        artifact: refSchema,
        format: { type: "string" },
        bytes: { type: "integer" },
        records: { type: "integer" },
      },
      required: ["dataset", "artifact", "format", "bytes", "records"],
      additionalProperties: false,
    },
  });
  const dataset = registry.registerResource({
    id: "large-dataset",
    version: 1,
    scope,
    kind: "dataset",
    body: { identity: "logical-dataset" },
  });
  const artifact = registry.registerResource({
    id: "large-jsonl",
    version: 1,
    scope,
    kind: "artifact",
    body: {
      digest: hash("synthetic artifact identity only"),
      bytes: 1000000000000,
      records: 1000000000,
      format: "jsonl",
    },
  });
  const handle = { dataset, artifact, format: "jsonl", bytes: 1000000000000, records: 1000000000 };
  const executor = registry.registerAdapter(
    {
      id: "handle-source",
      version: 1,
      scope,
      artifact: hash("fixture handle adapter"),
      capabilities: ["data.read", "resource.read"],
    },
    () => ({ handle: [handle] }),
  );
  const type = registry.registerType({
    id: "handle-source",
    version: 1,
    scope,
    category: "ingest",
    config: empty,
    adapter: executor,
    capabilities: ["data.read", "resource.read"],
    ports: { inputs: {}, outputs: { handle: port(contract) } },
    bindings: {
      dataset: { kind: "dataset", required: true },
      artifact: { kind: "artifact", required: true },
    },
  });
  const definition: Definition = {
    format: "workflow/1",
    id: "handles",
    version: 1,
    scope,
    name: "Synthetic handle example",
    budget: large,
    stages: [{ id: "ingest", name: "Ingest", budget: large }],
    steps: [
      {
        id: "source",
        stage: "ingest",
        type,
        config: {},
        pins: { dataset, artifact },
        budget: small,
      },
    ],
    edges: [],
  };
  const workflow = Workflow.publish(definition, registry, {
    ...policy,
    capabilities: [...policy.capabilities, "resource.read"],
  });
  const run = await workflow.run(registry);
  assert.equal(run.state, "completed");
  assert.deepEqual(run.outputs.source.handle, [handle]);
  assert.ok(run.usage.memoryBytes < 8192);
});

test("cooperative deadlines return a failed trace without accepting late adapter outputs", async () => {
  const { registry, definition, source, adapter } = fixture();
  const delayed = adapter("fixture-delay", ["data.read"], async ({ pins, signal }) => {
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return { json: [pins.source.body], text: [pins.source.body] };
  });
  const type = registry.registerType({
    ...registry.type(source),
    id: "delayed-source",
    adapter: delayed,
  });
  definition.steps[0].type = type;
  definition.steps[0].budget.timeMs = 10;
  const run = await Workflow.publish(definition, registry, policy).run(registry);
  assert.equal(run.state, "failed");
  assert.match(run.steps[0].error!, /time|abort/i);
  assert.equal(Object.hasOwn(run.outputs, "read-1"), false);
});

test("usage charges cannot overflow integer accounting and erase the failed trace", async () => {
  const fixture = traceFixture([{ ...small, tokens: Number.MAX_SAFE_INTEGER }], ({ charge }) => {
    charge({ tokens: Number.MAX_SAFE_INTEGER });
    charge({ tokens: 1 });
    return { text: ["unreachable"] };
  });
  fixture.definition.budget.tokens = Number.MAX_SAFE_INTEGER;
  fixture.policy.budget.tokens = Number.MAX_SAFE_INTEGER;
  const run = await Workflow.publish(fixture.definition, fixture.registry, fixture.policy).run(
    fixture.registry,
  );
  assert.equal(run.state, "failed");
  assert.match(run.steps[0].error!, /charge|overflow|budget/i);
  assert.equal(run.steps[0].usage.tokens, Number.MAX_SAFE_INTEGER);
});

test("output storage allocation is checked before an oversized artifact can reach publication", async () => {
  const { registry, definition } = fixture();
  definition.steps[0].budget.storageBytes = 1;
  const run = await Workflow.publish(definition, registry, policy).run(registry);
  assert.equal(run.state, "failed");
  assert.match(run.steps[0].error!, /storageBytes.*budget|budget.*storageBytes/i);
  assert.equal(Object.hasOwn(run.outputs, "publish"), false);
});

test("the checked-in JSON example executes five sources using explicitly trusted synthetic handlers", async () => {
  const example = JSON.parse(
    await readFile(new URL("../../config/workflow.example.json", import.meta.url), "utf8"),
  );
  assert.equal(example.format, "workflow-example/1");
  const trusted = fixture().registry;
  const registry = Registry.open(example.registry, trusted);
  const workflow = Workflow.publish(example.workflow, registry, example.policy);
  const run = await workflow.run(registry);
  assert.equal(run.state, "completed");
  assert.deepEqual(run.outputs.publish.report, [
    {
      summary: { ids: ["source-1", "source-2", "source-3", "source-4", "source-5"], count: 5 },
      representations: 5,
    },
  ]);
  assert.equal(typeof run.outputs["read-1"].text[0], "string");
});

test("definitions reject accessors without executing host code during JSON validation", () => {
  const { registry, definition } = fixture();
  let executed = false;
  Object.defineProperty(definition, "name", {
    enumerable: true,
    get() {
      executed = true;
      return "side effect";
    },
  });
  assert.throws(() => Workflow.publish(definition, registry, policy), /JSON|accessor/i);
  assert.equal(executed, false);
});

test("retained packet allocations count toward the complete workflow memory budget", () => {
  const { registry, definition } = fixture();
  definition.budget.memoryBytes = 7 * small.memoryBytes;
  for (const stage of definition.stages) stage.budget.memoryBytes = definition.budget.memoryBytes;
  assert.throws(
    () => Workflow.publish(definition, registry, policy),
    /aggregate.*budget.*memoryBytes|memoryBytes.*budget/i,
  );
});

test("local trace bounds reject an oversized retained plan before any adapter can perform work", async () => {
  const registry = new Registry();
  const contract = registry.registerContract({
    id: "text",
    version: 1,
    scope,
    kind: "text",
    format: "text",
    schema: { type: "string" },
  });
  let calls = 0;
  const executor = registry.registerAdapter(
    { id: "large", version: 1, scope, artifact: hash("large synthetic fixture"), capabilities: [] },
    () => {
      calls++;
      return { text: ["x".repeat(9 * 1024 ** 2)] };
    },
  );
  const type = registry.registerType({
    id: "large",
    version: 1,
    scope,
    category: "custom",
    config: empty,
    adapter: executor,
    capabilities: [],
    ports: { inputs: {}, outputs: { text: port(contract) } },
    bindings: {},
  });
  const allocation: Budget = {
    ...small,
    memoryBytes: 12 * 1024 ** 2,
    storageBytes: 10 * 1024 ** 2,
  };
  const total: Budget = { ...large, memoryBytes: 32 * 1024 ** 2, storageBytes: 32 * 1024 ** 2 };
  const definition: Definition = {
    format: "workflow/1",
    id: "large",
    version: 1,
    scope,
    name: "Large fixture",
    budget: total,
    stages: [{ id: "main", name: "Main", budget: total }],
    steps: ["a", "b"].map((id) => ({
      id,
      stage: "main",
      type,
      config: {},
      pins: {},
      budget: allocation,
    })),
    edges: [],
  };
  const workflow = Workflow.publish(definition, registry, { ...policy, budget: total });
  await assert.rejects(workflow.run(registry), /trace|artifact handles/i);
  assert.equal(calls, 0);
});

function traceFixture(allocations: Budget[], handler: Handler) {
  const registry = new Registry();
  const contract = registry.registerContract({
    id: "text",
    version: 1,
    scope,
    kind: "text",
    format: "text",
    schema: { type: "string" },
  });
  const adapter = registry.registerAdapter(
    {
      id: "trace",
      version: 1,
      scope,
      artifact: hash("trace synthetic fixture"),
      capabilities: [],
    },
    handler,
  );
  const type = registry.registerType({
    id: "trace",
    version: 1,
    scope,
    category: "custom",
    config: empty,
    adapter,
    capabilities: [],
    bindings: {},
    ports: {
      inputs: { text: port(contract, "many", false) },
      outputs: { text: port(contract) },
    },
  });
  const total = { ...large, memoryBytes: 64 * 1024 ** 2, storageBytes: 64 * 1024 ** 2 };
  const definition: Definition = {
    format: "workflow/1",
    id: "trace",
    version: 1,
    scope,
    name: "Trace fixture",
    budget: total,
    stages: [{ id: "main", name: "Main", budget: total }],
    steps: allocations.map((budget, index) => ({
      id: "step-" + index,
      stage: "main",
      type,
      config: {},
      pins: {},
      budget,
    })),
    edges: [],
  };
  return { registry, definition, policy: { ...policy, budget: total } };
}

test("trace preflight reserves repeated input packets for every downstream attempt", async () => {
  let calls = 0;
  const allocation = { ...small, memoryBytes: 5 * 1024 ** 2, storageBytes: 4 * 1024 ** 2 };
  const fixture = traceFixture(
    Array.from({ length: 5 }, () => allocation),
    () => {
      calls++;
      return { text: ["small actual output"] };
    },
  );
  fixture.definition.edges = [1, 2, 3, 4].map((index) => ({
    id: "route-" + index,
    from: { step: "step-0", port: "text" },
    to: { step: "step-" + index, port: "text" },
  }));
  for (const step of fixture.definition.steps.slice(1))
    step.budget = { ...allocation, storageBytes: 64 };
  const workflow = Workflow.publish(fixture.definition, fixture.registry, fixture.policy);
  await assert.rejects(workflow.run(fixture.registry), /trace.*artifact handles/i);
  assert.equal(calls, 0);
});

test("trace preflight reserves a rejected payload after earlier accepted outputs", async () => {
  let calls = 0;
  const fixture = traceFixture(
    [
      { ...small, memoryBytes: 9 * 1024 ** 2, storageBytes: 8 * 1024 ** 2 },
      { ...small, memoryBytes: 9 * 1024 ** 2, storageBytes: 64 },
    ],
    () => {
      calls++;
      return { text: ["small actual output"] };
    },
  );
  const workflow = Workflow.publish(fixture.definition, fixture.registry, fixture.policy);
  await assert.rejects(workflow.run(fixture.registry), /trace.*artifact handles/i);
  assert.equal(calls, 0);
});

test("trace reservations use output bounds without charging unused memory headroom twice", async () => {
  const allocation = { ...small, memoryBytes: 9 * 1024 ** 2, storageBytes: 64 };
  const fixture = traceFixture([allocation, allocation], () => ({ text: ["small"] }));
  const run = await Workflow.publish(fixture.definition, fixture.registry, fixture.policy).run(
    fixture.registry,
  );
  assert.equal(run.state, "completed");
  assert.equal(run.steps.length, 2);
});

test("adapter error diagnostics stay bounded without discarding the failed attempt", async () => {
  const fixture = traceFixture([small], () => {
    throw Error("synthetic failure " + "x".repeat(17 * 1024 ** 2));
  });
  const run = await Workflow.publish(fixture.definition, fixture.registry, fixture.policy).run(
    fixture.registry,
  );
  assert.equal(run.state, "failed");
  assert.equal(run.steps.length, 1);
  assert.match(run.steps[0].error!, /^synthetic failure /);
  assert.ok(Buffer.byteLength(JSON.stringify(run.steps[0].error)) <= 4096);
});

test("storage budgets measure the normalized output including omitted optional ports", async () => {
  const { registry, definition, source, adapter } = fixture();
  const executor = adapter("fixture-omitted-port", ["data.read"], () => ({}));
  const original = registry.type(source);
  const type = registry.registerType({
    ...original,
    id: "optional-source",
    adapter: executor,
    ports: {
      inputs: {},
      outputs: Object.fromEntries(
        Object.entries(original.ports.outputs).map(([key, value]) => [
          key,
          { ...value, required: false },
        ]),
      ),
    },
  });
  definition.steps[0].type = type;
  definition.steps[0].budget.storageBytes = 2;
  const run = await Workflow.publish(definition, registry, policy).run(registry);
  assert.equal(run.state, "failed");
  assert.match(run.steps[0].error!, /storageBytes.*budget|budget.*storageBytes/i);
  assert.equal(Object.hasOwn(run.outputs, "read-1"), false);
});

function retainedFixture(
  allocations: number[],
  handlers: Handler[],
  linked = false,
  cardinality: Port["cardinality"] = "one",
) {
  const registry = new Registry();
  const contract = registry.registerContract({
    id: "text",
    version: 1,
    scope,
    kind: "text",
    format: "text",
    schema: { type: "string" },
  });
  const total: Budget = { ...large, memoryBytes: 32 * 1024 ** 2, storageBytes: 32 * 1024 ** 2 };
  const definition: Definition = {
    format: "workflow/1",
    id: "trace-fixture",
    version: 1,
    scope,
    name: "Trace fixture",
    budget: total,
    stages: [{ id: "main", name: "Main", budget: total }],
    steps: [],
    edges: [],
  };
  for (const [index, allocation] of allocations.entries()) {
    const id = "step-" + index;
    const adapter = registry.registerAdapter(
      {
        id,
        version: 1,
        scope,
        artifact: hash(id),
        capabilities: [],
      },
      handlers[index],
    );
    const type = registry.registerType({
      id,
      version: 1,
      scope,
      category: "custom",
      config: empty,
      adapter,
      capabilities: [],
      ports: {
        inputs: linked && index ? { text: port(contract, cardinality) } : {},
        outputs: { text: port(contract, cardinality) },
      },
      bindings: {},
    });
    definition.steps.push({
      id,
      stage: "main",
      type,
      config: {},
      pins: {},
      budget: {
        ...small,
        cpuMs: 5000,
        timeMs: 5000,
        memoryBytes: allocation * 1024 ** 2,
        storageBytes: allocation * 1024 ** 2,
      },
    });
    if (linked && index)
      definition.edges.push({
        id: "edge-" + index,
        from: { step: "step-" + (index - 1), port: "text" },
        to: { step: id, port: "text" },
      });
  }
  return {
    registry,
    workflow: Workflow.publish(definition, registry, { ...policy, budget: total }),
  };
}

test("failed output diagnostics share the step allocation with retained inputs", async () => {
  const { registry, workflow } = retainedFixture(
    [5, 10],
    [() => ({ text: ["x".repeat(4 * 1024 ** 2)] }), () => ({ text: ["y".repeat(9 * 1024 ** 2)] })],
    true,
  );
  const run = await workflow.run(registry);
  assert.equal(run.state, "failed");
  assert.equal(run.steps.length, 2);
  assert.match(run.steps[1].error!, /budget.*memoryBytes|memoryBytes.*budget/i);
  assert.equal(run.steps[1].inputs.text[0], run.outputs["step-0"].text[0]);
  assert.equal(run.steps[1].rejected, undefined);
  assert.equal(Object.hasOwn(run.outputs, "step-1"), false);
});

test("oversized adapter errors retain a bounded explicit diagnostic", async () => {
  const { registry, workflow } = retainedFixture(
    [1],
    [
      () => {
        throw Error("\0".repeat(3 * 1024 ** 2));
      },
    ],
  );
  const run = await workflow.run(registry);
  assert.equal(run.state, "failed");
  assert.equal(run.steps.length, 1);
  assert.match(run.steps[0].error!, /truncated/);
  assert.ok(Buffer.byteLength(JSON.stringify(run)) < 16 * 1024 ** 2);
});

test("trace preflight reserves metadata in addition to packet allocations", async () => {
  let calls = 0;
  const { registry, workflow } = retainedFixture(
    [16],
    [
      () => {
        calls++;
        return { text: ["small"] };
      },
    ],
  );
  await assert.rejects(workflow.run(registry), /trace|artifact handles/i);
  assert.equal(calls, 0);
});

test("one large valid output remains within the local trace allocation", async () => {
  const { registry, workflow } = retainedFixture(
    [12],
    [() => ({ text: ["x".repeat(9 * 1024 ** 2)] })],
  );
  const run = await workflow.run(registry);
  assert.equal(run.state, "completed");
  assert.equal((run.outputs["step-0"].text[0] as string).length, 9 * 1024 ** 2);
});

test("failed input assembly counts packet separators before retaining each packet", async () => {
  const inputBudget = 127 * 65536;
  let calls = 0;
  const { registry, workflow } = retainedFixture(
    [8 + 1000 / 1024 ** 2, inputBudget / 1024 ** 2],
    [
      () => ({ text: Array.from({ length: 65536 }, () => "x".repeat(125)) }),
      () => {
        calls++;
        return { text: ["unused"] };
      },
    ],
    true,
    "many",
  );
  const run = await workflow.run(registry);
  assert.equal(run.state, "failed");
  assert.equal(run.steps.length, 2);
  assert.match(run.steps[1].error!, /input.*memory budget/i);
  assert.equal(calls, 0);
  assert.ok(Buffer.byteLength(JSON.stringify(run.steps[1].inputs)) <= inputBudget);
  assert.ok(Buffer.byteLength(JSON.stringify(run)) <= 16 * 1024 ** 2);
});
