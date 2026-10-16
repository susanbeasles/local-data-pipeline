# Continuous batching verification

## Prompt/model integration answer

Comprehensive role instructions have **not** been embedded in the model and then recompiled. The existing LoRA adapter changes weights for a narrow synthetic JSON-schema/copying task. It does not qualify as incorporating all required semantic-role instructions. Compiling unchanged weights or keeping attention state resident would not satisfy that requirement. This targeted optimization neither retrains the model nor changes the role, user input frame, temperature, stopping rules, output schema, or evidence/persistence semantics.

## Installed engine findings

Inspected the installed MLX-LM 0.29.1 implementation directly, without loading production content:

- `mlx_lm/generate.py`, `BatchGenerator._process_prompts`: left-pads multiple prompts into a `[B,L]` tensor, creates batch-aware KV caches, and calls the model with those multiple rows.
- `BatchGenerator._step` and `_next`: call the same model on `[B,1]` tokens for all active sequences, remove finished rows, and extend active batch caches with newly admitted prompts.
- `models/qwen2.py`, `Attention.__call__`: preserves `B` through linear projections and `[B,heads,L,dim]` attention tensors. The model does not loop over sequences to generate independently.

Thus the earlier implementation already executed genuine batched model forwards. Its prefill size equaled decode capacity (16), and the engine admits new prompts only while free decode slots are at least the configured prefill size. That setting prevents refilling partially occupied batches. The targeted change exposes `mlx.prefillSize` independently and permits bounded decode capacities up to 64. Existing allocation limits, 32 GB aggregate footprint guard, OS networking/input restrictions, output validation, and checkpoint handling remain enforced. The two-worker default and its measured settings file remain unchanged.

Instrumentation delegates every model call to the original loaded model object and records actual input batch rows. It neither clones weights nor adds per-forward synchronization. Counter labels `prefill:B` represent multi-token input calls; `token:B` represents one-token calls including the final prompt token and autoregressive decode.

## Sustained paired measurements

All configurations processed **384 source files**, comprising the original 192 baseline fixture texts repeated twice at distinct paths. Each file receives a separate complete inference and result; there is no deduplication, skipped source, truncation, or shortened output. Three windows of 128 use identical source text, identifiers, hashes, role adapter, max output token budget 256, and exact source-keyed output oracle across configurations. All three configurations completed all 384 files correctly with full integrity, generated 18,816 output tokens, stayed under 32,000,000,000 bytes, and exceeded 60 seconds of active processing.

Hardware: Apple M4 Pro, 12 CPU cores, 48 GiB installed memory. Local Qwen 2.5 3B, existing synthetic learned adapter, temperature zero. Files/minute and generated tokens/sec include initialization, pipeline execution, persistence, and correctness reconciliation. Active processing durations: baseline 128.38 s; single model/32 slots 98.62 s; single model/64 slots 71.48 s.

| Configuration | Workers × decode / prefill | Files/min | Generated tokens/s | MLX pooled prompt-phase tokens/s | Aggregate input tokens/s (pipeline wall time) | Mean GPU | Peak footprint |
|---|---|---:|---:|---:|---:|---:|---:|
| baseline | 2 × 16 / 16 | 176.06 | 143.78 | 438.40 | 170.49 | 75.9% | 14.59 GB |
| continuous-32 | 1 × 32 / 4 | 224.85 | 183.63 | 713.49 | 221.93 | 80.6% | 7.92 GB |
| continuous-64 | 1 × 64 / 4 | 313.29 | 255.85 | 722.66 | 306.19 | 82.1% | 8.99 GB |

The pooled prompt-phase metric divides total prompt tokens by summed worker MLX prompt-phase seconds. MLX includes admission and associated generation in this timing: it is **not pure prefill kernel time or aggregate concurrent wall-clock phase throughput**. The adjacent aggregate input-token metric uses active pipeline wall time, including decode and persistence. Raw per-worker counters are retained. GPU utilization is system-wide Apple GPU device utilization, so unrelated applications may contribute.

One resident model with 32 decode slots matches the baseline's aggregate slot count and improves measured completed-file throughput by **27.7%**. One model with 64 decode slots improves it by **78.0%**, with peak aggregate footprint **8.99 GB**, versus **14.59 GB** for two workers. These are measured gains on this workload, not proof of performance on full production analysis or every input distribution. The earlier 192-file baseline report remains unchanged; compare configurations using these fresh paired measurements. **1,000 completed files/minute remains unmet.**

The actual forward trace recorded 600 single-token calls at batch row count 32, and 300 at row count 64, using one loaded model. Uniform fixtures finish together, so these timing runs recorded zero mid-decode refill events. Their gains demonstrate larger true model batches and shared weights; they must not be attributed to exercised continuous refill.

## Continuous admission proof

A separate real-Qwen probe used one model, four decode slots, prefill size one, and four of the same exact fixture texts. Two requests were delayed 100 ms to arrive while the first two were decoding. It recorded **two mid-decode admission events**, model forwards growing to four rows, and all four complete outputs passing the source-keyed oracle and integrity checks. This proves continuous admission with independent sequence state under one shared model. Its short duration is a behavioral probe, not a throughput benchmark.

An additional synthetic MLX backend contract test uses variable-length sequences to verify batch row filtering, sequence identity, and admission into a running batch. It does not load model weights or read the corpus. Fresh strict TypeScript checking and the complete **37/37 test suite** pass, including earlier concurrency, interruption, hash, corruption, memory and OS sandbox acceptance checks. Independent source review found the measurement labels needed clarification; that clarification is included in code and evidence.

## Preserved failures and limitations

An initial enlarged set introduced previously unqualified service-number examples. The two-worker run completed 382/384, with two output-token exhaustion errors and failed exact correctness/integrity. That run remains under `state/workers-iiTXrr/` and was excluded from successful performance claims; its one-model comparison was interrupted. It reinforces the known limitation that this adapter is narrow synthetic adaptation, not comprehensive semantic-role qualification. The final paired comparison uses the original benchmark payloads with repetition, without modifying any failed fixture or relaxing validation/token limits.

No production dataset inventory, enrichment, migration, normalization, or processing was performed. No model weight changes, global configuration changes, remote inference, or additional project were introduced.

## Reproduction and artifacts

- `node pipeline/benchmark.ts continuous`: runs the three paired configurations; never changes the default residency settings.
- `node pipeline/probe.ts`: runs the real-model staggered-admission correctness probe.
- `npm test`; `./node_modules/.bin/tsc`: full synthetic acceptance and strict type checking.
- Complete measured evidence: `state/workers-lwKfCm/comparison.json` and each candidate's `benchmark.json`/`state/resources.json`.
- Comparison log: `state/continuous-baseline-fixtures.log`.
- Real refill proof: `state/refill-ARWnF2/work/proof.json`; log `state/refill-proof.log`.
- Full test log: `state/tests-batching-final.log`.
- Optional tested candidate parameters: `config/continuous-64.json` (not applied to default or production).

The optional candidate parameters are `workers:1`, `batchSize:64`, `prefillSize:4`, `memoryBytes:31000000000`, `budgetBytes:32000000000`, and root `concurrency:64`. Use all inference fields inside `mlx` and preserve existing runtime/base/adapter paths, semantic configuration, and output limits. The accepted-role-manifest gate remains in place. Production execution remains separately authorized.
