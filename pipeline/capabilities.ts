/** Built-in operators bind declared resources to full local SQLite/JSONL data. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { Catalog } from "./catalog.ts";
import { Dataset, validateSteps, type RecordInput, type Revision } from "./dataset.ts";
import {
  Registry,
  type Scope,
  type Ref,
  type Schema,
  type Context,
  type Json,
  type Outputs,
  type Capability,
  type Binding,
  type Port,
} from "./workflow.ts";
import { order, validRole, type Role, type Payload } from "./roles.ts";
import { proof } from "./proof.ts";
import type { Inference, Request } from "./run.ts";

export type LibraryOptions = {
  catalog: Catalog;
  dataset: Dataset;
  connections?: Record<string, string>;
  infer?: Inference;
  modelKey?: string;
  concurrency?: number;
  recordBytes?: number;
};
export type Handle = { revision: string; count: number; hash: string };
export type Library = {
  registry: Registry;
  types: Readonly<Record<string, Ref>>;
  contracts: { jsonl: Ref; sqlite: Ref };
};
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const shape = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const string: Schema = { type: "string" },
  empty = shape({});
function key(context: Context) {
  const hex = sha(context.run + "\0" + context.step);
  return (
    hex.slice(0, 8) +
    "-" +
    hex.slice(8, 12) +
    "-4" +
    hex.slice(13, 16) +
    "-8" +
    hex.slice(17, 20) +
    "-" +
    hex.slice(20, 32)
  );
}
function field(value: unknown, path: string): unknown {
  if (!/^\$(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/.test(path))
    throw Error("field path must be a simple JSON property path");
  let result = value;
  for (const name of path.slice(2).split(".").filter(Boolean)) {
    if (
      ["__proto__", "constructor", "prototype"].includes(name) ||
      !object(result) ||
      !Object.hasOwn(result, name)
    )
      return undefined;
    result = result[name];
  }
  return result;
}
function plain(value: unknown, limit: number) {
  const text = JSON.stringify(value);
  if (text === undefined || Buffer.byteLength(text) > limit)
    throw Error("record exceeds configured byte bound; normalize or chunk it explicitly");
  return text;
}
function inspect(dataset: Dataset, value: unknown): Revision {
  if (
    !object(value) ||
    typeof value.revision !== "string" ||
    !Number.isSafeInteger(value.count) ||
    typeof value.hash !== "string"
  )
    throw Error("invalid dataset handle");
  const revision = dataset.revision(value.revision);
  if (revision.count !== value.count || revision.hash !== value.hash)
    throw Error("dataset handle integrity mismatch");
  return revision;
}
function handle(revision: Revision): Handle {
  return { revision: revision.id, count: revision.count, hash: revision.hash };
}
function outputs(revision: Revision): Outputs {
  const ref = handle(revision) as unknown as Json;
  return { jsonl: [ref], sqlite: [ref] };
}
function input(context: Context, dataset: Dataset): Revision {
  const values = [...(context.inputs.jsonl ?? []), ...(context.inputs.sqlite ?? [])];
  if (!values.length) throw Error("bind a SQLite or JSONL dataset input");
  const revisions = values.map((value) => inspect(dataset, value));
  if (revisions.some((r) => r.id !== revisions[0].id))
    throw Error("dual representations must identify the same revision");
  return revisions[0];
}
/** Bounded framing, full hashes and exact order; no model receives filesystem references. */
async function* records(
  dataset: Dataset,
  revision: Revision,
  maxBytes: number,
  signal: AbortSignal,
): AsyncGenerator<RecordInput> {
  await dataset.verify(revision.id);
  const hash = createHash("sha256");
  let pending = Buffer.alloc(0),
    count = 0;
  const stream = createReadStream(revision.path, { highWaterMark: 65536 });
  try {
    for await (const part of stream) {
      if (signal.aborted) throw Error("operation aborted");
      const bytes = Buffer.from(part);
      hash.update(bytes);
      pending = Buffer.concat([pending, bytes]);
      for (;;) {
        const end = pending.indexOf(10);
        if (end < 0) break;
        if (end > maxBytes) throw Error("record exceeds configured byte bound");
        const line = pending.subarray(0, end).toString("utf8");
        pending = pending.subarray(end + 1);
        if (!line) throw Error("empty JSONL record");
        const value = JSON.parse(line) as RecordInput;
        if (
          typeof value.id !== "string" ||
          typeof value.source !== "string" ||
          typeof value.key !== "string" ||
          !Object.hasOwn(value, "body")
        )
          throw Error("invalid canonical JSONL record");
        count++;
        yield value;
      }
      if (pending.length > maxBytes) throw Error("record exceeds configured byte bound");
    }
    if (pending.length || count !== revision.count || hash.digest("hex") !== revision.hash)
      throw Error("JSONL revision integrity changed during processing");
  } finally {
    stream.destroy();
  }
}

export async function library(scope: Scope, options: LibraryOptions): Promise<Library> {
  const registry = new Registry(),
    types: Record<string, Ref> = Object.create(null),
    dataset = options.dataset;
  const concurrency = options.concurrency ?? 64,
    maxBytes = options.recordBytes ?? 8 * 1024 ** 2;
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 64 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1024 ||
    maxBytes > 64 * 1024 ** 2
  )
    throw Error("invalid library resource bounds");
  const sourceHash = sha(await readFile(import.meta.filename));
  const schema = shape({ revision: string, count: { type: "integer", minimum: 0 }, hash: string });
  const jsonl = registry.registerContract({
    id: "dataset.jsonl",
    version: 1,
    scope,
    kind: "dataset",
    format: "jsonl",
    schema,
  });
  const sqlite = registry.registerContract({
    id: "dataset.sqlite",
    version: 1,
    scope,
    kind: "dataset",
    format: "sqlite",
    schema,
  });
  const out = {
    jsonl: { contract: jsonl, required: true, cardinality: "one" as const },
    sqlite: { contract: sqlite, required: true, cardinality: "one" as const },
  };
  const incoming = {
    jsonl: { contract: jsonl, required: false, cardinality: "one" as const },
    sqlite: { contract: sqlite, required: false, cardinality: "one" as const },
  };
  function register(
    id: string,
    category: string,
    config: Schema,
    capabilities: Capability[],
    bindings: Record<string, Binding>,
    handler: (context: Context) => Promise<Outputs>,
    inputs: Record<string, Port> = incoming,
  ) {
    const adapter = registry.registerAdapter(
      { id, version: 1, scope, artifact: sha(sourceHash + "\0" + id), capabilities },
      handler,
    );
    types[id] = registry.registerType({
      id,
      version: 1,
      scope,
      category,
      config,
      adapter,
      capabilities,
      bindings,
      ports: { inputs, outputs: out },
    });
  }
  register(
    "dataset.capture",
    "ingest",
    shape({ table: string, name: string }),
    ["data.read", "data.write", "resource.read"],
    { source: { kind: "connection", required: true } },
    async (context) => {
      const body = context.pins.source?.body;
      const connection = object(body) ? body.connection : undefined;
      const source = typeof connection === "string" ? options.connections?.[connection] : undefined;
      if (!source) throw Error("connection has no approved local catalog binding");
      const config = context.config as { table: string; name: string },
        id = key(context);
      async function* sourceRecords() {
        for await (const row of options.catalog.records(source!, config.table)) {
          if (context.signal.aborted) throw Error("operation aborted");
          plain(row.sqlite, maxBytes);
          yield { id: row.id, source: source!, key: row.key, body: row.sqlite };
        }
      }
      return outputs(await dataset.capture(config.name, sourceRecords(), { id }));
    },
    {},
  );
  register(
    "dataset.transform",
    "transform",
    shape({ name: string, steps: string, pauseOnFailure: { type: "boolean" } }),
    ["data.read", "data.write"],
    {},
    async (context) => {
      const parent = input(context, dataset);
      await dataset.verify(parent.id);
      const config = context.config as { name: string; steps: string; pauseOnFailure: boolean },
        steps = validateSteps(JSON.parse(config.steps));
      const started = dataset.start(parent.id, steps, {
        id: key(context),
        pauseOnFailure: config.pauseOnFailure,
      });
      const run =
        started.state === "paused"
          ? await dataset.resume(started.id)
          : await dataset.execute(started.id);
      if (run.state !== "completed" || !run.revision)
        throw Error(
          "dataset validation paused: " + run.id + "; review failures, correct and resume",
        );
      return outputs(dataset.revision(run.revision));
    },
  );
  register("dataset.verify", "validate", empty, ["data.read"], {}, async (context) => {
    const revision = input(context, dataset);
    await dataset.verify(revision.id);
    return outputs(revision);
  });
  register(
    "model.infer",
    "infer",
    shape({ role: { type: "string", enum: [...order] }, payload: string, name: string }),
    ["data.read", "data.write", "model.invoke"],
    { model: { kind: "model", required: true } },
    async (context) => {
      if (!options.infer || !options.modelKey)
        throw Error("no admitted resident local model is configured");
      const model = context.pins.model?.body;
      if (!object(model) || model.provider !== "mlx" || model.model !== options.modelKey)
        throw Error("model resource does not match the admitted resident model");
      const config = context.config as { role: Role; payload: string; name: string },
        revision = input(context, dataset),
        infer = options.infer;
      const saved = dataset.revisions().find((item) => item.id === "rev-" + key(context));
      if (saved) await dataset.verify(saved.id);
      async function enrich(record: RecordInput, index: number): Promise<RecordInput> {
        if (context.signal.aborted) throw Error("operation aborted");
        const value = field(record.body, config.payload);
        if (!object(value)) throw Error("model input must map to a dynamic payload object");
        plain(value, maxBytes);
        const payload = value as Payload,
          text = JSON.stringify(payload),
          digest = sha(text);
        const request: Request = {
          id: sha(context.run + "\0" + context.step + "\0" + record.id),
          role: config.role,
          text,
          attempt: 1,
          chunk: { id: record.id, index: 0, start: 0, end: text.length, text, hash: digest },
          sourceHash: sha(plain(record.body, maxBytes)),
          configHash: context.workflow.digest,
          payload,
        };
        const cached = dataset.checkpoint(key(context), index);
        if (cached) {
          const body = cached.body,
            history = object(body) && object(body.inference) ? body.inference : undefined,
            entry = history?.[config.role];
          if (
            cached.id !== record.id ||
            cached.source !== record.source ||
            cached.key !== record.key ||
            !object(entry) ||
            entry.sourceHash !== request.sourceHash ||
            entry.configHash !== request.configHash ||
            entry.model !== options.modelKey ||
            entry.inputRevision !== revision.id ||
            entry.inputHash !== revision.hash ||
            entry.run !== context.run ||
            entry.step !== context.step
          )
            throw Error("model checkpoint provenance mismatch");
          return cached;
        }
        const result = await infer(request),
          evidence = proof(result);
        if (
          !object(evidence) ||
          evidence.id !== request.id ||
          evidence.role !== config.role ||
          !Array.isArray(evidence.phases) ||
          !evidence.phases.length
        )
          throw Error("local model requires attributable measured inference proof");
        let tokens = 0;
        for (const phase of evidence.phases) {
          if (
            !object(phase) ||
            !Number.isSafeInteger(phase.inputTokens) ||
            Number(phase.inputTokens) < 1 ||
            !Number.isSafeInteger(phase.outputTokens) ||
            Number(phase.outputTokens) < 0
          )
            throw Error("local model proof requires measured phase tokens");
          tokens += Number(phase.inputTokens) + Number(phase.outputTokens);
          if (!Number.isSafeInteger(tokens)) throw Error("local model token usage overflow");
        }
        context.charge({ tokens });
        if (!validRole(config.role, result, payload))
          throw Error("local model output failed the packaged role contract");
        if (!object(record.body)) throw Error("model enrichment requires an object record");
        const previous = object(record.body.enrichment) ? record.body.enrichment : {},
          history = object(record.body.inference) ? record.body.inference : {};
        return {
          ...record,
          body: {
            ...record.body,
            enrichment: { ...previous, [config.role]: JSON.parse(JSON.stringify(result)) },
            inference: {
              ...history,
              [config.role]: {
                run: context.run,
                step: context.step,
                model: options.modelKey,
                sourceHash: request.sourceHash,
                configHash: request.configHash,
                inputRevision: revision.id,
                inputHash: revision.hash,
                tokens,
                proof: evidence,
              },
            },
          },
        };
      }
      async function* batch(group: RecordInput[], start: number) {
        const settled = await Promise.allSettled(
          group.map((record, index) => enrich(record, start + index)),
        );
        for (const item of settled) {
          if (item.status === "rejected") throw item.reason;
          yield item.value;
        }
      }
      async function* enriched() {
        let group: RecordInput[] = [],
          index = 0;
        for await (const record of records(dataset, revision, maxBytes, context.signal)) {
          group.push(record);
          if (group.length >= Math.min(concurrency, context.budget.concurrency)) {
            for await (const value of batch(group, index)) yield value;
            index += group.length;
            group = [];
          }
        }
        for await (const value of batch(group, index)) yield value;
      }
      return outputs(await dataset.capture(config.name, enriched(), { id: key(context) }));
    },
  );
  return { registry, types: Object.freeze(types), contracts: { jsonl, sqlite } };
}
