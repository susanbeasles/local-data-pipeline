import { Metadata, digest, type Row, type Sql } from "./metadata.ts";
import { schema as validateSchema } from "./profile.ts";
import {
  Registry,
  Workflow,
  type Definition,
  type Frozen,
  type Json,
  type Manifest,
  type Policy,
  type Ref,
  type Resource,
} from "./workflow.ts";

export type Document = {
  format: "platform-definition/1";
  registry: Manifest;
  workflow: Definition;
};
export type Version = {
  id: string;
  workflow: string;
  version: number;
  name: string;
  hash: string;
  status: string;
};
export type ModelBody = {
  provider: string;
  model: string;
  capabilities: string[];
  modalities: string[];
  parameters: { [key: string]: Json };
  context: { [key: string]: Json };
};
export type PromptBody = { template: string; variables: { [key: string]: Json }; contract: Ref };
export type RuleBody = {
  language: "json-logic";
  expression: Json;
  input: Ref;
  output?: Ref;
  config: { [key: string]: Json };
};
export type SchemaBody = {
  type: "json-schema";
  schema: Json;
  compatibility: { [key: string]: Json };
};
export type DatasetBody = { revision: string };
export type ArtifactBody = { artifact: string };
export type ConnectionBody = { connection: string };

/** Canonical JSON also snapshots untrusted input before the first asynchronous operation. */
function json(value: unknown): string {
  const seen = new Set<object>();
  let bytes = 0;
  const add = (text: string) => {
    bytes += Buffer.byteLength(text);
    if (bytes > 1_048_576) throw Error("definition JSON exceeds 1 MiB; use an artifact");
    return text;
  };
  const visit = (item: unknown, depth: number): string => {
    if (depth > 64) throw Error("definition JSON nesting exceeds 64");
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    )
      return add(JSON.stringify(item));
    if (
      !item ||
      typeof item !== "object" ||
      seen.has(item) ||
      Object.getOwnPropertySymbols(item).length ||
      (!Array.isArray(item) &&
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null)
    )
      throw Error("definition must contain finite acyclic plain JSON");
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item)))
      if (
        !Object.hasOwn(descriptor, "value") ||
        (!descriptor.enumerable && !(Array.isArray(item) && key === "length"))
      )
        throw Error("definition JSON cannot contain accessors or hidden fields");
    seen.add(item);
    let result: string;
    if (Array.isArray(item)) {
      if (
        Object.keys(item).length !== item.length ||
        Array.from({ length: item.length }, (_, i) => Object.hasOwn(item, i)).includes(false)
      )
        throw Error("definition JSON arrays cannot contain holes or extra keys");
      result = add("[") + item.map((child) => visit(child, depth + 1)).join(",") + add("]");
    } else
      result =
        add("{") +
        Object.keys(item)
          .sort()
          .map((key) => add(JSON.stringify(key)) + add(":") + visit((item as Row)[key], depth + 1))
          .join(",") +
        add("}");
    seen.delete(item);
    return result;
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(result) > 1_048_576)
    throw Error("definition JSON exceeds 1 MiB; use an artifact");
  return result;
}
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
    keys.some((key) => !optional.includes(key) && !Object.hasOwn(value, key))
  )
    throw Error("invalid " + label + " fields");
}
function text(value: unknown, label: string, max = 4096): asserts value is string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max)
    throw Error("invalid " + label);
}
function uuid(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
  )
    throw Error("invalid UUID");
}
function strings(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 128) throw Error("invalid " + label);
  for (const item of value) text(item, label, 256);
}
const ref = (kind: string, definition: unknown): Ref => {
  const value = definition as { id: string; version: number };
  return { id: value.id, version: value.version, digest: digest(json({ kind, definition })) };
};

/** Identifiers come only from the fixed SQL mappings below, never from document fields. */
async function ensure(
  sql: Sql,
  table: string,
  keys: readonly string[],
  values: Row,
  jsons: readonly string[] = [],
): Promise<void> {
  const columns = Object.keys(values),
    params = columns.map((key) => (jsons.includes(key) ? json(values[key]) : values[key]));
  await sql.query(
    `INSERT INTO platform.${table}(${columns.join(",")}) VALUES(${columns.map((key, i) => "$" + (i + 1) + (jsons.includes(key) ? "::jsonb" : "")).join(",")}) ON CONFLICT(${keys.join(",")}) DO NOTHING`,
    params,
  );
  const row = (
    await sql.query(
      `SELECT ${columns.join(",")} FROM platform.${table} WHERE ${keys.map((key, i) => key + "=$" + (i + 1)).join(" AND ")}`,
      keys.map((key) => values[key]),
    )
  ).rows[0];
  if (!row || columns.some((key) => json(row[key]) !== json(values[key])))
    throw Error("immutable " + table + " version or digest conflict");
}

/** Host-owned policy and exact trusted executors form the authority boundary. */
export class Definitions {
  private readonly metadata: Metadata;
  private readonly trusted: Registry;
  private readonly policy: Policy;
  constructor(metadata: Metadata, trusted: Registry, policy: Policy) {
    this.metadata = metadata;
    this.trusted = trusted;
    this.policy = JSON.parse(json(policy)) as Policy;
    const scope = metadata.scope;
    if (
      this.policy.scope.workspace !== scope.workspace ||
      this.policy.scope.project !== scope.project ||
      this.policy.scope.owner !== scope.principal
    )
      throw Error("definition host policy scope is unauthorized");
  }
  private scope(value: { scope: Frozen<Policy["scope"]> }): void {
    if (json(value.scope) !== json(this.policy.scope))
      throw Error("definition registry scope is unauthorized");
  }
  async publish(value: unknown): Promise<{ id: string; hash: string }> {
    const document = JSON.parse(json(value)) as unknown;
    fields(document, ["format", "registry", "workflow"], "platform definition");
    if (document.format !== "platform-definition/1")
      throw Error("invalid platform definition format");
    const registry = Registry.open(document.registry, this.trusted),
      manifest = registry.manifest();
    for (const group of [manifest.contracts, manifest.adapters, manifest.types, manifest.resources])
      for (const item of group) this.scope(item);
    const workflow = Workflow.publish(document.workflow, registry, this.policy);
    return this.metadata.transaction(async (metadata, sql) => {
      await this.provision(metadata, sql, registry);
      const saved = await metadata.define(workflow);
      const row = (
        await sql.query(
          "SELECT status,execution_policy FROM platform.workflow_versions WHERE workspace_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE",
          [metadata.scope.workspace, metadata.scope.project, saved.id],
        )
      ).rows[0];
      object(row?.execution_policy, "stored execution policy");
      if (row.execution_policy.registry !== undefined) {
        if (json(row.execution_policy.registry) !== json(manifest))
          throw Error("immutable workflow registry version conflict");
      } else {
        if (row.status !== "draft")
          throw Error("published workflow has no immutable registry manifest");
        await sql.query(
          "UPDATE platform.workflow_versions SET execution_policy=execution_policy || $4::jsonb WHERE workspace_id=$1 AND project_id=$2 AND id=$3",
          [
            metadata.scope.workspace,
            metadata.scope.project,
            saved.id,
            json({ registry: manifest }),
          ],
        );
      }
      return metadata.publish(saved.id);
    });
  }
  private async provision(metadata: Metadata, sql: Sql, registry: Registry): Promise<void> {
    const manifest = registry.manifest(),
      workspace = metadata.scope.workspace;
    const keys = ["workspace_id", "key", "version"];
    for (const contract of manifest.contracts)
      await ensure(
        sql,
        "contracts",
        keys,
        {
          workspace_id: workspace,
          key: contract.id,
          version: contract.version,
          digest: ref("contract", contract).digest,
          kind: contract.kind,
          schema_body: contract.schema,
          semantics: { format: contract.format },
        },
        ["schema_body", "semantics"],
      );
    for (const adapter of manifest.adapters)
      await ensure(
        sql,
        "adapters",
        keys,
        {
          workspace_id: workspace,
          key: adapter.id,
          version: adapter.version,
          digest: ref("adapter", adapter).digest,
          runtime: "trusted-handler",
          artifact_uri: "sha256:" + adapter.artifact,
          artifact_digest: adapter.artifact,
          runtime_contract: 1,
          capabilities: adapter.capabilities,
          isolation: { authority: "host-registered" },
        },
        ["capabilities", "isolation"],
      );
    for (const type of manifest.types)
      await ensure(
        sql,
        "step_types",
        keys,
        {
          workspace_id: workspace,
          key: type.id,
          version: type.version,
          digest: ref("type", type).digest,
          adapter_key: type.adapter.id,
          adapter_version: type.adapter.version,
          category: type.category,
          configuration_schema: type.config,
          input_ports: type.ports.inputs,
          output_ports: type.ports.outputs,
          bindings: type.bindings,
          capabilities: type.capabilities,
          modes: ["batch"],
        },
        ["configuration_schema", "input_ports", "output_ports", "bindings", "capabilities"],
      );
    for (const resource of manifest.resources)
      await this.resource(metadata, sql, registry, resource);
  }
  private async resource(
    metadata: Metadata,
    sql: Sql,
    registry: Registry,
    resource: Frozen<Resource>,
  ): Promise<void> {
    const workspace = metadata.scope.workspace,
      project = metadata.scope.project;
    const identity = { workspace_id: workspace, key: resource.id, version: resource.version };
    const keys = ["workspace_id", "key", "version"];
    const body: unknown = resource.body;
    object(body, resource.kind + " body");
    await ensure(sql, "resources", keys, {
      ...identity,
      project_id: project,
      digest: ref("resource", resource).digest,
      kind: resource.kind,
      name: resource.id,
    });
    const contract = (value: unknown): Ref => {
      const pin = value as Ref;
      registry.contract(pin);
      return pin;
    };
    switch (resource.kind) {
      case "model": {
        fields(
          body,
          ["provider", "model", "capabilities", "modalities", "parameters", "context"],
          "model body",
        );
        text(body.provider, "model provider", 256);
        text(body.model, "model key", 256);
        strings(body.capabilities, "model capabilities");
        strings(body.modalities, "model modalities");
        if (!body.modalities.length) throw Error("model modalities must not be empty");
        object(body.parameters, "model parameters");
        object(body.context, "model context");
        await ensure(
          sql,
          "models",
          keys,
          {
            ...identity,
            provider: body.provider,
            model_key: body.model,
            capabilities: body.capabilities,
            modalities: body.modalities,
            parameters: body.parameters,
            context_limits: body.context,
          },
          ["capabilities", "parameters", "context_limits"],
        );
        break;
      }
      case "prompt": {
        fields(body, ["template", "variables", "contract"], "prompt body");
        text(body.template, "prompt template", 262144);
        object(body.variables, "prompt variables");
        const output = contract(body.contract);
        await ensure(
          sql,
          "prompts",
          keys,
          {
            ...identity,
            template: body.template,
            variables: body.variables,
            contract_key: output.id,
            contract_version: output.version,
          },
          ["variables"],
        );
        break;
      }
      case "rule": {
        fields(body, ["language", "expression", "input", "output", "config"], "rule body", [
          "output",
        ]);
        if (body.language !== "json-logic") throw Error("unsupported rule language");
        object(body.config, "rule configuration");
        const input = contract(body.input),
          output = body.output === undefined ? undefined : contract(body.output);
        await ensure(
          sql,
          "logic",
          keys,
          {
            ...identity,
            kind: "rule",
            language: body.language,
            expression: json(body.expression),
            input_contract: input.id,
            input_version: input.version,
            output_contract: output?.id ?? null,
            output_version: output?.version ?? null,
            configuration: body.config,
          },
          ["configuration"],
        );
        break;
      }
      case "schema": {
        fields(body, ["type", "schema", "compatibility"], "schema body");
        if (body.type !== "json-schema") throw Error("unsupported schema type");
        validateSchema(body.schema);
        object(body.compatibility, "schema compatibility");
        await ensure(
          sql,
          "schemas",
          keys,
          {
            ...identity,
            schema_type: body.type,
            body: body.schema,
            compatibility: body.compatibility,
          },
          ["body", "compatibility"],
        );
        break;
      }
      case "dataset": {
        fields(body, ["revision"], "dataset body");
        uuid(body.revision);
        const existing = (
          await sql.query(
            "SELECT id FROM platform.dataset_versions WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND state='published'",
            [workspace, project, body.revision],
          )
        ).rows[0];
        if (!existing) throw Error("unknown published dataset revision in scope");
        await ensure(sql, "dataset_resources", keys, {
          ...identity,
          project_id: project,
          revision_id: body.revision,
        });
        break;
      }
      case "artifact": {
        fields(body, ["artifact"], "artifact body");
        uuid(body.artifact);
        const existing = (
          await sql.query(
            "SELECT id FROM platform.artifacts WHERE workspace_id=$1 AND project_id=$2 AND id=$3",
            [workspace, project, body.artifact],
          )
        ).rows[0];
        if (!existing) throw Error("unknown committed artifact in scope");
        await ensure(sql, "artifact_resources", keys, {
          ...identity,
          project_id: project,
          artifact_id: body.artifact,
        });
        break;
      }
      case "connection": {
        fields(body, ["connection"], "connection body");
        uuid(body.connection);
        const existing = (
          await sql.query(
            "SELECT id,credential_id FROM platform.connections WHERE workspace_id=$1 AND id=$2 AND status='active'",
            [workspace, body.connection],
          )
        ).rows[0];
        if (!existing) throw Error("unknown active connection in scope");
        if (existing.credential_id) await metadata.transaction(async () => undefined, "secret-use");
        await ensure(sql, "connection_resources", keys, {
          ...identity,
          connection_id: body.connection,
        });
        break;
      }
      default:
        throw Error("unsupported resource kind");
    }
  }
  async open(version: string): Promise<{ workflow: Workflow; registry: Registry }> {
    uuid(version);
    return this.metadata.transaction(async (metadata, sql) => {
      const row = (
        await sql.query(
          "SELECT compiled_release,execution_policy FROM platform.workflow_versions WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND status='published'",
          [metadata.scope.workspace, metadata.scope.project, version],
        )
      ).rows[0];
      if (!row) throw Error("unknown published workflow version in scope");
      object(row.execution_policy, "stored execution policy");
      const registry = Registry.open(row.execution_policy.registry, this.trusted);
      return { workflow: Workflow.open(row.compiled_release, registry, this.policy), registry };
    }, "view");
  }
  async list(options: { limit?: number; after?: string } = {}): Promise<Version[]> {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw Error("definition list limit must be 1..1000");
    if (options.after !== undefined) uuid(options.after);
    return this.metadata.transaction(async (metadata, sql) => {
      const rows = (
        await sql.query(
          "SELECT v.id,v.workflow_id,v.number,v.definition->>'name' AS name,v.definition_hash,v.status FROM platform.workflow_versions v WHERE v.workspace_id=$1 AND v.project_id=$2 AND ($3::uuid IS NULL OR v.id>$3::uuid) ORDER BY v.id LIMIT $4",
          [metadata.scope.workspace, metadata.scope.project, options.after ?? null, limit],
        )
      ).rows;
      return rows.map((row) => ({
        id: String(row.id),
        workflow: String(row.workflow_id),
        version: Number(row.number),
        name: String(row.name),
        hash: String(row.definition_hash),
        status: String(row.status),
      }));
    }, "view");
  }
}
