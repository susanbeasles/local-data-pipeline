import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { launch, assertNetworkDenied } from "./sandbox.ts";
import { enrich } from "./enrich.ts";
import { order } from "./roles.ts";
import { run } from "./run.ts";
import { profile as validateProfile } from "./profile.ts";
import { inspect } from "./package.ts";
import { inspect as inspectExtractor } from "./extractor.ts";
import { randomUUID } from "node:crypto";
import { atomic } from "./store.ts";
import { configure, type Pipeline } from "./config.ts";
import { boundaries } from "./run.ts";
import { modelVersion, pool, bounds } from "./mlx.ts";
import { status } from "./status.ts";
const [command, path] = process.argv.slice(2);
if (
  !path ||
  !["run", "resume", "status", "validate", "guarded-run"].includes(command)
)
  throw Error(
    "Usage: node pipeline/cli.ts run|resume|validate /absolute/config.json; status /absolute/work",
  );
if (command === "status") {
  console.log(JSON.stringify(await status(resolve(path)), null, 2));
} else {
  let config = JSON.parse(await readFile(resolve(path), "utf8")) as Pipeline;
  const directory = dirname(resolve(path));
  config.input = resolve(directory, config.input);
  config.work = resolve(directory, config.work);
  for (const key of ["runtime", "base", "package"] as const)
    if (config.mlx[key]) config.mlx[key] = resolve(directory, config.mlx[key]!);
  if (config.extractor)
    config.extractor.directory = resolve(directory, config.extractor.directory);
  if (typeof config.profile === "string")
    config.profile = JSON.parse(
      await readFile(resolve(directory, config.profile), "utf8"),
    );
  if (config.profile) {
    config.profile = validateProfile(config.profile);
    if (config.enrichment) throw Error("choose a profile or graph enrichment");
    config.roles = config.profile.stages.map((s) => s.name);
  }
  if (
    config.review &&
    (!Array.isArray(config.review.after) ||
      config.review.after.some((r) => !config.roles.includes(r)) ||
      new Set(config.review.after).size !== config.review.after.length)
  )
    throw Error("invalid review stages");
  if (command === "run" || command === "resume" || command === "validate") {
    if (command === "resume") config.resume = true;
    const selected = JSON.parse(
      await readFile(
        join(import.meta.dirname, "../config/residency.json"),
        "utf8",
      ),
    );
    config = configure(config, selected);
    if (
      config.engine !== "mlx" ||
      !config.mlx.package ||
      Object.keys(config.mlx.adapters).length ||
      config.mlx.roleMode === "inline"
    )
      throw Error("production requires packaged MLX with unchanged weights");
    for (const key of ["chunkSize", "attempts", "maxBytes"] as const)
      if (
        !Number.isSafeInteger(config[key]) ||
        config[key] < 1 ||
        (key === "chunkSize" && config[key] < 2)
      )
        throw Error("invalid " + key);
    if (
      !config.profile &&
      (config.roles.join(",") !== order.join(",") ||
        !config.enrichment?.namespace.trim())
    )
      throw Error(
        "six-stage enrichment requires explicit namespace and ordered roles",
      );
    const paths = await boundaries(config.input, config.work);
    if (config.extractor) await inspectExtractor(config.extractor, paths.input);
    await boundaries(config.input, config.mlx.package);
    await boundaries(config.mlx.base, config.work);
    await boundaries(config.mlx.runtime, config.work);
    await access(join(config.mlx.runtime, "bin/python3"), constants.X_OK);
    const pkg = await inspect(config.mlx.package, config.mlx.base);
    if (
      JSON.stringify(pkg.profile) !== JSON.stringify(config.profile) ||
      pkg.roles.map((r) => r.role).join(",") !== config.roles.join(",")
    )
      throw Error(
        "profile does not match sealed role package; create a new package",
      );
    if (command === "validate") {
      console.log(
        JSON.stringify(
          { valid: true, config, packageIdentity: pkg.identity },
          null,
          2,
        ),
      );
      process.exit(0);
    }
    const snapshot = join(
      paths.work,
      "state",
      `run-config-${randomUUID()}.json`,
    );
    await atomic(snapshot, config);
    process.exitCode = await launch(
      config.input,
      config.work,
      import.meta.filename,
      ["guarded-run", snapshot],
      config.mlx,
    );
  } else {
    await assertNetworkDenied();
    if (config.engine !== "mlx")
      throw Error("production entrypoint requires MLX");
    if (
      config.concurrency < 1 ||
      config.concurrency > bounds(config.mlx).capacity
    )
      throw Error("concurrency exceeds resident worker capacity");
    if (
      !config.mlx.package ||
      Object.keys(config.mlx.adapters).length ||
      config.mlx.roleMode === "inline"
    )
      throw Error(
        "production requires packaged role artifacts with unchanged base weights",
      );
    config.model = await modelVersion(config.mlx, config.roles);
    const workers = pool(config.mlx);
    try {
      await workers.ready;
      const report = config.profile
        ? await run(config, (r) => workers.infer(r))
        : await enrich(config, (r) => workers.infer(r));
      // Full integrity evidence remains in state; keep terminal output bounded.
      const core = "chunks" in report ? report.chunks : report;
      const summary = {
        ...core,
        sources: undefined,
        errors: core.errors.slice(0, 20),
        errorCount: core.errors.length,
      };
      console.log(
        JSON.stringify(
          "chunks" in report ? { ...report, chunks: summary } : summary,
        ),
      );
      if (!report.integrity) process.exitCode = 1;
    } finally {
      await workers.close();
    }
  }
}
