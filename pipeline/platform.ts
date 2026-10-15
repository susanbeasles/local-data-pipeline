import { mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Catalog, type Source } from "./catalog.ts";
import { Dataset } from "./dataset.ts";
import { Definitions } from "./definitions.ts";
import { Execution, type Batch, type Work } from "./execution.ts";
import { Files, Metadata, Postgres, type Database, type Row, type Scope } from "./metadata.ts";
import { Registry, Workflow, type Policy } from "./workflow.ts";
import type { Model } from "./mlx.ts";
import type { Inference } from "./run.ts";

export type Config = {
  format: "platform/1";
  state: string;
  input?: string;
  scope: Scope;
  policy: Policy;
  database: { environment: string } | { socket: string; database: string; user: string };
  catalog?: Source[];
  connections?: Record<string, string>;
  model?: Model;
  modelKey?: string;
};
/** Trusted host dependencies; injected database/registry objects never originate in JSON. */
export type Bindings = { database?: Database; registry?: Registry };
export type WorkerOptions = {
  worker: string;
  limit?: number;
  pollMs?: number;
  signal?: AbortSignal;
  onWork?: (work: Work) => void | Promise<void>;
};
export type WorkerState = { processed: number; stopped: "signal" | "limit" };
export type Action =
  | "health"
  | "registry"
  | "sources"
  | "tables"
  | "page"
  | "record"
  | "flows"
  | "preview"
  | "publish"
  | "run"
  | "work"
  | "pause"
  | "resume"
  | "status";

const bound = 2 * 1024 ** 2;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const own = (value: object, key: string) => Object.hasOwn(value, key);
function object(value: unknown, label: string): asserts value is Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("invalid " + label);
}
function fields(
  value: unknown,
  keys: readonly string[],
  label: string,
  optional: readonly string[] = [],
): asserts value is Row {
  object(value, label);
  if (
    Object.keys(value).some((key) => !keys.includes(key)) ||
    keys.some((key) => !optional.includes(key) && !own(value, key))
  )
    throw Error("invalid " + label + " fields");
}
function text(value: unknown, label: string, max = 4096): asserts value is string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max)
    throw Error("invalid " + label);
}
function path(value: unknown, label: string): asserts value is string {
  text(value, label);
  if (!isAbsolute(value) || value.includes("\0")) throw Error(label + " must be an absolute path");
}
function json(value: unknown): string {
  const seen = new Set<object>();
  let bytes = 0;
  const add = (value: string) => {
    bytes += Buffer.byteLength(value);
    if (bytes > bound) throw Error("platform JSON exceeds 2 MiB bound");
    return value;
  };
  const visit = (value: unknown, depth: number): string => {
    if (depth > 64) throw Error("platform JSON nesting exceeds bound");
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    )
      return add(JSON.stringify(value));
    if (
      !value ||
      typeof value !== "object" ||
      seen.has(value) ||
      Object.getOwnPropertySymbols(value).length ||
      (!Array.isArray(value) &&
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null)
    )
      throw Error("platform values must be finite acyclic plain JSON");
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value)))
      if (
        !own(descriptor, "value") ||
        (!descriptor.enumerable && !(Array.isArray(value) && key === "length"))
      )
        throw Error("platform JSON cannot contain accessors or hidden fields");
    seen.add(value);
    let result: string;
    if (Array.isArray(value)) {
      if (
        Object.keys(value).length !== value.length ||
        Array.from({ length: value.length }, (_, i) => own(value, String(i))).includes(false)
      )
        throw Error("platform JSON arrays must be dense");
      result = add("[") + value.map((child) => visit(child, depth + 1)).join(",") + add("]");
    } else
      result =
        add("{") +
        Object.keys(value)
          .sort()
          .map((key) => add(JSON.stringify(key)) + add(":") + visit((value as Row)[key], depth + 1))
          .join(",") +
        add("}");
    seen.delete(value);
    return result;
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(result) > bound) throw Error("platform JSON exceeds 2 MiB bound");
  return result;
}
export function configuration(value: unknown): Config {
  const copy: unknown = JSON.parse(json(value));
  fields(
    copy,
    [
      "format",
      "state",
      "input",
      "scope",
      "policy",
      "database",
      "catalog",
      "connections",
      "model",
      "modelKey",
    ],
    "platform configuration",
    ["input", "catalog", "connections", "model", "modelKey"],
  );
  if (copy.format !== "platform/1") throw Error("unsupported platform configuration format");
  path(copy.state, "operator state");
  if (copy.input !== undefined) path(copy.input, "worker input root");
  fields(copy.scope, ["workspace", "project", "principal"], "scope");
  for (const value of Object.values(copy.scope))
    if (typeof value !== "string" || !uuid.test(value)) throw Error("invalid operator scope UUID");
  fields(copy.policy, ["scope", "budget", "capabilities", "grants"], "host policy");
  fields(copy.policy.scope, ["workspace", "project", "owner"], "policy scope");
  if (
    copy.policy.scope.workspace !== copy.scope.workspace ||
    copy.policy.scope.project !== copy.scope.project ||
    copy.policy.scope.owner !== copy.scope.principal
  )
    throw Error("operator policy scope mismatch");
  const budget = [
    "cpuMs",
    "memoryBytes",
    "storageBytes",
    "timeMs",
    "tokens",
    "costMicros",
    "concurrency",
  ];
  fields(copy.policy.budget, budget, "policy budget");
  for (const [key, value] of Object.entries(copy.policy.budget))
    if (
      !Number.isSafeInteger(value) ||
      Number(value) < (["cpuMs", "memoryBytes", "timeMs", "concurrency"].includes(key) ? 1 : 0) ||
      Number(value) >
        (key === "concurrency" ? 1024 : key === "timeMs" ? 86_400_000 : Number.MAX_SAFE_INTEGER)
    )
      throw Error("invalid policy budget " + key);
  const caps = [
    "data.read",
    "data.write",
    "model.invoke",
    "prompt.read",
    "rule.read",
    "resource.read",
    "notify.send",
  ];
  if (
    !Array.isArray(copy.policy.capabilities) ||
    new Set(copy.policy.capabilities).size !== copy.policy.capabilities.length ||
    copy.policy.capabilities.some((cap) => !caps.includes(String(cap)))
  )
    throw Error("invalid host policy capabilities");
  if (!Array.isArray(copy.policy.grants) || copy.policy.grants.length > 4096)
    throw Error("invalid host policy grants");
  for (const grant of copy.policy.grants) {
    fields(grant, ["id", "version", "digest"], "policy resource grant");
    text(grant.id, "grant identifier", 96);
    if (
      !Number.isSafeInteger(grant.version) ||
      Number(grant.version) < 1 ||
      typeof grant.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(grant.digest)
    )
      throw Error("invalid pinned policy grant");
  }
  object(copy.database, "database configuration");
  if (own(copy.database, "environment")) {
    fields(copy.database, ["environment"], "database configuration");
    if (
      typeof copy.database.environment !== "string" ||
      !/^[A-Z][A-Z0-9_]{0,127}$/.test(copy.database.environment)
    )
      throw Error("invalid database environment name");
  } else {
    fields(copy.database, ["socket", "database", "user"], "database configuration");
    path(copy.database.socket, "database socket");
    text(copy.database.database, "database name", 63);
    text(copy.database.user, "database user", 63);
  }
  if (copy.catalog !== undefined) {
    if (!Array.isArray(copy.catalog) || copy.catalog.length > 256)
      throw Error("invalid source catalog");
    for (const source of copy.catalog) {
      fields(
        source,
        ["id", "name", "kind", "root", "pointer", "progress", "processFile", "database"],
        "catalog source",
        ["pointer", "progress", "processFile", "database"],
      );
      text(source.id, "source identifier", 96);
      text(source.name, "source name", 256);
      path(source.root, "source root");
      if (!["intake", "personal", "git", "pipeline", "sqlite"].includes(String(source.kind)))
        throw Error("unsupported catalog source kind");
      for (const key of ["pointer", "progress", "processFile", "database"])
        if (source[key] !== undefined) text(source[key], "source " + key);
    }
  }
  if (copy.connections !== undefined) {
    object(copy.connections, "connection bindings");
    for (const [key, source] of Object.entries(copy.connections)) {
      if (!uuid.test(key)) throw Error("connection bindings require UUID keys");
      if (!(copy.catalog as Source[] | undefined)?.some((item) => item.id === source))
        throw Error("connection binding requires a registered source");
    }
  }
  if (copy.model !== undefined) {
    fields(
      copy.model,
      [
        "runtime",
        "base",
        "adapters",
        "timeoutMs",
        "maxTokens",
        "batchSize",
        "memoryBytes",
        "package",
        "roleMode",
        "prefillSize",
        "workers",
        "budgetBytes",
        "queueTimeoutMs",
      ],
      "resident model",
      ["roleMode", "prefillSize", "workers", "budgetBytes", "queueTimeoutMs"],
    );
    for (const key of ["runtime", "base", "package"]) path(copy.model[key], "model " + key);
    if (copy.model.roleMode !== undefined && copy.model.roleMode !== "packaged")
      throw Error("resident model requires packaged roles");
    object(copy.model.adapters, "model adapters");
    if (Object.keys(copy.model.adapters).length)
      throw Error("resident platform uses packaged roles; learned adapters are unsupported");
    text(copy.modelKey, "trusted model key", 256);
  } else if (copy.modelKey !== undefined)
    throw Error("model key requires a resident model configuration");
  return copy as Config;
}
async function canonical(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(value);
    if (parent === value) throw error;
    return join(await canonical(parent), value.slice(parent.length));
  }
}
const inside = (root: string, value: string) => root === value || value.startsWith(root + sep);
const overlap = (a: string, b: string) => inside(a, b) || inside(b, a);

/** A local command service. Operator configuration is trusted; graph documents carry no authority. */
export class Platform {
  private readonly metadata: Metadata;
  private readonly definitions: Definitions;
  private readonly execution: Execution;
  private readonly registry: Registry;
  private readonly catalog: Catalog;
  private readonly dataset: Dataset;
  private readonly closeDb?: () => Promise<void>;
  private readonly closeModel: () => Promise<void>;
  private readonly config: Config;
  private closed = false;
  private constructor(
    config: Config,
    metadata: Metadata,
    registry: Registry,
    catalog: Catalog,
    dataset: Dataset,
    closeModel: () => Promise<void>,
    closeDb?: () => Promise<void>,
  ) {
    this.config = config;
    this.metadata = metadata;
    this.registry = registry;
    this.catalog = catalog;
    this.dataset = dataset;
    this.closeModel = closeModel;
    this.closeDb = closeDb;
    this.definitions = new Definitions(metadata, registry, config.policy);
    this.execution = new Execution(metadata, registry, join(config.state, "artifacts"), {
      policy: config.policy,
    });
  }
  static async open(value: unknown, bindings: Bindings = {}): Promise<Platform> {
    const config = configuration(value);
    let database = bindings.database,
      owned: Postgres | undefined;
    if (!database) {
      if ("environment" in config.database) {
        const connection = process.env[config.database.environment];
        if (!connection)
          throw Error(
            "database environment is missing or not configured: " + config.database.environment,
          );
        owned = Postgres.local(connection);
      } else
        owned = Postgres.socket({
          path: config.database.socket,
          database: config.database.database,
          user: config.database.user,
        });
      database = owned;
    }
    let dataset: Dataset | undefined,
      resident: ReturnType<typeof import("./mlx.ts").pool> | undefined;
    try {
      let version: unknown;
      try {
        version = (
          await database.query("SELECT max(version)::integer AS version FROM platform.migrations")
        ).rows[0]?.version;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "42P01" || code === "3F000")
          throw Error(
            "PostgreSQL platform schema is not ready; apply the authorized migrations before opening the service",
          );
        throw Error(
          "local PostgreSQL is unavailable; verify the socket or loopback binding and database permissions",
        );
      }
      if (version !== 1)
        throw Error("unsupported platform migration version; authorized migration is required");
      config.state = await canonical(resolve(config.state));
      const catalog = new Catalog(config.catalog ?? [], config.state);
      const reads = [
        ...(config.catalog ?? []).map((source) => source.root),
        ...(await catalog.roots()),
      ];
      if (config.input) reads.push(config.input);
      if (config.model) reads.push(config.model.runtime, config.model.base, config.model.package!);
      for (const root of reads)
        if (overlap(await canonical(resolve(root)), config.state))
          throw Error("source/model and operator state overlap");
      if (config.input && config.model)
        for (const root of [config.model.runtime, config.model.base, config.model.package!])
          if (overlap(await canonical(root), await canonical(config.input)))
            throw Error("resident model and worker input roots overlap");
      for (const name of ["datasets", "artifacts"])
        if (!inside(config.state, await canonical(join(config.state, name))))
          throw Error("operator output directory escapes state");
      if (config.model) {
        const { bounds } = await import("./mlx.ts");
        bounds(config.model);
      }
      dataset = new Dataset(join(config.state, "datasets"));
      await mkdir(join(config.state, "artifacts"), { recursive: true, mode: 0o700 });
      const metadata = new Metadata(
        database,
        config.scope,
        new Files(join(config.state, "artifacts")),
      );
      const infer: Inference | undefined = config.model
        ? async (request) => {
            if (!("socket" in config.database))
              throw Error("resident inference requires an explicit PostgreSQL Unix socket binding");
            const count = config.model!.workers ?? 1;
            for (let i = 0; i < count; i++)
              for (const key of ["IN", "OUT", "ERR"]) {
                const descriptor = Number(
                  process.env["PIPELINE_WORKER_" + key + "_" + i] ??
                    (i === 0 ? process.env["PIPELINE_WORKER_" + key] : undefined),
                );
                if (!Number.isSafeInteger(descriptor) || descriptor < 3)
                  throw Error(
                    "resident model descriptors are absent; launch through the isolated supervisor",
                  );
              }
            const { pool } = await import("./mlx.ts");
            resident ??= pool(config.model!);
            await resident.ready;
            return resident.infer(request);
          }
        : undefined;
      const registry =
        bindings.registry ??
        (
          await (
            await import("./capabilities.ts")
          ).library(config.policy.scope, {
            catalog,
            dataset,
            connections: config.connections,
            infer,
            modelKey: config.modelKey,
            concurrency: Math.min(64, config.policy.budget.concurrency),
          })
        ).registry;
      return new Platform(
        config,
        metadata,
        registry,
        catalog,
        dataset,
        async () => {
          await resident?.close();
        },
        owned ? () => owned!.close() : undefined,
      );
    } catch (error) {
      dataset?.close();
      await resident?.close();
      await owned?.close();
      throw error;
    }
  }
  private async view<T>(fn: () => T | Promise<T>): Promise<T> {
    return this.metadata.transaction(async () => fn(), "view");
  }
  async command(action: string, value: unknown = {}): Promise<unknown> {
    if (this.closed) throw Error("platform is closed");
    const input: unknown = JSON.parse(json(value));
    switch (action) {
      case "health":
        fields(input, [], "health request");
        return this.view(() => ({
          format: "platform/1",
          schema: 1,
          status: "ready",
          mode: "batch",
          model: !!this.config.model,
        }));
      case "registry":
        fields(input, [], "registry request");
        return this.view(() => this.registry.manifest());
      case "sources":
        fields(input, [], "sources request");
        return this.view(() => this.catalog.sources());
      case "tables":
        fields(input, ["source"], "tables request");
        text(input.source, "source");
        return this.view(() => this.catalog.tables(input.source as string));
      case "page":
        fields(input, ["source", "table", "options"], "page request", ["options"]);
        text(input.source, "source");
        text(input.table, "table");
        if (input.options !== undefined)
          fields(input.options, ["offset", "limit", "query"], "page options", [
            "offset",
            "limit",
            "query",
          ]);
        return this.view(() =>
          this.catalog.page(
            input.source as string,
            input.table as string,
            input.options as { offset?: number; limit?: number; query?: string } | undefined,
          ),
        );
      case "record":
        fields(input, ["source", "table", "key"], "record request");
        text(input.source, "source");
        text(input.table, "table");
        return this.view(() =>
          this.catalog.record(input.source as string, input.table as string, input.key),
        );
      case "flows":
        fields(input, ["limit", "after"], "flow query", ["limit", "after"]);
        return this.definitions.list(input as { limit?: number; after?: string });
      case "preview":
        return this.view(() => {
          fields(input, ["format", "registry", "workflow"], "platform definition");
          if (input.format !== "platform-definition/1")
            throw Error("unsupported platform definition format");
          const registry = Registry.open(input.registry, this.registry),
            manifest = registry.manifest();
          for (const items of [
            manifest.contracts,
            manifest.adapters,
            manifest.types,
            manifest.resources,
          ])
            for (const item of items)
              if (json(item.scope) !== json(this.config.policy.scope))
                throw Error("definition registry scope is unauthorized");
          return Workflow.publish(input.workflow, registry, this.config.policy).release;
        });
      case "publish":
        return this.definitions.publish(input);
      case "run":
        fields(input, ["version", "batch"], "run request", ["batch"]);
        text(input.version, "workflow version");
        return this.execution.start(input.version, input.batch as Batch | undefined);
      case "work":
        fields(input, ["worker", "limit"], "work request", ["limit"]);
        text(input.worker, "worker", 128);
        if (input.limit !== undefined) {
          if (
            !Number.isSafeInteger(input.limit) ||
            Number(input.limit) < 1 ||
            Number(input.limit) > 100
          )
            throw Error("work limit must be 1..100");
          return this.execution.drain(input.worker, Number(input.limit));
        }
        return (await this.execution.work(input.worker)) ?? null;
      case "pause":
      case "resume":
        fields(input, ["run"], "control request");
        text(input.run, "run");
        await this.execution[action](input.run);
        return { run: input.run, action };
      case "status":
        fields(input, ["run"], "status request");
        text(input.run, "run");
        return this.execution.status(input.run);
      default:
        throw Error("unsupported platform action");
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.closeModel();
    } finally {
      this.dataset.close();
      await this.closeDb?.();
    }
  }
  /** Stop signals affect admission; in-flight work finishes its durable checkpoint. */
  async worker(options: WorkerOptions): Promise<WorkerState> {
    if (this.closed) throw Error("platform is closed");
    text(options.worker, "worker", 128);
    const poll = options.pollMs ?? 500;
    if (!Number.isSafeInteger(poll) || poll < 25 || poll > 60_000)
      throw Error("worker poll interval must be 25..60000 ms");
    if (
      options.limit !== undefined &&
      (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1_000_000)
    )
      throw Error("worker task limit must be 1..1000000");
    let processed = 0;
    for (;;) {
      if (options.signal?.aborted) return { processed, stopped: "signal" };
      if (options.limit !== undefined && processed >= options.limit)
        return { processed, stopped: "limit" };
      const work = await this.execution.work(options.worker);
      if (work) {
        processed++;
        await options.onWork?.(work);
      } else
        try {
          await delay(poll, undefined, { signal: options.signal });
        } catch (error) {
          if (!options.signal?.aborted) throw error;
        }
    }
  }
}

/** One bounded JSON request and one JSON response; suitable for a pipe or native bridge. */
export async function serve(
  platform: Platform,
  input: AsyncIterable<Uint8Array | string>,
  write: (value: string) => unknown,
): Promise<void> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    const value = Buffer.from(chunk);
    bytes += value.length;
    if (bytes > bound) throw Error("platform request exceeds 2 MiB bound");
    chunks.push(value);
  }
  const request: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  fields(request, ["action", "input"], "platform request", ["input"]);
  text(request.action, "action", 64);
  const result = await platform.command(request.action, request.input ?? {});
  await write(json(result) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  let platform: Platform | undefined;
  try {
    if (process.argv.length !== 3)
      throw Error(
        "Usage: node pipeline/platform.ts /absolute/operator/platform.json < request.json",
      );
    path(process.argv[2], "operator configuration");
    const config = await readFile(process.argv[2]);
    if (config.length > bound) throw Error("platform configuration exceeds 2 MiB bound");
    platform = await Platform.open(JSON.parse(config.toString("utf8")));
    await serve(platform, process.stdin, (value) => process.stdout.write(value));
  } catch (error) {
    process.exitCode = 1;
    process.stdout.write(
      JSON.stringify({
        error: { message: error instanceof Error ? error.message : "platform command failed" },
      }) + "\n",
    );
  } finally {
    await platform?.close();
  }
}
