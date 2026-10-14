import { randomUUID } from "node:crypto";
import { realpath, mkdir, writeFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { Socket } from "node:net";
import { boundaries } from "./run.ts";
import { sandbox } from "./legacy/sandbox.ts";
import { bounds, type Model } from "./mlx.ts";
export async function profile(input: string, work: string) {
  const p = await boundaries(input, work);
  return `(version 1)\n(allow default)\n(deny network*)\n(deny file-write*)\n(allow file-write* (subpath ${JSON.stringify(p.work)}))\n(deny file-write* (subpath ${JSON.stringify(p.input)}))\n`;
}
export async function assertNetworkDenied() {
  await new Promise<void>((ok, no) => {
    const s = new Socket();
    s.on("error", (e: NodeJS.ErrnoException) =>
      e.code === "EPERM" ? ok() : no(Error("OS network denial not established: " + e.code)),
    );
    s.on("connect", () => {
      s.destroy();
      no(Error("OS network denial missing"));
    });
    s.setTimeout(2000, () => {
      s.destroy();
      no(Error("network probe timeout"));
    });
    s.connect(9, "127.0.0.1");
  });
}
export async function launch(
  input: string,
  work: string,
  entry: string,
  args: string[],
  model?: Model,
) {
  if (process.platform !== "darwin") throw Error("only verified macOS sandbox supported");
  const paths = await boundaries(input, work);
  await mkdir(join(paths.work, "state"), { recursive: true });
  const launchId = randomUUID();
  const file = join(paths.work, "state", `runtime-${launchId}.sb`);
  await writeFile(file, await profile(paths.input, paths.work), {
    mode: 0o600,
  });
  const env = {
    PATH: "/usr/bin:/bin",
    ...(model
      ? {
          PIPELINE_RUNTIME: model.runtime,
          PIPELINE_BASE: model.base,
          ...(model.package ? { PIPELINE_PACKAGE: model.package } : {}),
        }
      : {}),
    HOME: paths.work,
    TMPDIR: paths.work,
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    HF_HUB_DISABLE_TELEMETRY: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
  };
  let box;
  let command = "/usr/bin/sandbox-exec",
    argv = ["-f", file, process.execPath, entry, ...args];
  if (model) {
    const limits = bounds(model);
    const roles = Object.keys(model.adapters);
    if (!model.package && roles.length !== 1)
      throw Error("descriptor supervisor requires one fixed role");
    box = await sandbox(
      model.runtime,
      model.base,
      join(import.meta.dirname, "worker.py"),
      model.package ?? model.adapters[roles[0]],
      [join(import.meta.dirname, "decoder.py"), join(import.meta.dirname, "admission.py")],
    );
    const spec = join(paths.work, "state", `launcher-${launchId}.json`);
    await writeFile(
      spec,
      JSON.stringify({
        count: limits.count,
        budgetBytes: limits.budget,
        work: paths.work,
        workerCwd: box.directory,
        env,
        workerEnv: box.env,
        worker: [
          "/usr/bin/sandbox-exec",
          "-f",
          box.profile,
          box.python,
          join(import.meta.dirname, "worker.py"),
          model.base,
          model.package ?? model.adapters[roles[0]],
          String(model.batchSize),
          String(model.memoryBytes),
          String(model.prefillSize ?? model.batchSize),
          model.roleMode ?? "packaged",
        ],
        application: argv.slice(0, 0).concat(["/usr/bin/sandbox-exec", ...argv]),
      }),
      { mode: 0o600 },
    );
    command = "/usr/bin/python3";
    argv = [join(import.meta.dirname, "launch.py"), spec];
  }
  const child = spawn(command, argv, { stdio: "inherit", env });
  try {
    return await new Promise<number>((ok, no) => {
      child.once("error", no);
      child.once("exit", (code) => ok(code ?? 1));
    });
  } finally {
    await box?.close();
  }
}
