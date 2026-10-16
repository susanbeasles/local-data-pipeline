# Two-hour round acceptance

The budget is 7,200 seconds per complete enrichment stage over the designated dataset revision. Start the clock before that round's preparation. Include normalization, scheduling, model execution, retries, validation and durable publication. Restarting does not reset this clock. A completed source requires every required chunk and result; scheduled jobs are not completed files.

`config/throughput.json` names the six required stages and budget. Evaluate recorded round evidence with:

```sh
npm run check:throughput -- /absolute/rounds.json config/throughput.json
```

The evidence is a JSON array. Each item has `role`, `input` (the dataset inventory SHA-256), `expected` (source count), `completed`, `failed`, `pending`, `running`, `invalid`, `unsupported`, `integrity` (boolean), `started` (epoch milliseconds before preparation), and `finished`. Every stage must cover the same dataset and source count. Exit codes are 0 for acceptance, 1 for a missed target, and 2 for invalid evidence. This is an evidence evaluator: it does not independently certify a supplied JSON assertion. Obtain completion and integrity from verified source/chunk/output reconciliation, and retain the underlying execution receipts. Global graph stages must also reconcile all input sources; their pair-job counts cannot substitute for source coverage.

The current full production round has **not** passed this target. Neither a short synthetic benchmark nor lossless storage factoring establishes complete-stage throughput.

## Lossless JSONL preparation

```sh
node pipeline/normalize.ts /absolute/read-only-jsonl-input /absolute/separate-work
```

The entrypoint enforces OS network denial and input write denial. Its input directory accepts regular JSONL files only; malformed or unsupported sources fail visibly. It preserves exact original bytes in SQLite content blocks and lossless archived JSONL, stores full parsed records, and publishes content-addressed values plus source mappings in `staging/`. Repeated nested structures are factored with separate reference maps. Reconstruction, source hashes, original archives and export hashes are checked before reporting integrity. Existing input bytes are never changed.

Re-run the same command to resume the same dataset revision. Changed or removed input files require a new work directory. Inspect `progress.json` and `report.json`; failed or interrupted work is not a completed certificate. The duration retains the first recorded start across restarts.

The normalization report deliberately has `inferenceReady: false`. Existing enrichment does not resolve this factored format. Do not point it at `values.jsonl` or treat null reference slots as the original source content. A qualified model-facing context representation remains required; expanding all references recovers correctness but restores the repeated token cost.

## Local prefill measurement

`pipeline/prefill-benchmark.ts` is a sandbox child entrypoint. Launch through `sandbox.launch` with a sealed local model, an explicit synthetic input boundary and separate work directory containing `model.json`. It warms the resident model, runs 32 identical synthetic Tag requests at application concurrency 16, validates each result, and saves input/output token counts, wall time, output hashes and actual forward batch shapes. The existing descriptor supervisor saves aggregate memory and system-wide GPU utilization in `state/resources.json`.

Use identical models, requests, instructions and guards when comparing `prefillSize`. Exclude initialization only when explicitly reporting warmed request performance. Cold-start and full-round acceptance include initialization. Compare output hashes and validate stage quality separately. A Tag microbenchmark is not six-stage acceptance.

Changes to prefill settings currently change the model fingerprint and job identities. Keep an active instance's frozen engine and configuration unchanged. A short successful comparison alone does not authorize discarding completed work or certifying a new six-stage production instance.
