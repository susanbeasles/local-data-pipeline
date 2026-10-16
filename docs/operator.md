# Local enrichment operator guide

Controlled six-stage synthetic acceptance passed in both inline and packaged modes. The default is one shared-weight resident model with 64 continuous-batching slots and prefill admission of four. This establishes the tested fixtures, not unrestricted semantic accuracy or sustained production throughput. See `docs/verification.md` for measurements and limitations.

The production command is `node pipeline/cli.ts run /absolute/config.json`, from `/Users/avespoli/local-data-pipeline`. Do not run it against the corpus until execution is separately authorized. The command performs all six ordered stages: tag, classify, summarize, knowledge, reconcile, connect. The last two adjudicate entity pairs across chunk results.

Use `config/enrichment.example.json` as a template. Set an explicit existing input directory, a disjoint work directory, and the namespace. Input is a logical read-only reference: no relocation, migration, cleanup or generated files in the input directory. Work contains `staging/`, `state/` and `output/`; model role packages are under this project's `models/`. Existing model weights and the installed Python runtime are read-only local dependencies.

For configurable enrichment tasks beyond the six-stage graph workflow, see `docs/reuse.md` and `config/profile.example.json`. `node pipeline/cli.ts validate /absolute/config.json` checks configuration without processing input. Explicit batching/resource settings are preserved.

## Role artifacts

`node pipeline/package.ts /absolute/local/base /absolute/new/role-package` creates six sealed `model.json` artifacts and a manifest. Each artifact contains its SYSTEM instructions, input policy, schema and generation settings, and references the same SHA-256 sealed base weights. Packaging never trains, adapts or modifies weights. This is a custom MLX role package, analogous to configuring SYSTEM in a Modelfile; it does not recompile instructions into weights.

Set `mlx.package` to the package directory, `mlx.adapters` to `{}` and `mlx.roleMode` to `packaged`. Runtime automatically loads all role configurations. The application supplies role selection and dynamic payloads only. Resident initialization constructs/tokenizes each role prefix once and computes independent reusable role attention state; each sequence receives isolated state. Attention reuse is an optimization of the packaged configuration, not the package itself. Six loaded artifacts, seven initial instruction-set tokenizations (including the connection presence check), zero request template constructions/tokenizations, and zero transmitted SYSTEM bytes are observable in worker metrics. Integrity checks reject altered weights or role artifacts.

## Runtime and recovery

macOS Apple Silicon, Node 24.19 and the recorded local Python/MLX environment are required. `package-lock.json` pins Node dependencies; `config/python.lock.txt` records the installed Python environment. For an independent environment use Python 3.9 with matching local wheels and `pip install --no-index --find-links /absolute/wheelhouse -r config/python.lock.txt`. Local wheel URL entries must resolve to available files. The wheelhouse is not bundled; do not infer offline reproducibility on a different machine without supplying it.

The launcher enforces OS Seatbelt network denial and read-only input. Model workers additionally deny arbitrary file access, writes and process spawning. Startup fails if network denial is absent. The supervisor monitors aggregate process footprint against 32 GB; this is sampled enforcement, not a hard kernel allocation ceiling. GPU utilization is system-wide and can include other applications.

Resume explicitly with `node pipeline/cli.ts resume /absolute/config.json`, using the same input and work directory. Completed receipts are verified and reused. Interrupted jobs recover, and previously failed jobs receive a fresh bounded `attempts` budget; attempt numbers and failed receipts remain in the audit history. Kernel locks serialize runs; SQLite WAL/FULL durability, leases and atomic receipts retain completed work. Hash/schema/provenance checks detect corrupt outputs, invalidate dependent chunk stages and resume graph jobs. Graph publications and file dispositions are regenerated from durable receipts. Changed input/config/model cannot silently reuse old receipts. Do not edit checkpoint databases or artifacts to force completion.

Read-only status: `node pipeline/cli.ts status /absolute/work`. Live view: `node pipeline/status.ts /absolute/work --watch` (updates every two seconds). It reports phase, process liveness, completed/pending/running/failed job counts, per-role progress, and recent failures. It distinguishes semantic benchmark failures from structurally completed jobs. Status never initializes a model or starts processing.

`state/enrichment-report.json` reports six-stage completion; `output/files.jsonl` accounts for every discovered file; `output/graph.json` seals entity/group/edge JSONL publications. A file counts as completed only after its chunk stages and applicable graph adjudications finish. Progress is emitted every five seconds. Structural integrity does not by itself prove semantic quality.

## Verification

Run `npm test` and `npx tsc --noEmit`. Run `node pipeline/enrichment-benchmark.ts` for the controlled two-file real-MLX six-stage comparison. It creates a new synthetic input/work directory under project state, runs both inline and artifact modes, and writes `comparison.json`. Semantic acceptance checks substantive claims, names, alias grouping and dependency direction; failures return nonzero. Old narrow worker/batching benchmarks are historical and do not establish full six-stage performance or current role quality.

`node pipeline/verify.ts check /absolute/input /absolute/work` checks saved source hashes, chunk coverage and output artifacts under the OS network/input-write restrictions, without loading a model or doing inference. An integrity pass verifies attribution and coverage, not semantic correctness.

UTF-8 text and valid text JSONL are normalized losslessly (line endings) and fully chunked. Binary formats without extractors, symlinks/special files and protected credential paths have explicit unsupported dispositions. Invalid UTF-8/JSONL is invalid. Files exceeding configured extraction memory fail explicitly; no truncation is used. All unordered entity pairs are currently adjudicated, giving quadratic graph work. These are material capability and scaling limits, not permission to skip work.
