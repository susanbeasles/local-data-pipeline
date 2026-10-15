import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync, createReadStream, lstatSync, realpathSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, dirname, parse } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { accepts, schema } from "./profile.ts";
import type { Schema } from "./roles.ts";
import { hash, publish } from "./store.ts";

export type { Schema } from "./roles.ts";
export type RecordInput = { id: string; source: string; key: string; body: unknown };
export type Input = RecordInput;
export type Annotation = {
  tags?: string[];
  keywords?: string[];
  summary?: string;
  category?: string;
  rating?: number;
};
export type Item = Input & Annotation & { original: unknown; tags: string[]; keywords: string[] };
export type Revision = {
  id: string;
  name: string;
  parent?: string;
  created: string;
  count: number;
  hash: string;
  path: string;
  bytes: number;
  run?: string;
};
export type Filters = {
  query?: string;
  source?: string;
  tag?: string;
  keyword?: string;
  category?: string;
  rating?: number;
  offset?: number;
  limit?: number;
};
export type Page = {
  revision: Revision;
  records: Item[];
  total: number;
  offset: number;
  limit: number;
  more: boolean;
};
export type Link = { from: string; to: string; kind: string };
export type Match = { path: string; equals?: unknown; contains?: string; exists?: boolean };
export type Check = {
  op: "check";
  path: string;
  type?: "string" | "number" | "boolean" | "object" | "array";
  required?: boolean;
  minLength?: number;
  onFailure?: "reject" | "quarantine";
};
export type Step =
  | { op: "set"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | ({ op: "include" | "exclude" } & Match)
  | { op: "dedupe"; paths?: string[] }
  | Check
  | { op: "validate"; schema: Schema; onFailure?: "reject" | "quarantine" };
export type Report = {
  processed: number;
  accepted: number;
  excluded: number;
  duplicate: number;
  quarantined: number;
  failed: number;
  corrected: number;
};
export type Run = {
  id: string;
  parent: string;
  revision?: string;
  state: "running" | "paused" | "completed";
  steps: Step[];
  pauseOnFailure: boolean;
  cursor: number;
  total: number;
  report: Report;
};
export type Failure = {
  id: string;
  runId: string;
  recordId: string;
  step: number;
  op: Step["op"];
  reason: string;
  body: unknown;
  state: "open" | "corrected" | "resolved" | "quarantined";
};
export type Outcome = {
  recordId: string;
  index: number;
  state: "accepted" | "excluded" | "duplicate" | "quarantined" | "failed";
  body: unknown;
  step?: number;
  reason?: string;
};
export type Options = { pauseOnFailure?: boolean; id?:string };
export type Capture = { id: string };
export type Integrity = { records: number; bytes: number; hash: string; intact: true };
type Row = { [key: string]: unknown };
type Stored = Input & { text: string; digest: string };
const active = new Set<string>();
const unsafe = new Set(["__proto__", "prototype", "constructor"]);
const own = (value: object, key: string) => Object.hasOwn(value, key);
const object = (value: unknown): value is Row =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, label: string) => {
  if (typeof value !== "string" || !value.trim() || value.length > 4096)
    throw Error("invalid " + label);
  return value;
};
/** Canonical, lossless JSON only; reject values that JSON.stringify would silently discard. */
function json(value: unknown, seen = new Set<object>(), depth = 0): string {
  if (depth > 128) throw Error("JSON nesting exceeds 128");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== "object" || seen.has(value))
    throw Error("body must contain finite, acyclic JSON values");
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw Error("body must contain plain JSON objects");
  if (Object.getOwnPropertySymbols(value).length) throw Error("JSON symbol keys unsupported");
  seen.add(value);
  let result: string;
  if (Array.isArray(value)) {
    const values: string[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!own(value, String(i))) throw Error("JSON sparse arrays unsupported");
      values.push(json(value[i], seen, depth + 1));
    }
    result = "[" + values.join(",") + "]";
  } else
    result =
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + json((value as Row)[key], seen, depth + 1))
        .join(",") +
      "}";
  seen.delete(value);
  return result;
}
function decode(row: Row | undefined, label: string): unknown {
  if (!row || typeof row.body !== "string" || hash(row.body) !== row.digest)
    throw Error("dataset integrity mismatch: " + label);
  return JSON.parse(row.body);
}
function tokens(path: string): string[] {
  if (typeof path !== "string" || path.length > 4096) throw Error("invalid JSON path");
  let parts: string[];
  if (path === "$" || path === "") parts = [];
  else if (path.startsWith("/")) {
    if (/~(?![01])/u.test(path)) throw Error("invalid JSON Pointer escape");
    parts = path
      .slice(1)
      .split("/")
      .map((p) => p.replaceAll("~1", "/").replaceAll("~0", "~"));
  } else {
    if (!/^\$(?:\.[A-Za-z_][A-Za-z0-9_-]*|\[(?:0|[1-9][0-9]*)\])+$/u.test(path))
      throw Error("unsupported JSON path");
    parts = [...path.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)|\[([0-9]+)\]/gu)].map(
      (m) => m[1] ?? m[2],
    );
  }
  if (parts.some((p) => unsafe.has(p))) throw Error("unsafe JSON path");
  if (parts.length > 128) throw Error("JSON path nesting exceeds 128");
  return parts;
}
function at(body: unknown, path: string): { exists: boolean; value?: unknown } {
  let value = body;
  for (const key of tokens(path)) {
    if ((!object(value) && !Array.isArray(value)) || !own(value, key)) return { exists: false };
    value = (value as Row)[key];
  }
  return { exists: true, value };
}
function change(body: unknown, path: string, value: unknown, remove = false): unknown {
  const parts = tokens(path);
  if (!parts.length) {
    if (remove) throw Error("cannot remove JSON root");
    return JSON.parse(json(value));
  }
  let node = body;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!object(node) && !Array.isArray(node)) throw Error("JSON path crosses a scalar");
    if (!own(node, key)) {
      if (remove) return body;
      if (Array.isArray(node) && (!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) !== node.length))
        throw Error("JSON array index is out of bounds");
      (node as Row)[key] = /^(0|[1-9][0-9]*)$/u.test(parts[i + 1]) ? [] : {};
    }
    node = (node as Row)[key];
  }
  if (!object(node) && !Array.isArray(node)) throw Error("JSON path crosses a scalar");
  const key = parts.at(-1)!;
  if (Array.isArray(node)) {
    if (!/^(0|[1-9][0-9]*)$/u.test(key)) throw Error("invalid JSON array index");
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index > node.length)
      throw Error("JSON array index is out of bounds");
    if (remove) {
      if (index < node.length) node.splice(index, 1);
    } else node[index] = JSON.parse(json(value));
  } else if (remove) delete node[key];
  else node[key] = JSON.parse(json(value));
  return body;
}
function matches(body: unknown, step: Match): boolean {
  const found = at(body, step.path);
  if (own(step, "exists") && found.exists !== step.exists) return false;
  if (own(step, "equals") && (!found.exists || json(found.value) !== json(step.equals)))
    return false;
  if (
    own(step, "contains") &&
    (!found.exists || typeof found.value !== "string" || !found.value.includes(step.contains!))
  )
    return false;
  return true;
}
function diagnostic(shape: Schema, value: unknown, path = ""): string {
  const child = (key: string | number) =>
    path + "/" + String(key).replaceAll("~", "~0").replaceAll("/", "~1");
  if (shape.type === "object" && object(value)) {
    for (const key of shape.required ?? [])
      if (!own(value, key)) return child(key) + ": required field is missing";
    for (const key of Object.keys(value))
      if (!own(shape.properties!, key)) return child(key) + ": additional field is not allowed";
    for (const [key, item] of Object.entries(shape.properties ?? {}))
      if (own(value, key) && !accepts(item, value[key]))
        return diagnostic(item, value[key], child(key));
  }
  if (shape.type === "array" && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++)
      if (!accepts(shape.items!, value[i])) return diagnostic(shape.items!, value[i], child(i));
  }
  const limits = ["minimum", "maximum", "minItems", "maxItems", "minLength"] as const;
  const details = limits
    .filter((key) => shape[key] !== undefined)
    .map((key) => key + " " + shape[key]);
  if (shape.enum) details.push("allowed enum value");
  return (
    (path || "/") + ": expected " + shape.type + (details.length ? ", " + details.join(", ") : "")
  );
}

function check(body: unknown, rule: Check): string | undefined {
  const field = at(body, rule.path);
  if (!field.exists) return rule.required ? rule.path + ": required field is missing" : undefined;
  const value = field.value;
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (rule.type !== undefined && type !== rule.type) return rule.path + ": expected " + rule.type;
  if (rule.minLength !== undefined) {
    const length =
      typeof value === "string" ? [...value].length : Array.isArray(value) ? value.length : -1;
    if (length < rule.minLength)
      return rule.path + ": expected string or array, minLength " + rule.minLength;
  }
  return undefined;
}

export function validateSteps(value: unknown): Step[] {
  json(value);
  if (!Array.isArray(value) || value.length > 128) throw Error("invalid dataset steps");
  for (const step of value) {
    if (!object(step)) throw Error("invalid dataset step");
    let keys: string[];
    switch (step.op) {
      case "set":
        keys = ["op", "path", "value"];
        if (!own(step, "value")) throw Error("set requires value");
        tokens(step.path as string);
        break;
      case "remove":
        keys = ["op", "path"];
        if (!tokens(step.path as string).length) throw Error("cannot remove JSON root");
        break;
      case "include":
      case "exclude":
        keys = ["op", "path", "equals", "contains", "exists"];
        tokens(step.path as string);
        if (!["equals", "contains", "exists"].some((k) => own(step, k)))
          throw Error("filter requires a match");
        if (own(step, "contains") && typeof step.contains !== "string")
          throw Error("contains requires string");
        if (own(step, "exists") && typeof step.exists !== "boolean")
          throw Error("exists requires boolean");
        break;
      case "dedupe":
        keys = ["op", "paths"];
        if (step.paths !== undefined) {
          if (!Array.isArray(step.paths) || !step.paths.length || step.paths.length > 128)
            throw Error("invalid dedupe paths");
          step.paths.forEach((p) => tokens(p as string));
        }
        break;
      case "check":
        keys = ["op", "path", "type", "required", "minLength", "onFailure"];
        tokens(step.path as string);
        if (
          step.type !== undefined &&
          (typeof step.type !== "string" ||
            !["string", "number", "boolean", "object", "array"].includes(step.type))
        )
          throw Error("unsupported field check type");
        if (step.required !== undefined && typeof step.required !== "boolean")
          throw Error("invalid field check required");
        if (
          step.minLength !== undefined &&
          (!Number.isSafeInteger(step.minLength) ||
            Number(step.minLength) < 0 ||
            Number(step.minLength) > 1_000_000)
        )
          throw Error("invalid field check minLength");
        if (
          step.minLength !== undefined &&
          step.type !== undefined &&
          !["string", "array"].includes(String(step.type))
        )
          throw Error("field check minLength requires string or array");
        if (
          step.onFailure !== undefined &&
          (typeof step.onFailure !== "string" || !["reject", "quarantine"].includes(step.onFailure))
        )
          throw Error("invalid validation disposition");
        break;
      case "validate":
        keys = ["op", "schema", "onFailure"];
        schema(step.schema);
        if (
          step.onFailure !== undefined &&
          (typeof step.onFailure !== "string" || !["reject", "quarantine"].includes(step.onFailure))
        )
          throw Error("invalid validation disposition");
        break;
      default:
        throw Error("unsupported dataset step");
    }
    if (Object.keys(step).some((k) => !keys.includes(k)))
      throw Error("unsupported dataset step field");
  }
  return JSON.parse(json(value)) as Step[];
}

function guarded(path: string, kind?: "file" | "directory"): void {
  let current = parse(path).root;
  const parts = path.slice(current.length).split("/").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink() && !["/tmp", "/var"].includes(current))
      throw Error("dataset storage rejects symbolic links: " + current);
    if (i < parts.length - 1 && !stat.isDirectory() && !stat.isSymbolicLink())
      throw Error("dataset storage ancestor is not a directory");
    if (i === parts.length - 1 && !stat.isSymbolicLink()) {
      if (kind === "directory" && !stat.isDirectory())
        throw Error("dataset storage requires a directory");
      if (kind === "file" && (!stat.isFile() || stat.nlink !== 1))
        throw Error("dataset storage rejects aliased or nonregular files");
    }
  }
}
function canonical(path: string): string {
  guarded(path, "directory");
  let parent = path;
  const suffix: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(parent), ...suffix.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (parent === dirname(parent)) throw error;
      suffix.push(parent.slice(dirname(parent).length + (dirname(parent) === "/" ? 0 : 1)));
      parent = dirname(parent);
    }
  }
}
export type Observer={path:string;digest:string};
function proof(pid: number, observer?:Observer): string | undefined {
  try {
    if(observer){const stat=lstatSync(observer.path);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||hash(readFileSync(observer.path))!==observer.digest)throw Error('process observer integrity mismatch');}
    // Both observers include kernel birth identity plus the executable. The
    // default ps observer additionally records full arguments outside Seatbelt.
    const identity=execFileSync(observer?.path??'/bin/ps',observer?[String(pid)]:['-p',String(pid),'-o','lstart=','-o','command='],{encoding:'utf8',timeout:1500}).trim();
    return identity ? hash(identity) : undefined;
  } catch {
    return undefined;
  }
}
function owner(token: string, observer?:Observer): string {
  const identity = proof(process.pid, observer);
  if (!identity) throw Error("cannot establish dataset worker identity");
  return JSON.stringify({ pid: process.pid, token, proof: identity });
}

/** Dedicated operator workspace. Never opens a registered source or invokes a model. */
export class Dataset {
  readonly root: string;
  private readonly db: DatabaseSync;
  private closed = false;
  private observer?:Observer;
  constructor(root: string, options:{observer?:Observer}={}) {
    this.observer=options.observer;
    this.root = canonical(resolve(root));
    const path = join(this.root, "dataset.sqlite");
    // Check every mutable target before creating directories, opening SQLite or chmod.
    guarded(this.root, "directory");
    guarded(join(this.root, "revisions"), "directory");
    for (const suffix of ["", "-wal", "-shm", "-journal"]) guarded(path + suffix, "file");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db
      .exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS originals(id TEXT PRIMARY KEY,source TEXT NOT NULL,human_key TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions(id TEXT PRIMARY KEY,name TEXT NOT NULL,parent TEXT REFERENCES revisions(id),created TEXT NOT NULL,count INTEGER NOT NULL,hash TEXT NOT NULL,path TEXT NOT NULL,bytes INTEGER NOT NULL,run TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS revision_items(revision TEXT NOT NULL REFERENCES revisions(id),n INTEGER NOT NULL,id TEXT NOT NULL REFERENCES originals(id),body TEXT NOT NULL CHECK(json_valid(body)),digest TEXT NOT NULL,PRIMARY KEY(revision,n),UNIQUE(revision,id));
      CREATE TABLE IF NOT EXISTS annotations(id TEXT PRIMARY KEY REFERENCES originals(id),body TEXT NOT NULL CHECK(json_valid(body)));
      CREATE TABLE IF NOT EXISTS links(origin TEXT NOT NULL REFERENCES originals(id),target TEXT NOT NULL REFERENCES originals(id),kind TEXT NOT NULL,PRIMARY KEY(origin,target,kind));
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,parent TEXT NOT NULL REFERENCES revisions(id),revision TEXT REFERENCES revisions(id),state TEXT NOT NULL,steps TEXT NOT NULL,step_hash TEXT NOT NULL,pause INTEGER NOT NULL,cursor INTEGER NOT NULL,total INTEGER NOT NULL,owner TEXT);
      CREATE TABLE IF NOT EXISTS run_items(run TEXT NOT NULL REFERENCES runs(id),n INTEGER NOT NULL,id TEXT NOT NULL REFERENCES originals(id),state TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),digest TEXT NOT NULL,step INTEGER,reason TEXT,PRIMARY KEY(run,n),UNIQUE(run,id));
      CREATE TABLE IF NOT EXISTS failures(id TEXT PRIMARY KEY,run TEXT NOT NULL REFERENCES runs(id),record TEXT NOT NULL REFERENCES originals(id),n INTEGER NOT NULL,step INTEGER NOT NULL,op TEXT NOT NULL,reason TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),digest TEXT NOT NULL,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS corrections(n INTEGER PRIMARY KEY AUTOINCREMENT,run TEXT NOT NULL REFERENCES runs(id),record TEXT NOT NULL REFERENCES originals(id),body TEXT NOT NULL CHECK(json_valid(body)),digest TEXT NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS seen(run TEXT NOT NULL REFERENCES runs(id),step INTEGER NOT NULL,key TEXT NOT NULL,n INTEGER NOT NULL,PRIMARY KEY(run,step,key));
      CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY,name TEXT NOT NULL,parent TEXT,run TEXT,created TEXT NOT NULL,state TEXT NOT NULL,error TEXT,owner TEXT);
      CREATE TABLE IF NOT EXISTS draft_items(revision TEXT NOT NULL REFERENCES drafts(id),n INTEGER NOT NULL,id TEXT NOT NULL,source TEXT NOT NULL,human_key TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),digest TEXT NOT NULL,PRIMARY KEY(revision,n),UNIQUE(revision,id));
      CREATE INDEX IF NOT EXISTS revision_lookup ON revision_items(revision,id);
      CREATE INDEX IF NOT EXISTS failure_lookup ON failures(run,n);
      CREATE INDEX IF NOT EXISTS correction_lookup ON corrections(run,record,n);
    `);
    if (
      !this.db
        .prepare("PRAGMA table_info(drafts)")
        .all()
        .some((row) => row.name === "owner")
    )
      this.db.exec("ALTER TABLE drafts ADD COLUMN owner TEXT");
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private original(id: string): Row {
    const row = this.db.prepare("SELECT * FROM originals WHERE id=?").get(id);
    if (!row) throw Error("unknown record: " + id);
    decode(row, "original " + id);
    return row;
  }
  private prepare(records: Input[]): Stored[] {
    if (!Array.isArray(records)) throw Error("records must be an array");
    const ids = new Set<string>();
    return records.map((record) => {
      if (!object(record)) throw Error("invalid record");
      const id = text(record.id, "record id"),
        source = text(record.source, "source"),
        key = text(record.key, "record key");
      if (ids.has(id)) throw Error("duplicate record identity");
      ids.add(id);
      const prior = this.db.prepare("SELECT * FROM originals WHERE id=?").all(id);
      if (prior.some((r) => r.id !== id || r.source !== source || r.human_key !== key))
        throw Error("record identity mismatch");
      for (const row of prior) decode(row, "original " + id);
      const body = json(record.body);
      return { id, source, key, body: JSON.parse(body), text: body, digest: hash(body) };
    });
  }
  private line(record: Input) {
    return (
      json({ id: record.id, source: record.source, key: record.key, body: record.body }) + "\n"
    );
  }
  private async publish(
    name: string,
    records: Iterable<RecordInput> | AsyncIterable<RecordInput>,
    parent?: string,
    run?: string,
    stable?: string,
  ): Promise<Revision> {
    text(name, "revision name");
    if (parent) this.revision(parent);
    const id = "rev-" + (stable ?? run ?? randomUUID()),
      path = join(this.root, "revisions", id + ".jsonl");
    guarded(join(this.root, "revisions"), "directory");
    guarded(path, "file");
    const token = randomUUID(),
      ownership = owner(token,this.observer);
    let created = new Date().toISOString(),
      prior: Revision | undefined,
      saved = 0;
    this.transaction(() => {
      const draft = this.db.prepare("SELECT * FROM drafts WHERE id=?").get(id);
      const revision = this.db.prepare("SELECT id FROM revisions WHERE id=?").get(id);
      if (revision) prior = this.revision(id);
      if (
        draft &&
        (draft.name !== name || draft.parent !== (parent ?? null) || draft.run !== (run ?? null))
      )
        throw Error("capture identity mismatch");
      if (prior && (prior.name !== name || prior.parent !== parent || prior.run !== run))
        throw Error("capture identity mismatch");
      if (draft && this.ownerAlive(draft.owner)) throw Error("dataset import is active");
      created = draft ? String(draft.created) : (prior?.created ?? created);
      if (draft)
        this.db
          .prepare("UPDATE drafts SET owner=?,state=?,error=NULL WHERE id=?")
          .run(ownership, prior ? "published" : "staging", id);
      else
        this.db
          .prepare(
            "INSERT INTO drafts(id,name,parent,run,created,state,error,owner) VALUES(?,?,?,?,?,?,NULL,?)",
          )
          .run(
            id,
            name,
            parent ?? null,
            run ?? null,
            created,
            prior ? "published" : "staging",
            ownership,
          );
      if (!prior) {
        const prefix = this.db
          .prepare(
            "SELECT count(*) count,min(n) first,max(n) last FROM draft_items WHERE revision=?",
          )
          .get(id)!;
        saved = Number(prefix.count);
        if (saved && (prefix.first !== 0 || prefix.last !== saved - 1))
          throw Error("dataset import prefix integrity mismatch");
      }
      active.add(token);
    });
    try {
      let count = 0;
      for await (const value of records) {
        const record = this.prepare([value])[0];
        if (prior) {
          const row = this.db
            .prepare(
              "SELECT r.*,o.source,o.human_key FROM revision_items r JOIN originals o ON o.id=r.id WHERE r.revision=? AND r.n=?",
            )
            .get(id, count);
          if (row) decode(row, "published replay " + count);
          if (
            !row ||
            row.id !== record.id ||
            row.source !== record.source ||
            row.human_key !== record.key ||
            row.digest !== record.digest
          )
            throw Error("published import replay prefix mismatch at record " + count);
        } else
          this.transaction(() => {
            const row = this.db
              .prepare("SELECT * FROM draft_items WHERE revision=? AND n=?")
              .get(id, count);
            if (row) {
              decode(row, "import prefix " + count);
              if (
                row.id !== record.id ||
                row.source !== record.source ||
                row.human_key !== record.key ||
                row.digest !== record.digest
              )
                throw Error("import replay prefix mismatch at record " + count);
            } else {
              if (count < saved) throw Error("dataset import prefix integrity mismatch");
              if (
                this.db
                  .prepare("SELECT 1 FROM draft_items WHERE revision=? AND id=?")
                  .get(id, record.id)
              )
                throw Error("duplicate record identity");
              this.db
                .prepare("INSERT INTO draft_items VALUES(?,?,?,?,?,?,?)")
                .run(id, count, record.id, record.source, record.key, record.text, record.digest);
            }
          });
        count++;
      }
      if (count < (prior?.count ?? saved))
        throw Error("import replay is shorter than saved prefix");
      if (prior) {
        await this.verify(prior.id);
        return prior;
      }
      let bytes = 0;
      const self = this;
      function* lines() {
        for (const row of self.db
          .prepare("SELECT * FROM draft_items WHERE revision=? ORDER BY n")
          .iterate(id)) {
          const line = self.line({
            id: String(row.id),
            source: String(row.source),
            key: String(row.human_key),
            body: decode(row, "draft " + row.id),
          });
          bytes += Buffer.byteLength(line);
          yield line;
        }
      }
      const digest = await publish(path, lines());
      const revision: Revision = {
        id,
        name,
        ...(parent ? { parent } : {}),
        created,
        count,
        hash: digest,
        path,
        bytes,
        ...(run ? { run } : {}),
      };
      this.transaction(() => {
        const collision = this.db
          .prepare(
            "SELECT 1 FROM draft_items d JOIN originals o ON d.id=o.id WHERE d.revision=? AND (d.source!=o.source OR d.human_key!=o.human_key) LIMIT 1",
          )
          .get(id);
        if (collision) throw Error("record identity mismatch");
        this.db
          .prepare("INSERT INTO revisions VALUES(?,?,?,?,?,?,?,?,?)")
          .run(id, name, parent ?? null, created, count, digest, path, bytes, run ?? null);
        this.db
          .prepare(
            "INSERT OR IGNORE INTO originals SELECT id,source,human_key,body,digest FROM draft_items WHERE revision=?",
          )
          .run(id);
        this.db
          .prepare(
            "INSERT INTO revision_items SELECT revision,n,id,body,digest FROM draft_items WHERE revision=?",
          )
          .run(id);
        this.db.prepare("UPDATE drafts SET state='published' WHERE id=?").run(id);
        this.db.prepare("DELETE FROM draft_items WHERE revision=?").run(id);
        if (run)
          this.db
            .prepare("UPDATE runs SET state='completed',revision=?,cursor=total WHERE id=?")
            .run(id, run);
      });
      return revision;
    } catch (error) {
      if (!prior)
        this.db
          .prepare("UPDATE drafts SET state='failed',error=? WHERE id=?")
          .run(String(error), id);
      throw error;
    } finally {
      active.delete(token);
      this.db.prepare("UPDATE drafts SET owner=NULL WHERE id=? AND owner=?").run(id, ownership);
    }
  }
  async capture(
    name: string,
    records: Iterable<RecordInput> | AsyncIterable<RecordInput>,
    options?: Capture,
  ): Promise<Revision> {
    if (
      options !== undefined &&
      (!object(options) ||
        Object.keys(options).some((k) => k !== "id") ||
        typeof options.id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options.id))
    )
      throw Error("capture id must be a UUID");
    return this.publish(name, records, undefined, undefined, options?.id);
  }
  /** Read one verified capture checkpoint without materializing the full saved prefix. */
  checkpoint(id: string, index: number): RecordInput | undefined {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) || !Number.isSafeInteger(index) || index < 0)
      throw Error("invalid capture checkpoint");
    const revision = "rev-" + id;
    const published = this.db.prepare("SELECT id FROM revisions WHERE id=?").get(revision);
    const row = published
      ? this.db.prepare("SELECT r.*,o.source,o.human_key FROM revision_items r JOIN originals o ON o.id=r.id WHERE r.revision=? AND r.n=?").get(revision,index)
      : this.db.prepare("SELECT * FROM draft_items WHERE revision=? AND n=?").get(revision,index);
    if (!row) return undefined;
    return {id:String(row.id),source:String(row.source),key:String(row.human_key),body:decode(row,"capture checkpoint " + index)};
  }
  revision(id: string): Revision {
    const row = this.db.prepare("SELECT * FROM revisions WHERE id=?").get(id);
    if (!row) throw Error("unknown revision: " + id);
    return {
      id: String(row.id),
      name: String(row.name),
      ...(row.parent ? { parent: String(row.parent) } : {}),
      created: String(row.created),
      count: Number(row.count),
      hash: String(row.hash),
      path: String(row.path),
      bytes: Number(row.bytes),
      ...(row.run ? { run: String(row.run) } : {}),
    };
  }
  revisions(): Revision[] {
    return this.db
      .prepare("SELECT id FROM revisions ORDER BY rowid DESC")
      .all()
      .map((r) => this.revision(String(r.id)));
  }
  private item(row: Row): Item {
    const body = decode(row, "revision item " + row.id),
      origin = this.original(String(row.id));
    const annotation = this.db
      .prepare("SELECT body FROM annotations WHERE id=?")
      .get(String(row.id));
    const values = annotation ? (JSON.parse(String(annotation.body)) as Annotation) : {};
    return {
      id: String(row.id),
      source: String(origin.source),
      key: String(origin.human_key),
      body,
      original: decode(origin, "original " + row.id),
      tags: [],
      keywords: [],
      ...values,
    };
  }
  page(id: string, filters: Filters = {}): Page {
    const revision = this.revision(id),
      offset = filters.offset ?? 0,
      limit = filters.limit ?? 50;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 1_000_000 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw Error("invalid dataset page bounds");
    for (const key of ["query", "source", "tag", "keyword", "category"] as const)
      if (
        filters[key] !== undefined &&
        (typeof filters[key] !== "string" || filters[key]!.length > 4096)
      )
        throw Error("invalid dataset filter");
    if (
      filters.rating !== undefined &&
      (!Number.isInteger(filters.rating) || filters.rating < 0 || filters.rating > 5)
    )
      throw Error("invalid rating");
    const clauses = ["r.revision=?"],
      params: (string | number)[] = [id];
    if (filters.query?.trim()) {
      clauses.push("instr(lower(r.body||o.source||o.human_key||coalesce(a.body,'')),lower(?))>0");
      params.push(filters.query.trim());
    }
    if (filters.source !== undefined) {
      clauses.push("o.source=?");
      params.push(filters.source);
    }
    for (const [key, field] of [
      ["tag", "tags"],
      ["keyword", "keywords"],
    ] as const)
      if (filters[key] !== undefined) {
        clauses.push(`EXISTS(SELECT 1 FROM json_each(a.body,'$.${field}') WHERE value=?)`);
        params.push(filters[key]!);
      }
    if (filters.category !== undefined) {
      clauses.push("json_extract(a.body,'$.category')=?");
      params.push(filters.category);
    }
    if (filters.rating !== undefined) {
      clauses.push("json_extract(a.body,'$.rating')=?");
      params.push(filters.rating);
    }
    const query =
      " FROM revision_items r JOIN originals o ON o.id=r.id LEFT JOIN annotations a ON a.id=r.id WHERE " +
      clauses.join(" AND ");
    const total = Number(this.db.prepare("SELECT count(*) n" + query).get(...params)!.n);
    const rows = this.db
      .prepare("SELECT r.*" + query + " ORDER BY r.n LIMIT ? OFFSET ?")
      .all(...params, limit, offset);
    return {
      revision,
      records: rows.map((row) => this.item(row)),
      total,
      offset,
      limit,
      more: offset + rows.length < total,
    };
  }
  annotate(id: string, values: Annotation): void {
    this.original(id);
    if (
      !object(values) ||
      Object.keys(values).some(
        (k) => !["tags", "keywords", "summary", "category", "rating"].includes(k),
      )
    )
      throw Error("invalid annotation");
    for (const key of ["tags", "keywords"] as const)
      if (
        values[key] !== undefined &&
        (!Array.isArray(values[key]) ||
          values[key]!.length > 1000 ||
          values[key]!.some((v) => typeof v !== "string" || !v.trim() || v.length > 4096))
      )
        throw Error("invalid " + key);
    for (const key of ["summary", "category"] as const)
      if (
        values[key] !== undefined &&
        (typeof values[key] !== "string" || values[key]!.length > 1_000_000)
      )
        throw Error("invalid " + key);
    if (
      values.rating !== undefined &&
      (!Number.isInteger(values.rating) || values.rating < 0 || values.rating > 5)
    )
      throw Error("invalid rating");
    const prior = this.db.prepare("SELECT body FROM annotations WHERE id=?").get(id);
    const merged = { ...(prior ? JSON.parse(String(prior.body)) : {}), ...values };
    for (const key of ["tags", "keywords"] as const)
      if (merged[key]) merged[key] = [...new Set(merged[key])];
    this.db
      .prepare(
        "INSERT INTO annotations VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(id, json(merged));
  }
  link(from: string, to: string, kind: string): void {
    this.original(from);
    this.original(to);
    text(kind, "link kind");
    this.db.prepare("INSERT OR IGNORE INTO links VALUES(?,?,?)").run(from, to, kind);
  }
  links(id: string): Link[] {
    this.original(id);
    return this.db
      .prepare(
        "SELECT origin,target,kind FROM links WHERE origin=? OR target=? ORDER BY origin,target,kind",
      )
      .all(id, id)
      .map((r) => ({ from: String(r.origin), to: String(r.target), kind: String(r.kind) }));
  }
  async edit(parent: string, id: string, body: unknown): Promise<Revision> {
    json(body);
    const revision = this.revision(parent);
    if (!this.db.prepare("SELECT 1 FROM revision_items WHERE revision=? AND id=?").get(parent, id))
      throw Error("record is absent from parent revision");
    const self = this;
    function* records() {
      for (const row of self.db
        .prepare("SELECT * FROM revision_items WHERE revision=? ORDER BY n")
        .iterate(parent)) {
        const item = self.item(row);
        yield {
          id: item.id,
          source: item.source,
          key: item.key,
          body: item.id === id ? body : item.body,
        };
      }
    }
    return this.publish(revision.name + " edit", records(), parent);
  }
  start(parent: string, plan: Step[], options: Options = {}): Run {
    const revision = this.revision(parent),
      validated = validateSteps(plan),
      body = json(validated),
      id = options.id??randomUUID();
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))throw Error('dataset run identity must be a UUID');
    if (options.pauseOnFailure !== undefined && typeof options.pauseOnFailure !== "boolean")
      throw Error("invalid pauseOnFailure");
    return this.transaction(()=>{
      const prior=this.db.prepare('SELECT * FROM runs WHERE id=?').get(id);
      if(prior){
        if(prior.parent!==parent||prior.steps!==body||prior.pause!==(options.pauseOnFailure===false?0:1))throw Error('dataset run identity has different parameters');
        return this.readRun(id);
      }
      this.db.prepare("INSERT INTO runs VALUES(?,?,NULL,'running',?,?,?,0,?,NULL)").run(id,parent,body,hash(body),options.pauseOnFailure===false?0:1,revision.count);
      return this.readRun(id);
    });
  }
  private runRow(id: string): Row {
    const row = this.db.prepare("SELECT * FROM runs WHERE id=?").get(id);
    if (!row) throw Error("unknown run: " + id);
    if (typeof row.steps !== "string" || hash(row.steps) !== row.step_hash)
      throw Error("dataset steps integrity mismatch");
    return row;
  }
  private readRun(id: string): Run {
    const row = this.runRow(id),
      report: Report = {
        processed: 0,
        accepted: 0,
        excluded: 0,
        duplicate: 0,
        quarantined: 0,
        failed: 0,
        corrected: 0,
      };
    for (const result of this.db
      .prepare("SELECT state,count(*) n FROM run_items WHERE run=? GROUP BY state")
      .all(id)) {
      const key = String(result.state) as keyof Omit<Report, "processed" | "corrected">;
      if (!["accepted", "excluded", "duplicate", "quarantined", "failed"].includes(key))
        throw Error("dataset disposition integrity mismatch");
      report[key] = Number(result.n);
      report.processed += Number(result.n);
    }
    report.corrected = Number(
      this.db.prepare("SELECT count(DISTINCT record) n FROM corrections WHERE run=?").get(id)!.n,
    );
    return {
      id,
      parent: String(row.parent),
      ...(row.revision ? { revision: String(row.revision) } : {}),
      state: row.state as Run["state"],
      steps: JSON.parse(String(row.steps)),
      pauseOnFailure: !!row.pause,
      cursor: Number(row.cursor),
      total: Number(row.total),
      report,
    };
  }
  runs(): Run[] {
    return this.db
      .prepare("SELECT id FROM runs ORDER BY rowid DESC")
      .all()
      .map((r) => this.readRun(String(r.id)));
  }
  async run(parent: string, plan: Step[], options: Options = {}): Promise<Run> {
    return this.execute(this.start(parent, plan, options).id);
  }
  pause(id: string): void {
    const row = this.runRow(id);
    if (row.state !== "completed")
      this.db.prepare("UPDATE runs SET state='paused' WHERE id=?").run(id);
  }
  private ownerAlive(value: unknown): boolean {
    if (!value) return false;
    const stored = JSON.parse(String(value)) as { pid: number; token: string; proof?: string };
    if (stored.pid === process.pid) return active.has(stored.token);
    return !!stored.proof && proof(stored.pid,this.observer) === stored.proof;
  }
  async resume(id: string): Promise<Run> {
    this.transaction(() => {
      const row = this.runRow(id);
      if (row.state === "completed") return;
      if (this.ownerAlive(row.owner)) throw Error("dataset run is active");
      if (this.db.prepare("SELECT 1 FROM failures WHERE run=? AND state='open' LIMIT 1").get(id))
        throw Error("unresolved failure: correct the record before resuming");
      this.db.prepare("UPDATE runs SET state='running',owner=NULL WHERE id=?").run(id);
    });
    return this.execute(id);
  }
  async execute(id: string): Promise<Run> {
    const token = randomUUID(),
      ownership = owner(token,this.observer);
    let claimed = false;
    this.transaction(() => {
      const row = this.runRow(id);
      if (row.state !== "running") return;
      if (this.ownerAlive(row.owner)) throw Error("dataset run is active");
      this.db.prepare("UPDATE runs SET owner=? WHERE id=?").run(ownership, id);
      active.add(token);
      claimed = true;
    });
    if (!claimed) return this.readRun(id);
    try {
      const initial = this.readRun(id);
      for (;;) {
        const row = this.runRow(id);
        if (row.state !== "running") return this.readRun(id);
        const run = { ...initial, cursor: Number(row.cursor) };
        if (run.cursor >= run.total) {
          const self = this;
          function* records() {
            for (const row of self.db
              .prepare(
                "SELECT i.*,o.source,o.human_key FROM run_items i JOIN originals o ON o.id=i.id WHERE i.run=? AND i.state='accepted' ORDER BY i.n",
              )
              .iterate(id))
              yield {
                id: String(row.id),
                source: String(row.source),
                key: String(row.human_key),
                body: decode(row, "run output " + row.id),
              };
          }
          await this.publish(this.revision(run.parent).name + " result", records(), run.parent, id);
          return this.readRun(id);
        }
        this.record(run);
        await setImmediate();
      }
    } catch (error) {
      if (!this.closed)
        this.db.prepare("UPDATE runs SET state='paused' WHERE id=? AND state!='completed'").run(id);
      throw error;
    } finally {
      active.delete(token);
      if (!this.closed)
        this.db.prepare("UPDATE runs SET owner=NULL WHERE id=? AND owner=?").run(id, ownership);
    }
  }
  private record(run: Run): void {
    this.transaction(() => {
      const current = this.runRow(run.id);
      if (current.state !== "running" || Number(current.cursor) !== run.cursor) return;
      const row = this.db
        .prepare("SELECT * FROM revision_items WHERE revision=? AND n=?")
        .get(run.parent, run.cursor);
      if (!row) throw Error("dataset parent integrity mismatch: missing record");
      const id = String(row.id),
        correction = this.db
          .prepare(
            "SELECT body,digest FROM corrections WHERE run=? AND record=? ORDER BY n DESC LIMIT 1",
          )
          .get(run.id, id);
      let body = decode(correction ?? row, "input " + id),
        state: Outcome["state"] = "accepted",
        failure: { step: number; reason: string; op: Step["op"] } | undefined;
      const seen: { step: number; key: string }[] = [];
      let stopped: number | undefined, reason: string | undefined;
      for (let i = 0; i < run.steps.length; i++) {
        const step = run.steps[i];
        try {
          switch (step.op) {
            case "set":
              body = change(body, step.path, step.value);
              break;
            case "remove":
              body = change(body, step.path, null, true);
              break;
            case "include":
            case "exclude":
              if (matches(body, step) !== (step.op === "include")) {
                state = "excluded";
                reason = step.op + " filter";
              }
              break;
            case "dedupe": {
              const key = hash(
                step.paths ? json(step.paths.map((path) => at(body, path))) : json(body),
              );
              if (
                this.db
                  .prepare("SELECT 1 FROM seen WHERE run=? AND step=? AND key=?")
                  .get(run.id, i, key)
              ) {
                state = "duplicate";
                reason = "duplicate of earlier accepted record";
              } else seen.push({ step: i, key });
              break;
            }
            case "check": {
              const reason = check(body, step);
              if (reason) {
                state = step.onFailure === "quarantine" ? "quarantined" : "failed";
                failure = { step: i, op: step.op, reason };
              }
              break;
            }
            case "validate":
              if (!accepts(step.schema, body)) {
                state = step.onFailure === "quarantine" ? "quarantined" : "failed";
                failure = {
                  step: i,
                  op: step.op,
                  reason: "schema validation failed at " + diagnostic(step.schema, body),
                };
              }
              break;
          }
        } catch (error) {
          state = "failed";
          failure = { step: i, op: step.op, reason: String(error) };
        }
        if (state !== "accepted") {
          stopped = i;
          reason = failure?.reason ?? reason;
          break;
        }
      }
      const value = json(body);
      this.db
        .prepare(
          "INSERT INTO run_items VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(run,n) DO UPDATE SET state=excluded.state,body=excluded.body,digest=excluded.digest,step=excluded.step,reason=excluded.reason",
        )
        .run(run.id, run.cursor, id, state, value, hash(value), stopped ?? null, reason ?? null);
      if (state === "accepted")
        for (const key of seen)
          this.db
            .prepare("INSERT INTO seen VALUES(?,?,?,?)")
            .run(run.id, key.step, key.key, run.cursor);
      this.db
        .prepare(
          "UPDATE failures SET state='resolved' WHERE run=? AND record=? AND state='corrected'",
        )
        .run(run.id, id);
      if (failure)
        this.db
          .prepare("INSERT INTO failures VALUES(?,?,?,?,?,?,?,?,?,?)")
          .run(
            randomUUID(),
            run.id,
            id,
            run.cursor,
            failure.step,
            failure.op,
            failure.reason,
            value,
            hash(value),
            run.pauseOnFailure ? "open" : state === "quarantined" ? "quarantined" : "open",
          );
      const pause = !!failure && run.pauseOnFailure;
      this.db
        .prepare("UPDATE runs SET cursor=?,state=? WHERE id=?")
        .run(pause ? run.cursor : run.cursor + 1, pause ? "paused" : "running", run.id);
    });
  }
  review(id:string,kind:'failures'|'outcomes',bounds:{offset?:number;limit?:number}={}){
    this.runRow(id);const offset=bounds.offset??0,limit=bounds.limit??100;
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>1000)throw Error('audit page bounds');
    const table=kind==='failures'?'failures':kind==='outcomes'?'run_items':null;
    if(!table)throw Error('unknown audit kind');
    const total=Number(this.db.prepare('SELECT count(*) n FROM '+table+' WHERE run=?').get(id)!.n);
    return {offset,limit,total,more:offset+limit<total,records:kind==='failures'?this.failures(id,{offset,limit}):this.outcomes(id,{offset,limit})};
  }
  failures(id: string,bounds?:{offset:number;limit:number}): Failure[] {
    this.runRow(id);
    if(bounds&&(!Number.isSafeInteger(bounds.offset)||bounds.offset<0||!Number.isSafeInteger(bounds.limit)||bounds.limit<1||bounds.limit>1000))throw Error('audit page bounds');
    return this.db
      .prepare("SELECT * FROM failures WHERE run=? ORDER BY rowid LIMIT ? OFFSET ?")
      .all(id,bounds?.limit??1000,bounds?.offset??0)
      .map((row) => ({
        id: String(row.id),
        runId: id,
        recordId: String(row.record),
        step: Number(row.step),
        op: row.op as Step["op"],
        reason: String(row.reason),
        body: decode(row, "failure " + row.id),
        state: row.state as Failure["state"],
      }));
  }
  outcomes(id: string,bounds?:{offset:number;limit:number}): Outcome[] {
    this.runRow(id);
    if(bounds&&(!Number.isSafeInteger(bounds.offset)||bounds.offset<0||!Number.isSafeInteger(bounds.limit)||bounds.limit<1||bounds.limit>1000))throw Error('audit page bounds');
    return this.db
      .prepare("SELECT * FROM run_items WHERE run=? ORDER BY n LIMIT ? OFFSET ?")
      .all(id,bounds?.limit??1000,bounds?.offset??0)
      .map((row) => ({
        recordId: String(row.id),
        index: Number(row.n),
        state: row.state as Outcome["state"],
        body: decode(row, "outcome " + row.id),
        ...(row.step !== null ? { step: Number(row.step) } : {}),
        ...(row.reason ? { reason: String(row.reason) } : {}),
      }));
  }
  correct(id: string, recordId: string, body: unknown): void {
    const value = json(body);
    this.transaction(() => {
      const run = this.runRow(id);
      if (run.state !== "paused") throw Error("corrections require a paused run");
      if (this.ownerAlive(run.owner)) throw Error("dataset run is active");
      const failure = this.db
        .prepare(
          "SELECT * FROM failures WHERE run=? AND record=? AND state IN ('open','corrected') AND n=? ORDER BY rowid DESC LIMIT 1",
        )
        .get(id, recordId, Number(run.cursor));
      if (!failure) throw Error("no unresolved failure for this record");
      this.db
        .prepare("INSERT INTO corrections(run,record,body,digest,created) VALUES(?,?,?,?,?)")
        .run(id, recordId, value, hash(value), new Date().toISOString());
      this.db
        .prepare("UPDATE failures SET state='corrected' WHERE run=? AND record=? AND state='open'")
        .run(id, recordId);
    });
  }
  async verify(id: string): Promise<Integrity> {
    const revision = this.revision(id),
      dbHash = createHash("sha256");
    let bytes = 0,
      count = 0;
    for (const row of this.db
      .prepare("SELECT * FROM revision_items WHERE revision=? ORDER BY n")
      .iterate(id)) {
      if (Number(row.n) !== count++) throw Error("dataset revision integrity mismatch");
      const record = this.item(row),
        line = this.line(record);
      bytes += Buffer.byteLength(line);
      dbHash.update(line);
    }
    if (
      count !== revision.count ||
      bytes !== revision.bytes ||
      dbHash.digest("hex") !== revision.hash
    )
      throw Error("dataset revision integrity mismatch");
    if (revision.path !== join(this.root, "revisions", revision.id + ".jsonl"))
      throw Error("dataset mirror path integrity mismatch");
    guarded(revision.path, "file");
    const fileHash = createHash("sha256");
    let fileBytes = 0;
    try {
      for await (const chunk of createReadStream(revision.path)) {
        fileBytes += chunk.length;
        fileHash.update(chunk);
      }
    } catch {
      throw Error("dataset mirror integrity mismatch: unavailable");
    }
    if (fileBytes !== bytes || fileHash.digest("hex") !== revision.hash)
      throw Error("dataset mirror integrity mismatch");
    return { records: count, bytes, hash: revision.hash, intact: true };
  }
  close(): void {
    if (this.closed) return;
    const owners = this.db
      .prepare(
        "SELECT owner FROM runs WHERE owner IS NOT NULL UNION ALL SELECT owner FROM drafts WHERE owner IS NOT NULL",
      )
      .all();
    if (
      owners.some((row) => {
        const value = JSON.parse(String(row.owner)) as { token: string };
        return active.has(value.token);
      })
    )
      throw Error("cannot close an executing dataset");
    this.db.close();
    this.closed = true;
  }
}
