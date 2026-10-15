import { cp, mkdir, writeFile, readFile, readdir, chmod, realpath, lstat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { seal, fileHash } from "./seal.ts";
type Manifest = { format: "pipeline-release/1"; hash: string };
/** A version snapshot, not a security boundary against its host owner. */
export class Release {
  root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  static async create(source: string, target: string, config: unknown) {
    source = await realpath(source);
    target = resolve(target);
    const parent = await realpath(resolve(target, ".."));
    target = join(parent, target.split(sep).at(-1)!);
    if (target === source || target.startsWith(source + sep) || source.startsWith(target + sep))
      throw Error("release/source overlap");
    // Reject aliases and special files before copying. Capture bytes, never live symlinks.
    const names = ["pipeline", "config", "package.json", "package-lock.json"];
    const pkg=JSON.parse(await readFile(join(source,'package.json'),'utf8')),
      lock=JSON.parse(await readFile(join(source,'package-lock.json'),'utf8'));
    if(Object.keys(pkg.dependencies??{}).length&&!lock.packages)throw Error('installed locked runtime dependencies required');
    const dependencies=Object.entries(lock.packages??{}).filter(([name,value])=>name&&!(value as {dev?:boolean}).dev).map(([name,value])=>{
      const entry=value as {link?:boolean;version?:string};
      if(!name.startsWith('node_modules/')||name.split('/').some(part=>!part||part==='.'||part==='..')||entry.link||!entry.version)throw Error('unsupported runtime dependency path or link');
      return {name,version:entry.version};
    });
    for(const dep of dependencies){
      const path=join(source,dep.name);
      if(await realpath(path)!==path||(await lstat(path)).isSymbolicLink())throw Error('runtime dependency aliases are not immutable');
      const installed=JSON.parse(await readFile(join(path,'package.json'),'utf8'));
      if(installed.version!==dep.version)throw Error('runtime dependency version differs from lock');
    }
    names.push(...dependencies.map(d=>d.name).filter(name=>!dependencies.some(d=>name.startsWith(d.name+'/'))));
    const digest = async (root: string, name: string) =>
      ["pipeline", "config"].includes(name)||name.startsWith('node_modules/')
        ? (await seal(join(root, name))).hash
        : fileHash(join(root, name));
    const before = new Map<string, string>();
    for (const name of names) before.set(name, await digest(source, name));
    await mkdir(target); // Exclusive: existing instances are never overwritten.
    const payload = join(target, "payload");
    await mkdir(payload);
    for (const name of names)
      await cp(join(source, name), join(payload, name), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    for (const name of names) {
      if (
        (await digest(source, name)) !== before.get(name) ||
        (await digest(payload, name)) !== before.get(name)
      )
        throw Error("source changed while staging release");
    }
    await writeFile(join(payload, "instance.json"), JSON.stringify(config, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    const actual = await seal(payload);
    await writeFile(
      join(target, "release.json"),
      JSON.stringify({ format: "pipeline-release/1", hash: actual.hash }) + "\n",
      { flag: "wx", mode: 0o444 },
    );
    async function freeze(path: string) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const file = join(path, entry.name);
        if (entry.isDirectory()) await freeze(file);
        else await chmod(file, 0o444);
      }
      await chmod(path, 0o555);
    }
    await freeze(payload);
    const release = new Release(target);
    await release.verify();
    return release;
  }
  async verify() {
    const manifest = JSON.parse(
      await readFile(join(this.root, "release.json"), "utf8"),
    ) as Manifest;
    if (
      manifest.format !== "pipeline-release/1" ||
      !/^[a-f0-9]{64}$/.test(manifest.hash) ||
      (await seal(join(this.root, "payload"))).hash !== manifest.hash
    )
      throw Error("release integrity mismatch");
    return manifest;
  }
}
