# Six-stage implementation and verification — 2026-10-13

## Current implementation

The packaged six-stage pipeline uses unchanged local Qwen 2.5 3B Instruct weights and sealed role configuration artifacts in `models/qwen-roles-v14`. Each artifact contains fixed instructions, schema, input selection and generation settings. The custom runtime honors the artifacts automatically and receives dynamic payloads. Packaging does not modify or recompile weights and is not fine-tuning or LoRA. Bare MLX loading does not implement this custom package contract.

There are six public roles and seven initialized instruction states, including the private source-presence check in connect. In packaged mode, repeated requests construct/tokenize zero system instructions and transmit zero system bytes. Independent sequence attention state shares model weights. `config/residency.json` now selects one resident model with 64 continuous-batching slots, prefill size 4, concurrency 64 and a 32-billion-byte monitored process budget. The example references v14.

Stages tag/classify/summarize/knowledge operate on complete chunks; reconcile/connect adjudicate entity pairs over attributable upstream results. Deterministic hashes and receipts bind sources, chunks, role/model configuration, attempts and evidence. SQLite WAL/FULL state, central result persistence, atomic artifact writes and kernel locks preserve restart safety. Explicit resume gives failed jobs a fresh bounded retry allowance while retaining attempt history and verified completed results. Coverage/dispositions include unsupported and invalid inputs. Status is read-only and detects interrupted owner processes.

OS Seatbelt denies runtime network access and input writes; model workers also deny arbitrary file access, writes and spawning. Tests exercise the restrictions, rather than trusting a local configuration label.

## Acceptance evidence

Fresh checks after default promotion: `npm test`, 57 tests passed, zero failures/skips; `npm run check`, exit 0. Log: `state/tests-resumed-delivery.log`. The tests include process termination/recovery, graph resume, failed inference retries, concurrency/backpressure, memory breach termination, source and output corruption, modified/duplicate sources, invalid JSONL/UTF-8, unsupported files, full chunk reconstruction, missing/extra artifacts and six-stage orchestration. Deterministic inference fixtures test orchestration; they do not establish real-model quality.

Actual local-model relationship suite: 8/8 controlled cases passed (`state/relations-order.log`). The final actual-model six-stage comparison completed both configurations with integrity=true and no semantic acceptance errors (`state/enrichment-2zXnoC`). Neither result was obtained from production inputs. No production enrichment run is authorized or was launched.

This final comparison supersedes older failed v6–v13 semantic experiments, which remain preserved. The historical 313 files/minute result is a narrow copy-role benchmark, not current six-stage throughput.

## Measured final comparison

| Metric | Inline fixed instructions | Packaged role instructions/state |
|---|---:|---:|
| Completed files | 2 | 2 |
| Total seconds | 132.881420292 | 126.777668 |
| Completed files/minute | 0.9030607871 | 0.9465389441 |
| Request prompt-prefill tokens | 15,044 | 4,284 |
| Initialization fixed-system tokens | 0 | 1,925 |
| Reported generated tokens | 1,390 | 1,390 |
| Generated tokens/sec, wall time | 10.4604541173 | 10.9640761021 |
| Repeated system tokenizations | 61 | 0 |
| Repeated template constructions | 61 | 0 |
| Initial instruction tokenizations | 0 | 7 |
| Fixed tokens reused | 0 | 10,760 |
| Integrity / semantic acceptance | passed / passed | passed / passed |

The engine reports 1,451 generation tokens in both runs, whereas benchmark reported-output tokens are 1,390. These counters have different scopes; retain both, do not relabel them as identical. Prompt generation seconds: inline 19.472667209; packaged 9.126477792. Decode seconds: inline 87.208433089; packaged 88.076393787. Request prefill excludes packaged initialization; including initialization gives 6,209 packaged prompt tokens.

Packaged process resources: peak footprint 7,999,250,616 bytes; peak resident 7,033,339,904 bytes; no 32 GB budget exceedance; mean GPU utilization 68.002%, peak 100%. GPU measurements are system-wide Apple GPU utilization and can include other applications. The comparison.json resource record also reports inline peak footprint 7,853,780,104 bytes, peak resident 6,991,265,792 bytes and mean system-wide GPU utilization 70.289%; neither run exceeded budget. The comparison verifies identical fixed instructions, dynamic request hashes and output hashes across modes.

This is a two-file correctness workload with graph and presence work, NOT a sustained throughput benchmark or a 313-files/minute six-stage result. The packaged run saved roughly 6.10 seconds in this workload; generation and additional semantic checks dominate elapsed time. Batched-forward counters are recorded in the raw metrics.

## Limits and unverified properties

Controlled semantic acceptance does not prove accuracy on arbitrary data. Connection presence checks are model decisions, not a semantic oracle. They evaluate both name orders, individual statements and full/reversed context without early stopping, adding substantial work. Pair enumeration is exhaustive and quadratic in entity occurrences.

Text and text JSONL extraction are supported. Other binary/document formats have explicit unsupported dispositions; there are no added document extractors. Configured oversized files fail explicitly rather than truncate. Protected credential/special paths may have null content hashes because they are not read. Memory monitoring is sampled enforcement, not a hard OS allocation cap.

The local installed runtime and model are read-only dependencies; Python package versions and Node dependencies are pinned. A standalone offline wheelhouse is not bundled, and fresh-machine installation is not verified. Runtime remains macOS Apple Silicon specific. No sustained representative six-stage throughput claim follows from two files. Full 1/2/4-worker six-stage scaling is not measured by this comparison. Input-specific production compatibility remains untested by design.

See `docs/operator.md` for production entrypoint, protected integrity verification, status and explicit resume. See `docs/handoff-2026-10-13.md` for implementation details and preserved history. The handoff describes the earlier stop state; current default/example promotion and fresh checks are recorded here. This report distinguishes controlled verified behavior from remaining capability limits and does not assert unrestricted semantic correctness.

Final protected integrity-only CLI check on the packaged synthetic checkpoint returned discovered=2, completed=2, errors=[], integrity=true, exit 0. It initialized no model and performed no enrichment.

## Reusable profile and extractor extension — subsequent verification

The entrypoint now accepts an enrichment/1 profile embedded in config or referenced by a JSON file. Stage names, fixed instructions, schemas, order and token allowances are configurable. A sealed package must match the configured profile. Custom profiles use the same durable scheduler, dependency handling, lossless chunk staging, validation, recovery, status and bounded local worker as the six-stage workflow. The built-in graph contract remains intact. Config defaults no longer replace explicit batching, memory or concurrency values. Relative paths resolve against configuration location; validation checks model/runtime/work separation and executable runtime presence before generating run artifacts.

A sealed operator-authored extractor interface supports additional local formats without editing scheduler code. Extensions cannot reside in input and are not auto-discovered. Their directory hashes are validated without execution; loading requires OS network denial. Tests cover raw hashing, normalized size limits, unsupported dispositions, seal tampering and actual sandboxed execution/resume. Extension modules must bundle their local dependencies and remain deterministic; transitive imports outside the sealed directory are not independently sealed by this interface.

Actual local Qwen acceptance for a custom catalog profile produced names=[Alpha] and supported=true. Current checkpoint contains one completed file and two completed jobs, each attempt 1; explicit resume reused completed results. Evidence: state/custom-profile-acceptance.json, state/custom-live-final.log, state/custom-resume-final.log. Protected integrity verification returned no errors. This is a controlled custom-task acceptance case, not generalized semantic accuracy.

Fresh real-model six-stage regression: state/enrichment-Inj9lI/comparison.json. Both modes completed two files with integrity=true and qualityErrors=[], with identical fixed instructions, dynamic request hashes and output hashes. Its purpose was regression acceptance after extensibility changes; a brief overlapping custom test means it should not replace the earlier isolated performance comparison.

The updated automated suite covers 64 tests, including custom-stage dependency execution, invalid schemas, retained explicit settings, profile changes, sealed artifacts, external-profile CLI validation without input processing/work creation and custom extraction. See state/tests-reusable-final.log for the latest full run. New task-specific business rules still need acceptance tests; generic profiles enforce their configured schema, not every possible business invariant. Arbitrary global graph behavior, unsupported JSON-schema features and additional model backends require targeted extensions rather than being silently approximated.

Reusable operation and extension instructions: docs/reuse.md. No production processing occurred.
