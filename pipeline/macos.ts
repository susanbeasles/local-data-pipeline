import { readFile, mkdir, statfs, access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, resolve, join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export type Mac = {
  name: string;
  runner: string;
  home: string;
  image: string;
  diskBytes: number;
  memoryBytes: number;
  cpus: number;
};
export function settings(value: unknown): Mac {
  const v = value as Mac;
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).some(
      (k) => !["name", "runner", "home", "image", "diskBytes", "memoryBytes", "cpus"].includes(k),
    ) ||
    typeof v.name !== "string" ||
    !/^pipeline-[a-z0-9-]+$/.test(v.name) ||
    typeof v.runner !== "string" ||
    !isAbsolute(v.runner) ||
    v.runner.includes("\0") ||
    typeof v.home !== "string" ||
    !isAbsolute(v.home) ||
    resolve(v.home) === "/" ||
    v.home.includes("\0") ||
    typeof v.image !== "string" ||
    !/^ghcr\.io\/cirruslabs\/macos-[a-z0-9-]+@sha256:[a-f0-9]{64}$/.test(v.image) ||
    !Number.isSafeInteger(v.cpus) ||
    v.cpus < 1 ||
    v.cpus > 32 ||
    !Number.isSafeInteger(v.diskBytes) ||
    v.diskBytes < 20_000_000_000 ||
    !Number.isSafeInteger(v.memoryBytes) ||
    v.memoryBytes < 4 * 1024 ** 3 ||
    v.memoryBytes > 28 * 1024 ** 3
  )
    throw Error("invalid macOS guest resources");
  return { ...v };
}
export function space(v: Mac, available: number) {
  const required = v.diskBytes + 10 * 1024 ** 3;
  if (!Number.isFinite(available) || available < required)
    throw Error(
      `insufficient macOS VM storage: need ${required} bytes including reserve; available ${available}; no files were removed`,
    );
}
export function boot(v: Mac) {
  settings(v);
  return ["run", "--no-graphics", "--no-audio", "--no-usb-accessories", "--no-clipboard", v.name];
}
export class Guest {
  config: Mac;
  constructor(config: unknown) {
    this.config = settings(config);
  }
  private env() {
    return {
      PATH: "/usr/bin:/bin",
      HOME: this.config.home,
      TART_HOME: this.config.home,
      TART_NO_AUTO_PRUNE: "1",
      TART_NO_TELEMETRY: "1",
    };
  }
  private async invoke(args: string[]) {
    return (
      await exec(this.config.runner, args, {
        env: this.env(),
        maxBuffer: 1024 * 1024,
        timeout: 120000,
      })
    ).stdout;
  }
  async create() {
    await access(this.config.runner, constants.X_OK);
    await mkdir(this.config.home, { recursive: true });
    if ((await realpath(this.config.home)) !== resolve(this.config.home))
      throw Error("VM home aliases are forbidden");
    const fs = await statfs(this.config.home);
    space(this.config, fs.bavail * fs.bsize);
    // No overwrite and no pruning: existing VMs and all unrelated files are preserved.
    await this.invoke(["clone", this.config.image, this.config.name]);
    await this.invoke([
      "set",
      this.config.name,
      "--cpu",
      String(this.config.cpus),
      "--memory",
      String(Math.floor(this.config.memoryBytes / 1024 ** 2)),
    ]);
  }
  start() {
    const child = spawn(
      "/usr/bin/python3",
      ["-I", join(import.meta.dirname, "vmnet.py"), this.config.runner, ...boot(this.config)],
      { env: this.env(), stdio: "inherit" },
    );
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => child.kill(signal));
    return new Promise<number>((ok, no) => {
      child.once("error", no);
      child.once("exit", (code) => ok(code ?? 1));
    });
  }
  async execute(command: string[]) {
    if (!command.length || !isAbsolute(command[0]) || command.some((s) => s.includes("\0")))
      throw Error("absolute guest command required");
    return this.invoke(["exec", this.config.name, ...command]);
  }
  async stop() {
    return this.invoke(["stop", this.config.name]);
  }
  async inspect() {
    return JSON.parse(await this.invoke(["get", this.config.name, "--format", "json"]));
  }
}
if (process.argv[1] === import.meta.filename) {
  const [command, path, ...args] = process.argv.slice(2);
  if (!path)
    throw Error(
      "Usage: node pipeline/macos.ts create|start|exec|stop|inspect /path/mac.json [guest command]",
    );
  const file = resolve(path);
  const value = JSON.parse(await readFile(file, "utf8"));
  for (const key of ["runner", "home"])
    if (typeof value[key] === "string") value[key] = resolve(file, "..", value[key]);
  const guest = new Guest(value);
  if (command === "create") await guest.create();
  else if (command === "start") process.exitCode = await guest.start();
  else if (command === "exec") process.stdout.write(await guest.execute(args));
  else if (command === "stop") await guest.stop();
  else if (command === "inspect") console.log(JSON.stringify(await guest.inspect()));
  else throw Error("unknown macOS guest command");
}
