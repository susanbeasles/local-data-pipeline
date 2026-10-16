/** Lossless, content-addressed factoring. Reference maps are separate from source keys. */
import { hash } from "./store.ts";
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonNode = { id: string; data: Json; links: Record<string, string> };
const keys = new Set(["root", "blocks", "bot_profile", "user_profile", "attachments", "files"]);
const pointer = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");
function canonical(value: Json, depth = 0): string {
  if (depth > 96) throw Error("JSON nesting budget exceeded");
  if (
    typeof value === "number" &&
    (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
  )
    throw Error("unsafe JSON integer or nonfinite value");
  if (typeof value === "number" && Object.is(value, -0))
    throw Error("unsupported negative-zero numeric representation");
  if (Array.isArray(value)) return "[" + value.map((v) => canonical(v, depth + 1)).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]!, depth + 1))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export class JsonValues {
  readonly nodes = new Map<string, JsonNode>();
  private counts = new Map<string, number>();
  private identity(value: Json) {
    return hash(canonical(value));
  }
  index(value: Json) {
    canonical(value);
    const walk = (v: Json, key = "", depth = 0) => {
      if (depth > 96) throw Error("JSON nesting budget exceeded");
      if (v && typeof v === "object") {
        if (keys.has(key) && Buffer.byteLength(canonical(v)) >= 512) {
          const id = this.identity(v);
          this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
        }
        if (Array.isArray(v)) for (const child of v) walk(child, "", depth + 1);
        else for (const k of Object.keys(v)) walk(v[k]!, k, depth + 1);
      }
    };
    walk(value);
  }
  add(value: Json): JsonNode {
    const id = this.identity(value),
      prior = this.nodes.get(id);
    if (prior) return prior;
    const links: Record<string, string> = Object.create(null);
    const encode = (v: Json, path: string, key = "", depth = 0): Json => {
      if (depth > 96) throw Error("JSON nesting budget exceeded");
      if (v && typeof v === "object") {
        if (keys.has(key) && Buffer.byteLength(canonical(v)) >= 512) {
          const child = this.identity(v);
          if ((this.counts.get(child) ?? 0) > 1) {
            links[path] = this.add(v).id;
            return null;
          }
        }
        if (Array.isArray(v))
          return v.map((child, i) => encode(child, path + "/" + i, "", depth + 1));
        const out: Record<string, Json> = Object.create(null);
        for (const k of Object.keys(v).sort())
          out[k] = encode(v[k]!, path + "/" + pointer(k), k, depth + 1);
        return out;
      }
      return v;
    };
    const node = { id, data: encode(value, ""), links };
    this.nodes.set(id, node);
    return node;
  }
  expand(id: string, parents = new Set<string>()): Json {
    if (parents.has(id)) throw Error("cyclic JSON dictionary");
    const node = this.nodes.get(id);
    if (!node) throw Error("missing JSON dictionary value");
    const seen = new Set(parents);
    seen.add(id);
    let data = JSON.parse(JSON.stringify(node.data)) as Json;
    for (const [path, target] of Object.entries(node.links)) {
      const parts = path
        .split("/")
        .slice(1)
        .map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"));
      if (!parts.length) throw Error("invalid JSON reference path");
      let parent = data as Record<string, Json>;
      for (const part of parts.slice(0, -1)) {
        if (parent === null || typeof parent !== "object" || !Object.hasOwn(parent, part))
          throw Error("invalid JSON reference parent");
        parent = parent[part] as Record<string, Json>;
      }
      const key = parts.at(-1)!;
      if (
        parent === null ||
        typeof parent !== "object" ||
        !Object.hasOwn(parent, key) ||
        parent[key] !== null
      )
        throw Error("invalid JSON reference slot");
      Object.defineProperty(parent, key, {
        value: this.expand(target, seen),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    if (this.identity(data) !== id) throw Error("reconstructed JSON hash mismatch");
    return data;
  }
}
