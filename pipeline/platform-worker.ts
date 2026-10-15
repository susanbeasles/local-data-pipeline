import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { Platform, configuration } from "./platform.ts";
import { assertNetworkDenied, launch } from "./sandbox.ts";
import type { Work } from "./execution.ts";

export type Progress = {
  type: "task";
  run: string;
  task: string;
  attempt: string;
  status: Work["status"];
};
/** Adapter errors and artifact contents never become worker progress frames. */
export function progress(work: Work): Progress {
  return {
    type: "task",
    run: work.run,
    task: work.task,
    attempt: work.attempt,
    status: work.status,
  };
}

async function main(args: string[]): Promise<number> {
  const supervised = args[0] === "--supervised";
  const file = args[supervised ? 1 : 0];
  if (args.length !== (supervised ? 2 : 1) || !file || !isAbsolute(file))
    throw Error("Usage: node pipeline/platform-worker.ts /absolute/operator/platform.json");
  const bytes = await readFile(file);
  if (bytes.length > 2 * 1024 ** 2) throw Error("platform configuration exceeds 2 MiB bound");
  const config = configuration(JSON.parse(bytes.toString("utf8")));
  const input = config.input ?? config.catalog?.[0]?.root;
  if (!input) throw Error("worker input root is required: configure input or a catalog source");
  if (!("socket" in config.database))
    throw Error("isolated platform workers require an explicit PostgreSQL Unix socket binding");
  if (!supervised)
    return launch(input, config.state, import.meta.filename, ["--supervised", file], config.model, {
      socket: config.database.socket,
    });

  // The internal flag carries no authority. Verify the actual OS restriction.
  await assertNetworkDenied();
  const platform = await Platform.open(config);
  const stop = new AbortController();
  const signal = () => stop.abort();
  process.once("SIGINT", signal);
  process.once("SIGTERM", signal);
  try {
    const result = await platform.worker({
      worker: "platform-" + process.pid,
      signal: stop.signal,
      onWork(work) {
        process.stdout.write(JSON.stringify(progress(work)) + "\n");
      },
    });
    process.stdout.write(JSON.stringify({ type: "stopped", ...result }) + "\n");
    return 0;
  } finally {
    process.removeListener("SIGINT", signal);
    process.removeListener("SIGTERM", signal);
    await platform.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.exitCode = 1;
    process.stdout.write(
      JSON.stringify({
        error: { message: error instanceof Error ? error.message : "platform worker failed" },
      }) + "\n",
    );
  }
}
