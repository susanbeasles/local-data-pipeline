import { inspect } from "./package.ts";
import { Refs } from "./refs.ts";
import { annotate } from "./proof.ts";
import { Dispatch } from "./dispatch.ts";
import { WorkerFailure } from "./errors.ts";
import { seal, fileHash } from "./seal.ts";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Socket } from "node:net";
import { EventEmitter } from "node:events";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { hash } from "./store.ts";
import { assertNetworkDenied } from "./sandbox.ts";
import { sandbox, type Sandbox } from "./legacy/sandbox.ts";
import type { Request } from "./run.ts";
export type Model = {
  package?: string;
  roleMode?: "packaged" | "inline";
  prefillSize?: number;
  workers?: number;
  budgetBytes?: number;
  runtime: string;
  base: string;
  adapters: Record<string, string>;
  timeoutMs: number;
  maxTokens: number;
  batchSize: number;
  memoryBytes: number;
};
type Pending = {
  resolve: (v: unknown, evidence?: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
export class Worker {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  pending = new Map<string, Pending>();
  metrics = {
    inputTokens: 0,
    outputTokens: 0,
    peakBytes: 0,
    responses: 0,
    systemBytesSent: 0,
    traces: [] as {
      id: string;
      role: string;
      inputHash: string;
      systemHash: string;
      resultHash: string;
    }[],
    loadSeconds: 0,
    engine: {} as Record<string, number>,
    forwards: {} as Record<string, number>,
    initialization: {} as Record<string, unknown>,
  };
  instructions: Record<string, string> = {};
  diagnostic = "";
  ended = false;
  box: Sandbox | undefined;
  constructor(model: Model, adapter: string, box?: Sandbox, index = 0) {
    this.box = box;
    if (box)
      this.child = box.launch([
        join(import.meta.dirname, "worker.py"),
        model.base,
        adapter,
        String(model.batchSize),
        String(model.memoryBytes),
        String(model.prefillSize ?? model.batchSize),
        model.roleMode ?? "packaged",
      ]);
    else {
      const ids = [
        "PIPELINE_WORKER_IN",
        "PIPELINE_WORKER_OUT",
        "PIPELINE_WORKER_ERR",
      ].map((key) =>
        Number(
          process.env[key + "_" + index] ??
            (index === 0 ? process.env[key] : undefined),
        ),
      );
      if (ids.some((n) => !Number.isSafeInteger(n) || n < 3))
        throw Error("descriptor worker absent");
      const events = new EventEmitter();
      const stdout = new Socket({
          fd: ids[1],
          readable: true,
          writable: false,
        }),
        stderr = new Socket({ fd: ids[2], readable: true, writable: false }),
        stdin = new Socket({ fd: ids[0], readable: false, writable: true });
      stdout.on("end", () => events.emit("exit"));
      stdout.on("error", (e) => events.emit("error", e));
      stderr.on("error", (e) => events.emit("error", e));
      stdin.on("error", (e) => events.emit("error", e));
      this.child = Object.assign(events, {
        stdout,
        stderr,
        stdin,
        kill: (signal: string = "SIGTERM") => {
          try {
            process.kill(
              Number(
                process.env["PIPELINE_WORKER_PID_" + index] ??
                  process.env.PIPELINE_WORKER_PID,
              ),
              signal as NodeJS.Signals,
            );
          } catch {}
          return true;
        },
      }) as unknown as ChildProcessWithoutNullStreams;
    }
    let readyOk!: () => void, readyNo!: (e: Error) => void;
    this.ready = new Promise((ok, no) => {
      readyOk = ok;
      readyNo = no;
    });
    const init = setTimeout(() => {
      this.child.kill("SIGKILL");
      readyNo(new WorkerFailure("model initialization timeout"));
    }, model.timeoutMs);
    this.child.stderr.on("data", (b) => {
      this.diagnostic = (this.diagnostic + b.toString()).slice(-4000);
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      try {
        if (line.length > 8 * 1024 * 1024)
          throw Error("worker frame budget exceeded");
        const value = JSON.parse(line);
        if (value.ready) {
          this.metrics.initialization = value.initialization ?? {};
          this.metrics.loadSeconds = Number(value.loadSeconds) || 0;
          clearTimeout(init);
          readyOk();
          return;
        }
        if (value.progress === true) {
          if (
            ![
              value.active,
              value.generationTokens,
              value.promptTokens,
              value.peakBytes,
            ].every((n) => Number.isFinite(n) && n >= 0)
          )
            throw Error("invalid worker progress frame");
          this.diagnostic = JSON.stringify({
            active: value.active,
            generationTokens: value.generationTokens,
            promptTokens: value.promptTokens,
            peakBytes: value.peakBytes,
          });
          return;
        }
        const p = this.pending.get(value.id);
        if (!p) throw Error("worker response identity mismatch");
        clearTimeout(p.timer);
        this.pending.delete(value.id);
        if (value.error)
          p.reject(
            Object.assign(Error(value.error), {
              partial: value.partial,
              outputTokens: value.outputTokens,
            }),
          );
        else {
          this.metrics.inputTokens += Number(value.inputTokens) || 0;
          this.metrics.outputTokens += Number(value.outputTokens) || 0;
          this.metrics.peakBytes = Math.max(
            this.metrics.peakBytes,
            Number(value.peakBytes) || 0,
          );
          this.metrics.engine = value.engineStats ?? this.metrics.engine;
          this.metrics.forwards = value.forwards ?? this.metrics.forwards;
          if (value.trace) {
            this.metrics.traces.push(value.trace);
            if (this.metrics.traces.length > 64) this.metrics.traces.shift();
          }
          this.metrics.responses++;
          p.resolve(value.result, value.trace);
        }
      } catch (e) {
        this.fail(Error(String(e)));
      }
    });
    lines.on("error", (e) => {
      clearTimeout(init);
      readyNo(e);
      this.fail(e);
    });
    const exit = () => {
      clearTimeout(init);
      const e = new WorkerFailure("MLX worker terminated: " + this.diagnostic);
      readyNo(e);
      this.fail(e);
    };
    this.child.on("error", exit);
    this.child.on("exit", exit);
  }
  static async start(model: Model, adapter: string, index = 0) {
    await assertNetworkDenied();
    if (!process.env.PIPELINE_WORKER_IN_0 && !process.env.PIPELINE_WORKER_IN)
      throw Error(
        "worker must be launched by descriptor supervisor before application sandbox",
      );
    const worker = new Worker(model, adapter, undefined, index);
    try {
      await worker.ready;
      return worker;
    } catch (e) {
      await worker.close();
      throw e;
    }
  }
  fail(e: Error) {
    if (!(e instanceof WorkerFailure)) e = new WorkerFailure(e.message);
    this.ended = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
    this.child.kill("SIGKILL");
  }
  async infer(r: Request, model: Model) {
    await this.ready;
    if (this.ended) throw new WorkerFailure("worker unavailable");
    if (this.pending.size >= model.batchSize)
      throw Error("worker capacity exceeded");
    if (this.pending.has(r.id)) throw Error("duplicate in-flight identity");
    const refs = new Refs(r.payload);
    return new Promise<unknown>((ok, no) => {
      const timer = setTimeout(
        () =>
          this.fail(
            new WorkerFailure(
              "inference timeout; last engine progress: " +
                (this.diagnostic || "none"),
            ),
          ),
        model.timeoutMs,
      );
      this.pending.set(r.id, {
        resolve: (value, evidence) =>
          ok(annotate(refs.restore(value), refs.restore(evidence))),
        reject: no,
        timer,
      });
      if (model.package && model.roleMode === "inline")
        this.metrics.systemBytesSent += Buffer.byteLength(
          this.instructions[r.role],
        );
      this.child.stdin.write(
        JSON.stringify(
          model.package
            ? {
                id: r.id,
                role: r.role,
                payload: r.payload ? refs.encode(r.payload) : undefined,
                ...(model.roleMode === "inline"
                  ? { system: this.instructions[r.role] }
                  : {}),
              }
            : { id: r.id, text: r.text, maxTokens: model.maxTokens },
        ) + "\n",
      );
    });
  }
  async close() {
    if (!this.ended) {
      this.ended = true;
      this.child.stdin.end();
      this.child.kill();
    }
    await this.box?.close();
  }
}
export async function fingerprint(model: Model) {
  const base = await seal(model.base),
    runtime = await seal(model.runtime, true);
  const adapters = [];
  for (const role of Object.keys(model.adapters).sort()) {
    adapters.push({
      role,
      weights: await fileHash(
        join(model.adapters[role], "adapters.safetensors"),
      ),
      config: await fileHash(join(model.adapters[role], "adapter_config.json")),
    });
  }
  return hash(
    JSON.stringify({
      base: base.hash,
      runtime: runtime.hash,
      adapters,
      package: model.package
        ? (await inspect(model.package, model.base)).identity
        : null,
      roleMode: model.roleMode ?? "packaged",
      worker: await fileHash(join(import.meta.dirname, "worker.py")),
      decoder: await fileHash(join(import.meta.dirname, "decoder.py")),
      refs: await fileHash(join(import.meta.dirname, "refs.ts")),
      proof: await fileHash(join(import.meta.dirname, "proof.ts")),
      profile: await fileHash(join(import.meta.dirname, "profile.ts")),
      schema: await fileHash(join(import.meta.dirname, "run.ts")),
      settings: {
        workers: model.workers ?? 1,
        budgetBytes: model.budgetBytes ?? 32_000_000_000,
        timeoutMs: model.timeoutMs,
        maxTokens: model.maxTokens,
        batchSize: model.batchSize,
        prefillSize: model.prefillSize ?? model.batchSize,
        memoryBytes: model.memoryBytes,
        temperature: 0,
        thinking: false,
        trustRemoteCode: false,
      },
    }),
  );
}
export async function modelVersion(model: Model, roles: string[]) {
  await assertNetworkDenied();
  if (model.package) {
    const pkg = await inspect(model.package, model.base);
    if (roles.join(",") !== pkg.roles.map((r) => r.role).join(","))
      throw Error("configured packaged roles required");
    return hash(
      JSON.stringify({
        package: pkg.identity,
        fingerprint: await fingerprint(model),
      }),
    );
  }
  throw Error(
    "production requires packaged role instructions; learned adapters are not supported",
  );
}

export function bounds(model: Model) {
  if (
    ![model.memoryBytes, model.timeoutMs, model.maxTokens].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  )
    throw Error("invalid worker resource/inference limits");
  const count = model.workers ?? 1,
    budget = model.budgetBytes ?? 32_000_000_000;
  if (
    ![1, 2, 4].includes(count) ||
    !Number.isInteger(model.batchSize) ||
    model.batchSize < 1 ||
    model.batchSize > 64
  )
    throw Error("workers must be 1, 2 or 4; batch size 1..64");
  if (
    !Number.isSafeInteger(budget) ||
    budget < 1024 ** 3 ||
    budget > 32_000_000_000 ||
    model.memoryBytes * count > budget - 512 * 1024 ** 2
  )
    throw Error(
      "aggregate MLX allocations exceed memory budget including application reserve",
    );
  const prefill = model.prefillSize ?? model.batchSize;
  if (!Number.isInteger(prefill) || prefill < 1 || prefill > model.batchSize)
    throw Error("prefill size must be 1..batch size");
  return { count, budget, capacity: count * model.batchSize };
}
export function pool(model: Model) {
  const { count, capacity } = bounds(model);
  let roles = Object.keys(model.adapters);
  if (!model.package && roles.length !== 1)
    throw Error("resident workers require one fixed adapted role");
  let workers: Worker[] = [];
  const ready = assertNetworkDenied()
    .then(async () => {
      if (model.package)
        roles = (await inspect(model.package, model.base)).roles.map(
          (r) => r.role,
        );
      for (let i = 0; i < count; i++)
        workers.push(
          new Worker(
            model,
            model.package ?? model.adapters[roles[0]],
            undefined,
            i,
          ),
        );
      if (model.package && model.roleMode === "inline") {
        for (const role of roles) {
          const cfg = JSON.parse(
            await readFile(join(model.package, role, "model.json"), "utf8"),
          );
          for (const worker of workers) worker.instructions[role] = cfg.system;
        }
      }
      await Promise.all(workers.map((worker) => worker.ready));
      return workers;
    })
    .catch((error) => {
      for (const worker of workers)
        worker.fail(new WorkerFailure("resident pool initialization failed"));
      throw error instanceof WorkerFailure
        ? error
        : new WorkerFailure(String(error));
    });
  // Install a rejection handler immediately; callers receive the original error.
  ready.catch(() => {});
  const dispatch = new Dispatch<Request, unknown>(
    Array.from({ length: count }, (_, i) => async (r) => {
      const all = await ready;
      if (!roles.includes(r.role as any)) throw Error("worker role mismatch");
      if (all[i].ended)
        throw new WorkerFailure(
          "worker terminated; checkpoint retained, restart the run",
        );
      return all[i].infer(r, model);
    }),
    model.batchSize,
    capacity,
  );
  return {
    ready,
    infer(r: Request) {
      return dispatch.submit(r);
    },
    async stats() {
      await ready;
      return workers.map((w) => w.metrics);
    },
    async close() {
      try {
        await ready;
      } catch {}
      await Promise.all(workers.map((w) => w.close()));
    },
  };
}
