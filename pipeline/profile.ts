import type { Schema } from "./roles.ts";
import { order } from "./roles.ts";
export type Stage = {
  name: string;
  system: string;
  maxTokens: number;
  schema: Schema;
};
export type Profile = { format: "enrichment/1"; name: string; stages: Stage[] };
const own = (v: object, k: string) => Object.hasOwn(v, k);
function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function keys(v: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(v).some((k) => !allowed.includes(k)))
    throw Error("unsupported schema/config field");
}
export function schema(value: unknown, depth = 0): asserts value is Schema {
  if (!record(value) || depth > 32) throw Error("invalid schema");
  keys(value, [
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "enum",
    "minimum",
    "maximum",
    "minItems",
    "maxItems",
    "minLength",
  ]);
  if (
    !["object", "array", "string", "integer", "number", "boolean"].includes(
      String(value.type),
    )
  )
    throw Error("unsupported schema type");
  if (
    value.enum !== undefined &&
    (!Array.isArray(value.enum) ||
      !value.enum.length ||
      value.enum.some((v) => v !== null && typeof v === "object"))
  )
    throw Error("invalid schema enum");
  for (const k of ["minimum", "maximum", "minItems", "maxItems", "minLength"])
    if (
      value[k] !== undefined &&
      (typeof value[k] !== "number" ||
        !Number.isFinite(value[k]) ||
        (["minItems", "maxItems", "minLength"].includes(k) &&
          (!Number.isSafeInteger(value[k]) || Number(value[k]) < 0)))
    )
      throw Error("invalid schema limit");
  if (
    value.minimum !== undefined &&
    value.maximum !== undefined &&
    Number(value.minimum) > Number(value.maximum)
  )
    throw Error("invalid schema range");
  if (
    value.minItems !== undefined &&
    value.maxItems !== undefined &&
    Number(value.minItems) > Number(value.maxItems)
  )
    throw Error("invalid schema range");
  if (value.enum !== undefined) {
    if (value.type === "boolean")
      throw Error("boolean schema enums unsupported by installed decoder");
    for (const item of value.enum as unknown[])
      if (!accepts({ ...value, enum: undefined } as Schema, item))
        throw Error("schema enum type mismatch");
  }
  if (value.type === "object") {
    if (
      !record(value.properties) ||
      value.additionalProperties !== false ||
      !Array.isArray(value.required) ||
      value.required.some(
        (k) => typeof k !== "string" || !own(value.properties as object, k),
      )
    )
      throw Error(
        "object schema requires explicit properties, required and additionalProperties=false",
      );
    for (const [k, s] of Object.entries(value.properties)) {
      if (["__proto__", "prototype", "constructor"].includes(k))
        throw Error("unsafe schema key");
      schema(s, depth + 1);
    }
  } else if (value.type === "array") schema(value.items, depth + 1);
}
export function accepts(s: Schema, v: unknown): boolean {
  if (s.enum && !s.enum.some((x) => JSON.stringify(x) === JSON.stringify(v)))
    return false;
  switch (s.type) {
    case "boolean":
      return typeof v === "boolean";
    case "string":
      return (
        typeof v === "string" &&
        (s.minLength === undefined || [...v].length >= s.minLength)
      );
    case "integer":
    case "number":
      return (
        typeof v === "number" &&
        Number.isFinite(v) &&
        (s.type !== "integer" || Number.isSafeInteger(v)) &&
        (s.minimum === undefined || v >= s.minimum) &&
        (s.maximum === undefined || v <= s.maximum)
      );
    case "array":
      return (
        Array.isArray(v) &&
        v.length >= (s.minItems ?? 0) &&
        (s.maxItems === undefined || v.length <= s.maxItems) &&
        v.every((x) => accepts(s.items!, x))
      );
    case "object":
      return (
        record(v) &&
        (s.required ?? []).every((k) => own(v, k)) &&
        Object.keys(v).every((k) => own(s.properties!, k)) &&
        Object.entries(s.properties ?? {}).every(
          ([k, t]) => !own(v, k) || accepts(t, v[k]),
        )
      );
    default:
      return false;
  }
}
export function profile(value: unknown): Profile {
  if (!record(value)) throw Error("invalid profile");
  keys(value, ["format", "name", "stages"]);
  if (
    value.format !== "enrichment/1" ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    !Array.isArray(value.stages) ||
    !value.stages.length ||
    value.stages.length > 32
  )
    throw Error("invalid profile");
  const names = new Set<string>();
  for (const s of value.stages) {
    if (!record(s)) throw Error("invalid stage");
    keys(s, ["name", "system", "maxTokens", "schema"]);
    if (
      typeof s.name !== "string" ||
      !/^[a-z][a-z0-9-]{0,47}$/.test(s.name) ||
      names.has(s.name)
    )
      throw Error("invalid or duplicate stage");
    if (
      [...order, "presence", "constructor", "prototype"].includes(s.name as any)
    )
      throw Error("reserved stage name");
    names.add(s.name);
    if (
      typeof s.system !== "string" ||
      !s.system.trim() ||
      !Number.isSafeInteger(s.maxTokens) ||
      Number(s.maxTokens) < 1 ||
      Number(s.maxTokens) > 32768
    )
      throw Error("invalid stage instructions/budget");
    schema(s.schema);
    if ((s.schema as Schema).type !== "object")
      throw Error("stage schema must have object root");
  }
  return structuredClone(value) as Profile;
}
export function artifact(
  stage: Stage,
  prior: string[],
  base: { path: string; hash: string },
) {
  return {
    format: "local-role/1",
    role: stage.name,
    base,
    system: stage.system,
    input: {
      context: ["sourceId", "sourceHash", "chunkId", "sourceName"],
      prior,
    },
    schema: stage.schema,
    maxTokens: stage.maxTokens,
    output: { schema: stage.schema, privateRoot: [], privateEdge: [] },
    temperature: 0,
    thinking: false,
    weightChanges: false,
    adapter: null,
  };
}
