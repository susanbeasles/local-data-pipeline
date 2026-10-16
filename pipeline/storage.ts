/** macOS installation storage policy. Never stores runtime data in application code. */
import { homedir } from "node:os";
import { join, resolve, dirname, sep } from "node:path";
import { lstat, realpath, mkdir, writeFile, readFile, chmod, chown } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
export type Mode = "standard" | "hardened";
export type Layout = {
  mode: Mode;
  data: string;
  cache: string;
  logs: string;
  account: string | null;
};
export function validateMode(value: unknown): Mode {
  if (value !== "standard" && value !== "hardened")
    throw Error("installation mode must be standard or hardened");
  return value;
}
export function layout(mode: Mode, home = homedir()): Layout {
  validateMode(mode);
  const library = mode === "hardened" ? "/Library" : join(resolve(home), "Library");
  return {
    mode,
    data: join(library, "Application Support/LocalDataPipeline"),
    cache: join(library, "Caches/LocalDataPipeline"),
    logs: join(library, "Logs/LocalDataPipeline"),
    account: mode === "hardened" ? "_pipeline" : null,
  };
}
const inside = (root: string, path: string) => path === root || path.startsWith(root + sep);
async function unaliased(path: string) {
  let part = resolve(path);
  while (true) {
    const info = await lstat(part).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
      return null;
    });
    if (info?.isSymbolicLink()) throw Error("aliased storage path");
    if (part === dirname(part)) break;
    part = dirname(part);
  }
}
async function location(path: string, project: string) {
  await unaliased(path);
  await unaliased(project);
  if (inside(project, path) || inside(path, project))
    throw Error("runtime storage and project checkout must be separate");
  // A separately nested Git checkout must not become a data destination either.
  let parent = path;
  while (parent !== dirname(parent)) {
    if (
      await lstat(join(parent, ".git")).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
        return null;
      })
    )
      throw Error("runtime storage cannot be inside a project checkout");
    parent = dirname(parent);
  }
}
export class Storage {
  readonly paths: Layout;
  readonly project: string;
  constructor(paths: Layout, project: string) {
    this.paths = paths;
    this.project = resolve(project);
  }
  async create(uid: number, gid = process.getgid?.() ?? -1) {
    if (!Number.isSafeInteger(uid) || uid < 1) throw Error("non-root storage owner required");
    if (this.paths.mode === "hardened" && process.getuid?.() !== 0)
      throw Error("hardened installation requires administrator/root provisioning");
    if (this.paths.mode === "standard" && uid !== process.getuid?.())
      throw Error("standard storage must belong to the installing user");
    const roots = [this.paths.data, this.paths.cache, this.paths.logs];
    for (const path of roots) {
      await location(resolve(path), this.project);
      if (
        await lstat(path).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== "ENOENT") throw e;
          return null;
        })
      )
        throw Error("storage already exists; verify the installed mode instead of replacing it");
    }
    for (const path of roots) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await mkdir(path, { mode: 0o700 });
      if (process.platform === "darwin") await promisify(execFile)("/bin/chmod", ["-N", path]);
      await chmod(path, 0o700);
      if (process.getuid?.() === 0) await chown(path, uid, gid);
    }
    const file = join(this.paths.data, "installation.json");
    await writeFile(
      file,
      JSON.stringify({
        format: "pipeline-installation/1",
        mode: this.paths.mode,
        paths: this.paths,
        owner: uid,
        group: gid,
        created: new Date().toISOString(),
        runtime: "not-configured",
      }) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    if (process.getuid?.() === 0) await chown(file, uid, gid);
    return this.verify(uid);
  }
  async verify(uid: number) {
    for (const path of [this.paths.data, this.paths.cache, this.paths.logs]) {
      await location(resolve(path), this.project);
      const info = await lstat(path);
      if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o777) !== 0o700)
        throw Error("storage ownership or permissions mismatch");
      if (process.platform === "darwin") {
        const { stdout } = await promisify(execFile)("/bin/ls", ["-lde", path]);
        if (
          stdout
            .split("\n")
            .slice(1)
            .some((line) => /\ballow\b/.test(line))
        )
          throw Error("storage ACL grants additional access");
      }
    }
    const file = join(this.paths.data, "installation.json");
    await unaliased(file);
    const info = await lstat(file);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== uid || (info.mode & 0o777) !== 0o600)
      throw Error("installation record ownership or permissions mismatch");
    const record = JSON.parse(await readFile(file, "utf8"));
    if (
      record.format !== "pipeline-installation/1" ||
      record.mode !== this.paths.mode ||
      record.owner !== uid ||
      JSON.stringify(record.paths) !== JSON.stringify(this.paths)
    )
      throw Error("installation identity mismatch");
    return record;
  }
}
export async function outsideProject(path: string, project = resolve(import.meta.dirname, "..")) {
  let target = resolve(path);
  for (const [alias, actual] of [
    ["/var", "/private/var"],
    ["/tmp", "/private/tmp"],
    ["/etc", "/private/etc"],
  ]) {
    if ((target === alias || target.startsWith(alias + sep)) && (await realpath(alias)) === actual)
      target = actual + target.slice(alias.length);
  }
  await location(target, await realpath(project));
  return resolve(path);
}
