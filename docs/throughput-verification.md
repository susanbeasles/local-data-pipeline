# Round throughput verification — 2026-10-16

Status: **two-hour full-round target not met**. No full-stage performance acceptance is claimed.

## Measurements

Apple M4 Pro, 16 GPU cores, 48 GiB physical memory; aggregate process budget 32 GB. Local Qwen 2.5 3B, unchanged bfloat16 model artifacts, sealed packaged roles, one resident model, 64 decode slots, 16 application requests. OS network and input-write restrictions remained enforced.

Each configuration ran one warmup followed by the same 32 synthetic Tag requests. All 32 output hashes matched across all configurations; the worker recorded actual multi-row prefill forwards at rows 4 and 8. Each sample processed 56224 dynamic input tokens and 256 generated tokens. These are completed **stage requests**, not completed multi-chunk files or a six-stage run.

| Prefill sequences | Request seconds | Input tokens/s | Generated tokens/s | Stage jobs/min | Peak process GB | Mean GPU |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 83.69 | 671.8 | 3.06 | 22.94 | 10.45 | 76.1% |
| 4 | 79.22 | 709.8 | 3.23 | 24.24 | 10.74 | 77.7% |
| 8 | 78.44 | 716.8 | 3.26 | 24.48 | 10.93 | 78.4% |

Worker initialization is excluded from request timings; supervisor memory/GPU sampling includes initialization. GPU utilization is system-wide and peaked at 100% in all three runs. The full synthetic suite overlapped part of the first configuration; this is a short diagnostic comparison, not a sustained isolated or statistically repeated qualification. The observed small differences do not justify claiming a stable production gain.

Production resumed automatically using its existing frozen engine, configuration and completed receipts. Prefill settings are fingerprinted; changing them in place would create different job identities. They were not silently changed.

## Target gap and input cost

The current snapshot contains 6,866 accepted Slack/Atlassian API-response files, 542,515,017 raw bytes, and 94,187 chunks per chunk-based stage. It excludes additional repository capture waves and outstanding collection. Two hours for its Tag stage requires 784.89 completed chunk jobs/minute **and** all 6,866 sources reconciled as complete. The short best synthetic measurement was 24.48 stage jobs/minute, over 32 times below that job rate despite its shorter average inputs. This is evidence that the current execution path fails the target, not a universal hardware impossibility proof.

A local recent-call sample averaged 2,514 input tokens and 22 generated tokens. The historical 313/minute result used narrow adapter fixtures averaging 57 input tokens, not this unchanged-weight six-stage workload. Increasing independent model instances or decode capacity does not remove the measured input-prefill cost.

An aggregate SQLite check found only 492 duplicate chunk hashes among 94,187 chunks; exact chunk memoization alone cannot close the gap. Raw API pages repeat large nested thread roots, profiles and message structures while current generic chunking misaligns those repeats.

## Implemented integrity work

Lossless normalization completed all 6,866 snapshot sources in 153.437 seconds with integrity true. Original bytes remain in SQLite and compressed JSONL archives; the factored JSONL view is 317,904,541 bytes. Source hashes, reconstructed values and exports were verified. This 41.4% byte reduction is a storage measurement, not measured token or inference acceleration. The normalized representation explicitly reports inferenceReady:false.

Model-facing normalization must still preserve complete thread/history context, all nonredundant structured evidence and source mappings; passing unresolved reference slots to the current worker would be incorrect. Expanding every reference restores the repeated token cost. No production cutover to that format occurred. Graph reconciliation also retains an exhaustive pair schedule whose quadratic scale remains unqualified.

Recovery changes retain completed attempts, restore only hash/schema/provenance-verified results, and avoid rewriting unchanged chunk/FTS data. The two-hour evidence evaluator rejects incomplete, unsupported, failed, unverified, mismatched or still-running rounds. It does not fabricate execution evidence. See [operator commands](throughput.md).

## Verification and remaining work

Final verification passed all 383 synthetic tests with zero failures; TypeScript checking passed. No full-source inference round has completed within two hours. The six-stage small synthetic gate establishes integration and semantic checks only, not production throughput. Provider-aware model-context integration, complete-source round measurement and large graph-stage qualification remain required.

Raw benchmark traces, memory/GPU samples, normalized archives and production checkpoints remain local under ignored state/. No source payload or runtime artifact is part of this report or intended for GitHub.
