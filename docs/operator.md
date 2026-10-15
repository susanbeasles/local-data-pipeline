# Local enrichment operator guide

Controlled six-stage synthetic acceptance passed in both inline and packaged modes. The default is one shared-weight resident model with 64 continuous-batching slots and prefill admission of four. This establishes the tested fixtures, not unrestricted semantic accuracy or sustained production throughput. See `docs/verification.md` for measurements and limitations.

The production command is `node pipeline/cli.ts run /absolute/config.json`, from `<checkout>`. Do not run it against the corpus until execution is separately authorized. The command performs all six ordered stages: tag, classify, summarize, knowledge, reconcile, connect. The last two adjudicate entity pairs across chunk results.

Use `config/enrichment.example.json` as a template. Set an explicit existing input directory, a disjoint work directory, and the namespace. Input is a logical read-only reference: no relocation, migration, cleanup or generated files in the input directory. Work contains `staging/`, `state/` and `output/`; model role packages are under this project's `models/`. Existing model weights and the installed Python runtime are read-only local dependencies.

For configurable enrichment tasks beyond the six-stage graph workflow, see `docs/reuse.md` and `config/profile.example.json`. `node pipeline/cli.ts validate /absolute/config.json` checks configuration without processing input. Explicit batching/resource settings are preserved.

## Role artifacts

`node pipeline/package.ts /absolute/local/base /absolute/new/role-package` creates six sealed `model.json` artifacts and a manifest. Each artifact contains its SYSTEM instructions, input policy, schema and generation settings, and references the same SHA-256 sealed base weights. Packaging never trains, adapts or modifies weights. This is a custom MLX role package, analogous to configuring SYSTEM in a Modelfile; it does not recompile instructions into weights.

Set `mlx.package` to the package directory, `mlx.adapters` to `{}` and `mlx.roleMode` to `packaged`. Runtime automatically loads all role configurations. The application supplies role selection and dynamic payloads only. Resident initialization constructs/tokenizes each role prefix once and computes independent reusable role attention state; each sequence receives isolated state. Attention reuse is an optimization of the packaged configuration, not the package itself. Six loaded artifacts, seven initial instruction-set tokenizations (including the connection presence check), zero request template constructions/tokenizations, and zero transmitted SYSTEM bytes are observable in worker metrics. Integrity checks reject altered weights or role artifacts.

## Runtime and recovery

macOS Apple Silicon, Node 24.19 and the recorded local Python/MLX environment are required. `package-lock.json` pins Node dependencies; `config/python.lock.txt` records the installed Python environment. Use uv exclusively for Python environment and dependency management: `uv venv --python /usr/bin/python3 --no-python-downloads .venv`, then `uv pip sync --python .venv/bin/python --offline --no-index --find-links /absolute/wheelhouse --require-hashes config/python.uv.lock`. The installed Command Line Tools Python 3.9 framework is supported; the full Xcode application is not required. The wheelhouse is not bundled; do not infer offline reproducibility on a different machine without supplying it.

The launcher enforces OS Seatbelt network denial and read-only input. Model workers additionally deny arbitrary file access, writes and process spawning. Startup fails if network denial is absent. The supervisor monitors aggregate process footprint against 32 GB; this is sampled enforcement, not a hard kernel allocation ceiling. GPU utilization is system-wide and can include other applications.

Resume explicitly with `node pipeline/cli.ts resume /absolute/config.json`, using the same input and work directory. Completed receipts are verified and reused. Interrupted jobs recover, and previously failed jobs receive a fresh bounded `attempts` budget; attempt numbers and failed receipts remain in the audit history. Kernel locks serialize runs; SQLite WAL/FULL durability, leases and atomic receipts retain completed work. Hash/schema/provenance checks detect corrupt outputs, invalidate dependent chunk stages and resume graph jobs. Graph publications and file dispositions are regenerated from durable receipts. Changed input/config/model cannot silently reuse old receipts. Do not edit checkpoint databases or artifacts to force completion.

Read-only status: `node pipeline/cli.ts status /absolute/work`. Live view: `node pipeline/status.ts /absolute/work --watch` (updates every two seconds). It reports phase, process liveness, completed/pending/running/failed job counts, per-role progress, and recent failures. It distinguishes semantic benchmark failures from structurally completed jobs. Status never initializes a model or starts processing.

`state/enrichment-report.json` reports six-stage completion; `output/files.jsonl` accounts for every discovered file; `output/graph.json` seals entity/group/edge JSONL publications. A file counts as completed only after its chunk stages and applicable graph adjudications finish. Progress is emitted every five seconds. Structural integrity does not by itself prove semantic quality.

## Verification

Run `npm test` and `npx tsc --noEmit`. Run `node pipeline/enrichment-benchmark.ts` for the controlled two-file real-MLX six-stage comparison. It creates a new synthetic input/work directory under project state, runs both inline and artifact modes, and writes `comparison.json`. Semantic acceptance checks substantive claims, names, alias grouping and dependency direction; failures return nonzero. Old narrow worker/batching benchmarks are historical and do not establish full six-stage performance or current role quality.

`node pipeline/verify.ts check /absolute/input /absolute/work` checks saved source hashes, chunk coverage and output artifacts under the OS network/input-write restrictions, without loading a model or doing inference. An integrity pass verifies attribution and coverage, not semantic correctness.

UTF-8 text and valid text JSONL are normalized losslessly (line endings) and fully chunked. Binary formats without extractors, symlinks/special files and protected credential paths have explicit unsupported dispositions. Invalid UTF-8/JSONL is invalid. Files exceeding configured extraction memory fail explicitly; no truncation is used. All unordered entity pairs are currently adjudicated, giving quadratic graph work. These are material capability and scaling limits, not permission to skip work.

## Review, recovery and customization

See [console.md](console.md) for the authenticated local control panel and durable stage approvals. See [reuse.md](reuse.md) for custom profiles, schemas, sealed role packages and extractors. Adding/removing stages is a profile change: build a matching role artifact and use a separate work directory when changing processing semantics. Existing production checkpoints belong to their original model/configuration identity.

From the project directory:

```sh
npm run check
npm test
node pipeline/cli.ts validate /absolute/config.json
node pipeline/cli.ts run /absolute/config.json
node pipeline/cli.ts resume /absolute/config.json
npm run status -- /absolute/work-directory
npm run console -- /absolute/work-directory 8765
```

Resume reacquires the processing lock, validates cached stages and output hashes, recovers interrupted leases and preserves completed valid results. Failed integrity exits unsuccessfully; pending jobs are never represented as completed. Review-enabled runs wait for explicit approval, and incomplete stages cannot be approved. Unknown input formats and configured resource/context limits receive explicit dispositions; install a matching extractor or correct configuration rather than silently dropping them. Keep inputs, staging, state, models and output paths separate.

The six-stage example uses a 512 MiB extraction limit and 900-second inference deadline. Dense prompts can spend several minutes in batched prefill before the first result; the timeout is a configurable wall-clock deadline, not a token limit. Engine diagnostics distinguish progress from completion. Increase the deadline explicitly when deeper role outputs need it; never reduce source coverage or schema requirements to fit a benchmark. Large indexed stages retain complete text in staged JSONL and compact offset/hash metadata in their source snapshot.


### Machine-local paths

Production input, work, Python runtime, base model, and role-package paths belong in operator-owned JSON outside tracked source. Relative paths in a run configuration resolve from that JSON file's directory. The checked-in examples use checkout-relative `.venv` and `models/` paths; they are conventions, not preinstalled artifacts. Existing local configurations and model files are not moved or rewritten by portability changes.

Synthetic MLX tools and installed-runtime tests use `PIPELINE_CONFIG=/absolute/local/run.json` to obtain only `mlx.runtime`, `mlx.base`, and `mlx.package`. Explicit `PIPELINE_RUNTIME`, `PIPELINE_BASE`, and `PIPELINE_PACKAGE` override those bindings. Without configuration they use `.venv`, `models/qwen2.5-3b`, and `models/qwen-roles-v14` in the checkout. Missing dependencies fail explicitly; they are not silently skipped. The sandbox supervisor passes only these explicit model bindings to synthetic child tools, alongside its existing restricted environment. No cloud credentials are inherited.

The worker sandbox derives the actual interpreter/framework and Python library version from the selected local runtime. System paths such as `/usr/bin/sandbox-exec` remain platform requirements; no account home is embedded in the policy. Integration tests continue to establish actual network, file-read/write, and process-fork denial.

`config/python.lock.txt` contains version pins, not local wheel URLs. For offline setup supply an operator-owned wheel directory with `uv pip sync --offline --no-index --find-links`; no installation or downloads happen during path resolution.

Inference data is authoritative in SQLite, including actual normalized chunk text and result JSON. See [sqlite-data.md](sqlite-data.md) for the data contract, explicit legacy import, JSONL export and database-backed UI review. Existing file-backed checkpoints must be imported before the new runner can resume them.
