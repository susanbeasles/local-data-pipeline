import { createHash } from "node:crypto";
import { access, lstat, mkdir, opendir, readFile, realpath, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { arch, hostname, platform, totalmem } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Guest, settings, type Mac } from "./macos.ts";
import { fileHash, seal } from "./seal.ts";

const exec = promisify(execFile);
const GiB = 1024 ** 3;
export type Pin = { path: string; sha256: string };
export type Paths = { input: string; staging: string; state: string; models: string; output: string };
export type Config = {
  format: "pipeline-provision-config/1";
  storage: Paths;
  control: { root: string };
  executor: { mac: Mac; runner: Pin };
  metadata: { placement: "pipeline.executor"; bootstrap: null | { node: Pin; entry: Pin; config: Record<string, unknown> } };
  model?: { root: string; sha256: string };
  runtime?: { root: string; sha256: string };
};
export type Observation = {
  id: string;
  kind: string;
  identity: string;
  configuration: string;
  qualified: boolean;
  observedAt: string;
  evidence: Record<string, unknown>;
};
export type Request = { format: "pipeline-provision-request/1"; operation: "provision" | "inspect"; spec: string; request: string; config: Config };
export type Receipt = { format: "pipeline-infra-receipt/1"; spec: string; request: string; resources: Observation[]; qualification: { vm: false; inference: false } };

function record(value: unknown, keys: string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key)) ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some((descriptor) => !Object.hasOwn(descriptor, "value") || !descriptor.enumerable))
    throw Error("Invalid " + label);
}
function path(value: unknown): asserts value is string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value === "/" || value.includes("\0"))
    throw Error("Explicit absolute resource path required");
}
function hash(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw Error("SHA-256 digest required");
}
function pin(value: unknown): asserts value is Pin {
  record(value, ["path", "sha256"], "executable pin"); path(value.path); hash(value.sha256);
}
const contains = (parent: string, child: string) => parent === child || child.startsWith(parent + sep);
export function configuration(value: unknown): string {
  const sorted = (item: unknown): unknown => Array.isArray(item) ? item.map(sorted) : item && typeof item === "object" ?
    Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, sorted(child)])) : item;
  return createHash("sha256").update(JSON.stringify(sorted(value))).digest("hex");
}
export function config(value: unknown): Config {
  record(value, ["format", "storage", "control", "executor", "metadata", "model", "runtime"], "provision config");
  if (value.format !== "pipeline-provision-config/1") throw Error("Unknown provision config");
  record(value.storage, ["input", "staging", "state", "models", "output"], "storage paths");
  for (const key of ["input", "staging", "state", "models", "output"]) path(value.storage[key]);
  const paths = Object.values(value.storage) as string[];
  for (let a = 0; a < paths.length; a++) for (let b = a + 1; b < paths.length; b++)
    if (contains(paths[a], paths[b]) || contains(paths[b], paths[a])) throw Error("Storage paths overlap the corpus or another resource");
  record(value.control, ["root"], "control resource"); path(value.control.root);
  record(value.executor, ["mac", "runner"], "executor resource");
  const mac = settings(value.executor.mac); pin(value.executor.runner);
  if (mac.runner !== value.executor.runner.path || mac.memoryBytes + 4 * GiB > 32 * GiB ||
      !contains(value.storage.state as string, mac.home) || !contains(value.storage.state as string, value.control.root))
    throw Error("Executor/control must use owned state and the shared 32 GiB memory budget");
  record(value.metadata, ["placement", "bootstrap"], "metadata resource");
  if (value.metadata.placement !== "pipeline.executor") throw Error("Metadata placement must be the confined executor");
  if (value.metadata.bootstrap !== null) {
    record(value.metadata.bootstrap, ["node", "entry", "config"], "guest bootstrap");
    pin(value.metadata.bootstrap.node); pin(value.metadata.bootstrap.entry);
    if (!value.metadata.bootstrap.config || typeof value.metadata.bootstrap.config !== "object" || Array.isArray(value.metadata.bootstrap.config))
      throw Error("Guest bootstrap config required");
  }
  for (const key of ["model", "runtime"] as const) if (value[key] !== undefined) {
    record(value[key], ["root", "sha256"], key + " resource"); path(value[key].root); hash(value[key].sha256);
    if (contains(value.storage.input as string, value[key].root) || contains(value[key].root, value.storage.input as string)) throw Error("Runtime/model must remain outside the corpus");
  }
  return structuredClone(value) as Config;
}

async function canonical(value: string): Promise<void> {
  path(value);
  let parent = value;
  while (true) {
    try { if (await realpath(parent) !== parent) throw Error("Resource path aliases are forbidden"); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const next = dirname(parent); if (next === parent) throw Error("No canonical resource ancestor"); parent = next;
  }
}
async function directory(value: string, create: boolean) {
  await canonical(value);
  if (create) await mkdir(value, { recursive: true, mode: 0o700 });
  const stat = await lstat(value);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) || (process.getuid && stat.uid !== process.getuid()))
    throw Error("Resource directory must be owned and protected: " + value);
  return { path: await realpath(value), device: stat.dev, inode: stat.ino, mode: stat.mode & 0o777 };
}
async function verified(value: Pin): Promise<void> {
  await canonical(value.path); await access(value.path, constants.X_OK);
  if (await fileHash(value.path) !== value.sha256) throw Error("Executable digest integrity mismatch");
}
const observation = (id: string, kind: string, identity: string, value: unknown, qualified: boolean, evidence: Record<string, unknown>): Observation =>
  ({ id, kind, identity, configuration: configuration(value), qualified, observedAt: new Date().toISOString(), evidence });

export class Storage {
  private readonly paths: Paths;
  constructor(paths: Paths) {
    // Reuse the path validator without coupling storage to a VM or operator binaries.
    const values = Object.values(paths);
    for (const value of values) path(value);
    for (const a of values) for (const b of values) if (a !== b && (contains(a, b) || contains(b, a))) throw Error("Storage paths overlap the corpus");
    if (new Set(values).size !== 5) throw Error("Storage paths must be separate");
    this.paths = { ...paths };
  }
  private async observe(create: boolean): Promise<Observation> {
    // Inspect every ancestor before the first write, including not-yet-created children of aliases.
    for (const value of Object.values(this.paths)) await canonical(value);
    const input = await directory(this.paths.input, false);
    const roots: Record<string, unknown> = { input };
    for (const key of ["staging", "state", "models", "output"] as const) roots[key] = await directory(this.paths[key], create);
    return observation("pipeline.storage", "local.storage", "storage:" + configuration(roots), this.paths, true, { roots, inputReadOnly: true });
  }
  provision() { return this.observe(true); }
  inspect() { return this.observe(false); }
}

export class Executor {
  private readonly config: Config;
  constructor(value: Config) { this.config = config(value); }
  private async guest(create: boolean): Promise<Guest> {
    if (platform() !== "darwin" || arch() !== "arm64") throw Error("A local Apple Silicon macOS host is required");
    if (this.config.executor.mac.memoryBytes + 4 * GiB > totalmem()) throw Error("Insufficient shared host memory");
    await verified(this.config.executor.runner);
    await directory(this.config.executor.mac.home, create);
    return new Guest(this.config.executor.mac);
  }
  private marker() { return join(this.config.storage.state, "executor-" + this.config.executor.mac.name + ".json"); }
  private async observe(guest: Guest): Promise<Observation> {
    const value: unknown = await guest.inspect();
    if (!value || typeof value !== "object") throw Error("Unrecognized Tart VM observation");
    const vm = value as Record<string, unknown>, mac = this.config.executor.mac;
    // Tart get JSON reports Memory in MiB and Disk in decimal GB.
    if (vm.OS !== "darwin" || vm.CPU !== mac.cpus || vm.Memory !== mac.memoryBytes / 1024 ** 2 ||
        typeof vm.Disk !== "number" || vm.Disk * 1_000_000_000 < mac.diskBytes ||
        typeof vm.MACAddress !== "string" || !/^[a-f0-9:]{17}$/i.test(vm.MACAddress) || typeof vm.Running !== "boolean")
      throw Error("Observed VM identity or resource configuration mismatch");
    return observation("pipeline.executor", "macos.vm", "tart:" + mac.home + ":" + mac.name + ":" + vm.MACAddress,
      this.config.executor, false, { vm, image: mac.image, requiredNetwork: "private-zero-egress", isolationVerified: false, mlxVerified: false });
  }
  async inspect(): Promise<Observation> {
    const guest = await this.guest(false);
    const marker = JSON.parse(await readFile(this.marker(), "utf8")) as Observation;
    const current = await this.observe(guest);
    if (marker.identity !== current.identity || marker.configuration !== current.configuration)
      throw Error("VM image provenance or configuration integrity mismatch");
    return current;
  }
  async provision(): Promise<Observation> {
    const guest = await this.guest(true);
    let exists = false;
    try { await lstat(this.marker()); exists = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (exists) return this.inspect();
    try { await guest.inspect(); }
    catch (error) {
      if ((error as { code?: unknown }).code !== 1 || !/does not exist|not found/i.test(String((error as { stderr?: string }).stderr))) throw error;
      await guest.create();
      const mac = this.config.executor.mac;
      await exec(mac.runner, ["set", mac.name, "--disk-size", String(Math.ceil(mac.diskBytes / 1_000_000_000))], {
        env: { PATH: "/usr/bin:/bin", HOME: mac.home, TART_HOME: mac.home, TART_NO_AUTO_PRUNE: "1", TART_NO_TELEMETRY: "1" }, timeout: 120000, maxBuffer: 1024 ** 2,
      });
      const current = await this.observe(guest);
      await writeFile(this.marker(), JSON.stringify(current) + "\n", { flag: "wx", mode: 0o600 });
      return current;
    }
    throw Error("Existing VM has no verified image provenance; explicit adoption is required");
  }
}

async function metadata(value: Config, operation: Request["operation"]): Promise<Observation> {
  const bootstrap = value.metadata.bootstrap;
  if (!bootstrap) throw Error("A digest-pinned guest metadata bootstrap is required; host PostgreSQL fallback is forbidden");
  const guest = new Guest(value.executor.mac);
  const vm = await guest.inspect() as Record<string, unknown>;
  if (vm.Running !== true) throw Error("Metadata requires an already running confined guest; provisioning does not boot or qualify a VM");
  for (const item of [bootstrap.node, bootstrap.entry]) {
    const output = await guest.execute(["/usr/bin/shasum", "-a", "256", item.path]);
    if (output.trim().split(/\s+/)[0] !== item.sha256) throw Error("Guest bootstrap digest integrity mismatch");
  }
  const payload = Buffer.from(JSON.stringify({ ...bootstrap.config, operation })).toString("base64");
  const result: unknown = JSON.parse(await guest.execute([bootstrap.node.path, bootstrap.entry.path, "--config-base64", payload]));
  if (!result || typeof result !== "object" || typeof (result as Record<string, unknown>).identity !== "string") throw Error("Guest PostgreSQL identity receipt required");
  return observation("pipeline.metadata", "postgres.local", (result as { identity: string }).identity, value.metadata, false, { placement: "pipeline.executor", bootstrap: result });
}

export class Asset {
  private readonly kind: "model" | "runtime";
  private readonly value: { root: string; sha256: string };
  private readonly input: string;
  constructor(kind: "model" | "runtime", value: { root: string; sha256: string }, input: string) {
    path(value.root); path(input); hash(value.sha256);
    if (contains(input, value.root) || contains(value.root, input)) throw Error("Asset roots must remain outside the corpus");
    this.kind = kind; this.value = { ...value }; this.input = input;
  }
  async inspect(): Promise<Observation> {
    const resource = this.value;
    await canonical(resource.root);
    const visit = async (root: string): Promise<void> => {
      for await (const entry of await opendir(root)) {
        const file = join(root, entry.name);
        if (entry.isDirectory()) await visit(file);
        else if (entry.isSymbolicLink() && contains(this.input, await realpath(file)))
          throw Error("Runtime asset aliases cannot read the corpus");
      }
    };
    await visit(resource.root);
    const actual = await seal(resource.root, this.kind === "runtime");
    if (actual.hash !== resource.sha256) throw Error(this.kind + " digest integrity mismatch");
    return observation("pipeline." + this.kind, this.kind === "model" ? "mlx.model" : "python.uv", "sha256:" + actual.hash, resource, false, { root: resource.root, qualified: false });
  }
}

export async function provision(value: unknown): Promise<Receipt> {
  record(value, ["format", "operation", "spec", "request", "config"], "provision request");
  if (value.format !== "pipeline-provision-request/1" || !["provision", "inspect"].includes(value.operation as string) || typeof value.request !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(value.request)) throw Error("Invalid provision operation");
  hash(value.spec);
  const target = config(value.config), operation = value.operation as Request["operation"];
  if (!target.metadata.bootstrap) throw Error("A digest-pinned guest metadata bootstrap is required; no ready receipt can be issued");
  if (await fileHash(join(import.meta.dirname, "guest-postgres.ts")) !== target.metadata.bootstrap.entry.sha256)
    throw Error("Metadata bootstrap must match the known bundled guest-postgres capability");
  const storage = new Storage(target.storage);
  const resources = [await storage[operation]()];
  const control = await directory(target.control.root, operation === "provision");
  resources.push(observation("pipeline.control", "macos.native", hostname() + ":" + control.device + ":" + control.inode, target.control, platform() === "darwin" && arch() === "arm64", { directory: control, platform: platform(), arch: arch(), installed: false }));
  const executor = new Executor(target);
  resources.push(await executor[operation]());
  resources.push(await metadata(target, operation));
  for (const key of ["model", "runtime"] as const) if (target[key]) {
    resources.push(await new Asset(key, target[key], target.storage.input).inspect());
  }
  return { format: "pipeline-infra-receipt/1", spec: value.spec, request: value.request, resources, qualification: { vm: false, inference: false } };
}

if (process.argv[1] === import.meta.filename) {
  try {
    let input = "";
    for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 1024 ** 2) throw Error("Provision request exceeds byte bound"); }
    process.stdout.write(JSON.stringify(await provision(JSON.parse(input))) + "\n");
  } catch (error) { console.error(error instanceof Error ? error.message : "Local provisioning failed"); process.exitCode = 1; }
}
