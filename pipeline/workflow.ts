import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { schema as validateSchema, accepts } from "./profile.ts";
import type { Schema } from "./roles.ts";

export type { Schema } from "./roles.ts";
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ReadonlyJson =
  | null
  | boolean
  | number
  | string
  | readonly ReadonlyJson[]
  | { readonly [key: string]: ReadonlyJson };
export type Frozen<T> = unknown extends T
  ? T
  : [Json] extends [T]
    ? ReadonlyJson
    : T extends (...args: never[]) => unknown
      ? T
      : T extends object
        ? { readonly [K in keyof T]: Frozen<T[K]> }
        : T;
export type Scope = { workspace: string; project: string; owner: string };
export type Ref = { id: string; version: number; digest: string };
export type Capability =
  | "data.read"
  | "data.write"
  | "model.invoke"
  | "prompt.read"
  | "rule.read"
  | "resource.read"
  | "notify.send";
export type Budget = {
  cpuMs: number;
  memoryBytes: number;
  storageBytes: number;
  timeMs: number;
  tokens: number;
  costMicros: number;
  concurrency: number;
};
export type Policy = { scope: Scope; capabilities: Capability[]; budget: Budget; grants: Ref[] };
export type Identity = { id: string; version: number; scope: Scope };
export type Contract = Identity & { kind: string; format: string; schema: Schema };
export type ResourceKind =
  | "dataset"
  | "artifact"
  | "model"
  | "prompt"
  | "rule"
  | "schema"
  | "connection";
export type Resource = Identity & { kind: ResourceKind; body: Json };
export type ArtifactHandle = {
  dataset: Ref;
  artifact: Ref;
  format: string;
  bytes: number;
  records: number;
};
export type Adapter = Identity & { artifact: string; capabilities: Capability[] };
export type Port = { contract: Ref; required: boolean; cardinality: "one" | "many" };
export type Ports = { inputs: Record<string, Port>; outputs: Record<string, Port> };
export type Binding = { kind: ResourceKind; required: boolean };
export type StepType = Identity & {
  category: string;
  config: Schema;
  adapter: Ref;
  capabilities: Capability[];
  ports: Ports;
  bindings: Record<string, Binding>;
};
export type Stage = { id: string; name: string; budget: Budget };
export type Step = {
  id: string;
  stage: string;
  type: Ref;
  config: Json;
  pins: Record<string, Ref>;
  budget: Budget;
};
export type Endpoint = { step: string; port: string };
export type Edge = { id: string; from: Endpoint; to: Endpoint };
export type Definition = Identity & {
  format: "workflow/1";
  name: string;
  budget: Budget;
  stages: Stage[];
  steps: Step[];
  edges: Edge[];
};
export type CompiledStep = Step & {
  adapter: Ref;
  ports: Ports;
  inputs: Record<string, Endpoint[]>;
  dependencies: string[];
};
export type Plan = { stages: string[]; levels: string[][]; steps: CompiledStep[] };
export type Release = {
  format: "workflow-release/1";
  definition: Definition;
  digest: string;
  plan: Plan;
};
export type Manifest = {
  format: "registry/1";
  contracts: Contract[];
  resources: Resource[];
  adapters: Adapter[];
  types: StepType[];
};
export type Outputs = Record<string, Json[]>;
export type Charge = { tokens?: number; costMicros?: number };
export type Usage = Budget;
export type Context = {
  readonly run: string;
  readonly workflow: Frozen<Ref>;
  readonly step: string;
  readonly config: Frozen<Json>;
  readonly inputs: Frozen<Outputs>;
  readonly pins: Frozen<Record<string, Resource>>;
  readonly budget: Frozen<Budget>;
  readonly capabilities: readonly Capability[];
  readonly signal: AbortSignal;
  charge(value: Charge): void;
};
export type Handler = (
  context: Context,
) => Outputs | Frozen<Outputs> | Promise<Outputs | Frozen<Outputs>>;
export type StepRun = {
  run: string;
  workflow: Ref;
  step: string;
  stage: string;
  type: Ref;
  adapter: Ref;
  state: "completed" | "failed";
  startedAt: string;
  finishedAt: string;
  usage: Usage;
  inputs: Outputs;
  outputDigest?: string;
  error?: string;
  rejected?: Json;
};
export type Run = {
  id: string;
  workflow: Ref;
  scope: Scope;
  state: "completed" | "failed";
  steps: StepRun[];
  outputs: Record<string, Outputs>;
  usage: Usage;
};
export type RunOptions = { policy?: Policy; signal?: AbortSignal };
type RegistryKind = "contract" | "resource" | "adapter" | "type";
type Entry<T> = { ref: Ref; definition: T };
const capabilities = new Set<Capability>([
  "data.read",
  "data.write",
  "model.invoke",
  "prompt.read",
  "rule.read",
  "resource.read",
  "notify.send",
]);
const resourceKinds = new Set<ResourceKind>([
  "dataset",
  "artifact",
  "model",
  "prompt",
  "rule",
  "schema",
  "connection",
]);
const bindingCaps: Record<ResourceKind, Capability> = {
  dataset: "data.read",
  artifact: "resource.read",
  model: "model.invoke",
  prompt: "prompt.read",
  rule: "rule.read",
  schema: "resource.read",
  connection: "resource.read",
};
const budgetKeys = [
  "cpuMs",
  "memoryBytes",
  "storageBytes",
  "timeMs",
  "tokens",
  "costMicros",
  "concurrency",
] as const;
const additive = new Set<keyof Budget>([
  "cpuMs",
  "memoryBytes",
  "storageBytes",
  "timeMs",
  "tokens",
  "costMicros",
]);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const own = (value: object, key: string) => Object.hasOwn(value, key);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const zero = (): Usage => ({
  cpuMs: 0,
  memoryBytes: 0,
  storageBytes: 0,
  timeMs: 0,
  tokens: 0,
  costMicros: 0,
  concurrency: 0,
});
const jsonBytes = 16 * 1024 ** 2;
const errorBytes = 4096;

function json(value: unknown, limit = jsonBytes): string {
  const seen = new Set<object>();
  let bytes = 0;
  const count = (text: string) => {
    bytes += Buffer.byteLength(text);
    if (bytes > limit) throw Error("JSON exceeds byte bound");
    return text;
  };
  const visit = (item: unknown, depth: number): string => {
    if (depth > 128) throw Error("JSON nesting exceeds bound");
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    )
      return count(JSON.stringify(item));
    if (
      !item ||
      typeof item !== "object" ||
      seen.has(item) ||
      Object.getOwnPropertySymbols(item).length ||
      (!Array.isArray(item) &&
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null)
    )
      throw Error("Workflow values must be finite, acyclic plain JSON");
    const descriptors = Object.getOwnPropertyDescriptors(item);
    for (const [key, descriptor] of Object.entries(descriptors))
      if (
        !own(descriptor, "value") ||
        (!descriptor.enumerable && !(Array.isArray(item) && key === "length"))
      )
        throw Error("JSON values cannot contain accessors or hidden fields");
    seen.add(item);
    let result: string;
    if (Array.isArray(item)) {
      if (
        Object.keys(item).length !== item.length ||
        Array.from({ length: item.length }, (_, n) => own(item, String(n))).some(
          (present) => !present,
        )
      )
        throw Error("JSON arrays cannot contain holes or extra keys");
      result =
        count("[") + item.map((child) => visit(child, depth + 1)).join(count(",")) + count("]");
    } else
      result =
        count("{") +
        Object.keys(item)
          .sort()
          .map(
            (key) =>
              count(JSON.stringify(key)) +
              count(":") +
              visit((item as Record<string, unknown>)[key], depth + 1),
          )
          .join(count(",")) +
        count("}");
    seen.delete(item);
    return result;
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(result) > limit) throw Error("JSON exceeds byte bound");
  return result;
}
function frozen<T>(value: T): Frozen<T> {
  const copy = JSON.parse(json(value)) as T;
  const freeze = (item: unknown): void => {
    if (item && typeof item === "object") {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
  };
  freeze(copy);
  return copy as Frozen<T>;
}
function fields(
  value: unknown,
  allowed: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key)))
    throw Error("Invalid " + label + " fields");
}
function id(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(value))
    throw Error("Invalid " + label + " identifier");
}
function name(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 256)
    throw Error("Invalid " + label);
}
function version(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 1000000)
    throw Error("Invalid version reference");
}
function digest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw Error("Invalid digest reference");
}
function scope(value: unknown): asserts value is Scope {
  fields(value, ["workspace", "project", "owner"], "scope");
  for (const key of ["workspace", "project", "owner"]) id(value[key], "scope " + key);
}
function identity(value: Record<string, unknown>) {
  id(value.id, "registry");
  version(value.version);
  scope(value.scope);
}
function reference(value: unknown): asserts value is Ref {
  fields(value, ["id", "version", "digest"], "reference");
  id(value.id, "reference");
  version(value.version);
  digest(value.digest);
}
function caps(value: unknown): asserts value is Capability[] {
  if (
    !Array.isArray(value) ||
    value.length > capabilities.size ||
    new Set(value).size !== value.length ||
    value.some((cap) => !capabilities.has(cap as Capability))
  )
    throw Error("Unknown or duplicate capability");
}
function budget(value: unknown): asserts value is Budget {
  fields(value, budgetKeys, "budget");
  for (const key of budgetKeys)
    if (
      !Number.isSafeInteger(value[key]) ||
      Number(value[key]) <
        (["memoryBytes", "timeMs", "cpuMs", "concurrency"].includes(key) ? 1 : 0) ||
      Number(value[key]) >
        (key === "concurrency" ? 1024 : key === "timeMs" ? 86400000 : Number.MAX_SAFE_INTEGER)
    )
      throw Error("Invalid resource budget " + key);
}
function within(value: Budget, limit: Budget, label: string): void {
  for (const key of budgetKeys)
    if (value[key] > limit[key]) throw Error(label + " budget exceeds " + key);
}
function aggregate(values: Budget[]): Budget {
  const total = zero();
  for (const value of values)
    for (const key of budgetKeys) {
      total[key] = additive.has(key) ? total[key] + value[key] : Math.max(total[key], value[key]);
      if (!Number.isSafeInteger(total[key])) throw Error("Resource budget overflow");
    }
  return total;
}
function ports(value: unknown, registry: Registry): asserts value is Ports {
  fields(value, ["inputs", "outputs"], "ports");
  for (const direction of ["inputs", "outputs"] as const) {
    const map = value[direction];
    if (!object(map) || Object.keys(map).length > 128) throw Error("Invalid port specification");
    for (const [key, port] of Object.entries(map)) {
      id(key, "port");
      fields(port, ["contract", "required", "cardinality"], "port");
      reference(port.contract);
      registry.contract(port.contract);
      if (typeof port.required !== "boolean" || !["one", "many"].includes(String(port.cardinality)))
        throw Error("Invalid port cardinality or required flag");
    }
  }
}
function binding(value: unknown): asserts value is Record<string, Binding> {
  if (!object(value) || Object.keys(value).length > 128) throw Error("Invalid resource bindings");
  for (const [key, item] of Object.entries(value)) {
    id(key, "binding");
    fields(item, ["kind", "required"], "binding");
    if (!resourceKinds.has(item.kind as ResourceKind) || typeof item.required !== "boolean")
      throw Error("Invalid binding kind or required flag");
  }
}

/** Trusted host registration binds an immutable artifact digest to a local handler. */
export class Registry {
  private entries = new Map<RegistryKind, Map<string, Entry<Identity>>>();
  private versions = new Set<string>();
  private handlers = new Map<string, Handler>();
  private add<T extends Identity>(kind: RegistryKind, definition: T): Ref {
    const key = json([kind, definition.scope.workspace, definition.id, definition.version]);
    if (this.versions.has(key)) throw Error("Registry version is already registered");
    const copy = frozen(definition) as T;
    const ref = frozen({
      id: copy.id,
      version: copy.version,
      digest: sha(json({ kind, definition: copy })),
    }) as Ref;
    let entries = this.entries.get(kind);
    if (!entries) this.entries.set(kind, (entries = new Map()));
    entries.set(ref.digest, { ref, definition: copy });
    this.versions.add(key);
    return ref;
  }
  private get<T extends Identity>(kind: RegistryKind, ref: Ref): T {
    reference(ref);
    const entry = this.entries.get(kind)?.get(ref.digest);
    if (!entry || entry.ref.id !== ref.id || entry.ref.version !== ref.version)
      throw Error("Unresolved " + kind + " version or digest reference");
    return entry.definition as T;
  }
  registerContract(value: Contract | Frozen<Contract>): Ref {
    json(value);
    fields(value, ["id", "version", "scope", "kind", "format", "schema"], "contract");
    identity(value);
    name(value.kind, "contract kind");
    name(value.format, "contract format");
    validateSchema(value.schema);
    return this.add("contract", value as Contract);
  }
  registerResource(value: Resource | Frozen<Resource>): Ref {
    json(value);
    fields(value, ["id", "version", "scope", "kind", "body"], "resource");
    identity(value);
    if (!resourceKinds.has(value.kind) || !own(value, "body"))
      throw Error("Invalid resource kind or body");
    return this.add("resource", value as Resource);
  }
  registerAdapter(value: Adapter | Frozen<Adapter>, handler: Handler): Ref {
    json(value);
    fields(value, ["id", "version", "scope", "artifact", "capabilities"], "adapter");
    identity(value);
    digest(value.artifact);
    caps(value.capabilities);
    if (typeof handler !== "function") throw Error("A registered local adapter requires a handler");
    const ref = this.add("adapter", value as Adapter);
    this.handlers.set(ref.digest, handler);
    return ref;
  }
  registerType(value: StepType | Frozen<StepType>): Ref {
    json(value);
    fields(
      value,
      [
        "id",
        "version",
        "scope",
        "category",
        "config",
        "adapter",
        "capabilities",
        "ports",
        "bindings",
      ],
      "step type",
    );
    identity(value);
    name(value.category, "step category");
    validateSchema(value.config);
    reference(value.adapter);
    caps(value.capabilities);
    ports(value.ports, this);
    binding(value.bindings);
    if (this.adapter(value.adapter).capabilities.some((cap) => !value.capabilities.includes(cap)))
      throw Error("Step type conceals required adapter capabilities");
    for (const item of Object.values(value.bindings))
      if (!value.capabilities.includes(bindingCaps[item.kind]))
        throw Error("Resource binding conceals a required capability");
    return this.add("type", value as StepType);
  }
  manifest(): Frozen<Manifest> {
    const list = <T extends Identity>(kind: RegistryKind): T[] =>
      [...(this.entries.get(kind)?.values() ?? [])]
        .map((entry) => entry.definition as T)
        .sort((a, b) =>
          compare(
            json([a.scope.workspace, a.id, a.version]),
            json([b.scope.workspace, b.id, b.version]),
          ),
        );
    return frozen({
      format: "registry/1",
      contracts: list<Contract>("contract"),
      resources: list<Resource>("resource"),
      adapters: list<Adapter>("adapter"),
      types: list<StepType>("type"),
    });
  }
  static open(value: unknown, trusted: Registry): Registry {
    const copy = JSON.parse(json(value));
    fields(copy, ["format", "contracts", "resources", "adapters", "types"], "registry manifest");
    if (copy.format !== "registry/1") throw Error("Invalid registry manifest format");
    for (const key of ["contracts", "resources", "adapters", "types"])
      if (!Array.isArray(copy[key]) || copy[key].length > 4096)
        throw Error("Registry manifest exceeds entry bounds");
    const registry = new Registry();
    for (const contract of copy.contracts as Contract[]) registry.registerContract(contract);
    for (const resource of copy.resources as Resource[]) registry.registerResource(resource);
    for (const adapter of copy.adapters as Adapter[]) {
      const ref = {
        id: adapter.id,
        version: adapter.version,
        digest: sha(json({ kind: "adapter", definition: adapter })),
      };
      trusted.adapter(ref);
      registry.registerAdapter(adapter, trusted.executor(ref));
    }
    for (const type of copy.types as StepType[]) registry.registerType(type);
    return registry;
  }
  contract(ref: Ref): Frozen<Contract> {
    return this.get<Contract>("contract", ref);
  }
  resource(ref: Ref): Frozen<Resource> {
    return this.get<Resource>("resource", ref);
  }
  adapter(ref: Ref): Frozen<Adapter> {
    return this.get<Adapter>("adapter", ref);
  }
  type(ref: Ref): Frozen<StepType> {
    return this.get<StepType>("type", ref);
  }
  executor(ref: Ref): Handler {
    this.adapter(ref);
    const handler = this.handlers.get(ref.digest);
    if (!handler) throw Error("Local adapter handler is unavailable");
    return handler;
  }
}

function authorize(value: Frozen<Identity>, ref: Frozen<Ref>, policy: Policy): void {
  if (value.scope.workspace !== policy.scope.workspace)
    throw Error("Reference is outside the authorized workspace scope");
  if (
    json(value.scope) !== json(policy.scope) &&
    !policy.grants.some((grant) => json(grant) === json(ref))
  )
    throw Error("Reference scope is not authorized");
}
function validatePolicy(value: unknown): asserts value is Policy {
  fields(value, ["scope", "capabilities", "budget", "grants"], "policy");
  scope(value.scope);
  caps(value.capabilities);
  budget(value.budget);
  if (!Array.isArray(value.grants) || value.grants.length > 4096)
    throw Error("Invalid scope grants");
  value.grants.forEach(reference);
}
function definition(value: unknown): Definition {
  const copy = JSON.parse(json(value, 2 * 1024 ** 2));
  fields(
    copy,
    ["format", "id", "version", "scope", "name", "budget", "stages", "steps", "edges"],
    "workflow definition",
  );
  identity(copy);
  name(copy.name, "workflow name");
  budget(copy.budget);
  if (
    copy.format !== "workflow/1" ||
    !Array.isArray(copy.stages) ||
    !copy.stages.length ||
    copy.stages.length > 128 ||
    !Array.isArray(copy.steps) ||
    !copy.steps.length ||
    copy.steps.length > 1024 ||
    !Array.isArray(copy.edges) ||
    copy.edges.length > 8192
  )
    throw Error("Invalid workflow definition graph bounds");
  const unique = (items: unknown[], label: string) => {
    const keys = new Set<string>();
    for (const item of items) {
      if (!object(item)) throw Error("Invalid " + label);
      id(item.id, label);
      if (keys.has(item.id)) throw Error("Duplicate " + label + " identifier");
      keys.add(item.id);
    }
  };
  unique(copy.stages, "stage");
  unique(copy.steps, "step");
  unique(copy.edges, "edge");
  for (const item of copy.stages) {
    fields(item, ["id", "name", "budget"], "stage");
    name(item.name, "stage name");
    budget(item.budget);
  }
  for (const item of copy.steps) {
    fields(item, ["id", "stage", "type", "config", "pins", "budget"], "step");
    id(item.stage, "stage");
    reference(item.type);
    budget(item.budget);
    if (!own(item, "config") || !object(item.pins) || Object.keys(item.pins).length > 128)
      throw Error("Invalid step config or pins");
    for (const [key, ref] of Object.entries(item.pins)) {
      id(key, "pin");
      reference(ref);
    }
  }
  for (const item of copy.edges) {
    fields(item, ["id", "from", "to"], "edge");
    for (const endpoint of [item.from, item.to]) {
      fields(endpoint, ["step", "port"], "edge endpoint");
      id(endpoint.step, "edge step");
      id(endpoint.port, "edge port");
    }
  }
  for (const items of [copy.stages, copy.steps, copy.edges])
    items.sort((a: { id: string }, b: { id: string }) => compare(a.id, b.id));
  return copy as Definition;
}
function topology(
  ids: string[],
  pairs: [string, string][],
  label: string,
): { order: string[]; levels: string[][] } {
  const needs = new Map(ids.map((id) => [id, new Set<string>()])),
    next = new Map(ids.map((id) => [id, new Set<string>()]));
  for (const [from, to] of pairs) {
    needs.get(to)!.add(from);
    next.get(from)!.add(to);
  }
  let ready = ids.filter((id) => !needs.get(id)!.size).sort();
  const order: string[] = [],
    levels: string[][] = [];
  while (ready.length) {
    const level = ready;
    levels.push(level);
    order.push(...level);
    const following = new Set<string>();
    for (const from of level)
      for (const to of next.get(from)!) {
        needs.get(to)!.delete(from);
        if (!needs.get(to)!.size) following.add(to);
      }
    ready = [...following].sort();
  }
  if (order.length !== ids.length) throw Error(label + " cycle is not permitted");
  return { order, levels };
}
function compile(value: Definition, registry: Registry, policy: Policy): Plan {
  if (json(value.scope) !== json(policy.scope))
    throw Error("Workflow ownership scope is not authorized");
  within(value.budget, policy.budget, "Workflow policy");
  const stages = new Map(value.stages.map((stage) => [stage.id, stage])),
    steps = new Map(value.steps.map((step) => [step.id, step]));
  const compiled = new Map<string, CompiledStep>();
  for (const stage of value.stages) {
    within(stage.budget, value.budget, "Stage " + stage.id);
    if (!value.steps.some((step) => step.stage === stage.id)) throw Error("Stage has no steps");
  }
  for (const step of value.steps) {
    const stage = stages.get(step.stage);
    if (!stage) throw Error("Step references an unknown stage");
    within(step.budget, stage.budget, "Step " + step.id);
    const type = registry.type(step.type),
      adapter = registry.adapter(type.adapter as Ref);
    authorize(type, step.type, policy);
    authorize(adapter, type.adapter, policy);
    for (const cap of type.capabilities)
      if (!policy.capabilities.includes(cap))
        throw Error("Step capability is not authorized: " + cap);
    if (!accepts(type.config as Schema, step.config))
      throw Error("Step configuration does not satisfy its registered schema");
    for (const port of [...Object.values(type.ports.inputs), ...Object.values(type.ports.outputs)])
      authorize(registry.contract(port.contract as Ref), port.contract, policy);
    for (const [key, pin] of Object.entries(step.pins)) {
      const binding = type.bindings[key];
      if (!binding) throw Error("Undeclared resource pin binding");
      const resource = registry.resource(pin);
      authorize(resource, pin, policy);
      if (resource.kind !== binding.kind) throw Error("Resource pin kind does not satisfy binding");
    }
    for (const [key, binding] of Object.entries(type.bindings))
      if (binding.required && !own(step.pins, key))
        throw Error("Required resource pin binding is missing");
    compiled.set(step.id, {
      ...step,
      adapter: type.adapter as Ref,
      ports: type.ports as Ports,
      inputs: Object.fromEntries(Object.keys(type.ports.inputs).map((key) => [key, []])),
      dependencies: [],
    });
  }
  const routes = new Set<string>(),
    pairs: [string, string][] = [],
    stagePairs: [string, string][] = [];
  for (const edge of value.edges) {
    const from = compiled.get(edge.from.step),
      to = compiled.get(edge.to.step);
    if (!from || !to)
      throw Error("Edge endpoint references an unknown step in this workflow version");
    const output = from.ports.outputs[edge.from.port],
      input = to.ports.inputs[edge.to.port];
    if (!output || !input) throw Error("Edge endpoint has no port in the declared direction");
    const route = json([edge.from, edge.to]);
    if (routes.has(route)) throw Error("Duplicate edge route");
    routes.add(route);
    if (json(output.contract) !== json(input.contract))
      throw Error("Port contract versions are incompatible; use an explicit conversion step");
    if (output.cardinality === "many" && input.cardinality === "one")
      throw Error(
        "Output cardinality many cannot feed input cardinality one without a selection step",
      );
    to.inputs[edge.to.port].push(edge.from);
    pairs.push([from.id, to.id]);
    if (from.stage !== to.stage) stagePairs.push([from.stage, to.stage]);
  }
  for (const step of compiled.values()) {
    for (const [key, port] of Object.entries(step.ports.inputs)) {
      const inputs = step.inputs[key];
      inputs.sort((a, b) => compare(json([a.step, a.port]), json([b.step, b.port])));
      if (port.required && !inputs.length)
        throw Error("Required step input is unbound: " + step.id + "." + key);
      if (port.cardinality === "one" && inputs.length > 1)
        throw Error("Input cardinality one has multiple bindings");
    }
    step.dependencies = [
      ...new Set(
        Object.values(step.inputs)
          .flat()
          .map((endpoint) => endpoint.step),
      ),
    ].sort();
  }
  topology([...steps.keys()], pairs, "Step");
  const stageOrder = topology([...stages.keys()], stagePairs, "Stage").order;
  const order: string[] = [],
    levels: string[][] = [];
  for (const stage of stageOrder) {
    const members = value.steps.filter((step) => step.stage === stage),
      ids = members.map((step) => step.id);
    within(
      aggregate(members.map((step) => step.budget)),
      stages.get(stage)!.budget,
      "Stage aggregate " + stage,
    );
    const local = topology(
      ids,
      pairs.filter(
        ([from, to]) => steps.get(from)!.stage === stage && steps.get(to)!.stage === stage,
      ),
      "Step",
    );
    order.push(...local.order);
    levels.push(...local.levels);
  }
  within(aggregate(value.steps.map((step) => step.budget)), value.budget, "Workflow aggregate");
  return { stages: stageOrder, levels, steps: order.map((id) => compiled.get(id)!) };
}

function checkPackets(
  values: unknown,
  port: Frozen<Port>,
  registry: Registry,
  label: string,
): asserts values is Json[] {
  if (
    !Array.isArray(values) ||
    (port.required && !values.length) ||
    (port.cardinality === "one" && values.length > 1)
  )
    throw Error("Port required/cardinality contract failed: " + label);
  const contract = registry.contract(port.contract as Ref);
  if (values.some((value) => !accepts(contract.schema as Schema, value)))
    throw Error("Port data contract failed: " + label);
}

function diagnostic(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  // A UTF-16 code unit occupies at most six bytes after JSON escaping.
  const limit = Math.floor((errorBytes - 5) / 6);
  return message.length > limit ? message.slice(0, limit) + "…" : message;
}

function reserveTrace(plan: Frozen<Plan>, workflow: Ref, scope: Frozen<Scope>): void {
  const run = "00000000-0000-0000-0000-000000000000";
  const date = "2000-01-01T00:00:00.000Z";
  const usage = Object.fromEntries(budgetKeys.map((key) => [key, Number.MAX_SAFE_INTEGER]));
  const ports = (values: Frozen<Record<string, Port>>) =>
    Object.fromEntries(Object.keys(values).map((key) => [key, []]));
  const outputs = new Map(
    plan.steps.map((step) => [
      step.id,
      Math.min(step.budget.storageBytes, step.budget.memoryBytes, jsonBytes),
    ]),
  );
  const message =
    "Local trace allocation exceeds its byte bound; use artifact handles for larger data";
  let metadata: number;
  try {
    metadata = Buffer.byteLength(
      json({
        id: run,
        workflow,
        scope,
        state: "completed",
        usage,
        outputs: Object.fromEntries(plan.steps.map((step) => [step.id, ports(step.ports.outputs)])),
        steps: plan.steps.map((step) => ({
          run,
          workflow,
          step: step.id,
          stage: step.stage,
          type: step.type,
          adapter: step.adapter,
          state: "completed",
          startedAt: date,
          finishedAt: date,
          usage,
          inputs: ports(step.ports.inputs),
          outputDigest: "0".repeat(64),
          error: "",
          rejected: null,
        })),
      }),
    );
  } catch {
    throw Error(message);
  }
  let retained = 0;
  for (const step of plan.steps) {
    // The returned trace serializes packets again for each downstream attempt.
    const inputs = Object.values(step.inputs)
      .flat()
      .reduce((bytes, endpoint) => bytes + outputs.get(endpoint.step)!, 0);
    retained += Math.min(inputs, step.budget.memoryBytes);
    const rejected = Math.min(step.budget.memoryBytes, jsonBytes);
    if (metadata + retained + rejected + errorBytes > jsonBytes) throw Error(message);
    retained += outputs.get(step.id)!;
    if (metadata + retained + errorBytes > jsonBytes) throw Error(message);
  }
}

/** Immutable, verified local DAG. Persistence and multi-process authority belong to an external run store. */
export class Workflow {
  readonly definition: Frozen<Definition>;
  readonly digest: string;
  readonly plan: Frozen<Plan>;
  readonly release: Frozen<Release>;
  private readonly policy: Frozen<Policy>;
  private constructor(value: Definition, plan: Plan, policy: Policy) {
    this.definition = frozen(value);
    this.digest = sha(json(this.definition));
    this.plan = frozen(plan);
    this.policy = frozen(policy);
    this.release = frozen({
      format: "workflow-release/1",
      definition: value,
      digest: this.digest,
      plan,
    });
    Object.freeze(this);
  }
  static publish(value: unknown, registry: Registry, policy: Policy): Workflow {
    json(policy);
    validatePolicy(policy);
    const normalized = definition(value);
    return new Workflow(normalized, compile(normalized, registry, policy), policy);
  }
  static open(value: unknown, registry: Registry, policy: Policy): Workflow {
    fields(value, ["format", "definition", "digest", "plan"], "workflow release");
    if (value.format !== "workflow-release/1") throw Error("Invalid workflow release format");
    digest(value.digest);
    const workflow = Workflow.publish(value.definition, registry, policy);
    if (workflow.digest !== value.digest) throw Error("Workflow release digest integrity mismatch");
    if (json(workflow.plan) !== json(value.plan))
      throw Error("Workflow compiled plan integrity mismatch");
    return workflow;
  }
  async run(registry: Registry, options: RunOptions = {}): Promise<Frozen<Run>> {
    const current = Workflow.open(
      this.release,
      registry,
      options.policy ?? (this.policy as Policy),
    );
    const runId = randomUUID(),
      workflow: Ref = {
        id: this.definition.id,
        version: this.definition.version,
        digest: this.digest,
      };
    reserveTrace(current.plan, workflow, current.definition.scope);
    const run: Run = {
      id: runId,
      workflow,
      scope: this.definition.scope as Scope,
      state: "completed",
      steps: [],
      outputs: Object.create(null),
      usage: zero(),
    };
    for (const step of current.plan.steps) {
      const inputs: Outputs = Object.create(null),
        pins: Record<string, Resource> = Object.create(null),
        usage = zero();
      const startedAt = new Date().toISOString(),
        started = performance.now(),
        cpu = process.cpuUsage();
      const attempt: StepRun = {
        run: runId,
        workflow,
        step: step.id,
        stage: step.stage,
        type: step.type as Ref,
        adapter: step.adapter as Ref,
        state: "completed",
        startedAt,
        finishedAt: startedAt,
        usage,
        inputs,
      };
      let output: unknown, timer: ReturnType<typeof setTimeout> | undefined;
      const controller = new AbortController(),
        abort = () => controller.abort(options.signal?.reason);
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
      try {
        let inputBytes = 0,
          packets = 0;
        for (const [key, endpoints] of Object.entries(step.inputs)) {
          inputs[key] = [];
          for (const endpoint of endpoints)
            for (const packet of run.outputs[endpoint.step][endpoint.port]) {
              inputBytes += Buffer.byteLength(
                json(packet, Math.min(step.budget.memoryBytes, jsonBytes)),
              );
              if (++packets > 65536 || inputBytes > step.budget.memoryBytes)
                throw Error("Step input packet or memory budget exceeded");
              inputs[key].push(packet);
            }
          checkPackets(inputs[key], step.ports.inputs[key], registry, step.id + "." + key);
        }
        for (const [key, pin] of Object.entries(step.pins))
          pins[key] = registry.resource(pin as Ref) as Resource;
        usage.memoryBytes = Buffer.byteLength(json({ config: step.config, inputs, pins }));
        usage.concurrency = 1;
        within(usage, step.budget as Budget, "Step input");
        if (controller.signal.aborted) throw Error("Workflow run was aborted");
        const context: Context = {
          run: runId,
          workflow: frozen(workflow),
          step: step.id,
          config: step.config,
          inputs: frozen(inputs),
          pins: frozen(pins),
          budget: step.budget,
          capabilities: registry.type(step.type as Ref).capabilities,
          signal: controller.signal,
          charge(value) {
            fields(value, ["tokens", "costMicros"], "usage charge");
            const next = { ...usage };
            for (const key of ["tokens", "costMicros"] as const) {
              const amount = value[key] ?? 0;
              if (!Number.isSafeInteger(amount) || amount < 0) throw Error("Invalid usage charge");
              next[key] += amount;
              if (!Number.isSafeInteger(next[key])) throw Error("Usage charge overflow");
            }
            within(next, step.budget as Budget, "Step usage");
            Object.assign(usage, next);
          },
        };
        output = await Promise.race([
          Promise.resolve().then(() =>
            registry.executor(step.adapter as Ref)(Object.freeze(context)),
          ),
          new Promise<never>((_ok, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(Error("Step time budget exceeded"));
            }, step.budget.timeMs);
            controller.signal.addEventListener(
              "abort",
              () => reject(Error("Workflow step aborted or time budget exceeded")),
              { once: true },
            );
          }),
        ]);
        json(output);
        if (!object(output) || Object.keys(output).some((key) => !own(step.ports.outputs, key)))
          throw Error("Adapter returned an undeclared output port");
        let outputPackets = 0;
        for (const [key, port] of Object.entries(step.ports.outputs)) {
          checkPackets(output[key] ?? [], port, registry, step.id + "." + key);
          outputPackets += (output[key] as Json[] | undefined)?.length ?? 0;
        }
        if (outputPackets > 65536) throw Error("Step output packet bound exceeded");
        const normalized = Object.fromEntries(
          Object.keys(step.ports.outputs).map((key) => [key, (output as Outputs)[key] ?? []]),
        );
        const serialized = json(normalized);
        usage.storageBytes = Buffer.byteLength(serialized);
        usage.memoryBytes += usage.storageBytes;
        usage.timeMs = Math.ceil(performance.now() - started);
        const elapsed = process.cpuUsage(cpu);
        usage.cpuMs = Math.ceil((elapsed.user + elapsed.system) / 1000);
        within(usage, step.budget as Budget, "Step output");
        run.outputs[step.id] = frozen(normalized) as Outputs;
        attempt.outputDigest = sha(serialized);
      } catch (error) {
        attempt.state = "failed";
        attempt.error = diagnostic(error, "Local adapter failed");
        run.state = "failed";
        if (output !== undefined) {
          try {
            const serialized = json(output, Math.min(step.budget.memoryBytes, jsonBytes));
            attempt.rejected = JSON.parse(serialized) as Json;
          } catch {
            /* Oversized/non-JSON outputs remain an explicit diagnostic, not accepted data. */
          }
        }
      } finally {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        usage.timeMs = Math.ceil(performance.now() - started);
        const elapsed = process.cpuUsage(cpu);
        usage.cpuMs = Math.ceil((elapsed.user + elapsed.system) / 1000);
        attempt.finishedAt = new Date().toISOString();
        if (attempt.state === "completed")
          try {
            within(usage, step.budget as Budget, "Step final usage");
          } catch (error) {
            attempt.state = "failed";
            attempt.error = diagnostic(error, "Step budget exceeded");
            delete attempt.outputDigest;
            delete run.outputs[step.id];
            run.state = "failed";
          }
        run.steps.push(attempt);
        run.usage = aggregate([run.usage, usage]);
      }
      if (run.state === "failed") break;
    }
    return frozen(run);
  }
}
