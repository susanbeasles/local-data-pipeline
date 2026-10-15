import { randomUUID, createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { chmod, mkdir, open, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import {
  Metadata,
  Files,
  digest,
  type Artifact,
  type Lease,
  type Receipt,
  type Row,
  type Run,
  type Sql,
} from "./metadata.ts";
import { accepts } from "./profile.ts";
import {
  Registry,
  Workflow,
  type Budget,
  type CompiledStep,
  type Context,
  type Frozen,
  type Json,
  type Outputs,
  type Policy,
  type Port,
  type Ref,
  type Resource,
  type Schema,
} from "./workflow.ts";

export type Batch = { mode?: "batch"; key?: string; parameters?: Json; maxAttempts?: number };
export type ExecutionOptions = {
  policy: Policy;
  leaseSeconds?: number;
  packetBytes?: number;
  packets?: number;
};
export type TaskState = {
  id: string;
  step: string;
  key: string;
  partition: string;
  status: string;
  fence: number;
};
export type ArtifactState = {
  id: string;
  step: string;
  port: string;
  uri: string;
  bytes: number;
  checksum: string;
};
export type ExecutionState = Run & {
  tasks: TaskState[];
  artifacts: ArtifactState[];
  usage: { resource: string; quantity: number; unit: string }[];
};
export type Work = {
  run: string;
  task: string;
  attempt: string;
  status: "completed" | "retry" | "failed";
  receipt?: Receipt;
  error?: string;
};
type Loaded = { workflow: Workflow; registry: Registry };
type Stored = { artifact: Artifact; records: number };
const keys = [
  "cpuMs",
  "memoryBytes",
  "storageBytes",
  "timeMs",
  "tokens",
  "costMicros",
  "concurrency",
] as const;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function identifier(value: string): void {
  if (!uuid.test(value)) throw Error("invalid UUID");
}
function finite(value: number, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw Error("invalid " + label);
}
/** Canonical finite JSON with byte, depth and accessor bounds at the host boundary. */
function json(value: unknown, limit = 1024 ** 2): string {
  let bytes = 0;
  const seen = new Set<object>();
  const text = (s: string) => {
    bytes += Buffer.byteLength(s);
    if (bytes > limit) throw Error("packet byte bound exceeded; use an artifact handle");
    return s;
  };
  const visit = (v: unknown, depth: number): string => {
    if (depth > 64) throw Error("JSON nesting bound exceeded");
    if (
      v === null ||
      typeof v === "string" ||
      typeof v === "boolean" ||
      (typeof v === "number" && Number.isFinite(v))
    )
      return text(JSON.stringify(v));
    if (
      !v ||
      typeof v !== "object" ||
      seen.has(v) ||
      Object.getOwnPropertySymbols(v).length ||
      (!Array.isArray(v) &&
        Object.getPrototypeOf(v) !== Object.prototype &&
        Object.getPrototypeOf(v) !== null)
    )
      throw Error("execution values must be finite plain JSON");
    const descriptors = Object.getOwnPropertyDescriptors(v);
    for (const [key, d] of Object.entries(descriptors))
      if (!Object.hasOwn(d, "value") || (!d.enumerable && !(Array.isArray(v) && key === "length")))
        throw Error("execution JSON cannot contain accessors or hidden values");
    seen.add(v);
    let result: string;
    if (Array.isArray(v)) {
      if (Object.keys(v).length !== v.length) throw Error("execution JSON arrays must be dense");
      result = text("[") + v.map((child) => visit(child, depth + 1)).join(text(",")) + text("]");
    } else
      result =
        text("{") +
        Object.keys(v)
          .sort()
          .map((key) => text(JSON.stringify(key)) + text(":") + visit((v as Row)[key], depth + 1))
          .join(text(",")) +
        text("}");
    seen.delete(v);
    return result;
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(result) > limit)
    throw Error("packet byte bound exceeded; use an artifact handle");
  return result;
}
function frozen<T>(value: T): Frozen<T> {
  const copy = JSON.parse(json(value, 16 * 1024 ** 2));
  const freeze = (v: unknown): void => {
    if (v && typeof v === "object") {
      for (const child of Object.values(v)) freeze(child);
      Object.freeze(v);
    }
  };
  freeze(copy);
  return copy as Frozen<T>;
}
function zero(): Budget {
  return {
    cpuMs: 0,
    memoryBytes: 0,
    storageBytes: 0,
    timeMs: 0,
    tokens: 0,
    costMicros: 0,
    concurrency: 1,
  };
}
function within(value: Budget, budget: Frozen<Budget>): void {
  for (const key of keys) if (value[key] > budget[key]) throw Error("step budget exceeded: " + key);
}
function packets(
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
    throw Error("port required/cardinality contract failed: " + label);
  const schema = registry.contract(port.contract as Ref).schema as Schema;
  if (values.some((value) => !accepts(schema, value)))
    throw Error("port data contract failed: " + label);
}

/** SQL is the authority. Instances contain no task, checkpoint, or completion cache. */
export class Execution {
  private readonly metadata: Metadata;
  private readonly trusted: Registry;
  private readonly root: string;
  private readonly policy: Policy;
  private readonly ttl: number;
  private readonly packetBytes: number;
  private readonly packetLimit: number;
  constructor(metadata: Metadata, registry: Registry, root: string, options: ExecutionOptions) {
    if (!options?.policy) throw Error("execution requires an explicit host policy");
    if (
      options.policy.scope.workspace !== metadata.scope.workspace ||
      options.policy.scope.project !== metadata.scope.project
    )
      throw Error("execution host policy scope mismatch");
    this.metadata = metadata;
    this.trusted = registry;
    this.root = resolve(root);
    this.policy = frozen(options.policy) as Policy;
    this.ttl = options.leaseSeconds ?? 60;
    finite(this.ttl, "lease seconds", 1, 3600);
    this.packetBytes = options.packetBytes ?? 1024 ** 2;
    finite(this.packetBytes, "packet bytes", 1, 16 * 1024 ** 2);
    this.packetLimit = options.packets ?? 65536;
    finite(this.packetLimit, "packet count", 1, 65536);
  }
  private get scope() {
    return [this.metadata.scope.workspace, this.metadata.scope.project] as const;
  }
  private async load(sql: Sql, version: string): Promise<Loaded> {
    identifier(version);
    const row = (
      await sql.query(
        "SELECT compiled_release,execution_policy FROM platform.workflow_versions WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND status='published'",
        [...this.scope, version],
      )
    ).rows[0];
    if (!row) throw Error("execution requires a published workflow version");
    const policy = row.execution_policy as { mode?: unknown; registry?: unknown };
    if (policy.mode !== "batch")
      throw Error("unsupported execution mode; only batch is implemented");
    if (!policy.registry) throw Error("published registry manifest is missing");
    const registry = Registry.open(policy.registry, this.trusted);
    const workflow = Workflow.open(row.compiled_release, registry, this.policy);
    const unsupported = (
      await sql.query(
        "SELECT s.key FROM platform.steps s JOIN platform.step_types t ON t.workspace_id=s.workspace_id AND t.key=s.type_key AND t.version=s.type_version WHERE s.workspace_id=$1 AND s.project_id=$2 AND s.version_id=$3 AND NOT ('batch'=ANY(t.modes))",
        [...this.scope, version],
      )
    ).rows;
    if (unsupported.length) throw Error("step does not support batch execution");
    return { workflow, registry };
  }
  async start(version: string, batch: Batch = {}): Promise<Run> {
    identifier(version);
    const input = JSON.parse(json(batch)) as Batch;
    if (
      Object.keys(input).some((key) => !["mode", "key", "parameters", "maxAttempts"].includes(key))
    )
      throw Error("unknown batch fields");
    if (input.mode !== undefined && input.mode !== "batch")
      throw Error("unsupported execution mode; only batch is implemented");
    const key = input.key ?? randomUUID(),
      max = input.maxAttempts ?? 3;
    if (typeof key !== "string" || !key.trim() || Buffer.byteLength(key) > 256)
      throw Error("invalid batch key");
    finite(max, "maximum attempts", 1, 100);
    return this.metadata.transaction(async (metadata, sql) => {
      await sql.query(
        "SELECT id FROM platform.workflow_versions WHERE workspace_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE",
        [...this.scope, version],
      );
      const { workflow } = await this.load(sql, version);
      const parameters = {
        execution: { key, maxAttempts: max },
        parameters: input.parameters ?? {},
      };
      const hash = digest(json({ workflow: workflow.digest, batch: parameters }));
      const prior = (
        await sql.query(
          "SELECT id,version_id,status,configuration_hash FROM platform.runs WHERE workspace_id=$1 AND project_id=$2 AND version_id=$3 AND parameters->'execution'->>'key'=$4",
          [...this.scope, version, key],
        )
      ).rows[0];
      if (prior) {
        if (prior.configuration_hash !== hash)
          throw Error("batch key already has different parameters");
        return {
          id: String(prior.id),
          version: String(prior.version_id),
          status: String(prior.status),
        };
      }
      const run = await metadata.run(version, { mode: "batch", configuration: hash, parameters });
      for (const step of workflow.plan.steps) {
        await metadata.queue(run.id, step.id, { key: "batch", maxAttempts: max });
        await metadata.seal(run.id, step.id);
      }
      return run;
    }, "execute");
  }
  async status(run: string): Promise<ExecutionState> {
    identifier(run);
    return this.metadata.transaction(async (_metadata, sql) => {
      const row = (
        await sql.query(
          "SELECT id,version_id,status FROM platform.runs WHERE workspace_id=$1 AND project_id=$2 AND id=$3",
          [...this.scope, run],
        )
      ).rows[0];
      if (!row) throw Error("unknown execution run");
      const tasks = (
        await sql.query(
          "SELECT t.*,s.step_key FROM platform.tasks t JOIN platform.step_runs s ON s.workspace_id=t.workspace_id AND s.project_id=t.project_id AND s.id=t.step_run_id WHERE t.workspace_id=$1 AND t.project_id=$2 AND t.run_id=$3 ORDER BY s.step_key,t.key LIMIT 4097",
          [...this.scope, run],
        )
      ).rows;
      const artifacts = (
        await sql.query(
          "SELECT a.id,a.uri,a.bytes,a.checksum,b.port_key,s.step_key FROM platform.artifacts a JOIN platform.bindings b ON b.workspace_id=a.workspace_id AND b.project_id=a.project_id AND b.artifact_id=a.id AND b.direction='output' JOIN platform.step_runs s ON s.workspace_id=b.workspace_id AND s.project_id=b.project_id AND s.id=b.step_run_id WHERE a.workspace_id=$1 AND a.project_id=$2 AND s.run_id=$3 ORDER BY s.step_key,b.port_key LIMIT 4097",
          [...this.scope, run],
        )
      ).rows;
      if (tasks.length > 4096 || artifacts.length > 4096)
        throw Error("execution snapshot exceeds bound");
      const usage = (
        await sql.query(
          "SELECT u.resource,u.unit,sum(u.quantity) quantity FROM platform.usage u JOIN platform.attempts a ON a.workspace_id=u.workspace_id AND a.project_id=u.project_id AND a.id=u.attempt_id JOIN platform.tasks t ON t.workspace_id=a.workspace_id AND t.project_id=a.project_id AND t.id=a.task_id WHERE u.workspace_id=$1 AND u.project_id=$2 AND t.run_id=$3 GROUP BY u.resource,u.unit ORDER BY u.resource",
          [...this.scope, run],
        )
      ).rows;
      return {
        id: String(row.id),
        version: String(row.version_id),
        status: String(row.status),
        tasks: tasks.map((t) => ({
          id: String(t.id),
          step: String(t.step_key),
          key: String(t.key),
          partition: String(t.partition_key),
          status: String(t.status),
          fence: Number(t.fence),
        })),
        artifacts: artifacts.map((a) => ({
          id: String(a.id),
          step: String(a.step_key),
          port: String(a.port_key),
          uri: String(a.uri),
          bytes: Number(a.bytes),
          checksum: String(a.checksum),
        })),
        usage: usage.map((u) => ({
          resource: String(u.resource),
          quantity: Number(u.quantity),
          unit: String(u.unit),
        })),
      };
    }, "view");
  }
  private async control(run: string, status: "paused" | "running"): Promise<void> {
    identifier(run);
    await this.metadata.transaction(async (_metadata, sql) => {
      const changed = await sql.query(
        "UPDATE platform.runs SET status=$4 WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND status IN ('running','paused') RETURNING id",
        [...this.scope, run, status],
      );
      if (!changed.rows.length) throw Error("run is terminal or unknown");
      await sql.query(
        "INSERT INTO platform.execution_events(workspace_id,project_id,run_id,entity_kind,entity_id,type,payload) VALUES($1,$2,$3,'run',$4,$5,'{}')",
        [...this.scope, run, run, status === "paused" ? "run.paused" : "run.resumed"],
      );
      if (status === "running")
        await sql.query(
          "UPDATE platform.runs r SET status='completed',completed_at=clock_timestamp() WHERE r.workspace_id=$1 AND r.project_id=$2 AND r.id=$3 AND NOT EXISTS(SELECT 1 FROM platform.step_runs s WHERE s.workspace_id=r.workspace_id AND s.project_id=r.project_id AND s.run_id=r.id AND s.status<>'completed')",
          [...this.scope, run],
        );
    }, "execute");
  }
  pause(run: string): Promise<void> {
    return this.control(run, "paused");
  }
  resume(run: string): Promise<void> {
    return this.control(run, "running");
  }
  private async inputs(
    lease: Lease,
    step: Frozen<CompiledStep>,
    registry: Registry,
    sql: Sql,
  ): Promise<{ values: Outputs; sources: string[] }> {
    const rows = (
      await sql.query(
        "SELECT a.*,b.port_key FROM platform.bindings b JOIN platform.artifacts a ON a.workspace_id=b.workspace_id AND a.project_id=b.project_id AND a.id=b.artifact_id WHERE b.workspace_id=$1 AND b.project_id=$2 AND b.step_run_id=$3 AND b.direction='input' ORDER BY b.port_key,a.id LIMIT 4097",
        [...this.scope, lease.stepRun],
      )
    ).rows;
    if (rows.length > 4096) throw Error("input artifact count bound exceeded");
    const values: Outputs = Object.create(null),
      sources = new Set<string>();
    for (const key of Object.keys(step.ports.inputs)) values[key] = [];
    let bytes = 0,
      count = 0;
    const verifier = new Files(this.root);
    for (const row of rows) {
      const port = String(row.port_key);
      if (!Object.hasOwn(values, port)) throw Error("unknown persisted input port");
      const artifact: Artifact = {
        id: String(row.id),
        representation: String(row.representation_id),
        port,
        uri: String(row.uri),
        bytes: Number(row.bytes),
        checksum: String(row.checksum),
        mediaType: String(row.media_type),
      };
      if (artifact.mediaType !== "application/x-ndjson")
        throw Error("unsupported persisted packet media type");
      bytes += artifact.bytes;
      if (bytes > Math.min(step.budget.memoryBytes, 16 * 1024 ** 2))
        throw Error("input byte bound exceeded; use an artifact handle");
      await verifier.verify(artifact);
      const file = await open(fileURLToPath(artifact.uri), "r");
      try {
        const stream = file.createReadStream({ autoClose: false }),
          hash = createHash("sha256");
        let observed = 0;
        stream.on("data", (chunk: string | Buffer) => {
          observed += Buffer.byteLength(chunk);
          hash.update(chunk);
        });
        const lines = createInterface({ input: stream, crlfDelay: Infinity });
        for await (const line of lines) {
          if (++count > this.packetLimit || Buffer.byteLength(line) > this.packetBytes)
            throw Error("input packet bound exceeded; use an artifact handle");
          if (!line.length) throw Error("empty JSONL packet");
          const value: unknown = JSON.parse(line);
          json(value, this.packetBytes);
          values[port].push(value as Json);
        }
        if (observed !== artifact.bytes || hash.digest("hex") !== artifact.checksum)
          throw Error("input artifact changed during read");
      } finally {
        await file.close();
      }
      sources.add(artifact.id);
    }
    for (const [key, port] of Object.entries(step.ports.inputs))
      packets(values[key], port, registry, step.id + "." + key);
    return { values, sources: [...sources] };
  }
  private async store(lease: Lease, port: string, values: readonly Json[]): Promise<Stored> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const root = await realpath(this.root);
    const id = randomUUID(),
      path = join(root, id + ".jsonl");
    if (!path.startsWith(root + sep)) throw Error("invalid artifact path");
    const file = await open(path, "wx", 0o600),
      hash = createHash("sha256");
    let bytes = 0;
    try {
      for (const value of values) {
        const line = json(value, this.packetBytes) + "\n";
        bytes += Buffer.byteLength(line);
        hash.update(line);
        await file.writeFile(line);
      }
      await file.sync();
    } finally {
      await file.close();
    }
    await chmod(path, 0o400);
    const dir = await open(root, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
    return {
      artifact: {
        id,
        representation: randomUUID(),
        port,
        uri: pathToFileURL(path).href,
        bytes,
        checksum: hash.digest("hex"),
        mediaType: "application/x-ndjson",
        partition: lease.partition,
      },
      records: values.length,
    };
  }
  private async register(sql: Sql, stored: Stored): Promise<void> {
    const a = stored.artifact,
      dataset = randomUUID(),
      revision = randomUUID();
    await sql.query(
      "INSERT INTO platform.datasets(workspace_id,project_id,id,key,name,kind,identity_strategy) VALUES($1,$2,$3,$4,$5,'packets','{\"kind\":\"packet-index\"}')",
      [...this.scope, dataset, "execution." + a.id, a.port],
    );
    await sql.query(
      "INSERT INTO platform.dataset_versions(workspace_id,project_id,dataset_id,id,number,content_hash,manifest_uri,record_count,byte_count) VALUES($1,$2,$3,$4,1,$5,$6,$7,$8)",
      [...this.scope, dataset, revision, a.checksum, a.uri, stored.records, a.bytes],
    );
    await sql.query(
      "INSERT INTO platform.representations(workspace_id,project_id,revision_id,id,format,format_version) VALUES($1,$2,$3,$4,'jsonl','1')",
      [...this.scope, revision, a.representation],
    );
  }
  private async meter(metadata: Metadata, attempt: string, usage: Budget): Promise<void> {
    for (const key of keys)
      await metadata.usage(attempt, {
        id: randomUUID(),
        resource: key,
        quantity: usage[key],
        unit:
          key === "tokens"
            ? "token"
            : key === "costMicros"
              ? "micro"
              : key.endsWith("Bytes")
                ? "byte"
                : key.endsWith("Ms")
                  ? "millisecond"
                  : "slot",
      });
  }
  async work(worker: string): Promise<Work | undefined> {
    let lease = await this.metadata.lease(worker, this.ttl);
    if (!lease) return undefined;
    const current = lease,
      controller = new AbortController(),
      usage = zero(),
      started = performance.now(),
      cpu = process.cpuUsage();
    let timer: ReturnType<typeof setTimeout> | undefined,
      heartbeat: ReturnType<typeof setInterval> | undefined,
      heartbeatError: unknown;
    let chain: Promise<unknown> = Promise.resolve();
    const measure = () => {
      usage.timeMs = Math.ceil(performance.now() - started);
      const elapsed = process.cpuUsage(cpu);
      usage.cpuMs = Math.ceil((elapsed.user + elapsed.system) / 1000);
    };
    try {
      const loaded = await this.metadata.transaction(async (_metadata, sql) => {
        const run = (
          await sql.query(
            "SELECT version_id,mode FROM platform.runs WHERE workspace_id=$1 AND project_id=$2 AND id=$3",
            [...this.scope, current.run],
          )
        ).rows[0];
        if (!run || run.mode !== "batch") throw Error("unsupported execution run mode");
        const loaded = await this.load(sql, String(run.version_id));
        const row = (
          await sql.query(
            "SELECT step_key FROM platform.step_runs WHERE workspace_id=$1 AND project_id=$2 AND id=$3",
            [...this.scope, current.stepRun],
          )
        ).rows[0];
        const step = loaded.workflow.plan.steps.find((step) => step.id === row?.step_key);
        if (!step) throw Error("leased step is not in compiled release");
        const inputs = await this.inputs(current, step, loaded.registry, sql);
        return { ...loaded, step, inputs };
      }, "execute");
      const { workflow, registry, step, inputs } = loaded;
      const pins: Record<string, Resource> = Object.create(null);
      for (const [key, ref] of Object.entries(step.pins))
        pins[key] = registry.resource(ref as Ref) as Resource;
      usage.memoryBytes = Buffer.byteLength(
        json({ config: step.config, pins, inputs: inputs.values }, 16 * 1024 ** 2),
      );
      within(usage, step.budget);
      heartbeat = setInterval(
        () => {
          chain = chain
            .then(async () => {
              lease = await this.metadata.heartbeat(lease!, this.ttl);
            })
            .catch((error) => {
              heartbeatError = error;
              controller.abort(error);
            });
        },
        Math.max(250, Math.floor((this.ttl * 1000) / 3)),
      );
      heartbeat.unref();
      const context: Context = {
        run: current.run,
        workflow: frozen({
          id: workflow.definition.id,
          version: workflow.definition.version,
          digest: workflow.digest,
        }),
        step: step.id,
        config: step.config,
        inputs: frozen(inputs.values),
        pins: frozen(pins),
        budget: step.budget,
        capabilities: registry.type(step.type as Ref).capabilities,
        signal: controller.signal,
        charge(value) {
          json(value);
          for (const key of Object.keys(value))
            if (!["tokens", "costMicros"].includes(key)) throw Error("unknown usage charge");
          for (const key of ["tokens", "costMicros"] as const) {
            const amount = value[key] ?? 0;
            finite(amount, "usage charge");
            usage[key] += amount;
          }
          within(usage, step.budget);
        },
      };
      measure();
      within(usage, step.budget);
      const result = await Promise.race([
        Promise.resolve().then(() =>
          registry.executor(step.adapter as Ref)(Object.freeze(context)),
        ),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => {
              controller.abort();
              reject(Error("step time budget exceeded"));
            },
            Math.max(1, step.budget.timeMs - usage.timeMs),
          );
          controller.signal.addEventListener(
            "abort",
            () => reject(Error("step aborted or lease lost")),
            { once: true },
          );
        }),
      ]);
      const encoded = json(result, Math.min(step.budget.memoryBytes, 16 * 1024 ** 2)),
        output = JSON.parse(encoded) as unknown;
      if (
        !output ||
        typeof output !== "object" ||
        Array.isArray(output) ||
        Object.keys(output).some((key) => !Object.hasOwn(step.ports.outputs, key))
      )
        throw Error("adapter returned an undeclared output port");
      let count = 0;
      const normalized: Outputs = Object.create(null);
      for (const [key, port] of Object.entries(step.ports.outputs)) {
        const values = (output as Outputs)[key] ?? [];
        packets(values, port, registry, step.id + "." + key);
        for (const value of values) json(value, this.packetBytes);
        count += values.length;
        normalized[key] = values;
      }
      if (count > this.packetLimit)
        throw Error("output packet bound exceeded; use an artifact handle");
      usage.memoryBytes += Buffer.byteLength(encoded);
      within(usage, step.budget);
      const stored: Stored[] = [];
      for (const [port, values] of Object.entries(normalized)) {
        stored.push(await this.store(current, port, values));
        usage.storageBytes += stored.at(-1)!.artifact.bytes;
        within(usage, step.budget);
      }
      if (inputs.sources.length * stored.length > 2048)
        throw Error("lineage edge bound exceeded; use an artifact handle");
      measure();
      within(usage, step.budget);
      if (heartbeatError) throw heartbeatError;
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      await chain;
      const receipt = await this.metadata.transaction(async (metadata, sql) => {
        for (const item of stored) await this.register(sql, item);
        const receipt = await metadata.commit(lease!, {
          key: "batch",
          artifacts: stored.map((item) => item.artifact),
          checkpoint: {
            cursor: {
              format: "batch-checkpoint/1",
              workflow: workflow.digest,
              step: step.id,
              complete: true,
            },
          },
          lineage: inputs.sources.flatMap((source) =>
            stored.map((item) => ({
              source,
              target: item.artifact.id,
              kind: "derived",
              transformation: step.adapter.digest,
            })),
          ),
        });
        measure();
        within(usage, step.budget);
        await this.meter(metadata, current.attempt, usage);
        for (const item of stored) {
          await sql.query(
            "UPDATE platform.representations SET state='published' WHERE workspace_id=$1 AND project_id=$2 AND id=$3",
            [...this.scope, item.artifact.representation],
          );
          await sql.query(
            "UPDATE platform.dataset_versions SET state='published' WHERE workspace_id=$1 AND project_id=$2 AND id=(SELECT revision_id FROM platform.representations WHERE workspace_id=$1 AND project_id=$2 AND id=$3)",
            [...this.scope, item.artifact.representation],
          );
        }
        return receipt;
      }, "execute");
      return {
        run: current.run,
        task: current.id,
        attempt: current.attempt,
        status: "completed",
        receipt,
      };
    } catch (error) {
      const message = (error instanceof Error ? error.message : "trusted adapter failed").slice(
        0,
        2000,
      );
      measure();
      let status: "failed" | "retry";
      try {
        status = await this.metadata.transaction(async (metadata, sql) => {
          await metadata.fail(lease!, { code: "execution.failed", message });
          await this.meter(metadata, current.attempt, usage);
          const task = (
            await sql.query(
              "SELECT status FROM platform.tasks WHERE workspace_id=$1 AND project_id=$2 AND id=$3",
              [...this.scope, current.id],
            )
          ).rows[0];
          return task.status === "failed" ? "failed" : "retry";
        }, "execute");
      } catch (failure) {
        if (!/fenc|lease|attempt/i.test(String(failure))) throw failure;
        return {
          run: current.run,
          task: current.id,
          attempt: current.attempt,
          status: "failed",
          error: message,
        };
      }
      return {
        run: current.run,
        task: current.id,
        attempt: current.attempt,
        status,
        error: message,
      };
    } finally {
      if (timer) clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      controller.abort();
      await chain;
    }
  }
  /** Work until SQL has no immediately claimable task; leased work may still be active. */
  async drain(worker: string, limit = 4096): Promise<Work[]> {
    finite(limit, "drain limit", 1, 65536);
    const result: Work[] = [];
    for (let i = 0; i < limit; i++) {
      const work = await this.work(worker);
      if (!work) return result;
      result.push(work);
    }
    throw Error("execution drain limit exceeded");
  }
}
