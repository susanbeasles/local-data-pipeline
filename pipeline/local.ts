import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
/** Machine bindings come from local configuration; defaults refer only to this checkout. */
export function assets(env: NodeJS.ProcessEnv = process.env) {
  const root = resolve(import.meta.dirname, "..");
  const file = env.PIPELINE_CONFIG ? resolve(env.PIPELINE_CONFIG) : undefined;
  const config = file ? JSON.parse(readFileSync(file, "utf8")) : {};
  const directory = file ? dirname(file) : root;
  const value = (key: string, variable: string, fallback: string) => {
    const selected = env[variable] ?? config.mlx?.[key];
    if (selected !== undefined && (typeof selected !== "string" || !selected.trim()))
      throw Error("invalid local asset path: " + key);
    return selected ? resolve(directory, selected) : join(root, fallback);
  };
  return {
    runtime: value("runtime", "PIPELINE_RUNTIME", ".venv"),
    base: value("base", "PIPELINE_BASE", "models/qwen2.5-3b"),
    package: value("package", "PIPELINE_PACKAGE", "models/qwen-roles-v14"),
  };
}
