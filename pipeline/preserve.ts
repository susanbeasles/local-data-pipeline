/** Lossless local preservation. No inference, extraction, source writes or Git fetch. */
import { DatabaseSync } from "node:sqlite";
import {
  mkdir,
  lstat,
  opendir,
  readlink,
  realpath,
  statfs,
  readFile,
  chmod,
  symlink,
  open,
  access,
} from "node:fs/promises";
import { join, resolve, relative, dirname, sep, basename, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { Content } from "./content.ts";
import { hash, atomic, publish } from "./store.ts";
import { fileHash } from "./seal.ts";
import { Lock } from "./lock.ts";

const exec = promisify(execFile);
/** Git opens the null device at startup; this grants no persistent filesystem write. */
export async function policy(input: string, work: string) {
  const { profile } = await import("./sandbox.ts");
  return (await profile(input, work)) + '\n(allow file-write-data (literal "/dev/null"))\n';
}
type Entry = {
  path: string;
  kind: "file" | "directory" | "symlink" | "socket";
  mode: number;
  bytes: number;
  hash?: string;
  target?: string;
};
async function* walk(root: string, dir = root): AsyncGenerator<Entry> {
  const info = await lstat(dir);
  yield { path: relative(root, dir), kind: "directory", mode: info.mode & 0o777, bytes: 0 };
  const names = [];
  for await (const e of await opendir(dir)) names.push(e.name);
  names.sort();
  for (const name of names) {
    const path = join(dir, name),
      s = await lstat(path),
      base = { path: relative(root, path), mode: s.mode & 0o777, bytes: s.size };
    if (s.isDirectory()) yield* walk(root, path);
    else if (s.isFile()) yield { ...base, kind: "file", hash: await fileHash(path) };
    else if (s.isSymbolicLink()) {
      const target = await readlink(path);
      yield { ...base, kind: "symlink", target, hash: hash(target) };
    } else if (s.isSocket()) yield { ...base, bytes: 0, kind: "socket" };
    else throw Error("unsupported filesystem entry prevents complete preservation: " + base.path);
  }
}
async function paths(input: string, work: string) {
  input = await realpath(input);
  work = resolve(work);
  let ancestor = work;
  while (!(await exists(ancestor))) ancestor = dirname(ancestor);
  work = resolve(await realpath(ancestor), relative(ancestor, work));
  if (work === input || work.startsWith(input + sep) || input.startsWith(work + sep))
    throw Error("preservation input/output must be separate trees");
  await mkdir(work, { recursive: true, mode: 0o700 });
  return { input, work };
}
export async function estimate(input: string) {
  input = await realpath(input);
  let bytes = 0,
    entries = 0;
  async function visit(path: string) {
    const s = await lstat(path);
    entries++;
    if (s.isFile()) bytes += s.size;
    else if (s.isDirectory())
      for await (const e of await opendir(path)) await visit(join(path, e.name));
    else if (!s.isSymbolicLink() && !s.isSocket())
      throw Error("unsupported filesystem entry: " + relative(input, path));
  }
  await visit(input);
  const disk = await statfs(input);
  return {
    input,
    entries,
    bytes,
    requiredBytes: Math.ceil(bytes * 2.7) + 2 * 1024 ** 3,
    availableBytes: disk.bavail * disk.bsize,
  };
}
async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
async function gitAudit(input: string, work: string, db: DatabaseSync) {
  let repositories = 0;
  const git =
    process.platform === "darwin" &&
    (await exists("/Library/Developer/CommandLineTools/usr/bin/git"))
      ? "/Library/Developer/CommandLineTools/usr/bin/git"
      : "git";
  for (const row of db.prepare("SELECT body FROM entries ORDER BY path").iterate()) {
    const e = JSON.parse(String(row.body)) as Entry;
    const path = join(input, e.path);
    const dot = e.path.split(sep).at(-1) === ".git";
    const bare =
      e.kind === "directory" &&
      (((await exists(join(path, "HEAD"))) && (await exists(join(path, "config")))) ||
        ((await exists(join(path, "objects"))) && (await exists(join(path, "refs")))));
    if (!dot && !bare) continue;
    if (dot && e.kind === "file") {
      const marker = await readFile(path, "utf8");
      if (isAbsolute(marker.replace(/^gitdir:\s*/, "").trim()))
        throw Error(
          "absolute Git worktree marker requires explicit relocation handling: " + e.path,
        );
    }
    const cwd = dot ? dirname(path) : path;
    const args = ["-c", "core.fsmonitor=false", "-c", "maintenance.auto=false", "-C", cwd];
    const options = {
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
        ),
        GIT_OPTIONAL_LOCKS: "0",
        GIT_NO_LAZY_FETCH: "1",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 300000,
    };
    const gitdir = (
      await exec(git, [...args, "rev-parse", "--absolute-git-dir"], options)
    ).stdout.trim();
    const common = (
      await exec(git, [...args, "rev-parse", "--path-format=absolute", "--git-common-dir"], options)
    ).stdout.trim();
    if (await exists(join(gitdir, "commondir"))) {
      if (isAbsolute((await readFile(join(gitdir, "commondir"), "utf8")).trim()))
        throw Error(
          "absolute Git common directory requires explicit relocation handling: " + e.path,
        );
    }
    for (const dependency of [gitdir, common]) {
      const actual = await realpath(dependency);
      if (actual !== input && !actual.startsWith(input + sep))
        throw Error("external Git storage must be preserved explicitly: " + actual);
    }
    for (const row of db
      .prepare("SELECT body FROM entries WHERE json_extract(body,'$.kind')='symlink'")
      .iterate()) {
      const entry = JSON.parse(String(row.body)) as Entry,
        path = join(input, entry.path);
      if ([gitdir, common].some((root) => path === root || path.startsWith(root + sep)))
        throw Error("Git storage symlinks require explicit dependency preservation: " + entry.path);
    }
    if (await exists(join(common, "shallow")))
      throw Error("shallow Git repository lacks complete history: " + e.path);
    if (await exists(join(common, "objects/info/alternates")))
      throw Error("Git alternates require explicit dependency preservation: " + e.path);
    // Promisor packs may represent missing remotely stored history; never certify them silently.
    if (await exists(join(common, "objects/pack"))) {
      for await (const f of await opendir(join(common, "objects/pack")))
        if (f.name.endsWith(".promisor"))
          throw Error("partial Git clone cannot certify full history: " + e.path);
    }
    try {
      const result = await exec(git, [...args, "fsck", "--full", "--strict"], options);
      await atomic(join(work, "git", hash(e.path) + ".json"), {
        path: e.path,
        gitdir: relative(input, gitdir),
        common: relative(input, common),
        verified: true,
        diagnostics: result.stdout + result.stderr,
      });
    } catch (error) {
      throw Error("Git object integrity verification failed: " + e.path, { cause: error });
    }
    repositories++;
  }
  return repositories;
}
export async function preserve(input: string, work: string) {
  ({ input, work } = await paths(input, work));
  const capacity = await estimate(input),
    disk = await statfs(work);
  const existing = await exists(join(work, "preservation.sqlite"));
  if (!existing && capacity.requiredBytes > disk.bavail * disk.bsize)
    throw Error("insufficient space for complete preservation: " + JSON.stringify(capacity));
  const lock = await Lock.acquire(join(work, "preservation.lock"));
  const db = new DatabaseSync(join(work, "preservation.sqlite"));
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS entries(path TEXT PRIMARY KEY,body TEXT NOT NULL,digest TEXT NOT NULL); CREATE TABLE IF NOT EXISTS binding(input TEXT NOT NULL)",
    );
    const binding = db.prepare("SELECT input FROM binding").get();
    if (binding && binding.input !== input)
      throw Error("preservation checkpoint belongs to a different input");
    if (!binding) db.prepare("INSERT INTO binding VALUES(?)").run(input);
    await atomic(join(work, "report.json"), {
      complete: false,
      scope: "local files and available Git history",
      input,
    });
    const content = new Content(db, work);
    await mkdir(join(work, "content"), { recursive: true, mode: 0o700 });
    let count = 0;
    for await (const entry of walk(input)) {
      const id = hash(entry.path),
        mirror = join(work, "content", id + ".jsonl");
      if (entry.kind === "file")
        await content.capture(id, join(input, entry.path), entry.hash!, mirror);
      if (entry.kind === "symlink") await content.link(id, entry.target!, mirror);
      const body = JSON.stringify(entry);
      db.prepare("INSERT OR REPLACE INTO entries VALUES(?,?,?)").run(entry.path, body, hash(body));
      if (++count % 1000 === 0)
        console.error(JSON.stringify({ type: "preservation", entries: count }));
    }
    await publish(
      join(work, "inventory.jsonl"),
      (function* () {
        for (const r of db.prepare("SELECT body FROM entries ORDER BY path").iterate())
          yield String(r.body) + "\n";
      })(),
    );
  } finally {
    db.close();
    await lock.close();
  }
  return verify(input, work);
}
export async function verify(input: string, work: string) {
  ({ input, work } = await paths(input, work));
  const lock = await Lock.acquire(join(work, "preservation.lock"));
  const db = new DatabaseSync(join(work, "preservation.sqlite"));
  try {
    await atomic(join(work, "report.json"), {
      complete: false,
      input,
      scope: "local files and available Git history",
    });
    const content = new Content(db, work);
    let entries = 0,
      bytes = 0;
    for await (const entry of walk(input)) {
      const row = db.prepare("SELECT body,digest FROM entries WHERE path=?").get(entry.path);
      if (
        !row ||
        hash(String(row.body)) !== row.digest ||
        String(row.body) !== JSON.stringify(entry)
      )
        throw Error("source inventory changed or corrupt: " + entry.path);
      if (entry.hash) {
        await content.verify(hash(entry.path), entry.hash);
        bytes += entry.bytes;
      }
      entries++;
    }
    if (entries !== db.prepare("SELECT count(*) n FROM entries").get()!.n)
      throw Error("source inventory has missing entries");
    // Compare the serialized inventory too: no pointers can substitute for content mirrors.
    const { createHash } = await import("node:crypto");
    const digest = createHash("sha256");
    for (const r of db.prepare("SELECT body FROM entries ORDER BY path").iterate())
      digest.update(String(r.body) + "\n");
    if (digest.digest("hex") !== (await fileHash(join(work, "inventory.jsonl"))))
      throw Error("inventory JSONL hash mismatch");
    const repositories = await gitAudit(input, work, db);
    // A certified archive must open without creating WAL/SHM sidecars during read-only restore.
    db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
    const report = {
      complete: true,
      scope: "local files and available Git history",
      input,
      entries,
      bytes,
      repositories,
      transientSockets: Number(
        db
          .prepare("SELECT count(*) n FROM entries WHERE json_extract(body,'$.kind')='socket'")
          .get()!.n,
      ),
      hostedHistory: false,
      inventoryHash: await fileHash(join(work, "inventory.jsonl")),
      verifiedAt: new Date().toISOString(),
    };
    await atomic(join(work, "report.json"), report);
    return report;
  } finally {
    db.close();
    await lock.close();
  }
}
export async function restore(work: string, output: string) {
  work = await realpath(work);
  output = resolve(output);
  if (await exists(output)) throw Error("restore destination must not exist");
  const db = new DatabaseSync(join(work, "preservation.sqlite"), { readOnly: true });
  try {
    const report = JSON.parse(await readFile(join(work, "report.json"), "utf8"));
    if (
      report.complete !== true ||
      report.entries !== db.prepare("SELECT count(*) n FROM entries").get()!.n ||
      report.inventoryHash !== (await fileHash(join(work, "inventory.jsonl")))
    )
      throw Error("restore requires a complete verified preservation report");
    const content = new Content(db, work);
    await mkdir(output, { mode: 0o700 });
    for (const row of db.prepare("SELECT body,digest FROM entries ORDER BY path").iterate()) {
      if (hash(String(row.body)) !== row.digest) throw Error("corrupt inventory");
      const e = JSON.parse(String(row.body)) as Entry,
        p = resolve(output, e.path);
      if (p !== output && !p.startsWith(output + sep)) throw Error("unsafe restore path");
      if (e.kind === "directory") {
        await mkdir(p, { recursive: true, mode: 0o700 });
        continue;
      }
      if (e.kind === "socket") continue; // Recorded metadata only; live kernel IPC has no file contents.
      // A previously restored symlink must never redirect a later restore write.
      let parent = dirname(p);
      while (parent !== output) {
        if ((await lstat(parent)).isSymbolicLink()) throw Error("symlink restore ancestor");
        parent = dirname(parent);
      }
      await content.verify(hash(e.path), e.hash!);
      if (e.kind === "symlink") await symlink(e.target!, p);
      else {
        const f = await open(p, "wx", 0o600);
        try {
          for (const part of content.parts(e.hash!)) await f.writeFile(part);
          await f.sync();
        } finally {
          await f.close();
        }
        await chmod(p, e.mode);
      }
    }
    for (const row of db.prepare("SELECT body FROM entries ORDER BY length(path) DESC").iterate()) {
      const e = JSON.parse(String(row.body)) as Entry;
      if (e.kind === "directory") await chmod(join(output, e.path), e.mode);
    }
  } finally {
    db.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, input, work] = process.argv.slice(2);
  if (command === "estimate" && input) {
    console.log(JSON.stringify(await estimate(input)));
    process.exit(0);
  }
  if (!input || !work)
    throw Error(
      "Usage: node pipeline/preserve.ts capture|verify /input /work OR restore /work /new-directory",
    );
  if (!process.argv.includes("--sandboxed") && command === "restore") {
    if (process.platform !== "darwin") throw Error("verified restore sandbox requires macOS");
    const source = await realpath(input),
      destination = join(await realpath(dirname(resolve(work))), basename(resolve(work)));
    if (await exists(destination)) throw Error("restore destination must not exist");
    const parent = await realpath(dirname(destination));
    if (
      parent !== dirname(destination) ||
      destination.startsWith(source + sep) ||
      source.startsWith(destination + sep)
    )
      throw Error("unsafe restore destination");
    const policy = `(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (subpath ${JSON.stringify(destination)}))`;
    const child = spawn(
      "/usr/bin/sandbox-exec",
      [
        "-p",
        policy,
        process.execPath,
        process.argv[1],
        command,
        source,
        destination,
        "--sandboxed",
      ],
      {
        stdio: "inherit",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", PYTHONDONTWRITEBYTECODE: "1" },
      },
    );
    process.exit(
      await new Promise<number>((ok, no) => {
        child.once("error", no);
        child.once("exit", (code) => ok(code ?? 1));
      }),
    );
  }
  if (!process.argv.includes("--sandboxed")) {
    if (process.platform !== "darwin") throw Error("verified preservation sandbox requires macOS");
    const bound = await paths(input, work);
    const child = spawn(
      "/usr/bin/sandbox-exec",
      [
        "-p",
        await policy(bound.input, bound.work),
        process.execPath,
        process.argv[1],
        command,
        bound.input,
        bound.work,
        "--sandboxed",
      ],
      {
        stdio: "inherit",
        env: {
          PATH: "/usr/bin:/bin",
          HOME: bound.work,
          TMPDIR: bound.work,
          PYTHONDONTWRITEBYTECODE: "1",
        },
      },
    );
    process.exit(
      await new Promise<number>((ok, no) => {
        child.once("error", no);
        child.once("exit", (code) => ok(code ?? 1));
      }),
    );
  }
  {
    const { assertNetworkDenied } = await import("./sandbox.ts");
    await assertNetworkDenied();
  }
  const report =
    command === "capture"
      ? await preserve(input, work)
      : command === "verify"
        ? await verify(input, work)
        : command === "restore"
          ? await restore(input, work)
          : (() => {
              throw Error("unknown preservation command");
            })();
  console.log(JSON.stringify(report ?? { restored: true }));
}
