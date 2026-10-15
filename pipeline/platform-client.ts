/** Optional native binding. Opening never migrates, starts a worker, or invokes a model. */
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Guest, settings, type Mac } from "./macos.ts";
import { Platform } from "./platform.ts";
type Pin = { path: string; sha256: string };
export type Binding = { mac: Mac; node: Pin; entry: Pin };
export function binding(value: unknown): Binding {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("invalid guest binding");
  const v = value as Binding;
  if (Object.keys(v).some((k) => !["mac", "node", "entry"].includes(k)))
    throw Error("invalid guest binding");
  settings(v.mac);
  for (const pin of [v.node, v.entry]) {
    if (
      !pin ||
      Object.keys(pin).some((k) => !["path", "sha256"].includes(k)) ||
      typeof pin.path !== "string" ||
      !isAbsolute(pin.path) ||
      pin.path === "/" ||
      pin.path.includes("\0") ||
      pin.path.split("/").some((s) => s === ".." || s === ".") ||
      !/^[a-f0-9]{64}$/.test(pin.sha256)
    )
      throw Error("pinned absolute guest entry required");
  }
  return structuredClone(v);
}
const actions = new Set([
  "health",
  "capabilities",
  "registry",
  "flows",
  "preview",
  "publish",
  "run",
  "status",
  "pause",
  "resume",
]);
export async function dispatch(
  platform: Pick<Platform, "command">,
  action: unknown,
  input: unknown = {},
): Promise<unknown> {
  if (typeof action !== "string" || !actions.has(action))
    throw Error("unsupported native platform action");
  return platform.command(action, input);
}
export async function request(
  path: string,
  action: unknown,
  input: unknown = {},
  options: { guest?: Binding } = {},
): Promise<unknown> {
  if (
    !isAbsolute(path) ||
    path.includes("\0") ||
    path.split("/").some((s) => s === ".." || s === ".")
  )
    throw Error("absolute platform configuration required");
  if (typeof action !== "string" || !actions.has(action))
    throw Error("unsupported native platform action");
  if (options.guest) {
    const target = binding(options.guest),
      guest = new Guest(target.mac);
    const verify = async () => {
      for (const pin of [target.node, target.entry]) {
        const output = await guest.execute(["/usr/bin/shasum", "-a", "256", pin.path]);
        if (output.trim().split(/\s+/)[0] !== pin.sha256)
          throw Error("guest entry digest mismatch");
      }
    };
    const payload = JSON.stringify({ action, input });
    if (Buffer.byteLength(payload) > 2 * 1024 ** 2)
      throw Error("platform request exceeds 2 MiB bound");
    await verify();
    const response = await guest.pipe([target.node.path, target.entry.path, path], payload);
    await verify();
    return JSON.parse(response);
  }
  const bytes = await readFile(path);
  if (bytes.length > 2 * 1024 ** 2) throw Error("platform configuration exceeds 2 MiB");
  const platform = await Platform.open(JSON.parse(bytes.toString("utf8")));
  try {
    return await dispatch(platform, action, input);
  } finally {
    await platform.close();
  }
}
