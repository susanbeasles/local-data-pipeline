import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type Source = {
  id: string;
  name: string;
  kind: "intake" | "personal" | "git" | "pipeline" | "sqlite";
  root: string;
  pointer?: string;
  progress?: string;
  processFile?: string;
  database?: string;
};
export type Metric = {
  id: string;
  label: string;
  value: string | number | boolean | null;
  unit?: string;
  observedAt: string;
  origin: { file: string; table?: string; field?: string; query?: string; code?: string };
  meaning: string;
  actions: string[];
};
export type SourceStatus = {
  id: string;
  name: string;
  kind: Source["kind"];
  root: string;
  alive: boolean | null;
  phase: string;
  stale: boolean;
  observedAt: string;
  updatedAt: string | null;
  ageSeconds: number | null;
  metrics: Metric[];
  errors: string[];
};
export type ColumnInfo = { name: string; type: string; nullable: boolean; primary: number };
export type TableInfo = {
  name: string;
  columns: ColumnInfo[];
  count: number;
  key: string[];
  mirror: boolean;
};
export type PageOptions = { offset?: number; limit?: number; query?: string };
export type RowView = {
  id: string;
  key: string;
  value: Record<string, unknown>;
  truncated: boolean;
};
export type Page = {
  source: string;
  table: string;
  offset: number;
  limit: number;
  total: number;
  rows: RowView[];
  truncated: boolean;
};
export type MirrorView = {
  status: "match" | "mismatch" | "missing" | "unavailable" | "limited";
  value?: unknown;
  path?: string;
  reason?: string;
};
export type Digest = {
  sqlite: string;
  scope: "record" | "preview";
  jsonl?: string;
  expected?: string;
  valid?: boolean;
};
export type RecordView = {
  id: string;
  source: string;
  table: string;
  key: string;
  sqlite: Record<string, unknown>;
  jsonl: MirrorView;
  digest: Digest;
  truncated: boolean;
};
export type CatalogRecord = { id: string; key: string; sqlite: Record<string, unknown> };
export type CatalogOptions = {
  staleSeconds?: number;
  previewBytes?: number;
  mirrorBytes?: number;
  mirrorLines?: number;
};

type Metadata = Record<string, unknown>;
type Resolved = {
  source: Source;
  root: string;
  database: string;
  progress: string;
  processFile: string;
  owner: Metadata;
  checkpoint: Metadata;
  updatedAt: string | null;
  errors: string[];
};
type Table = TableInfo & { rowid?: string };
type Cell = { type: "null" | "integer" | "real" | "text" | "blob"; value: string };
type Key = {
  v: 1;
  source: string;
  table: string;
  database: string;
  columns: string[];
  values: Cell[];
  rowid?: Cell;
};
type Selector = { where: string; values: SQLInputValue[] };
type Preview = {
  row: Record<string, unknown>;
  truncated: boolean;
  keyValues: unknown[];
  rowid?: unknown;
};
type MirrorRead = { path: string; bytes: Buffer; complete: boolean; changed: boolean };
const exec = promisify(execFile);
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const inside = (root: string, path: string) => path === root || path.startsWith(root + sep);
const overlap = (a: string, b: string) => inside(a, b) || inside(b, a);
const text = (value: unknown) => (typeof value === "string" && value.length ? value : undefined);
const object = (value: unknown): value is Metadata =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const date = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonical(parent), path.slice(parent.length));
  }
}

async function metadata(path: string): Promise<{ value: Metadata; time: string }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 65536) throw Error("Metadata exceeds read bound");
    const buffer = Buffer.alloc(Math.min(info.size + 1, 65537));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 65536) throw Error("Metadata exceeds read bound");
    let value: unknown;
    try {
      value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    } catch {
      throw Error("Invalid JSON metadata");
    }
    if (!object(value)) throw Error("Metadata requires an object");
    return { value, time: info.mtime.toISOString() };
  } finally {
    await file.close();
  }
}

function statement(db: DatabaseSync, sql: string): StatementSync {
  const query = db.prepare(sql);
  query.setReadBigInts(true);
  return query;
}

function normalized(value: unknown): unknown {
  if (typeof value === "bigint")
    return value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER
      ? Number(value)
      : value.toString();
  if (value instanceof Uint8Array)
    return {
      encoding: "base64",
      bytes: value.byteLength,
      base64: Buffer.from(value).toString("base64"),
    };
  return value;
}

function encodeCell(value: unknown): Cell {
  if (value === null) return { type: "null", value: "" };
  if (typeof value === "bigint") return { type: "integer", value: value.toString() };
  if (typeof value === "number") return { type: "real", value: String(value) };
  if (typeof value === "string") return { type: "text", value };
  if (value instanceof Uint8Array)
    return { type: "blob", value: Buffer.from(value).toString("base64") };
  throw Error("Unsupported record key");
}

function decodeCell(cell: unknown): SQLInputValue {
  if (!object(cell) || typeof cell.value !== "string") throw Error("Invalid record key");
  switch (cell.type) {
    case "null":
      return null;
    case "integer":
      if (/^-?\d{1,20}$/.test(cell.value)) return BigInt(cell.value);
      break;
    case "real": {
      const n = Number(cell.value);
      if (Number.isFinite(n)) return n;
      break;
    }
    case "text":
      return cell.value;
    case "blob": {
      const bytes = Buffer.from(cell.value, "base64");
      if (bytes.toString("base64") === cell.value) return bytes;
      break;
    }
  }
  throw Error("Invalid record key");
}

/** Read-only observations. Every request resolves the current pointer and opens a fresh reader. */
export class Catalog {
  private registrations: Source[];
  private state: string;
  private options: Required<CatalogOptions>;
  constructor(sources: Source[], state: string, options: CatalogOptions = {}) {
    this.state = resolve(state);
    this.registrations = sources.map((source) => ({ ...source, root: resolve(source.root) }));
    if (
      new Set(sources.map((source) => source.id)).size !== sources.length ||
      sources.some((source) => !source.id || !source.name)
    )
      throw Error("Source identifiers must be unique and named");
    for (const source of this.registrations)
      if (overlap(source.root, this.state)) throw Error("Source and operator state overlap");
    this.options = {
      staleSeconds: 300,
      previewBytes: 16384,
      mirrorBytes: 2 * 1024 ** 2,
      mirrorLines: 4096,
      ...options,
    };
    for (const key of ["staleSeconds", "previewBytes", "mirrorBytes", "mirrorLines"] as const) {
      const value = this.options[key];
      if (
        !Number.isSafeInteger(value) ||
        value < 1 ||
        value >
          (key === "staleSeconds" ? 365 * 86400 : key === "mirrorLines" ? 100000 : 16 * 1024 ** 2)
      )
        throw Error("Invalid catalog bound");
    }
  }

  private async resolve(id: string): Promise<Resolved> {
    const source = this.registrations.find((item) => item.id === id);
    if (!source) throw Error("Unknown source");
    let root = source.root,
      pointer: Metadata = {},
      config: Metadata = {};
    const errors: string[] = [];
    const pointerFile = source.pointer && resolve(source.root, source.pointer);
    if (pointerFile) pointer = (await metadata(pointerFile)).value;
    const control = pointerFile ? dirname(pointerFile) : root;
    let progress = resolve(
      control,
      source.progress ??
        text(pointer.progress) ??
        (pointer.configs ? "progress.json" : join(root, "progress.json")),
    );
    let checkpoint: Metadata = {},
      updatedAt: string | null = null;
    const readProgress = async () => {
      try {
        const read = await metadata(progress);
        checkpoint = read.value;
        updatedAt = date(
          checkpoint.updatedAt ?? checkpoint.updated ?? checkpoint.at ?? checkpoint.observedAt,
        );
        if (!updatedAt) {
          updatedAt = read.time;
          errors.push("Checkpoint timestamp unavailable; age uses file modification time");
        }
      } catch (error) {
        errors.push(
          errorCode(error) === "ENOENT"
            ? "Checkpoint unavailable: file missing"
            : "Checkpoint unavailable: invalid or unreadable metadata",
        );
      }
    };
    if (object(pointer.configs)) {
      await readProgress();
      const selected = text(checkpoint.pile) ?? Object.keys(pointer.configs)[0];
      const file = selected && text(pointer.configs[selected]);
      if (!file) throw Error("Pointer has no selected partition configuration");
      config = (await metadata(resolve(control, file))).value;
    }
    const selectedRoot =
      text(pointer.root) ?? text(pointer.work) ?? text(config.work) ?? text(config.root);
    if (selectedRoot) root = resolve(control, selectedRoot);
    const [actualRoot, actualState] = await Promise.all([canonical(root), canonical(this.state)]);
    if (overlap(actualRoot, actualState)) throw Error("Resolved source and operator state overlap");
    // Preserve the registered spelling in provenance while checking real paths at each read.
    if (!object(pointer.configs)) {
      progress = resolve(
        root,
        source.progress ??
          text(pointer.progress) ??
          text(config.progress) ??
          (source.kind === "pipeline" ? "state/phase.json" : "progress.json"),
      );
      await readProgress();
    }
    let owner: Metadata = { ...checkpoint, ...pointer };
    const processFile = source.processFile ?? text(pointer.processFile);
    const ownerFile = processFile ? resolve(control, processFile) : (pointerFile ?? progress);
    if (processFile) {
      try {
        owner = { ...owner, ...(await metadata(ownerFile)).value };
      } catch {
        owner = {};
        errors.push("Process identity metadata unavailable");
      }
    }
    let database = source.database ?? text(pointer.database) ?? text(config.database);
    if (!database) {
      const candidates =
        source.kind === "intake"
          ? ["state/intake.sqlite"]
          : source.kind === "git"
            ? ["git.sqlite"]
            : source.kind === "pipeline"
              ? ["state/pipeline.sqlite"]
              : [
                  "preservation.sqlite",
                  "inventory.sqlite",
                  "state/intake.sqlite",
                  "git.sqlite",
                  "state/pipeline.sqlite",
                  "data.sqlite",
                ];
      for (const candidate of candidates) {
        try {
          if ((await stat(resolve(root, candidate))).isFile()) {
            database = candidate;
            break;
          }
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
      }
      database ??= candidates[0];
    }
    const path = resolve(root, database);
    if (!inside(root, path) || !inside(actualRoot, await canonical(path)))
      throw Error("Database escapes source root");
    return {
      source,
      root,
      database: path,
      progress,
      processFile: ownerFile,
      owner,
      checkpoint,
      updatedAt,
      errors,
    };
  }

  /** Resolve live registrations without opening or sampling their databases. */
  async roots(): Promise<string[]> {
    return Promise.all(
      this.registrations.map(async (source) => (await this.resolve(source.id)).root),
    );
  }
  /** Freeze pointer-selected source identity for an independently running worker. */
  async bindings(): Promise<Source[]> {
    return Promise.all(
      this.registrations.map(async (registration) => {
        const source = await this.resolve(registration.id);
        return {
          ...registration,
          root: await realpath(source.root),
          database: await canonical(source.database),
          pointer: undefined,
          progress: undefined,
          processFile: undefined,
        };
      }),
    );
  }

  private async reader(source: Resolved): Promise<DatabaseSync> {
    const actualRoot = await realpath(source.root),
      path = await realpath(source.database);
    if (!inside(actualRoot, path)) throw Error("Database escapes source root");
    if (!(await stat(path)).isFile()) throw Error("Database unavailable: regular file required");
    const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000");
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private table(db: DatabaseSync, name: string): Table {
    const schema = db
      .prepare(
        "SELECT name,sql FROM sqlite_schema WHERE type='table' AND name=? AND name NOT LIKE 'sqlite_%'",
      )
      .get(name);
    if (!schema) throw Error("Unknown table");
    const columns = db
      .prepare("PRAGMA table_xinfo(" + quote(name) + ")")
      .all()
      .filter((column) => column.hidden !== 1)
      .map((column) => ({
        name: String(column.name),
        type: String(column.type),
        nullable: !column.notnull,
        primary: Number(column.pk),
      }));
    const primary = columns
      .filter((column) => column.primary)
      .sort((a, b) => a.primary - b.primary)
      .map((column) => column.name);
    const rowid = !/\bWITHOUT\s+ROWID\b/i.test(String(schema.sql))
      ? ["_rowid_", "rowid", "oid"].find(
          (field) => !columns.some((column) => column.name.toLowerCase() === field),
        )
      : undefined;
    const count = Number(db.prepare("SELECT COUNT(*) n FROM " + quote(name)).get()!.n);
    return {
      name,
      columns,
      count,
      key: primary.length ? primary : rowid ? [rowid] : [],
      rowid,
      mirror: ["receipts", "objects", "entries", "content_sources"].includes(name),
    };
  }

  private list(db: DatabaseSync): Table[] {
    return db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => this.table(db, String(row.name)));
  }

  private async alive(source: Resolved): Promise<{ value: boolean | null; reason: string }> {
    const pid = source.owner.pid ?? source.owner.controllerPid;
    if (!Number.isSafeInteger(pid) || Number(pid) < 1)
      return { value: null, reason: "No process identifier is registered" };
    let line: string;
    try {
      line = (
        await exec("/bin/ps", ["-p", String(pid), "-o", "lstart=,stat=,command="], {
          maxBuffer: 65536,
          timeout: 2000,
          env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
        })
      ).stdout.trim();
    } catch (error) {
      if ((error as { code?: unknown }).code === 1)
        return { value: false, reason: "Registered process is absent" };
      return { value: null, reason: "Process observation unavailable" };
    }
    const match = /^(.{24})\s+(\S+)\s+(.+)$/.exec(line);
    if (!match) return { value: null, reason: "Process observation unavailable" };
    if (match[2].startsWith("Z")) return { value: false, reason: "Registered process is a zombie" };
    const birth = text(source.owner.birth),
      command = text(source.owner.command),
      entry = text(source.owner.entry);
    if (
      (birth && birth.trim() !== match[1].trim()) ||
      (command && command !== match[3]) ||
      (entry && !match[3].split(/\s+/).includes(entry))
    ) {
      source.errors.push("Process identity differs from the registered PID metadata");
      return { value: false, reason: "PID exists but registered process identity differs" };
    }
    if (!(birth && command) && !entry) {
      source.errors.push("Process identity cannot be established from a PID alone");
      return {
        value: null,
        reason: "PID exists; birth and command or an entry path are required to verify identity",
      };
    }
    return {
      value: true,
      reason:
        entry && !(birth && command)
          ? "Observed PID command contains the registered entry; process birth was not registered"
          : "Observed process birth and command match the registered identity",
    };
  }

  async sources(): Promise<SourceStatus[]> {
    return Promise.all(
      this.registrations.map(async (registered) => {
        const observedAt = new Date().toISOString();
        let source: Resolved;
        try {
          source = await this.resolve(registered.id);
        } catch {
          return {
            id: registered.id,
            name: registered.name,
            kind: registered.kind,
            root: registered.root,
            alive: null,
            phase: "unavailable",
            stale: true,
            observedAt,
            updatedAt: null,
            ageSeconds: null,
            metrics: [],
            errors: [
              "Source unavailable: pointer, database path, or state boundary could not be resolved",
            ],
          };
        }
        const metrics: Metric[] = [],
          process = await this.alive(source);
        const add = (metric: Omit<Metric, "observedAt" | "actions">) =>
          metrics.push({
            ...metric,
            observedAt,
            actions: ["explain", ...(metric.origin.table ? ["browse"] : [])],
          });
        add({
          id: "process.alive",
          label: "Process alive",
          value: process.value,
          origin: {
            file: source.processFile,
            field: "pid",
            code: "ps -p PID -o lstart=,stat=,command=",
          },
          meaning: process.reason + ". Independent of the checkpoint phase and age.",
        });
        let db: DatabaseSync | undefined;
        try {
          db = await this.reader(source);
          for (const table of this.list(db)) {
            const responses = table.name === "receipts";
            add({
              id: `table.${table.name}.rows`,
              label: responses ? "Stored API responses" : `${table.name} rows`,
              value: table.count,
              unit: "rows",
              origin: {
                file: source.database,
                table: table.name,
                query: "SELECT COUNT(*) FROM " + quote(table.name),
              },
              meaning: responses
                ? "Live committed connector response rows in SQLite. One response can contain an API page, details, or an error; this is not a file or entity count."
                : `Live committed SQLite rows in ${table.name}. Row counts describe this table; they do not imply verified files, mirror integrity, or active work.`,
            });
            if (table.columns.some((column) => column.name === "state")) {
              for (const row of db
                .prepare(
                  "SELECT state,COUNT(*) n FROM " + quote(table.name) + " GROUP BY state LIMIT 100",
                )
                .all()) {
                if (typeof row.state !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(row.state))
                  continue;
                add({
                  id: `table.${table.name}.state.${row.state}`,
                  label: `${table.name}: ${row.state}`,
                  value: Number(row.n),
                  unit: "rows",
                  origin: {
                    file: source.database,
                    table: table.name,
                    field: "state",
                    query: "SELECT COUNT(*) FROM " + quote(table.name) + " WHERE state=?",
                  },
                  meaning: `Live committed rows whose stored state is ${row.state}. A stored state is not evidence that a collector process is alive.`,
                });
              }
            }
          }
        } catch {
          source.errors.push(
            "SQLite observations unavailable: database missing, busy, invalid, or unreadable",
          );
        } finally {
          db?.close();
        }
        let checkpointFields = 0;
        const checkpointMetrics = (value: Metadata, prefix = "", depth = 0) => {
          for (const [name, item] of Object.entries(value)) {
            if (checkpointFields >= 128) break;
            if (
              !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) ||
              ["pid", "controllerPid"].includes(name)
            )
              continue;
            const field = prefix + name;
            if (object(item) && depth < 2) {
              checkpointMetrics(item, field + ".", depth + 1);
              continue;
            }
            if (typeof item !== "boolean" && !(typeof item === "number" && Number.isFinite(item)))
              continue;
            const response =
              ["requests", "pending", "accepted", "failed", "unpublished"].includes(field) &&
              ["intake", "git"].includes(source.source.kind);
            add({
              id: "checkpoint." + field,
              label: "Checkpoint " + field,
              value: item,
              origin: { file: source.progress, field },
              meaning: response
                ? "Last checkpoint's request/API-response counter. Requests may represent pages, details, or errors; this is not a file or entity total and may differ from live SQLite rows."
                : "Last checkpoint's reported field. Its meaning and unit depend on the collector; it is not a live SQLite count or proof of active work.",
            });
            checkpointFields++;
          }
        };
        checkpointMetrics(source.checkpoint);
        const ageSeconds = source.updatedAt
          ? Math.max(0, Math.floor((Date.now() - Date.parse(source.updatedAt)) / 1000))
          : null;
        add({
          id: "checkpoint.age",
          label: "Checkpoint age",
          value: ageSeconds,
          unit: "seconds",
          origin: { file: source.progress, field: "updatedAt|updated|at" },
          meaning:
            "Seconds since the checkpoint timestamp, or file modification time when explicitly reported as a fallback. Missing checkpoints have an unknown age. Process liveness is observed separately.",
        });
        return {
          id: registered.id,
          name: registered.name,
          kind: registered.kind,
          root: source.root,
          alive: process.value,
          phase:
            text(source.checkpoint.phase) ??
            text(source.checkpoint.state) ??
            (source.checkpoint.complete === true ? "complete" : "unknown"),
          stale: ageSeconds === null || ageSeconds > this.options.staleSeconds,
          observedAt,
          updatedAt: source.updatedAt,
          ageSeconds,
          metrics,
          errors: source.errors,
        };
      }),
    );
  }

  async tables(sourceId: string): Promise<TableInfo[]> {
    const source = await this.resolve(sourceId),
      db = await this.reader(source);
    try {
      return this.list(db).map(({ rowid: _rowid, ...table }) => table);
    } finally {
      db.close();
    }
  }

  private token(source: Resolved, table: Table, values: unknown[], rowid?: unknown): string {
    const key: Key = {
      v: 1,
      source: source.source.id,
      table: table.name,
      database: sha(source.database),
      columns: table.key,
      values: values.map(encodeCell),
    };
    if (table.rowid && values.some((value) => value === null)) key.rowid = encodeCell(rowid);
    const token = Buffer.from(JSON.stringify(key)).toString("base64url");
    if (token.length > 65536) throw Error("Record key exceeds bound");
    return token;
  }

  private selector(source: Resolved, table: Table, token: unknown): Selector {
    if (typeof token !== "string" || token.length > 65536) throw Error("Invalid record key");
    let key: Key;
    try {
      key = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    } catch {
      throw Error("Invalid record key");
    }
    if (
      !key ||
      key.v !== 1 ||
      key.source !== source.source.id ||
      key.table !== table.name ||
      key.database !== sha(source.database) ||
      JSON.stringify(key.columns) !== JSON.stringify(table.key) ||
      !Array.isArray(key.values) ||
      key.values.length !== table.key.length ||
      !table.key.length
    )
      throw Error("Invalid record key for this source and table");
    const values = key.values.map(decodeCell);
    let where = table.key.map((field) => quote(field) + " IS ?").join(" AND ");
    if (key.rowid !== undefined) {
      if (!table.rowid || !values.some((value) => value === null))
        throw Error("Invalid nullable record key");
      where += " AND " + quote(table.rowid) + " IS ?";
      values.push(decodeCell(key.rowid));
    } else if (table.rowid && values.some((value) => value === null))
      throw Error("Invalid nullable record key");
    return { where, values };
  }

  private projection(table: Table, bytes: number): { sql: string; budget: number; alias: string } {
    const budget = Math.max(1, Math.floor(bytes / Math.max(1, table.columns.length)));
    let alias = "__catalog_key";
    while (table.columns.some((column) => column.name === alias)) alias += "_";
    const columns = table.columns.map((column) => {
      const field = quote(column.name);
      return `CASE typeof(${field}) WHEN 'text' THEN CAST(substr(CAST(${field} AS BLOB),1,${budget + 1}) AS TEXT) WHEN 'blob' THEN substr(${field},1,${budget + 1}) ELSE ${field} END AS ${field}`;
    });
    if (table.rowid) columns.push(quote(table.rowid) + " AS " + quote(alias));
    return { sql: columns.join(","), budget, alias };
  }

  private preview(
    raw: Record<string, unknown>,
    table: Table,
    budget: number,
    alias: string,
  ): Preview {
    let truncated = false;
    const row: Record<string, unknown> = Object.create(null);
    for (const column of table.columns) {
      const value = raw[column.name];
      if (typeof value === "string" && Buffer.byteLength(value) > budget) {
        row[column.name] = Buffer.from(value).subarray(0, budget).toString("utf8");
        truncated = true;
      } else if (value instanceof Uint8Array && value.length > budget) {
        row[column.name] = {
          encoding: "base64",
          base64: Buffer.from(value).subarray(0, budget).toString("base64"),
          truncated: true,
        };
        truncated = true;
      } else row[column.name] = normalized(value);
    }
    const keyValues = table.key.map((field) => (field === table.rowid ? raw[alias] : raw[field]));
    for (const value of keyValues)
      if (
        (typeof value === "string" && Buffer.byteLength(value) > budget) ||
        (value instanceof Uint8Array && value.byteLength > budget)
      )
        throw Error("Record key exceeds preview bound");
    return { row, truncated, keyValues, rowid: raw[alias] };
  }

  async page(sourceId: string, name: string, options: PageOptions = {}): Promise<Page> {
    const offset = options.offset ?? 0,
      limit = options.limit ?? 50,
      query = options.query ?? "";
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 1000000 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      typeof query !== "string" ||
      query.length > 4096
    )
      throw Error("Invalid page bounds");
    const source = await this.resolve(sourceId),
      db = await this.reader(source);
    try {
      const table = this.table(db, name);
      if (!table.key.length) throw Error("Table has no addressable record key");
      const { sql, budget, alias } = this.projection(table, this.options.previewBytes);
      const search = query.length
        ? table.columns
            .map((column) => "CAST(" + quote(column.name) + " AS TEXT) LIKE ? ESCAPE '\\'")
            .join(" OR ")
        : "";
      const where = search ? " WHERE " + search : "",
        values = query.length
          ? table.columns.map(() => "%" + query.replace(/[\\%_]/g, "\\$&") + "%")
          : [];
      const total = Number(
        db.prepare("SELECT COUNT(*) n FROM " + quote(name) + where).get(...values)!.n,
      );
      const rows = statement(
        db,
        "SELECT " +
          sql +
          " FROM " +
          quote(name) +
          where +
          " ORDER BY " +
          table.key.map(quote).join(",") +
          " LIMIT ? OFFSET ?",
      )
        .all(...values, limit, offset)
        .map((raw) => {
          const preview = this.preview(raw, table, budget, alias),
            key = this.token(source, table, preview.keyValues, preview.rowid);
          return { id: sha(key), key, value: preview.row, truncated: preview.truncated };
        });
      return {
        source: sourceId,
        table: name,
        offset,
        limit,
        total,
        rows,
        truncated: rows.some((row) => row.truncated),
      };
    } finally {
      db.close();
    }
  }

  /** Deliberate dataset capture streams full records, one SQLite row at a time. Mirrors are not certified here. */
  async *records(sourceId: string, name: string): AsyncGenerator<CatalogRecord> {
    const source = await this.resolve(sourceId),
      db = await this.reader(source);
    try {
      const table = this.table(db, name);
      if (!table.key.length) throw Error("Table has no addressable record key");
      let alias = "__catalog_key";
      while (table.columns.some((column) => column.name === alias)) alias += "_";
      const rowid = table.key.length === 1 && table.key[0] === table.rowid;
      const projection =
        table.columns.map((column) => quote(column.name)).join(",") +
        (table.rowid ? "," + quote(table.rowid) + " AS " + quote(alias) : "");
      for (const raw of statement(
        db,
        "SELECT " +
          projection +
          " FROM " +
          quote(name) +
          " ORDER BY " +
          table.key.map(quote).join(","),
      ).iterate()) {
        const key = this.token(
          source,
          table,
          table.key.map((field) => (rowid ? raw[alias] : raw[field])),
          raw[alias],
        );
        const sqlite = Object.fromEntries(
          table.columns.map((column) => [column.name, normalized(raw[column.name])]),
        );
        yield { id: sha(key), key, sqlite };
      }
    } finally {
      db.close();
    }
  }

  private fields(
    db: DatabaseSync,
    table: Table,
    selector: Selector,
    names: string[],
  ): { row: Record<string, unknown>; limited: boolean } {
    const fields = names.filter((field) => table.columns.some((column) => column.name === field));
    const budget = this.options.mirrorBytes;
    const sql = fields
      .map(
        (field) =>
          `CASE typeof(${quote(field)}) WHEN 'text' THEN CAST(substr(CAST(${quote(field)} AS BLOB),1,${budget + 1}) AS TEXT) WHEN 'blob' THEN substr(${quote(field)},1,${budget + 1}) ELSE ${quote(field)} END AS ${quote(field)}`,
      )
      .join(",");
    const row = statement(
      db,
      "SELECT " + sql + " FROM " + quote(table.name) + " WHERE " + selector.where,
    ).get(...selector.values)!;
    const limited = Object.values(row).some(
      (value) =>
        (typeof value === "string" && Buffer.byteLength(value) > budget) ||
        (value instanceof Uint8Array && value.byteLength > budget),
    );
    return { row, limited };
  }

  private async mirrorFile(source: Resolved, path: string): Promise<MirrorRead> {
    path = resolve(source.root, path);
    if (!inside(source.root, path)) throw Error("Mirror path escapes source root");
    const actualRoot = await realpath(source.root),
      actual = await realpath(path);
    if (!inside(actualRoot, actual)) throw Error("Mirror alias escapes source root");
    const file = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      if (!before.isFile()) throw Error("Mirror is not a regular file");
      const bytes = Buffer.alloc(Math.min(before.size, this.options.mirrorBytes + 1));
      let offset = 0;
      while (offset < bytes.length) {
        const read = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!read.bytesRead) break;
        offset += read.bytesRead;
      }
      const after = await file.stat(),
        current = await stat(path);
      return {
        path,
        bytes: bytes.subarray(0, Math.min(offset, this.options.mirrorBytes)),
        complete: before.size <= this.options.mirrorBytes && offset === before.size,
        changed:
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ino !== current.ino ||
          before.dev !== current.dev,
      };
    } finally {
      await file.close();
    }
  }

  private async mirror(
    source: Resolved,
    db: DatabaseSync,
    table: Table,
    selector: Selector,
    digest: Digest,
  ): Promise<MirrorView> {
    const fields =
      table.name === "receipts"
        ? ["id", "response", "receipt", "digest"]
        : table.name === "objects"
          ? ["oid", "part", "record"]
          : table.name === "entries"
            ? ["path", "body", "digest"]
            : table.name === "content_sources"
              ? ["source", "hash", "jsonl", "jsonlHash"]
              : [];
    if (
      !fields.length ||
      !fields.every(
        (field) => field === "digest" || table.columns.some((column) => column.name === field),
      )
    )
      return {
        status: "unavailable",
        reason: "No JSONL mirror adapter is defined for this table schema",
      };
    const { row, limited } = this.fields(db, table, selector, fields);
    let path: string,
      expected: string | undefined,
      integrity = true;
    if (table.name === "receipts") {
      if (typeof row.id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(row.id))
        return {
          status: "unavailable",
          reason: "Receipt identifier cannot resolve a safe mirror path",
        };
      path = join("staging", row.id + ".jsonl");
      expected = text(row.response);
      if (!limited && typeof row.receipt === "string" && typeof row.digest === "string") {
        digest.expected = row.digest;
        let receipt: unknown;
        try {
          receipt = JSON.parse(row.receipt);
        } catch {
          /* Invalid stored JSON is an integrity failure. */
        }
        digest.valid =
          sha(row.receipt) === row.digest &&
          object(receipt) &&
          object(receipt.task) &&
          receipt.task.id === row.id &&
          JSON.stringify(receipt.response) === row.response;
        integrity = digest.valid;
      }
    } else if (table.name === "objects") {
      path = "objects.jsonl";
      expected = text(row.record);
    } else if (table.name === "entries") {
      path = "inventory.jsonl";
      expected = text(row.body);
      if (!limited && typeof row.body === "string" && typeof row.digest === "string") {
        digest.expected = row.digest;
        digest.valid = sha(row.body) === row.digest;
        integrity = digest.valid;
      }
    } else {
      path = String(row.jsonl);
      digest.expected = text(row.jsonlHash);
    }
    if (limited)
      return {
        status: "limited",
        path: resolve(source.root, path),
        reason: "SQLite mirror payload exceeds the verification byte bound",
      };
    let file: MirrorRead;
    try {
      file = await this.mirrorFile(source, path);
    } catch (error) {
      return {
        status: errorCode(error) === "ENOENT" ? "missing" : "unavailable",
        path: resolve(source.root, path),
        reason:
          errorCode(error) === "ENOENT"
            ? "JSONL mirror file is missing"
            : "JSONL mirror path is outside the source root, invalid, or unreadable",
      };
    }
    if (file.changed)
      return {
        status: "limited",
        path: file.path,
        reason: "Mirror changed during observation; integrity is unknown",
      };
    const scanned: { payload: Buffer; raw: Buffer; framed: boolean }[] = [];
    let offset = 0;
    while (offset < file.bytes.length && scanned.length < this.options.mirrorLines) {
      const end = file.bytes.indexOf(10, offset);
      if (end < 0) {
        if (file.complete) {
          scanned.push({
            payload: file.bytes.subarray(offset),
            raw: file.bytes.subarray(offset),
            framed: false,
          });
          offset = file.bytes.length;
        }
        break;
      }
      scanned.push({
        payload: file.bytes.subarray(offset, end),
        raw: file.bytes.subarray(offset, end + 1),
        framed: true,
      });
      offset = end + 1;
    }
    const complete = file.complete && offset === file.bytes.length;
    const values: unknown[] = [];
    for (const line of scanned) {
      let value: unknown;
      try {
        value = JSON.parse(line.payload.toString("utf8"));
      } catch {
        return {
          status: "mismatch",
          path: file.path,
          reason: "JSONL mirror contains an invalid JSON record",
        };
      }
      if (table.name === "content_sources") {
        values.push(value);
        continue;
      }
      const selected =
        table.name === "receipts" ||
        (object(value) &&
          (table.name === "objects"
            ? value.oid === row.oid && String(value.part) === String(row.part)
            : value.path === row.path));
      if (!selected) continue;
      digest.jsonl = sha(line.raw);
      if (table.name === "receipts" && !complete)
        return {
          status: "limited",
          value,
          path: file.path,
          reason: "Receipt framing cannot be verified within the byte or line scan bound",
        };
      const match =
        typeof expected === "string" &&
        Buffer.from(expected).equals(line.payload) &&
        line.framed &&
        integrity &&
        (table.name !== "receipts" || scanned.length === 1);
      return {
        status: match ? "match" : "mismatch",
        value,
        path: file.path,
        reason: match
          ? "Selected actual JSONL record matches the stored SQLite payload bytes; the remaining artifact was not audited"
          : "Actual JSONL bytes or SQLite integrity digest differ",
      };
    }
    if (table.name === "content_sources") {
      if (!complete)
        return {
          status: "limited",
          value: values.length ? (values.length === 1 ? values[0] : values) : undefined,
          path: file.path,
          reason: "Content mirror exceeds the byte or line verification bound",
        };
      digest.jsonl = sha(file.bytes);
      digest.valid = digest.jsonl === digest.expected;
      const header = values[0],
        identity =
          object(header) &&
          header.kind === "content" &&
          header.source === row.source &&
          header.hash === row.hash;
      return {
        status: digest.valid && identity && file.bytes.at(-1) === 10 ? "match" : "mismatch",
        value: values.length === 1 ? values[0] : values,
        path: file.path,
        reason:
          "Compares the actual artifact digest, framing, and content header identity to content_sources; content block coverage is not audited",
      };
    }
    return {
      status: complete ? "missing" : "limited",
      path: file.path,
      reason: complete
        ? "Selected record is absent from the actual JSONL mirror"
        : "Selected record was not found within the byte or line scan bound",
    };
  }

  async record(sourceId: string, name: string, key: unknown): Promise<RecordView> {
    const source = await this.resolve(sourceId),
      db = await this.reader(source);
    let reading = false;
    try {
      const before = await stat(source.database);
      const version = db.prepare("PRAGMA data_version").get()!.data_version;
      db.exec("BEGIN");
      reading = true;
      const table = this.table(db, name),
        selector = this.selector(source, table, key);
      const { sql, budget, alias } = this.projection(table, this.options.previewBytes);
      const raw = statement(
        db,
        "SELECT " + sql + " FROM " + quote(name) + " WHERE " + selector.where,
      ).get(...selector.values);
      if (!raw) throw Error("Record no longer exists");
      const preview = this.preview(raw, table, budget, alias),
        token = this.token(source, table, preview.keyValues, preview.rowid);
      const digest: Digest = {
        sqlite: sha(JSON.stringify(preview.row)),
        scope: preview.truncated ? "preview" : "record",
      };
      let jsonl = await this.mirror(source, db, table, selector, digest);
      db.exec("COMMIT");
      reading = false;
      let changed = version !== db.prepare("PRAGMA data_version").get()!.data_version;
      try {
        const after = await stat(source.database);
        changed ||=
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs;
      } catch {
        changed = true;
      }
      if (changed)
        jsonl = {
          ...jsonl,
          status: "limited",
          reason:
            "SQLite database changed during observation; displayed data belongs to a read snapshot and current mirror integrity is unknown",
        };
      return {
        id: sha(token),
        source: sourceId,
        table: name,
        key: token,
        sqlite: preview.row,
        jsonl,
        digest,
        truncated: preview.truncated || jsonl.status === "limited",
      };
    } finally {
      if (reading) db.exec("ROLLBACK");
      db.close();
    }
  }
}
