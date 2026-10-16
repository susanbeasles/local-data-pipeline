import { outsideProject } from "./storage.ts";
/** Native workspace bridge. JSON requests arrive on stdin, never shell command strings. */
import { readFile, mkdir, open, realpath, readdir, writeFile, lstat } from "node:fs/promises";
import { resolve, dirname, join, sep } from "node:path";
import { spawn, execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { Socket } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { binding, type Binding } from "./platform-client.ts";
import { Catalog, type Source } from "./catalog.ts";
import { Dataset, type Step, type Observer, validateSteps } from "./dataset.ts";
import { Sessions, assist, type Provider, type FieldPacket } from "./sessions.ts";
import { atomic } from "./store.ts";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, lstatSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
export type Studio = {
  format: "studio/1";
  state: string;
  sources: Source[];
  providers: Provider[];
  protectedRoots?: string[];
  readRoots?: string[];
  panel?: { script: string; config: string };
  platform?: { config: string; guest?: Binding };
  file?: string;
  observer?: Observer;
};
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    const parent = dirname(path);
    if (parent === path) throw e;
    return join(await canonical(parent), path.slice(parent.length));
  }
}
export async function configure(path: string): Promise<Studio> {
  const file = await realpath(resolve(path)),
    base = dirname(file),
    value = JSON.parse(await readFile(file, "utf8")) as Studio;
  if (
    value.format !== "studio/1" ||
    !Array.isArray(value.sources) ||
    !Array.isArray(value.providers) ||
    !value.state
  )
    throw Error("invalid studio configuration");
  if (value.platform) {
    if (
      Object.keys(value.platform).some(k => !["config", "guest"].includes(k)) ||
      typeof value.platform.config !== "string" ||
      !value.platform.config.trim()
    )
      throw Error("invalid platform configuration binding");
    if (value.platform.guest !== undefined) {
      value.platform.guest = binding(value.platform.guest);
      if (!value.platform.config.startsWith("/") || value.platform.config.includes("\0") || value.platform.config.split("/").some(s => s === ".." || s === ".")) throw Error("absolute guest platform configuration required");
    } else value.platform.config = resolve(base, value.platform.config);
  }
  value.state = await canonical(resolve(base, value.state));
  await outsideProject(value.state);
  value.sources = value.sources.map((s) => ({
    ...s,
    root: resolve(base, s.root),
    ...(s.pointer ? { pointer: resolve(base, s.pointer) } : {}),
    ...(s.processFile ? { processFile: resolve(base, s.processFile) } : {}),
  }));
  value.protectedRoots = (value.protectedRoots || []).map((p) => resolve(base, p));
  value.readRoots = (value.readRoots || []).map((p) => resolve(base, p));
  value.providers = value.providers.map((p) => ({ ...p, executable: resolve(base, p.executable) }));
  const ids = new Set<string>();
  for (const source of value.sources) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(source.id) || ids.has(source.id))
      throw Error("invalid or duplicate source id");
    ids.add(source.id);
    const root = await realpath(source.root);
    if (
      value.state === root ||
      value.state.startsWith(root + sep) ||
      root.startsWith(value.state + sep)
    )
      throw Error("studio state and sources must be disjoint");
  }
  // Pointer-selected roots must be checked before creating any operator directory.
  await new Catalog(value.sources, value.state).roots();
  await mkdir(value.state, { recursive: true, mode: 0o700 });
  if ((await realpath(value.state)) !== value.state) throw Error("aliased studio state");
  if (process.platform === "darwin") {
    const code = join(import.meta.dirname, "process.c"),
      digest = createHash("sha256")
        .update(await readFile(code))
        .digest("hex"),
      path = join(await managed(value, "workers"), "process-" + digest),
      manifest = await managed(value, "workers", "process-" + digest + ".json");
    try {
      const saved = JSON.parse(await readFile(manifest, "utf8")),
        s = await lstat(path);
      if (
        s.isSymbolicLink() ||
        !s.isFile() ||
        s.nlink !== 1 ||
        saved.path !== path ||
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex") !== saved.digest
      )
        throw Error("process observer integrity mismatch");
      value.observer = saved;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const s = await lstat(path).catch(() => null);
      if (s) throw Error("unverified process observer exists");
      await promisify(execFile)("/usr/bin/clang", ["-O2", "-Wall", "-Werror", code, "-o", path], {
        timeout: 30000,
      });
      value.observer = {
        path,
        digest: createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      };
      await atomic(manifest, value.observer);
    }
  }
  value.file = file;
  return value;
}
const text = (v: unknown, name: string) => {
  if (typeof v !== "string" || !v.trim()) throw Error("missing " + name);
  return v;
};
async function managed(config: Studio, kind: "flows" | "imports" | "workers", name?: string) {
  const dir = join(config.state, kind);
  try {
    const s = await lstat(dir);
    if (s.isSymbolicLink() || !s.isDirectory() || (await realpath(dir)) !== dir)
      throw Error("aliased operator directory");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    await mkdir(dir, { mode: 0o700 });
  }
  if (!name) return dir;
  if (!/^(?:[a-z0-9-]+\.(?:json|log)|leases\.sqlite(?:-(?:wal|shm|journal))?)$/.test(name))
    throw Error("invalid operator artifact");
  const path = join(dir, name);
  try {
    const s = await lstat(path);
    if (s.isSymbolicLink() || !s.isFile() || s.nlink !== 1)
      throw Error("aliased operator artifact");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return path;
}
function identity(pid: number, observer?: Observer) {
  try {
    if (!Number.isSafeInteger(pid) || pid < 1) return "";
    if (observer) {
      const stat = lstatSync(observer.path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        createHash("sha256").update(readFileSync(observer.path)).digest("hex") !== observer.digest
      )
        throw Error("process observer integrity mismatch");
      return execFileSync(observer.path, [String(pid)], { encoding: "utf8", timeout: 2000 }).trim();
    }
    return execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], {
      encoding: "utf8",
      timeout: 2000,
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    }).trim();
  } catch {
    return "";
  }
}
type Lease = {
  id: string;
  token: string;
  status: string;
  owner: number;
  ownerProof: string;
  pid: number | null;
  proof: string | null;
  action: string;
  created: string;
  updated: string;
};
const startupMillis = 10_000;
async function leases(config: Studio) {
  const path = await managed(config, "workers", "leases.sqlite");
  for (const suffix of ["-wal", "-shm", "-journal"])
    await managed(config, "workers", "leases.sqlite" + suffix);
  const db = new DatabaseSync(path);
  try {
    db.exec(
      "PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS leases(id TEXT PRIMARY KEY,token TEXT NOT NULL,status TEXT NOT NULL,owner INTEGER NOT NULL,ownerProof TEXT NOT NULL,pid INTEGER,proof TEXT,action TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL)",
    );
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
function live(config: Studio, row: Lease | undefined) {
  if (!row) return false;
  if (row.status === "starting")
    return (
      Date.now() - Date.parse(row.created) < startupMillis &&
      !!row.ownerProof &&
      identity(Number(row.owner)) === row.ownerProof
    );
  return (
    row.status === "running" &&
    Number.isSafeInteger(row.pid) &&
    !!row.proof &&
    identity(Number(row.pid), config.observer) === row.proof
  );
}
async function active(config: Studio, id: string) {
  const db = await leases(config);
  try {
    return live(config, db.prepare("SELECT * FROM leases WHERE id=?").get(id) as Lease | undefined);
  } finally {
    db.close();
  }
}
export async function command(config: Studio, action: string, input: Record<string, any> = {}) {
  if (action === "platform") {
    if (!config.platform)
      throw Error(
        "Workflow platform is not provisioned; configure an authorized operator configuration.",
      );
    const { request } = await import("./platform-client.ts");
    return { result: await request(config.platform.config, input.action, input.input ?? {}, { guest: config.platform.guest }) };
  }
  const catalog = new Catalog(config.sources, config.state),
    sessions = new Sessions(join(config.state, "sessions"), config.providers, {
      protectedRoots: [
        ...config.sources.map((s) => s.root),
        ...(await catalog.roots()),
        join(config.state, "datasets"),
        ...(config.protectedRoots || []),
      ],
      readRoots: config.readRoots,
    });
  const store = () => new Dataset(join(config.state, "datasets"), { observer: config.observer });
  switch (action) {
    case "sources":
      return { observedAt: new Date().toISOString(), sources: await catalog.sources() };
    case "tables":
      return { tables: await catalog.tables(text(input.source, "source")) };
    case "page":
      return catalog.page(text(input.source, "source"), text(input.table, "table"), {
        offset: input.offset,
        limit: input.limit,
        query: input.query,
      });
    case "record":
      return catalog.record(text(input.source, "source"), text(input.table, "table"), input.key);
    case "assist":
      return assist(input as FieldPacket);
    case "providers":
      return { providers: await sessions.available() };
    case "sessions":
      return { sessions: await sessions.list() };
    case "session-start":
      return sessions.start({
        provider: input.provider,
        kind: input.kind || "help",
        prompt: text(input.prompt, "prompt"),
        context: input.context,
      });
    case "session-send":
      return sessions.send(text(input.id, "session"), text(input.prompt, "prompt"));
    case "session-poll":
      return sessions.snapshot(text(input.id, "session"), input.offset);
    case "session-stop":
      await sessions.stop(text(input.id, "session"));
      return { stopped: true };
    case "session-reset":
      return sessions.reset(text(input.id, "session"));
    case "session-branch":
      return sessions.branch(text(input.id, "session"), input.prompt);
    case "session-rewind":
      return sessions.rewind(text(input.id, "session"), Number(input.turn));
    case "session-compact":
      return sessions.compact(text(input.id, "session"));
    case "datasets": {
      const d = store();
      try {
        return { revisions: d.revisions(), runs: d.runs() };
      } finally {
        d.close();
      }
    }
    case "dataset-page": {
      const d = store();
      try {
        return d.page(text(input.revision, "revision"), input.filters || {});
      } finally {
        d.close();
      }
    }
    case "capture": {
      if (!Array.isArray(input.keys) || input.keys.length < 1 || input.keys.length > 100)
        throw Error("select between one and 100 records");
      const records = [];
      for (const key of input.keys) {
        const r = await catalog.record(
          text(input.source, "source"),
          text(input.table, "table"),
          key,
        );
        if (r.truncated)
          throw Error("record exceeds bounded capture preview; use the full import workflow");
        records.push({ id: r.id, source: input.source, key: r.key, body: r.sqlite });
      }
      const d = store();
      try {
        return await d.capture(text(input.name, "dataset name"), records);
      } finally {
        d.close();
      }
    }
    case "annotate": {
      const d = store();
      try {
        d.annotate(text(input.id, "record"), input.values);
        return { saved: true };
      } finally {
        d.close();
      }
    }
    case "link": {
      const d = store();
      try {
        d.link(
          text(input.from, "source record"),
          text(input.to, "target record"),
          text(input.kind, "link type"),
        );
        return { saved: true, links: d.links(input.from) };
      } finally {
        d.close();
      }
    }
    case "links": {
      const d = store();
      try {
        return { links: d.links(text(input.id, "record")) };
      } finally {
        d.close();
      }
    }
    case "edit": {
      const d = store();
      try {
        return await d.edit(text(input.revision, "revision"), text(input.id, "record"), input.body);
      } finally {
        d.close();
      }
    }
    case "failures": {
      const d = store();
      try {
        const page = d.review(text(input.id, "run"), "failures", {
          offset: input.offset,
          limit: input.limit,
        });
        return {
          failures: page.records,
          offset: page.offset,
          limit: page.limit,
          total: page.total,
          more: page.more,
        };
      } finally {
        d.close();
      }
    }
    case "correct": {
      const d = store();
      try {
        d.correct(text(input.id, "run"), text(input.record, "record"), input.body);
        return { corrected: true };
      } finally {
        d.close();
      }
    }
    case "flow-save": {
      const steps = validateSteps(input.steps),
        name = text(input.name || "Flow", "flow name"),
        id = createHash("sha256").update(JSON.stringify({ name, steps })).digest("hex"),
        path = await managed(config, "flows", id + ".json");
      await atomic(path, { format: "flow/1", id, name, steps });
      return { id, path };
    }
    case "flows": {
      const root = await managed(config, "flows");
      const flows = [];
      for (const name of (await readdir(root)).filter((n) => /^[a-f0-9]{64}\.json$/.test(n)))
        flows.push(JSON.parse(await readFile(await managed(config, "flows", name), "utf8")));
      return { flows };
    }
    case "flow-start": {
      const d = store();
      try {
        const run = d.start(text(input.revision, "revision"), input.steps as Step[], {
          pauseOnFailure: input.pauseOnFailure !== false,
        });
        await launch(config, "flow-worker", run.id);
        return run;
      } finally {
        d.close();
      }
    }
    case "flow-resume": {
      const d = store();
      try {
        if (!d.runs().some((r) => r.id === input.id)) throw Error("unknown run");
      } finally {
        d.close();
      }
      await launch(config, "flow-resume-worker", text(input.id, "run"));
      return { resuming: true, id: input.id };
    }
    case "flow-pause": {
      const d = store();
      try {
        d.pause(text(input.id, "run"));
        return { paused: true };
      } finally {
        d.close();
      }
    }
    case "outcomes": {
      const d = store();
      try {
        const page = d.review(text(input.id, "run"), "outcomes", {
          offset: input.offset,
          limit: input.limit,
        });
        return {
          outcomes: page.records,
          offset: page.offset,
          limit: page.limit,
          total: page.total,
          more: page.more,
        };
      } finally {
        d.close();
      }
    }
    case "verify": {
      const d = store();
      try {
        return await d.verify(text(input.revision, "revision"));
      } finally {
        d.close();
      }
    }
    case "import-table": {
      const id = randomUUID(),
        path = await managed(config, "imports", id + ".json");
      await catalog.tables(text(input.source, "source")).then((t) => {
        if (!t.some((x) => x.name === input.table)) throw Error("unknown table");
      });
      await atomic(path, {
        id,
        state: "pending",
        name: text(input.name, "dataset name"),
        source: text(input.source, "source"),
        table: text(input.table, "table"),
        processed: 0,
        created: new Date().toISOString(),
      });
      await launch(config, "import-worker", id);
      return { id, state: "pending" };
    }
    case "import-resume": {
      const id = text(input.id, "import");
      if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("invalid import identity");
      const job = JSON.parse(
        await readFile(await managed(config, "imports", id + ".json"), "utf8"),
      );
      if (job.state === "completed") return job;
      if (await active(config, id)) throw Error("import already active");
      await launch(config, "import-worker", id);
      return { resuming: true, id };
    }
    case "imports": {
      const dir = await managed(config, "imports");
      const imports = [];
      for (const name of (await readdir(dir)).filter((n) => /^[a-f0-9-]{36}\.json$/.test(n))) {
        const job = JSON.parse(await readFile(await managed(config, "imports", name), "utf8"));
        job.alive = await active(config, job.id);
        if (["running", "pending"].includes(job.state) && !job.alive) {
          job.state = "interrupted";
          job.error =
            "Registered worker is absent or its process identity changed. Resume verifies the saved prefix.";
        }
        imports.push(job);
      }
      return { imports };
    }
    default:
      throw Error("unknown studio command");
  }
}
async function launch(config: Studio, action: string, id: string) {
  if (!/^[a-f0-9-]{16,96}$/.test(id)) throw Error("invalid worker identity");
  if (!config.file) throw Error("saved studio configuration required");
  if (process.platform !== "darwin")
    throw Error("operator worker isolation is only verified on macOS");
  const token = randomUUID(),
    db = await leases(config),
    ownerProof = identity(process.pid),
    created = new Date().toISOString();
  if (!ownerProof) {
    db.close();
    throw Error("controller identity unavailable");
  }
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const old = db.prepare("SELECT * FROM leases WHERE id=?").get(id) as Lease | undefined;
      if (live(config, old)) throw Error("worker already active");
      db.prepare(
        "INSERT INTO leases VALUES(?,?,'starting',?,?,NULL,NULL,?,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,status='starting',owner=excluded.owner,ownerProof=excluded.ownerProof,pid=NULL,proof=NULL,action=excluded.action,created=excluded.created,updated=excluded.updated",
      ).run(id, token, process.pid, ownerProof, action, created, created);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    db.close();
    throw error;
  }
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const snapshot = await managed(config, "workers", id + "-config.json");
    try {
      await lstat(snapshot);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      await atomic(snapshot, {
        ...config,
        sources: await new Catalog(config.sources, config.state).bindings(),
        providers: [],
      });
    }
    const path = await managed(config, "workers", id + ".log"),
      log = await open(path, "a", 0o600);
    const profile = `(version 1) (allow default) (deny network*) (deny file-write*) (allow file-write* (subpath ${JSON.stringify(config.state)}))`;
    try {
      child = spawn(
        "/usr/bin/sandbox-exec",
        ["-p", profile, process.execPath, import.meta.filename, action, snapshot, id],
        {
          detached: true,
          stdio: ["ignore", log.fd, log.fd],
          env: {
            PATH: "/usr/bin:/bin",
            HOME: config.state,
            TMPDIR: config.state,
            LANG: "en_US.UTF-8",
            STUDIO_SANDBOX: "1",
            STUDIO_TOKEN: token,
          },
        },
      );
      await new Promise<void>((ok, no) => {
        child!.once("spawn", ok);
        child!.once("error", no);
      });
      child.unref();
    } finally {
      await log.close();
    }
    const expected = await realpath(process.execPath);
    let proof = "";
    for (let n = 0; n < 100; n++) {
      proof = identity(child.pid!, config.observer);
      if (proof && (config.observer ? proof.endsWith(":" + expected) : proof.includes(expected)))
        break;
      proof = "";
      if (child.exitCode !== null || child.signalCode !== null) break;
      await delay(20);
    }
    if (!proof) throw Error("worker exited before identity could be established");
    const published = db
      .prepare(
        "UPDATE leases SET status='running',pid=?,proof=?,updated=? WHERE id=? AND token=? AND status='starting'",
      )
      .run(child.pid!, proof, new Date().toISOString(), id, token);
    if (Number(published.changes) !== 1) throw Error("worker startup lease changed");
    await atomic(await managed(config, "workers", id + ".json"), {
      id,
      token,
      pid: child.pid,
      identity: proof,
      action,
      started: created,
    });
    return child.pid;
  } catch (error) {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    db.prepare("UPDATE leases SET status='failed',updated=? WHERE id=? AND token=?").run(
      new Date().toISOString(),
      id,
      token,
    );
    throw error;
  } finally {
    db.close();
  }
}
async function worker(config: Studio, action: string, id: string) {
  if (!/^[a-f0-9-]{16,96}$/.test(id)) throw Error("invalid worker identity");
  if (process.env.STUDIO_SANDBOX !== "1") throw Error("workers require the guarded launcher");
  const token = process.env.STUDIO_TOKEN;
  if (!token || !/^[a-f0-9-]{36}$/.test(token)) throw Error("worker startup token missing");
  const db = await leases(config);
  let admitted = false;
  try {
    for (let n = 0; n < 250; n++) {
      const row = db.prepare("SELECT * FROM leases WHERE id=?").get(id) as Lease | undefined;
      if (!row || row.token !== token || !["starting", "running"].includes(row.status))
        throw Error("worker startup lease changed");
      if (
        row.status === "running" &&
        Number(row.pid) === process.pid &&
        row.proof === identity(process.pid, config.observer)
      ) {
        admitted = true;
        break;
      }
      if (!live(config, row) && Date.now() - Date.parse(row.created) > startupMillis) break;
      await delay(20);
    }
    if (!admitted) throw Error("worker startup lease was not published");
  } catch (error) {
    db.close();
    throw error;
  }
  let failed = false;
  try {
    return await execute(config, action, id);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    db.prepare("UPDATE leases SET status=?,updated=? WHERE id=? AND token=? AND pid=?").run(
      failed ? "failed" : "done",
      new Date().toISOString(),
      id,
      token,
      process.pid,
    );
    db.close();
  }
}
async function execute(config: Studio, action: string, id: string) {
  await new Promise<void>((ok, no) => {
    const s = new Socket();
    s.once("error", (e: NodeJS.ErrnoException) => {
      s.destroy();
      e.code === "EPERM" ? ok() : no(Error("OS network denial not established: " + e.code));
    });
    s.once("connect", () => {
      s.destroy();
      no(Error("OS network denial missing"));
    });
    s.setTimeout(2000, () => {
      s.destroy();
      no(Error("network denial probe timed out"));
    });
    s.connect(9, "127.0.0.1");
  });
  const d = new Dataset(join(config.state, "datasets"), { observer: config.observer });
  try {
    if (action === "flow-worker") return await d.execute(id);
    if (action === "flow-resume-worker") return await d.resume(id);
    const path = await managed(config, "imports", id + ".json"),
      job = JSON.parse(await readFile(path, "utf8"));
    if (job.state === "completed") return job;
    const catalog = new Catalog(config.sources, config.state);
    job.state = "running";
    job.started = new Date().toISOString();
    await atomic(path, job);
    let processed = 0;
    const records = (async function* () {
      for await (const row of catalog.records(job.source, job.table)) {
        yield { id: row.id, source: job.source, key: row.key, body: row.sqlite };
        processed++;
        job.processed = processed;
        if (processed % 100 === 0) await atomic(path, job);
      }
    })();
    try {
      const revision = await d.capture(job.name, records, { id: job.id });
      Object.assign(job, {
        state: "completed",
        revision: revision.id,
        finished: new Date().toISOString(),
      });
      await atomic(path, job);
      return job;
    } catch (e) {
      Object.assign(job, { state: "failed", error: String(e), finished: new Date().toISOString() });
      await atomic(path, job);
      throw e;
    }
  } finally {
    d.close();
  }
}
async function input() {
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk;
    if (Buffer.byteLength(data) > 2 * 1024 ** 2) throw Error("request exceeds 2 MiB");
  }
  return data.trim() ? JSON.parse(data) : {};
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.umask(0o077);
  try {
    const [action, path, id] = process.argv.slice(2);
    if (!path) throw Error("Usage: node studio.ts command /studio.json < request.json");
    const config = await configure(path);
    console.log(
      JSON.stringify(
        action.endsWith("-worker")
          ? await worker(config, action, id)
          : await command(config, action, await input()),
      ),
    );
  } catch (e) {
    console.log(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    process.exitCode = 1;
  }
}
