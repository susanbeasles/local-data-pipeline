import { outsideProject } from "./storage.ts";
import { readFile, lstat, realpath, access } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { seal, fileHash } from "./seal.ts";
import { roles, order, inputs, generation, type Role } from "./roles.ts";
import {
  profile as validateProfile,
  artifact,
  type Profile,
} from "./profile.ts";
import { atomic, hash } from "./store.ts";
export type Manifest = {
  format: "local-role/1";
  profile?: Profile;
  base: { path: string; hash: string; files: Record<string, string> };
  roles: { role: string; path: string; hash: string }[];
  weightChanges: false;
  adapter: null;
};
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return join(await canonical(resolve(path, "..")), path.split(sep).at(-1)!);
  }
}
export async function pack(
  base: string,
  destination: string,
  custom?: Profile,
) {
  base = await realpath(base);
  destination = await canonical(resolve(destination));
  await outsideProject(destination);
  if (
    destination === base ||
    destination.startsWith(base + sep) ||
    base.startsWith(destination + sep)
  )
    throw Error("role package and base must be separate");
  try {
    await access(join(destination, "manifest.json"));
    throw Error("role package already exists");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const spec = custom ? validateProfile(custom) : undefined;
  const sealed = await seal(base),
    entries = [];
  for (const role of spec ? spec.stages.map((s) => s.name) : order) {
    const path = join(role, "model.json");
    await atomic(
      join(destination, path),
      spec
        ? artifact(
            spec.stages.find((s) => s.name === role)!,
            spec.stages
              .slice(
                0,
                spec.stages.findIndex((s) => s.name === role),
              )
              .map((s) => s.name),
            { path: base, hash: sealed.hash },
          )
        : {
            format: "local-role/1",
            role,
            base: { path: base, hash: sealed.hash },
            system: roles[role as Role].system,
            input: inputs[role as Role],
            ...generation(role as Role),
            temperature: 0,
            thinking: false,
            weightChanges: false,
            adapter: null,
          },
    );
    entries.push({ role, path, hash: await fileHash(join(destination, path)) });
  }
  const manifest: Manifest = {
    format: "local-role/1",
    base: { path: base, ...sealed },
    roles: entries,
    ...(spec ? { profile: spec } : {}),
    weightChanges: false,
    adapter: null,
  };
  await atomic(join(destination, "manifest.json"), manifest);
  return manifest;
}
export async function inspect(directory: string, base: string) {
  directory = await realpath(directory);
  base = await realpath(base);
  const m = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  ) as Manifest;
  const spec = m.profile ? validateProfile(m.profile) : undefined;
  if (
    m.format !== "local-role/1" ||
    m.weightChanges !== false ||
    m.adapter !== null ||
    m.base.path !== base ||
    m.roles.map((r) => r.role).join(",") !==
      (spec ? spec.stages.map((s) => s.name) : order).join(",")
  )
    throw Error("invalid role package");
  const actual = await seal(base);
  if (
    actual.hash !== m.base.hash ||
    JSON.stringify(Object.entries(actual.files).sort()) !==
      JSON.stringify(Object.entries(m.base.files).sort())
  )
    throw Error("base weight integrity mismatch");
  for (const entry of m.roles) {
    const file = join(directory, entry.path);
    if (
      entry.path !== join(entry.role, "model.json") ||
      !(await lstat(join(directory, entry.role))).isDirectory() ||
      !(await lstat(file)).isFile() ||
      (await realpath(file)) !== file ||
      (await fileHash(file)) !== entry.hash
    )
      throw Error("role artifact integrity mismatch");
    const value = JSON.parse(await readFile(file, "utf8")),
      expected = spec
        ? artifact(
            spec.stages.find((s) => s.name === entry.role)!,
            spec.stages
              .slice(
                0,
                spec.stages.findIndex((s) => s.name === entry.role),
              )
              .map((s) => s.name),
            { path: base, hash: m.base.hash },
          )
        : {
            format: "local-role/1",
            role: entry.role,
            base: { path: base, hash: m.base.hash },
            system: roles[entry.role as Role].system,
            input: inputs[entry.role as Role],
            ...generation(entry.role as Role),
            temperature: 0,
            thinking: false,
            weightChanges: false,
            adapter: null,
          };
    if (JSON.stringify(value) !== JSON.stringify(expected))
      throw Error("role artifact configuration mismatch");
  }
  return { ...m, identity: hash(JSON.stringify(m)) };
}
if (process.argv[1] === import.meta.filename) {
  const [base, out, profilePath] = process.argv.slice(2);
  if (!base || !out)
    throw Error(
      "Usage: node pipeline/package.ts /local/model /outside-input/roles",
    );
  const m = await pack(
    base,
    out,
    profilePath
      ? validateProfile(
          JSON.parse(await readFile(resolve(profilePath), "utf8")),
        )
      : undefined,
  );
  console.log(
    JSON.stringify({
      format: m.format,
      roles: m.roles.map((r) => r.role),
      baseHash: m.base.hash,
      weightChanges: false,
    }),
  );
}
