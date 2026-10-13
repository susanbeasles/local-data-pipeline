/** Integrity-only entrypoint: never initializes models or performs enrichment. */
import { resolve } from "node:path";
import { verify, boundaries } from "./run.ts";
import { launch, assertNetworkDenied } from "./sandbox.ts";
const [mode, input, work] = process.argv.slice(2);
if (!["check", "guarded"].includes(mode) || !input || !work)
  throw Error("Usage: node pipeline/verify.ts check /absolute/input /absolute/work");
const paths = await boundaries(resolve(input), resolve(work));
if (mode === "check") process.exitCode = await launch(paths.input, paths.work, import.meta.filename, ["guarded", paths.input, paths.work]);
else {
  await assertNetworkDenied();
  const report = await verify(paths.work, paths.input);
  console.log(JSON.stringify({ ...report, sources: undefined }));
  if (!report.integrity) process.exitCode = 1;
}
