import { Pool } from "pg";
import { Workflow } from "./workflow.ts";
import { schema, accepts } from "./profile.ts";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { open, lstat, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export type Row = { [key: string]: unknown };
export type Result<T> = { rows: T[]; rowCount: number };
export type Sql = {
  query<T extends Row = Row>(text: string, values?: readonly unknown[]): Promise<Result<T>>;
};
export type Database = Sql & { transaction<T>(fn: (sql: Sql) => Promise<T>): Promise<T> };
export type Scope = { workspace: string; project: string; principal: string };
export type Permission = "view" | "configure" | "execute" | "publish" | "administer" | "secret-use";
export type Run = { id: string; version: string; status: string };
export type Task = {
  id: string;
  run: string;
  stepRun: string;
  key: string;
  partition: string;
  status: string;
  fence: number;
};
export type Lease = Task & {
  attempt: string;
  token: string;
  worker: string;
  actor: string;
  expires: string;
};
export type Artifact = {
  id: string;
  representation: string;
  port: string;
  uri: string;
  bytes: number;
  checksum: string;
  mediaType: string;
  partition?: string;
  backend?: string;
};
export type Output = {
  key: string;
  artifacts: Artifact[];
  checkpoint?: { cursor: unknown; artifact?: string };
  lineage?: {
    source: string;
    target: string;
    kind: string;
    transformation: string;
    manifest?: string;
  }[];
};
export type Receipt = {
  id: string;
  task: string;
  key: string;
  hash: string;
  artifacts: string[];
  checkpoint?: string;
};
export type Verifier = { verify(artifact: Readonly<Artifact>): Promise<void> };
export type Usage = {
  id: string;
  resource: string;
  quantity: number;
  unit: string;
  estimatedCost?: number;
  actualCost?: number;
  currency?: string;
  pricingVersion?: string;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hex = /^[a-f0-9]{64}$/;
export const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
function text(value: unknown, name: string, max = 4096): asserts value is string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max)
    throw Error("invalid " + name);
}
function id(value: unknown): asserts value is string {
  if (typeof value !== "string" || !uuid.test(value)) throw Error("invalid UUID");
}
function json(value: unknown): string {
  const seen = new Set<object>();
  function visit(v: unknown, depth: number): string {
    if (depth > 64) throw Error("metadata JSON nesting exceeds 64");
    if (v === null || typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
    if (typeof v === "number" && Number.isFinite(v)) return JSON.stringify(v);
    if (!v || typeof v !== "object" || seen.has(v))
      throw Error("metadata must contain finite acyclic JSON");
    if (
      !Array.isArray(v) &&
      Object.getPrototypeOf(v) !== Object.prototype &&
      Object.getPrototypeOf(v) !== null
    )
      throw Error("metadata must be plain JSON");
    seen.add(v);
    let result: string;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++)
        if (!Object.hasOwn(v, i)) throw Error("metadata JSON sparse array");
      result = "[" + v.map((x) => visit(x, depth + 1)).join(",") + "]";
    } else
      result =
        "{" +
        Object.keys(v)
          .sort()
          .map((k) => JSON.stringify(k) + ":" + visit((v as Row)[k], depth + 1))
          .join(",") +
        "}";
    seen.delete(v);
    return result;
  }
  const body = visit(value, 0);
  if (Buffer.byteLength(body) > 1_048_576)
    throw Error("metadata JSON exceeds 1 MiB; use an artifact");
  return body;
}
function frozen<T>(value: T): T {
  const copy = JSON.parse(json(value)) as T;
  const freeze = (item: unknown): void => {
    if (item && typeof item === "object") {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
  };
  freeze(copy);
  return copy;
}

function seconds(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > 3600)
    throw Error("lease seconds must be 1..3600");
  return value;
}
function task(row: Row): Task {
  return {
    id: String(row.id),
    run: String(row.run_id),
    stepRun: String(row.step_run_id),
    key: String(row.key),
    partition: String(row.partition_key),
    status: String(row.status),
    fence: Number(row.fence),
  };
}
function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

/** Real pg Pool transactions. Only the local factory creates network clients. */
export class Postgres implements Database {
  private readonly pool: Pool;
  private constructor(pool: Pool) {
    this.pool = pool;
  }
  static local(connection: string): Postgres {
    const url = new URL(connection);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
      throw Error("PostgreSQL endpoint must be loopback");
    if (url.search) throw Error("PostgreSQL URL options are not accepted");
    return new Postgres(
      new Pool({
        connectionString: connection,
        max: 8,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30_000,
        ssl: false,
      }),
    );
  }
  async query<T extends Row = Row>(
    query: string,
    values: readonly unknown[] = [],
  ): Promise<Result<T>> {
    const result = await this.pool.query(query, [...values]);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? result.rows.length };
  }
  async transaction<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const sql: Sql = {
          query: async <R extends Row = Row>(query: string, values: readonly unknown[] = []) => {
            const r = await client.query(query, [...values]);
            return { rows: r.rows as R[], rowCount: r.rowCount ?? r.rows.length };
          },
        };
        const value = await fn(sql);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        if (attempt >= 2 || !["40001", "40P01"].includes(String((error as { code?: string }).code)))
          throw error;
      } finally {
        client.release();
      }
      await delay(10 * (attempt + 1));
    }
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** A concrete bounded local artifact verifier; it never fetches network URIs. */
export class Files implements Verifier {
  private readonly root: string;
  constructor(root: string) {
    this.root = realpathSync(resolve(root));
  }
  async verify(artifact: Readonly<Artifact>): Promise<void> {
    const url = new URL(artifact.uri);
    if (url.protocol !== "file:" || url.search || url.hash)
      throw Error("local artifact requires an exact file URI");
    const requested = fileURLToPath(url),
      path = await realpath(requested);
    if (!path.startsWith(this.root + sep) || (await lstat(requested)).isSymbolicLink())
      throw Error("artifact path is outside storage or aliased");
    const file = await open(path, "r");
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(artifact.bytes))
        throw Error("artifact byte integrity mismatch");
      const hash = createHash("sha256");
      for await (const bytes of file.createReadStream({ autoClose: false })) hash.update(bytes);
      const after = await file.stat({ bigint: true });
      if (
        hash.digest("hex") !== artifact.checksum ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      )
        throw Error("artifact checksum integrity mismatch");
    } finally {
      await file.close();
    }
  }
}

/** Trusted API boundary. Scope must come from authenticated identity, never graph data. */
export class Metadata {
  readonly scope: Readonly<Scope>;
  private readonly database: Database;
  private readonly verifier?: Verifier;
  constructor(database: Database, scope: Scope, verifier?: Verifier) {
    this.database = database;
    this.verifier = verifier;
    id(scope.workspace);
    id(scope.project);
    id(scope.principal);
    this.scope = Object.freeze({ ...scope });
  }
  private get values() {
    return [this.scope.workspace, this.scope.project] as const;
  }
  private async allow(sql: Sql, permission: Permission): Promise<void> {
    const { rows } = await sql.query(
      `SELECT 1 FROM platform.principals p JOIN platform.memberships m ON m.principal_id=p.id WHERE p.id=$3 AND p.status='active' AND m.workspace_id=$1 AND m.status='active' AND EXISTS(SELECT 1 FROM platform.projects WHERE workspace_id=$1 AND id=$2) AND (EXISTS(SELECT 1 FROM platform.grants g WHERE g.workspace_id=$1 AND (g.project_id=$2 OR g.project_id IS NULL) AND g.principal_id=$3 AND g.permission=$4) OR EXISTS(SELECT 1 FROM platform.role_bindings b JOIN platform.role_permissions r ON (r.workspace_id,r.role_id)=(b.workspace_id,b.role_id) WHERE b.workspace_id=$1 AND (b.project_id=$2 OR b.project_id IS NULL) AND b.principal_id=$3 AND r.permission=$4))`,
      [...this.values, this.scope.principal, permission],
    );
    if (!rows.length) throw Error("permission denied: " + permission);
  }
  private async change<T>(permission: Permission, fn: (sql: Sql) => Promise<T>): Promise<T> {
    return this.database.transaction(async (sql) => {
      await this.allow(sql, permission);
      return fn(sql);
    });
  }
  /** Trusted server composition; all nested Metadata methods reuse this transaction. */
  async transaction<T>(fn: (metadata: Metadata, sql: Sql) => Promise<T>): Promise<T> {
    return this.change("configure", async (sql) => {
      const bound: Database = {
        query: sql.query.bind(sql),
        transaction: (operation) => operation(sql),
      };
      return fn(new Metadata(bound, this.scope, this.verifier), sql);
    });
  }
  private async audit(
    sql: Sql,
    action: string,
    target: string,
    targetId: string,
    summary: unknown,
  ): Promise<void> {
    await sql.query(
      "SELECT id FROM platform.projects WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
      this.values,
    );
    const prior = (
      await sql.query(
        "SELECT event_hash FROM platform.audit WHERE workspace_id=$1 AND project_id=$2 ORDER BY sequence DESC LIMIT 1",
        this.values,
      )
    ).rows[0];
    const previous = prior ? String(prior.event_hash) : "0".repeat(64),
      at = new Date().toISOString();
    const body = {
      workspace: this.scope.workspace,
      project: this.scope.project,
      actor: this.scope.principal,
      action,
      target,
      targetId,
      summary,
      at,
      previous,
    };
    await sql.query(
      "INSERT INTO platform.audit(workspace_id,project_id,actor_id,action,target_type,target_id,summary,previous_hash,event_hash,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)",
      [
        ...this.values,
        this.scope.principal,
        action,
        target,
        targetId,
        json(summary),
        previous,
        digest(json(body)),
        at,
      ],
    );
  }
  private async event(
    sql: Sql,
    run: string,
    entity: string,
    target: string,
    type: string,
    payload: unknown,
  ): Promise<void> {
    await sql.query(
      "INSERT INTO platform.execution_events(workspace_id,project_id,run_id,entity_kind,entity_id,type,payload) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)",
      [...this.values, run, entity, target, type, json(payload)],
    );
  }
  /** Map a compiler-validated release to normalized draft rows atomically. */
  async define(workflow: Workflow): Promise<{ id: string; hash: string }> {
    if (!(workflow instanceof Workflow)) throw Error("a compiled Workflow is required");
    const release = workflow.release,
      definition = release.definition;
    if (
      definition.scope.workspace !== this.scope.workspace ||
      definition.scope.project !== this.scope.project ||
      definition.scope.owner !== this.scope.principal
    )
      throw Error("workflow definition scope is unauthorized");
    if (digest(json(definition)) !== release.digest)
      throw Error("workflow definition digest mismatch");
    return this.change("configure", async (sql) => {
      await sql.query(
        "INSERT INTO platform.workflows(workspace_id,project_id,id,name,owner_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,project_id,id) DO NOTHING",
        [...this.values, definition.id, definition.name, this.scope.principal],
      );
      await sql.query(
        "SELECT id FROM platform.workflows WHERE workspace_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE",
        [...this.values, definition.id],
      );
      const existing = (
        await sql.query(
          "SELECT id,definition_hash FROM platform.workflow_versions WHERE workspace_id=$1 AND project_id=$2 AND workflow_id=$3 AND number=$4",
          [...this.values, definition.id, definition.version],
        )
      ).rows[0];
      if (existing) {
        if (existing.definition_hash !== release.digest)
          throw Error("workflow version is immutable; create a new version");
        return { id: String(existing.id), hash: release.digest };
      }
      const version = randomUUID();
      await sql.query(
        "INSERT INTO platform.workflow_versions(workspace_id,project_id,workflow_id,id,number,definition_hash,definition,compiled_release,execution_policy,resource_policy,created_by) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11)",
        [
          ...this.values,
          definition.id,
          version,
          definition.version,
          release.digest,
          json(definition),
          json(release),
          json({ mode: "batch", artifactCommit: "atomic", security: "registered-capabilities" }),
          json(definition.budget),
          this.scope.principal,
        ],
      );
      for (const stage of definition.stages)
        await sql.query(
          "INSERT INTO platform.stages(workspace_id,project_id,version_id,key,name,resource_policy) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
          [...this.values, version, stage.id, stage.name, json(stage.budget)],
        );
      for (const step of release.plan.steps) {
        const original = definition.steps.find((item) => item.id === step.id);
        if (
          !original ||
          json(original.config) !== json(step.config) ||
          json(original.pins) !== json(step.pins) ||
          original.stage !== step.stage ||
          json(original.type) !== json(step.type)
        )
          throw Error("compiled step integrity mismatch");
        const registered = (
          await sql.query(
            "SELECT t.*,a.digest AS adapter_digest FROM platform.step_types t JOIN platform.adapters a ON a.workspace_id=t.workspace_id AND a.key=t.adapter_key AND a.version=t.adapter_version WHERE t.workspace_id=$1 AND t.key=$2 AND t.version=$3 AND t.digest=$4",
            [this.scope.workspace, step.type.id, step.type.version, step.type.digest],
          )
        ).rows[0];
        if (
          !registered ||
          registered.adapter_key !== step.adapter.id ||
          Number(registered.adapter_version) !== step.adapter.version ||
          registered.adapter_digest !== step.adapter.digest
        )
          throw Error("registered step or adapter pin does not resolve");
        schema(registered.configuration_schema);
        if (!accepts(registered.configuration_schema, step.config))
          throw Error("registered configuration schema failed");
        if (
          json(registered.input_ports) !== json(step.ports.inputs) ||
          json(registered.output_ports) !== json(step.ports.outputs)
        )
          throw Error("registered port specification mismatch");
        await sql.query(
          "INSERT INTO platform.steps(workspace_id,project_id,version_id,key,stage_key,type_key,type_version,type_digest,configuration,resource_policy) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)",
          [
            ...this.values,
            version,
            step.id,
            step.stage,
            step.type.id,
            step.type.version,
            step.type.digest,
            json(step.config),
            json(step.budget),
          ],
        );
        for (const direction of ["input", "output"] as const)
          for (const [key, port] of Object.entries(
            direction === "input" ? step.ports.inputs : step.ports.outputs,
          ))
            await sql.query(
              "INSERT INTO platform.ports(workspace_id,project_id,version_id,step_key,key,direction,contract_key,contract_version,contract_digest,required,cardinality) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
              [
                ...this.values,
                version,
                step.id,
                key,
                direction,
                port.contract.id,
                port.contract.version,
                port.contract.digest,
                port.required,
                port.cardinality,
              ],
            );
        const bindings = registered.bindings as {
          [key: string]: { kind: string; required: boolean };
        };
        for (const [role, binding] of Object.entries(bindings))
          if (binding.required && !step.pins[role]) throw Error("required resource pin is missing");
        for (const [role, ref] of Object.entries(step.pins)) {
          const resource = (
            await sql.query(
              "SELECT kind FROM platform.resources WHERE workspace_id=$1 AND key=$2 AND version=$3 AND digest=$4",
              [this.scope.workspace, ref.id, ref.version, ref.digest],
            )
          ).rows[0];
          if (!bindings[role] || !resource || resource.kind !== bindings[role].kind)
            throw Error("resource pin kind or digest does not resolve");
          await sql.query(
            "INSERT INTO platform.step_resources(workspace_id,project_id,version_id,step_key,role,resource_key,resource_version,resource_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
            [...this.values, version, step.id, role, ref.id, ref.version, ref.digest],
          );
        }
      }
      if (release.plan.steps.length !== definition.steps.length)
        throw Error("compiled step count mismatch");
      for (const edge of definition.edges)
        await sql.query(
          "INSERT INTO platform.edges(workspace_id,project_id,version_id,key,source_step,source_port,target_step,target_port) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            ...this.values,
            version,
            edge.id,
            edge.from.step,
            edge.from.port,
            edge.to.step,
            edge.to.port,
          ],
        );
      await this.audit(sql, "define", "workflow_version", version, {
        workflow: definition.id,
        number: definition.version,
        digest: release.digest,
      });
      return { id: version, hash: release.digest };
    });
  }
  async publish(version: string): Promise<{ id: string; hash: string }> {
    id(version);
    return this.change("publish", async (sql) => {
      const row = (
        await sql.query(
          "SELECT * FROM platform.workflow_versions WHERE workspace_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE",
          [...this.values, version],
        )
      ).rows[0];
      if (!row) throw Error("unknown workflow version");
      if (row.status === "retired") throw Error("retired workflow cannot be published");
      if (row.status === "draft")
        await sql.query(
          "UPDATE platform.workflow_versions SET status='published',published_at=clock_timestamp() WHERE workspace_id=$1 AND project_id=$2 AND id=$3",
          [...this.values, version],
        );
      await sql.query(
        "UPDATE platform.workflows SET current_version=$4 WHERE workspace_id=$1 AND project_id=$2 AND id=$3",
        [...this.values, row.workflow_id, version],
      );
      await this.audit(sql, "publish", "workflow_version", version, { hash: row.definition_hash });
      return { id: version, hash: String(row.definition_hash) };
    });
  }
  async run(
    version: string,
    input: { mode: string; configuration: string; parameters?: unknown; id?: string },
  ): Promise<Run> {
    input = frozen(input);
    id(version);
    if (!hex.test(input.configuration)) throw Error("invalid configuration digest");
    const runId = input.id ?? randomUUID();
    id(runId);
    const parameters = json(input.parameters ?? {});
    return this.change("execute", async (sql) => {
      const row = (
        await sql.query(
          "SELECT * FROM platform.workflow_versions WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND status='published' FOR SHARE",
          [...this.values, version],
        )
      ).rows[0];
      if (!row) throw Error("run requires a published version");
      await sql.query(
        "INSERT INTO platform.runs(workspace_id,project_id,id,workflow_id,version_id,mode,parameters,configuration_hash,initiated_by) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)",
        [
          ...this.values,
          runId,
          row.workflow_id,
          version,
          input.mode,
          parameters,
          input.configuration,
          this.scope.principal,
        ],
      );
      const stages = (
        await sql.query(
          "SELECT key FROM platform.stages WHERE workspace_id=$1 AND project_id=$2 AND version_id=$3 ORDER BY key",
          [...this.values, version],
        )
      ).rows;
      for (const stage of stages)
        await sql.query(
          "INSERT INTO platform.stage_runs(workspace_id,project_id,run_id,version_id,id,stage_key) VALUES($1,$2,$3,$4,$5,$6)",
          [...this.values, runId, version, randomUUID(), stage.key],
        );
      const steps = (
        await sql.query(
          "SELECT key,stage_key FROM platform.steps WHERE workspace_id=$1 AND project_id=$2 AND version_id=$3 AND enabled ORDER BY key",
          [...this.values, version],
        )
      ).rows;
      for (const step of steps)
        await sql.query(
          "INSERT INTO platform.step_runs(workspace_id,project_id,run_id,version_id,id,stage_key,step_key,configuration_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            ...this.values,
            runId,
            version,
            randomUUID(),
            step.stage_key,
            step.key,
            input.configuration,
          ],
        );
      await this.event(sql, runId, "run", runId, "run.started", {
        version,
        configuration: input.configuration,
      });
      await this.audit(sql, "execute", "run", runId, { version });
      return { id: runId, version, status: "running" };
    });
  }
  async queue(
    run: string,
    step: string,
    input: { key: string; partition?: string; maxAttempts?: number },
  ): Promise<Task> {
    input = frozen(input);
    id(run);
    text(step, "step", 256);
    text(input.key, "task key", 256);
    const max = input.maxAttempts ?? 3;
    if (!Number.isInteger(max) || max < 1 || max > 100) throw Error("invalid maximum attempts");
    return this.change("execute", async (sql) => {
      const row = (
        await sql.query(
          "SELECT s.*,r.status AS run_status FROM platform.step_runs s JOIN platform.runs r ON (r.workspace_id,r.project_id,r.id)=(s.workspace_id,s.project_id,s.run_id) WHERE s.workspace_id=$1 AND s.project_id=$2 AND s.run_id=$3 AND s.step_key=$4 FOR UPDATE OF s",
          [...this.values, run, step],
        )
      ).rows[0];
      if (!row) throw Error("unknown step run");
      const existing = (
        await sql.query(
          "SELECT * FROM platform.tasks WHERE workspace_id=$1 AND project_id=$2 AND step_run_id=$3 AND key=$4",
          [...this.values, row.id, input.key],
        )
      ).rows[0];
      if (existing) {
        if (
          existing.partition_key !== (input.partition ?? "") ||
          Number(existing.max_attempts) !== max
        )
          throw Error("task key already has different parameters");
        return task(existing);
      }
      if (
        row.tasks_closed ||
        !["queued", "running"].includes(String(row.status)) ||
        !["running", "queued"].includes(String(row.run_status))
      )
        throw Error("step task enumeration is sealed or not accepting tasks");
      const value = (
        await sql.query(
          "INSERT INTO platform.tasks(workspace_id,project_id,id,run_id,step_run_id,key,partition_key,max_attempts) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
          [...this.values, randomUUID(), run, row.id, input.key, input.partition ?? "", max],
        )
      ).rows[0];
      await this.event(sql, run, "task", String(value.id), "task.queued", { key: input.key });
      return task(value);
    });
  }
  async seal(run: string, step: string): Promise<void> {
    id(run);
    text(step, "step", 256);
    await this.change("execute", async (sql) => {
      const row = (
        await sql.query(
          "SELECT * FROM platform.step_runs WHERE workspace_id=$1 AND project_id=$2 AND run_id=$3 AND step_key=$4 FOR UPDATE",
          [...this.values, run, step],
        )
      ).rows[0];
      if (!row) throw Error("unknown step run");
      if (
        !(
          await sql.query(
            "SELECT 1 FROM platform.tasks WHERE workspace_id=$1 AND project_id=$2 AND step_run_id=$3 LIMIT 1",
            [...this.values, row.id],
          )
        ).rows.length
      )
        throw Error("step requires at least one task; represent empty data explicitly");
      await sql.query(
        "UPDATE platform.step_runs SET tasks_closed=true WHERE workspace_id=$1 AND project_id=$2 AND id=$3",
        [...this.values, row.id],
      );
      await this.advance(sql, String(row.id));
      await this.audit(sql, "seal", "step_run", String(row.id), {});
    });
  }
  private async advance(sql: Sql, stepRun: string): Promise<void> {
    const row = (
      await sql.query(
        `UPDATE platform.step_runs s SET status='completed',completed_at=clock_timestamp() WHERE s.workspace_id=$1 AND s.project_id=$2 AND s.id=$3 AND s.tasks_closed AND s.status IN ('queued','running') AND NOT EXISTS(SELECT 1 FROM platform.tasks t WHERE t.workspace_id=s.workspace_id AND t.project_id=s.project_id AND t.step_run_id=s.id AND t.status<>'completed') RETURNING *`,
        [...this.values, stepRun],
      )
    ).rows[0];
    if (!row) return;
    await sql.query(
      `UPDATE platform.stage_runs s SET status='completed',completed_at=clock_timestamp() WHERE s.workspace_id=$1 AND s.project_id=$2 AND s.run_id=$3 AND NOT EXISTS(SELECT 1 FROM platform.step_runs r WHERE r.workspace_id=s.workspace_id AND r.project_id=s.project_id AND r.run_id=s.run_id AND r.stage_key=s.stage_key AND r.status<>'completed')`,
      [...this.values, row.run_id],
    );
    await sql.query(
      `UPDATE platform.runs r SET status='completed',completed_at=clock_timestamp() WHERE r.workspace_id=$1 AND r.project_id=$2 AND r.id=$3 AND r.status='running' AND NOT EXISTS(SELECT 1 FROM platform.step_runs s WHERE s.workspace_id=r.workspace_id AND s.project_id=r.project_id AND s.run_id=r.id AND s.status<>'completed')`,
      [...this.values, row.run_id],
    );
  }
  async lease(worker: string, ttl = 60): Promise<Lease | undefined> {
    text(worker, "worker", 256);
    seconds(ttl);
    return this.change("execute", async (sql) => {
      // Reap exhausted leases first, retaining their attempt and failure evidence.
      const exhausted = (
        await sql.query(
          "SELECT * FROM platform.tasks WHERE workspace_id=$1 AND project_id=$2 AND status='leased' AND lease_expires_at<=clock_timestamp() AND fence>=max_attempts FOR UPDATE SKIP LOCKED",
          this.values,
        )
      ).rows;
      for (const row of exhausted) {
        await sql.query(
          "UPDATE platform.attempts SET status='expired',completed_at=clock_timestamp() WHERE workspace_id=$1 AND project_id=$2 AND task_id=$3 AND fence=$4 AND status='running'",
          [...this.values, row.id, row.fence],
        );
        await sql.query(
          "UPDATE platform.tasks SET status='failed',lease_owner=NULL,lease_actor=NULL,lease_token=NULL,lease_expires_at=NULL WHERE workspace_id=$1 AND project_id=$2 AND id=$3",
          [...this.values, row.id],
        );
        await sql.query(
          "UPDATE platform.step_runs SET status='failed',error_summary='attempts exhausted',completed_at=clock_timestamp() WHERE workspace_id=$1 AND project_id=$2 AND id=$3",
          [...this.values, row.step_run_id],
        );
        await sql.query(
          "UPDATE platform.runs SET status='failed',completed_at=clock_timestamp() WHERE workspace_id=$1 AND project_id=$2 AND id=$3",
          [...this.values, row.run_id],
        );
        await this.event(sql, String(row.run_id), "task", String(row.id), "task.exhausted", {});
      }
      const row = (
        await sql.query(
          `SELECT t.* FROM platform.tasks t JOIN platform.runs r ON (r.workspace_id,r.project_id,r.id)=(t.workspace_id,t.project_id,t.run_id) JOIN platform.step_runs s ON (s.workspace_id,s.project_id,s.id)=(t.workspace_id,t.project_id,t.step_run_id) WHERE t.workspace_id=$1 AND t.project_id=$2 AND r.status='running' AND s.status IN ('queued','running') AND t.ready_at<=clock_timestamp() AND t.fence<t.max_attempts AND (t.status='queued' OR (t.status='leased' AND t.lease_expires_at<=clock_timestamp())) AND NOT EXISTS(SELECT 1 FROM platform.edges e JOIN platform.step_runs upstream ON upstream.workspace_id=e.workspace_id AND upstream.project_id=e.project_id AND upstream.run_id=t.run_id AND upstream.step_key=e.source_step WHERE e.workspace_id=s.workspace_id AND e.project_id=s.project_id AND e.version_id=s.version_id AND e.target_step=s.step_key AND upstream.status<>'completed') AND NOT EXISTS(SELECT 1 FROM platform.ports p WHERE p.workspace_id=s.workspace_id AND p.project_id=s.project_id AND p.version_id=s.version_id AND p.step_key=s.step_key AND p.direction='input' AND p.required AND NOT EXISTS(SELECT 1 FROM platform.bindings b WHERE b.workspace_id=s.workspace_id AND b.project_id=s.project_id AND b.step_run_id=s.id AND b.port_key=p.key AND b.direction='input')) ORDER BY t.ready_at,t.id FOR UPDATE OF t SKIP LOCKED LIMIT 1`,
          this.values,
        )
      ).rows[0];
      if (!row) return undefined;
      await sql.query(
        "UPDATE platform.attempts SET status='expired',completed_at=clock_timestamp() WHERE workspace_id=$1 AND project_id=$2 AND task_id=$3 AND status='running'",
        [...this.values, row.id],
      );
      const token = randomUUID(),
        attempt = randomUUID();
      const leased = (
        await sql.query(
          "UPDATE platform.tasks SET status='leased',fence=fence+1,lease_owner=$4,lease_actor=$5,lease_token=$6,lease_expires_at=clock_timestamp()+make_interval(secs=>$7) WHERE workspace_id=$1 AND project_id=$2 AND id=$3 RETURNING *",
          [...this.values, row.id, worker, this.scope.principal, token, ttl],
        )
      ).rows[0];
      await sql.query(
        "INSERT INTO platform.attempts(workspace_id,project_id,id,task_id,fence,worker,actor,status) VALUES($1,$2,$3,$4,$5,$6,$7,'running')",
        [...this.values, attempt, row.id, leased.fence, worker, this.scope.principal],
      );
      await sql.query(
        "UPDATE platform.step_runs SET status='running',started_at=coalesce(started_at,clock_timestamp()) WHERE workspace_id=$1 AND project_id=$2 AND id=$3",
        [...this.values, row.step_run_id],
      );
      await this.event(sql, String(row.run_id), "task", String(row.id), "task.leased", {
        attempt,
        fence: Number(leased.fence),
        worker,
      });
      await this.audit(sql, "lease", "task", String(row.id), {
        attempt,
        fence: Number(leased.fence),
      });
      return {
        ...task(leased),
        attempt,
        token,
        worker,
        actor: this.scope.principal,
        expires: iso(leased.lease_expires_at),
      };
    });
  }
  private async locked(sql: Sql, lease: Lease, complete = false): Promise<Row> {
    id(lease.id);
    id(lease.attempt);
    id(lease.token);
    const row = (
      await sql.query(
        "SELECT *,lease_expires_at>clock_timestamp() AS live FROM platform.tasks WHERE workspace_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE",
        [...this.values, lease.id],
      )
    ).rows[0];
    if (!row || Number(row.fence) !== lease.fence || lease.actor !== this.scope.principal)
      throw Error("lease fencing mismatch");
    const attempt = (
      await sql.query(
        "SELECT * FROM platform.attempts WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND task_id=$4 AND fence=$5 AND actor=$6",
        [...this.values, lease.attempt, lease.id, lease.fence, this.scope.principal],
      )
    ).rows[0];
    if (!attempt || (!complete && attempt.status !== "running"))
      throw Error("attempt fencing mismatch");
    if (complete && row.status === "completed") return row;
    if (
      row.status !== "leased" ||
      row.lease_actor !== this.scope.principal ||
      row.lease_owner !== lease.worker ||
      row.lease_token !== lease.token ||
      !row.live
    )
      throw Error("lease expired or no longer owned");
    return row;
  }
  async heartbeat(lease: Lease, ttl = 60): Promise<Lease> {
    lease = frozen(lease);
    seconds(ttl);
    return this.change("execute", async (sql) => {
      await this.locked(sql, lease);
      const row = (
        await sql.query(
          "UPDATE platform.tasks SET lease_expires_at=clock_timestamp()+make_interval(secs=>$4) WHERE workspace_id=$1 AND project_id=$2 AND id=$3 RETURNING lease_expires_at",
          [...this.values, lease.id, ttl],
        )
      ).rows[0];
      return { ...lease, expires: iso(row.lease_expires_at) };
    });
  }
  private async receipt(sql: Sql, commit: Row): Promise<Receipt> {
    const artifacts = (
      await sql.query(
        "SELECT id FROM platform.artifacts WHERE workspace_id=$1 AND project_id=$2 AND commit_id=$3 ORDER BY id",
        [...this.values, commit.id],
      )
    ).rows.map((r) => String(r.id));
    const checkpoint = (
      await sql.query(
        "SELECT id FROM platform.checkpoints WHERE workspace_id=$1 AND project_id=$2 AND commit_id=$3",
        [...this.values, commit.id],
      )
    ).rows[0];
    return {
      id: String(commit.id),
      task: String(commit.task_id),
      key: String(commit.key),
      hash: String(commit.digest),
      artifacts,
      ...(checkpoint ? { checkpoint: String(checkpoint.id) } : {}),
    };
  }
  async commit(lease: Lease, output: Output): Promise<Receipt> {
    lease = frozen(lease);
    output = frozen(output);
    text(output.key, "commit key", 256);
    if (!Array.isArray(output.artifacts) || output.artifacts.length > 1000)
      throw Error("invalid artifact batch");
    const unique = new Set<string>();
    for (const artifact of output.artifacts) {
      id(artifact.id);
      id(artifact.representation);
      text(artifact.port, "output port", 256);
      text(artifact.uri, "artifact URI");
      text(artifact.mediaType, "media type", 256);
      if (
        !hex.test(artifact.checksum) ||
        !Number.isSafeInteger(artifact.bytes) ||
        artifact.bytes < 0 ||
        unique.has(artifact.id)
      )
        throw Error("invalid or duplicate artifact descriptor");
      unique.add(artifact.id);
    }
    const body = json(output),
      hash = digest(body);
    const repeated = await this.change("execute", async (sql) => {
      await this.locked(sql, lease, true);
      const prior = (
        await sql.query(
          "SELECT * FROM platform.commits WHERE workspace_id=$1 AND project_id=$2 AND task_id=$3",
          [...this.values, lease.id],
        )
      ).rows[0];
      if (!prior) return undefined;
      if (
        prior.key !== output.key ||
        prior.digest !== hash ||
        prior.attempt_id !== lease.attempt ||
        Number(prior.fence) !== lease.fence
      )
        throw Error("idempotent commit conflict");
      return this.receipt(sql, prior);
    });
    if (repeated) return repeated;
    // Verify before the SQL transaction; the lease is rechecked after potentially slow I/O.
    if (output.artifacts.length && !this.verifier)
      throw Error("artifact byte verification is required");
    for (const artifact of output.artifacts) await this.verifier!.verify(artifact);
    return this.change("execute", async (sql) => {
      const row = await this.locked(sql, lease, true);
      const prior = (
        await sql.query(
          "SELECT * FROM platform.commits WHERE workspace_id=$1 AND project_id=$2 AND task_id=$3",
          [...this.values, lease.id],
        )
      ).rows[0];
      if (prior) {
        if (
          prior.key !== output.key ||
          prior.digest !== hash ||
          prior.attempt_id !== lease.attempt ||
          Number(prior.fence) !== lease.fence
        )
          throw Error("idempotent commit conflict");
        return this.receipt(sql, prior);
      }
      if (row.status === "completed") throw Error("task commit is missing");
      const step = (
        await sql.query(
          "SELECT * FROM platform.step_runs WHERE workspace_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE",
          [...this.values, row.step_run_id],
        )
      ).rows[0];
      if (
        (
          await sql.query(
            "SELECT 1 FROM platform.quality_results WHERE workspace_id=$1 AND project_id=$2 AND step_run_id=$3 AND blocking AND NOT passed",
            [...this.values, row.step_run_id],
          )
        ).rows.length
      )
        throw Error("blocking quality gate failed");
      const ports = (
        await sql.query(
          "SELECT key,required FROM platform.ports WHERE workspace_id=$1 AND project_id=$2 AND version_id=$3 AND step_key=$4 AND direction='output'",
          [...this.values, step.version_id, step.step_key],
        )
      ).rows;
      for (const port of ports)
        if (port.required && !output.artifacts.some((a) => a.port === port.key))
          throw Error("required output port has no committed artifact");
      if (output.artifacts.some((a) => !ports.some((p) => p.key === a.port)))
        throw Error("unknown output port");
      const commit = {
        id: randomUUID(),
        task_id: lease.id,
        key: output.key,
        digest: hash,
        attempt_id: lease.attempt,
        fence: lease.fence,
      };
      await sql.query(
        "INSERT INTO platform.commits(workspace_id,project_id,id,task_id,attempt_id,fence,key,digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [...this.values, commit.id, lease.id, lease.attempt, lease.fence, output.key, hash],
      );
      for (const artifact of output.artifacts) {
        await sql.query(
          "INSERT INTO platform.artifacts(workspace_id,project_id,id,representation_id,commit_id,step_run_id,backend,uri,media_type,bytes,checksum,partition_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
          [
            ...this.values,
            artifact.id,
            artifact.representation,
            commit.id,
            row.step_run_id,
            artifact.backend ?? "local",
            artifact.uri,
            artifact.mediaType,
            artifact.bytes,
            artifact.checksum,
            artifact.partition ?? row.partition_key,
          ],
        );
        await sql.query(
          "INSERT INTO platform.bindings(workspace_id,project_id,id,step_run_id,version_id,step_key,port_key,direction,artifact_id,partition_key) VALUES($1,$2,$3,$4,$5,$6,$7,'output',$8,$9)",
          [
            ...this.values,
            randomUUID(),
            step.id,
            step.version_id,
            step.step_key,
            artifact.port,
            artifact.id,
            artifact.partition ?? row.partition_key,
          ],
        );
        const targets = (
          await sql.query(
            "SELECT downstream.* ,e.target_port FROM platform.edges e JOIN platform.step_runs downstream ON downstream.workspace_id=e.workspace_id AND downstream.project_id=e.project_id AND downstream.version_id=e.version_id AND downstream.step_key=e.target_step AND downstream.run_id=$5 WHERE e.workspace_id=$1 AND e.project_id=$2 AND e.version_id=$3 AND e.source_step=$4 AND e.source_port=$6",
            [...this.values, step.version_id, step.step_key, row.run_id, artifact.port],
          )
        ).rows;
        for (const target of targets)
          await sql.query(
            "INSERT INTO platform.bindings(workspace_id,project_id,id,step_run_id,version_id,step_key,port_key,direction,artifact_id,partition_key) VALUES($1,$2,$3,$4,$5,$6,$7,'input',$8,$9)",
            [
              ...this.values,
              randomUUID(),
              target.id,
              target.version_id,
              target.step_key,
              target.target_port,
              artifact.id,
              artifact.partition ?? row.partition_key,
            ],
          );
      }
      if (output.checkpoint) {
        if (output.checkpoint.artifact) id(output.checkpoint.artifact);
        await sql.query(
          "INSERT INTO platform.checkpoints(workspace_id,project_id,id,run_id,step_run_id,task_id,commit_id,partition_key,cursor_state,state_artifact) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)",
          [
            ...this.values,
            randomUUID(),
            row.run_id,
            row.step_run_id,
            lease.id,
            commit.id,
            row.partition_key,
            json(output.checkpoint.cursor),
            output.checkpoint.artifact ?? null,
          ],
        );
      }
      for (const edge of output.lineage ?? [])
        await sql.query(
          "INSERT INTO platform.lineage(workspace_id,project_id,id,run_id,step_run_id,source_artifact,target_artifact,kind,transformation_ref,manifest_uri) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [
            ...this.values,
            randomUUID(),
            row.run_id,
            row.step_run_id,
            edge.source,
            edge.target,
            edge.kind,
            edge.transformation,
            edge.manifest ?? null,
          ],
        );
      await sql.query(
        "UPDATE platform.attempts SET status='completed',completed_at=clock_timestamp() WHERE workspace_id=$1 AND project_id=$2 AND id=$3",
        [...this.values, lease.attempt],
      );
      await sql.query(
        "UPDATE platform.tasks SET status='completed',lease_owner=NULL,lease_actor=NULL,lease_token=NULL,lease_expires_at=NULL WHERE workspace_id=$1 AND project_id=$2 AND id=$3",
        [...this.values, lease.id],
      );
      await this.advance(sql, String(row.step_run_id));
      await this.event(sql, String(row.run_id), "task", lease.id, "task.committed", {
        commit: commit.id,
        artifacts: output.artifacts.map((a) => a.id),
        checkpoint: !!output.checkpoint,
      });
      await this.audit(sql, "commit", "task", lease.id, { commit: commit.id, digest: hash });
      return this.receipt(sql, commit);
    });
  }
  async fail(
    lease: Lease,
    error: { code: string; message: string },
    retrySeconds = 0,
  ): Promise<void> {
    lease = frozen(lease);
    error = frozen(error);
    text(error.code, "error code", 128);
    text(error.message, "error summary");
    if (!Number.isInteger(retrySeconds) || retrySeconds < 0 || retrySeconds > 86_400)
      throw Error("invalid retry delay");
    await this.change("execute", async (sql) => {
      const row = await this.locked(sql, lease),
        retry = lease.fence < Number(row.max_attempts);
      await sql.query(
        "UPDATE platform.attempts SET status='failed',completed_at=clock_timestamp(),error_code=$4,error_details=$5::jsonb WHERE workspace_id=$1 AND project_id=$2 AND id=$3",
        [...this.values, lease.attempt, error.code, json({ message: error.message })],
      );
      await sql.query(
        "UPDATE platform.tasks SET status=$4,ready_at=clock_timestamp()+make_interval(secs=>$5),lease_owner=NULL,lease_actor=NULL,lease_token=NULL,lease_expires_at=NULL WHERE workspace_id=$1 AND project_id=$2 AND id=$3",
        [...this.values, lease.id, retry ? "queued" : "failed", retrySeconds],
      );
      if (!retry)
        await sql.query(
          "UPDATE platform.step_runs SET status='failed',error_summary=$4 WHERE workspace_id=$1 AND project_id=$2 AND id=$3",
          [...this.values, row.step_run_id, error.code],
        );
      if (!retry)
        await sql.query(
          "UPDATE platform.runs SET status='failed',completed_at=clock_timestamp() WHERE workspace_id=$1 AND project_id=$2 AND id=$3",
          [...this.values, row.run_id],
        );
      await this.event(
        sql,
        String(row.run_id),
        "task",
        lease.id,
        retry ? "task.retry" : "task.failed",
        { attempt: lease.attempt, code: error.code },
      );
      await this.audit(sql, "fail", "task", lease.id, {
        attempt: lease.attempt,
        code: error.code,
        retry,
      });
    });
  }
  async usage(attempt: string, value: Usage): Promise<void> {
    value = frozen(value);
    id(attempt);
    id(value.id);
    text(value.resource, "usage resource", 128);
    text(value.unit, "usage unit", 128);
    if (!Number.isFinite(value.quantity) || value.quantity < 0)
      throw Error("invalid usage quantity");
    for (const amount of [value.estimatedCost, value.actualCost])
      if (amount !== undefined && (!Number.isFinite(amount) || amount < 0))
        throw Error("invalid usage cost");
    await this.change("execute", async (sql) => {
      if (
        !(
          await sql.query(
            "SELECT 1 FROM platform.attempts WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND actor=$4",
            [...this.values, attempt, this.scope.principal],
          )
        ).rows.length
      )
        throw Error("attempt is not owned");
      await sql.query(
        "INSERT INTO platform.usage(workspace_id,project_id,id,attempt_id,resource,quantity,unit,estimated_cost,actual_cost,currency,pricing_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [
          ...this.values,
          value.id,
          attempt,
          value.resource,
          value.quantity,
          value.unit,
          value.estimatedCost ?? null,
          value.actualCost ?? null,
          value.currency ?? null,
          value.pricingVersion ?? null,
        ],
      );
    });
  }
  async verifyAudit(): Promise<{ count: number; head: string }> {
    return this.change("view", async (sql) => {
      await sql.query(
        "SELECT id FROM platform.projects WHERE workspace_id=$1 AND id=$2 FOR SHARE",
        this.values,
      );
      let count = 0,
        head = "0".repeat(64),
        after = "0";
      for (;;) {
        const rows = (
          await sql.query(
            "SELECT * FROM platform.audit WHERE workspace_id=$1 AND project_id=$2 AND sequence>$3 ORDER BY sequence LIMIT 1000",
            [...this.values, after],
          )
        ).rows;
        if (!rows.length) break;
        for (const row of rows) {
          const body = {
            workspace: this.scope.workspace,
            project: this.scope.project,
            actor: String(row.actor_id),
            action: String(row.action),
            target: String(row.target_type),
            targetId: String(row.target_id),
            summary: row.summary,
            at: iso(row.occurred_at),
            previous: head,
          };
          if (row.previous_hash !== head || row.event_hash !== digest(json(body)))
            throw Error("audit chain integrity mismatch");
          head = String(row.event_hash);
          after = String(row.sequence);
          count++;
        }
      }
      return { count, head };
    });
  }
}
