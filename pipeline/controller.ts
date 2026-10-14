import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Release } from "./release.ts";
import { Lock } from "./lock.ts";
import { atomic } from "./store.ts";
const root = resolve(import.meta.dirname, "../.."),
  control = process.argv[2];
if (!control) throw Error("controller directory required");
if (
  Number(
    execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "pgid="], {
      encoding: "utf8",
    }).trim(),
  ) !== process.pid
)
  throw Error("controller requires a dedicated process group");
await new Release(root).verify();
const plan = JSON.parse(await readFile(join(root, "payload/instance.json"), "utf8"));
const lock = await Lock.acquire(join(control, "controller.lock"));
const previous = await readFile(join(control, "progress.json"), "utf8")
  .then(JSON.parse)
  .catch(() => ({}));
const start = Math.max(
  0,
  plan.partitions.findIndex((part: { name: string }) => part.name === previous.pile),
);
const run = randomUUID(),
  configs: Record<string, string> = {};
let child: ReturnType<typeof spawn> | undefined,
  stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    try {
      process.kill(-process.pid, "SIGTERM");
    } catch {}
    child?.kill("SIGTERM");
  });
try {
  await mkdir(control, { recursive: true });
  for (const part of plan.partitions) {
    const file = join(control, `config-${part.name}-${run}.json`);
    await writeFile(file, JSON.stringify({ ...part.config, resume: true }), {
      flag: "wx",
      mode: 0o600,
    });
    configs[part.name] = file;
  }
  await atomic(join(control, "production.json"), {
    revision: plan.revision,
    run,
    controllerPid: process.pid,
    configs,
    startedAt: new Date().toISOString(),
  });
  for (const part of plan.partitions.slice(start)) {
    if (stopping) break;
    await atomic(join(control, "progress.json"), {
      phase: "running",
      pile: part.name,
      run,
      controllerPid: process.pid,
      config: configs[part.name],
    });
    const log = createWriteStream(join(control, `${part.name}-${run}.log`), {
      flags: "a",
      mode: 0o600,
    });
    const exit = await new Promise<number>((ok, no) => {
      child = spawn(
        process.execPath,
        [join(root, "payload/pipeline/cli.ts"), "resume", configs[part.name]],
        {
          cwd: join(root, "payload"),
          env: { PATH: "/usr/bin:/bin" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout!.pipe(log, { end: false });
      child.stderr!.pipe(log, { end: false });
      child.once("error", no);
      child.once("close", (code) => ok(code ?? 1));
    });
    child = undefined;
    await new Promise<void>((r) => log.end(r));
    if (exit !== 0 || stopping) {
      await atomic(join(control, "progress.json"), {
        phase: stopping ? "paused" : "failed",
        pile: part.name,
        run,
        exit,
      });
      process.exitCode = stopping ? 0 : exit;
      break;
    }
    if (part === plan.partitions.at(-1))
      await atomic(join(control, "progress.json"), { phase: "completed", pile: part.name, run });
  }
} finally {
  await lock.close();
}
