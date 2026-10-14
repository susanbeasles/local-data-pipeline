import { readFile, open, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { status } from "./status.ts";
import { usage } from "./usage.ts";
import { hash, atomic } from "./store.ts";
import { boundaries } from "./run.ts";
import { Release } from "./release.ts";
import { Lock } from "./lock.ts";
const exec = promisify(execFile);
export type Panel = { control: string; entry: string; project: string; managed?: string };
async function settings(path: string): Promise<Panel> {
  const v = JSON.parse(await readFile(path, "utf8"));
  if (
    !v ||
    ["control", "entry", "project"].some((k) => typeof v[k] !== "string" || !v[k].startsWith("/"))
  )
    throw Error("invalid panel configuration");
  return v;
}
function matches(command: string, config: Panel) {
  const entries = [
    config.entry,
    ...(config.managed ? [join(config.managed, "payload/pipeline/controller.ts")] : []),
  ];
  return entries.some((entry) => command.split(/\s+/).includes(entry));
}
export async function prepare(config: Panel) {
  const c = await current(config);
  const partitions = [];
  for (const [name, path] of Object.entries(c.record.configs)) {
    if (!/^[A-Za-z0-9-]+$/.test(name)) throw Error("invalid partition name");
    const cfg = JSON.parse(await readFile(String(path), "utf8"));
    if (typeof cfg.input !== "string" || typeof cfg.work !== "string")
      throw Error("invalid partition paths");
    await boundaries(cfg.input, config.control);
    await boundaries(cfg.input, config.project);
    partitions.push({ name, config: cfg });
  }
  const root = join(config.control, "releases");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(root, { recursive: true });
  const owner = (await processes()).find((p) => p.pid === c.record.controllerPid);
  if (owner) {
    if (!matches(owner.command, config) || owner.group !== owner.pid)
      throw Error("controller must have a dedicated process group");
    await register(config, owner.pid);
  }
  const destination = join(root, crypto.randomUUID());
  await Release.create(config.project, destination, { revision: "native-instance", partitions });
  return { ...config, managed: destination };
}
async function current(config: Panel) {
  const record = JSON.parse(await readFile(join(config.control, "production.json"), "utf8"));
  const progress = JSON.parse(await readFile(join(config.control, "progress.json"), "utf8"));
  const pile = progress.pile ?? Object.keys(record.configs)[0];
  const file = record.configs[pile];
  if (!file) throw Error("unregistered partition");
  const pipeline = JSON.parse(await readFile(file, "utf8"));
  return { record, progress, pile, pipeline };
}
async function pending(config: Panel) {
  return readFile(join(config.control, "panel-intent.json"), "utf8")
    .then(JSON.parse)
    .catch(() => ({}));
}
async function processes() {
  const { stdout } = await exec("/bin/ps", ["-axo", "pid=,ppid=,pgid=,stat=,lstart=,command="], {
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.split("\n").flatMap((line) => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.{24})\s+(.+)$/);
    return m
      ? [
          {
            pid: Number(m[1]),
            parent: Number(m[2]),
            group: Number(m[3]),
            state: m[4],
            birth: m[5],
            command: m[6],
          },
        ]
      : [];
  });
}
export async function snapshot(config: Panel) {
  const c = await current(config),
    value = await status(c.pipeline.work);
  const tree = await processes();
  const intent = await pending(config);
  const group = await owned(config);
  const alive =
    group.members.length > 0 ||
    tree.some(
      (p) =>
        (p.pid === c.record.controllerPid || p.pid === intent.pid) && matches(p.command, config),
    );
  if (!alive && intent.state === "paused") value.phase = "paused";
  return {
    alive,
    partition: c.pile,
    run: c.record.run,
    controller: c.progress.phase,
    status: value,
    usage: usage(c.pipeline.work),
    stages: c.pipeline.roles ?? [],
  };
}
export async function logs(config: Panel) {
  const c = await current(config);
  if (!/^[A-Za-z0-9-]+$/.test(c.pile) || !/^[a-f0-9-]{36}$/.test(c.record.run))
    throw Error("invalid log identity");
  const path = await realpath(join(config.control, `${c.pile}-${c.record.run}.log`));
  if (!path.startsWith((await realpath(config.control)) + sep))
    throw Error("log outside control directory");
  const file = await open(path, "r");
  try {
    const size = (await file.stat()).size,
      buffer = Buffer.alloc(Math.min(size, 65536));
    await file.read(buffer, 0, buffer.length, size - buffer.length);
    return { text: buffer.toString("utf8").split("\n").slice(-200).join("\n"), offset: size };
  } finally {
    await file.close();
  }
}
export async function sample(config: Panel, role: string, offset = 0) {
  if (
    !/^[a-z][a-z0-9-]{0,47}$/.test(role) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 10000
  )
    throw Error("invalid stage/sample offset");
  const c = await current(config),
    work = await realpath(c.pipeline.work);
  const graph = ["reconcile", "connect"].includes(role);
  let generation: string | undefined;
  if (graph) {
    const phase = await readFile(join(work, "state", "phase.json"), "utf8")
      .then(JSON.parse)
      .catch(() => undefined);
    if (
      typeof phase?.generation !== "string" ||
      !/^[a-f0-9]{64}$/.test(phase.generation)
    )
      return {
        available: false,
        reason: "Active graph generation is unavailable",
      };
    generation = phase.generation;
  }
  const database = join(
    work,
    "state",
    graph ? "graph.sqlite" : "pipeline.sqlite",
  );
  const db = new DatabaseSync(database, { readOnly: true });
  let row;
  try {
    db.exec("PRAGMA busy_timeout=1000");
    row = db
      .prepare(
        `SELECT id,output,outputHash FROM jobs WHERE role=? AND state='completed' ${graph ? "AND config=?" : ""} ORDER BY rowid LIMIT 1 OFFSET ?`,
      )
      .get(...(generation ? [role, generation, offset] : [role, offset]));
  } finally {
    db.close();
  }
  if (!row?.output)
    return {
      available: false,
      reason: "No completed output for this stage yet",
    };
  const path = await realpath(String(row.output));
  if (!path.startsWith(work + sep) || (await stat(path)).size > 2 * 1024 * 1024)
    throw Error("sample outside work or exceeds 2 MiB");
  const data = await readFile(path);
  if (data.length > 2 * 1024 * 1024 || hash(data) !== row.outputHash)
    throw Error("sample integrity mismatch");
  return {
    available: true,
    id: row.id,
    receipt: JSON.parse(data.toString("utf8")),
  };
}
type ProcessInfo = Awaited<ReturnType<typeof processes>>[number];
type Owner = { pid: number; birth: string; command: string; group: number; members: ProcessInfo[] };
async function register(config: Panel, pid: number) {
  const tree = await processes(),
    root = tree.find((p) => p.pid === pid);
  if (!root) return;
  if (root.group !== root.pid || !matches(root.command, config))
    throw Error("dedicated controller identity not established");
  const owner: Owner = { ...root, members: tree.filter((p) => p.group === root.group) };
  await atomic(join(config.control, "panel-owner.json"), owner);
  return owner;
}
async function owned(config: Panel) {
  const owner = (await readFile(join(config.control, "panel-owner.json"), "utf8")
    .then(JSON.parse)
    .catch(() => undefined)) as Owner | undefined;
  if (!owner) return { owner: undefined, members: [] as ProcessInfo[] };
  const tree = await processes(),
    root = tree.find((p) => p.pid === owner.pid),
    members = tree.filter((p) => p.group === owner.group && !p.state.startsWith("Z"));
  if (root && (root.birth !== owner.birth || root.command !== owner.command))
    throw Error("controller PID identity changed; refusing to signal");
  if (
    members.length &&
    !root &&
    !members.some((p) =>
      owner.members.some((a) => a.pid === p.pid && a.birth === p.birth && a.command === p.command),
    )
  )
    throw Error("orphan process ownership cannot be verified; resume blocked");
  return { owner, members };
}
export async function pause(config: Panel) {
  const lock = await Lock.acquire(join(config.control, "panel.lock"));
  try {
    const c = await current(config);
    let group = await owned(config);
    if (!group.owner) {
      const root = (await processes()).find((p) => p.pid === c.record.controllerPid);
      if (root) throw Error("Prepare and register this running controller before pause");
    }
    await atomic(join(config.control, "panel-intent.json"), {
      state: "pausing",
      run: c.record.run,
      at: new Date().toISOString(),
    });
    const deadline = Date.now() + 15000;
    while (true) {
      group = await owned(config);
      if (!group.members.length) {
        await atomic(join(config.control, "panel-intent.json"), {
          state: "paused",
          run: c.record.run,
          at: new Date().toISOString(),
        });
        return { paused: true };
      }
      if (Date.now() > deadline)
        throw Error("Managed process group has not stopped; resume remains blocked");
      // A dedicated, verified group includes workers born after any earlier snapshot.
      try {
        process.kill(-group.owner!.group, "SIGTERM");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    await lock.close();
  }
}
export async function resume(config: Panel) {
  const lock = await Lock.acquire(join(config.control, "panel.lock"));
  try {
    const c = await current(config),
      tree = await processes();
    const group = await owned(config);
    if (c.progress.phase === "completed" && !group.members.length)
      return { completed: true, resuming: false };
    if (group.members.length) throw Error("Managed processes are still running");
    if (
      tree.some(
        (p) =>
          (p.pid === c.record.controllerPid || p.command.split(/\s+/).includes(config.control)) &&
          matches(p.command, config),
      )
    )
      throw Error("pipeline is already running or starting");
    if (!config.managed) throw Error("Prepare an instance snapshot before resuming");
    await new Release(config.managed).verify();
    const intent = await readFile(join(config.control, "panel-intent.json"), "utf8")
      .then(JSON.parse)
      .catch(() => ({}));
    if (intent.state === "pausing") throw Error("Pause has not finished; resume is blocked");
    const stream = await open(join(config.control, "panel-controller.log"), "a", 0o600);
    try {
      const child = spawn(
        process.execPath,
        [join(config.managed, "payload/pipeline/controller.ts"), config.control],
        {
          cwd: config.managed,
          detached: true,
          stdio: ["ignore", stream.fd, stream.fd],
          env: { PATH: "/usr/bin:/bin" },
        },
      );
      await new Promise<void>((ok, no) => {
        child.once("spawn", ok);
        child.once("error", no);
      });
      child.unref();
      if (child.pid) await register(config, child.pid);
      await atomic(join(config.control, "panel-intent.json"), {
        state: "resuming",
        pid: child.pid,
        at: new Date().toISOString(),
      });
      return { resuming: true, pid: child.pid };
    } finally {
      await stream.close();
    }
  } finally {
    await lock.close();
  }
}
if (process.argv[1] === import.meta.filename) {
  try {
    const [command, path, role = "summarize", offset = "0"] = process.argv.slice(2);
    if (!path)
      throw Error(
        "Usage: node pipeline/panel.ts status|logs|sample|pause|resume /absolute/panel.json [stage]",
      );
    const config = await settings(resolve(path));
    if (command === "prepare") {
      const value = await prepare(config);
      await atomic(resolve(path), value);
      console.log(JSON.stringify({ prepared: true, path: resolve(path) }));
      process.exit(0);
    }
    const value =
      command === "status"
        ? await snapshot(config)
        : command === "logs"
          ? await logs(config)
          : command === "sample"
            ? await sample(config, role, Number(offset))
            : command === "pause"
              ? await pause(config)
              : command === "resume"
                ? await resume(config)
                : (() => {
                    throw Error("unknown command");
                  })();
    console.log(JSON.stringify(value));
  } catch (e) {
    console.log(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    process.exitCode = 1;
  }
}
