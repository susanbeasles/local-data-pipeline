# Resident worker implementation and verification

Implemented directly in the existing `<checkout>` application. No new experimental project, dataset inventory, migration, or production processing was performed for this change.

## Verified behavior

The supervisor starts 1, 2, or 4 local Qwen 2.5 3B MLX processes. Each loads independent model and adapter objects, owns its attention/generation state and bounded request queue, and continuously batches at most 16 requests. One shared TypeScript dispatcher immediately assigns available jobs to free worker slots. There is no shared attention state or role-prompt cache substituted for learned behavior.

The application remains the sole result writer. Existing fsync/atomic file publication and SQLite FULL/WAL transactions are retained. Worker loss, malformed protocol frames, timeouts, and pool initialization failure retain restartable checkpoints. Restart reuses verified completed results and recovers interrupted attempts. There is no live worker respawn inside the sandbox; an interrupted pool is restarted through the normal application entrypoint.

Kernel Seatbelt profiles continue denying networking for the application and every inference worker, denying input writes, and giving workers only local model/runtime read access. Tests probe actual denied operations. A descriptor-only supervisor handles process setup and resource telemetry; it does not read input contents or forward model traffic. Event-driven pipe sockets avoid the filesystem-thread-pool deadlock found during preliminary multi-worker testing. Failed application startup and resistant child processes are cleaned up.

The configured budget is 32,000,000,000 bytes, not 32 GiB. Per-worker MLX allocation limits are set before loading. Aggregate physical footprint of supervisor, application, and workers is monitored independently of GPU telemetry. Budget breaches kill the processing processes immediately when observed; ordinary termination escalates after five seconds. The allocation limits and sampling are not a hard aggregate kernel memory ceiling: transients between samples can precede termination. The outer benchmark controller is excluded from reported aggregate footprint; the tested configurations have substantial headroom below 32 GB.

## Measured performance

Hardware: Apple M4 Pro, 12 CPU cores, 51,539,607,552 bytes installed memory. Runtime: installed local MLX-LM 0.29.1, Node 24.19.0. All runs use the same existing local Qwen 2.5 3B model and synthetic learned adapter, temperature zero, batch 16 per worker, and unchanged output requirements.

The identical workload contains 192 held-out synthetic text files, divided into three windows of 64. Every file and chunk must complete; all result fields are checked against an exact oracle keyed by source identity, so omissions, duplicates, incorrect source assignment, and incomplete outputs fail. Each run generated 9,408 tokens. Throughput includes initialization, persistence, integrity reconciliation, and oracle validation. Sustained qualification uses active pipeline window time, excluding model initialization and external oracle validation.

| Workers | Completed files | Files/min | Generated tokens/s | Peak physical footprint | Mean GPU utilization | Active processing | Correctness/integrity |
|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 192 | 98.06 | 80.08 | 7.32 GB | 86.6% | 114.35 s | Pass |
| 2 | 192 | 104.82 | 85.60 | 14.91 GB | 72.3% | 106.42 s | Pass |
| 4 | 192 | 77.72 | 63.47 | 29.09 GB | 90.4% | 138.92 s | Pass |

Two workers are the fastest stable tested configuration: batch 16 each, application concurrency 32, per-worker allocation limit 15,500,000,000 bytes. The CLI applies `config/residency.json` when `mlx.workers` is omitted. Explicit four-worker settings remain available in `config/workers-4.json`: concurrency 64, allocation limit 7,750,000,000 bytes per worker. Effective configuration and launcher specifications have unique snapshots outside the input tree.

Four workers used almost twice the memory of two workers and delivered lower aggregate throughput. More resident models do not scale linearly on the shared accelerator. GPU statistics are system-wide Apple GPU device utilization; other applications may contribute. No per-process utilization or memory-bandwidth counters were measured, so these observations do not prove a specific compute-versus-bandwidth bottleneck.

**The 1,000 completed files/minute target was not achieved.** No output shortening, truncation, semantic downgrade, or unsupported-source skipping was introduced to claim that target. This comparison establishes performance on the stated synthetic workload, not a universal performance bound or proof that every possible optimization is infeasible.

## Verification and limits

Fresh strict TypeScript checking passed. The complete automated suite passed **34/34 tests**, including four real resident IPC processes feeding centralized persistence and restart reuse, dynamic dispatch under uneven worker speeds, bounded queues, fatal transport classification, interrupted benchmark assessment, model/config identity changes, memory termination, startup cleanup, resistant-process termination, and the existing interruption, corruption, coverage, large-log, hash, retry, and OS sandbox checks. Mechanical tests use synthetic inference fixtures; the reported throughput uses actual MLX model execution. The independent source review's findings were repaired and regression checked.

All three real-model comparisons passed source-keyed exact correctness and integrity checks and exceeded sixty seconds of active processing. Raw samples, per-worker allocation/token metrics, window reports, and the selected configuration remain in the machine-readable evidence. Preliminary interrupted/deadlocked comparisons are retained but excluded from selection.

The learned adapter used here is the existing narrow synthetic schema adaptation. It is not comprehensive production semantic-role acceptance. The production CLI's accepted-role-manifest gate remains enforced, and that broader role qualification remains outstanding. The throughput table must not be represented as measured production analysis performance. No production dataset content was used in these benchmarks.

## Artifacts

- Evidence: `state/workers-p8WA83/comparison.json` (including resource samples).
- Benchmark log: `state/worker-matrix-32gb.log`.
- Complete test log: `state/tests-workers-final.log`.
- Selected settings: `config/residency.json`.
- Explicit four-worker settings: `config/workers-4.json`.
- Operator instructions: `docs/workers.md`.

Reproduce with `node pipeline/benchmark.ts matrix`; verify with `npm test` and `./node_modules/.bin/tsc`. Production execution remains separately authorized through the existing CLI.
