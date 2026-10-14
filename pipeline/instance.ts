import { readFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { Release } from "./release.ts";
import { configure, type Options } from "./config.ts";
import { boundaries } from "./run.ts";
import { fileHash, seal } from "./seal.ts";

const [command, path, target] = process.argv.slice(2);
if (command === "verify" && path) {
  const release = new Release(path);
  const manifest = await release.verify();
  console.log(JSON.stringify({ valid: true, ...manifest }));
} else if (command === "stage" && path && target) {
  const directory = dirname(resolve(path));
  const options = JSON.parse(await readFile(resolve(path), "utf8")) as Options;
  options.input = resolve(directory, options.input);
  const instance = resolve(target);
  await boundaries(options.input, instance);
  options.work = join(instance, "work");
  for (const key of ["runtime", "base", "package"] as const)
    if (options.mlx[key]) options.mlx[key] = resolve(directory, options.mlx[key]!);
  if (Object.keys(options.mlx.adapters).length)
    throw Error("instances require packaged roles, without adapters");
  if (typeof options.profile === "string")
    options.profile = JSON.parse(await readFile(resolve(directory, options.profile), "utf8"));
  if (options.extractor)
    options.extractor.directory = resolve(directory, options.extractor.directory);
  const config = configure(
    options,
    JSON.parse(await readFile(join(import.meta.dirname, "../config/residency.json"), "utf8")),
  );
  const bindings: Record<string, unknown> = {
    node: { path: process.execPath, hash: await fileHash(process.execPath) },
  };
  for (const key of ["runtime", "base", "package"] as const) {
    const root = config.mlx[key];
    if (root) bindings[key] = { path: root, hash: (await seal(root, key === "runtime")).hash };
  }
  if (config.extractor)
    bindings.extractor = {
      path: config.extractor.directory,
      hash: (await seal(config.extractor.directory)).hash,
    };
  const release = await Release.create(resolve(import.meta.dirname, ".."), instance, {
    ...config,
    bindings,
    isolation: {
      kind: "vm",
      state: "unverified",
      reason: "VM backend compatibility must pass before activation",
    },
  });
  console.log(
    JSON.stringify({
      staged: true,
      active: false,
      path: release.root,
      ...(await release.verify()),
      limitation:
        "Application and configuration frozen. External model/runtime bindings are sealed references, not VM-private copies. Activation is unavailable until VM integration passes.",
    }),
  );
} else
  throw Error(
    "Usage: node pipeline/instance.ts stage /absolute/config.json /absolute/new-instance | verify /absolute/instance",
  );
