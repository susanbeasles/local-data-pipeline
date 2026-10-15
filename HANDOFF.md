# Current checkpoint — 2026-10-15

This checkpoint publishes the previously local platform implementation for review; it is not a completed-platform or deployment claim. The definitions, durable execution, capability library, platform command service/worker, provisioning and guest PostgreSQL modules and their tests are now included in source. Older statements below saying those modules were not created are historical and superseded.

Current independently verified blocker: `npm run check` fails in `pipeline/platform-worker.ts` because `sandbox.launch` accepts four or five arguments while the new worker supplies a sixth socket-access argument. The required exact Unix-socket policy is not implemented. The new platform code has not passed a fresh complete acceptance run. VM/backend qualification, native JSON workflow controls and the deployment bundle-to-resource map remain incomplete. No production workload or resource apply is performed by this checkpoint.

The checkout also contains commit `18d60be`; the published `work/review-console` branch advanced independently to `fdf9853`. The histories are now reconciled on `work/platform-checkpoint` without overwriting either implementation. Both trace-guard regression suites are retained; all 37 affected workflow/budget tests pass. The new platform worker socket-access typecheck blocker remains separate and unresolved. Local infrastructure source is in the companion `susanbeasles/infra` branch `work/local-pipeline-resources`; qualification receipts deliberately do not claim a verified VM/inference backend.

---

# Engineering handoff — 2026-10-15

## Status

This commit is an engineering checkpoint, **not a declaration that the complete platform specification is finished**. It includes previously uncommitted collection/preservation work, the new native data workspace, and the workflow/PostgreSQL foundation. Production source data, local configurations, databases, JSONL, models, credentials and generated applications are excluded from Git.

No production enrichment was launched for this workspace implementation. Existing collectors and the pinned processing instance were not restarted or migrated. Their current status and collection completeness are not established by this handoff.

## Continuation checkpoint - 2026-10-15

The cumulative local trace guard is repaired. Admission reserves all retained packet allocations and trace metadata before adapter execution. Failure bodies share the step allocation with retained inputs, error messages are bounded, and input accounting includes JSON envelopes and separators. The original regression and five added workflow boundary/failure tests pass.

The descriptor supervisor now establishes its required macOS footprint observer before starting workers or the application. A synthetic observer-load failure regression confirms that neither child starts when that prerequisite fails. This does not establish the cause of the previously intermittent macOS extractor failure.

Verification used the latest registry-listed Node 24 release, **24.22.0**, installed separately from the host runtime. Type checking passes. The complete Linux suite finishes with **209 passed, 62 failed, 1 skipped, 272 total**. All **27 workflow tests**, **11 PostgreSQL metadata tests**, and the observer preflight regression pass. The remaining failures include missing macOS isolation/model facilities and unavailable process identity observation; this is not a passing macOS acceptance run. See [the exact verification report and failure inventory](docs/verification-2026-10-15.md).

Native compilation/GUI acceptance, installed MLX execution and the intermittent extractor failure still require the operator's macOS environment and local assets. The complete broader platform acceptance specification is not present in this checkout; the workflow/metadata integration and platform capabilities listed below remain unfinished.

## Original verification at handoff

- `npm run check`: passed.
- Final merged `npm test` with the existing local synthetic-test model/runtime bindings: **265 passed, 1 failed, 266 total**. The remote generation-scoped sampling and paused-worker verification fixes were merged without force-pushing; sampling retains the newer SQLite-only receipt/identity checks.
- Native Swift compilation was successful during development, but the **fresh handoff compilation failed**. The final check with an explicitly selected Command Line Tools SDK reports a missing `SwiftUIMacros.StateMacro` plugin. Earlier checks also reported malformed plugin responses or inability to load the standard library. Resolve SDK/compiler/plugin compatibility and rerun the build. No updated application deployment is claimed.
- No authenticated Codex/Claude inference requests were made during engineering validation. Local help probes identified Codex capabilities; Claude was absent at the configured local path.
- PostgreSQL tests execute actual PostgreSQL through PGlite. They are not proof of a separate-server deployment, multi-host concurrency or production load.

Known remaining full-suite failure:

1. `pipeline/tests/workflow.test.ts` — **local trace bounds reject an oversized retained plan before any adapter can perform work**: the expected preflight rejection is missing. Implement the cumulative trace allocation guard before adapters run; preserve the regression test. Prefer immutable artifact handles for large datasets.

An earlier full run also failed `pipeline/tests/extractor.test.ts` — **sealed extractor executes only under OS restrictions and participates in resume**, with subprocess exit status 1 instead of 0. It passed both subsequent full runs; investigate this intermittent runtime/sandbox failure rather than removing guards.

Local verification logs are `/private/tmp/handoff-merge-check.log`, `/private/tmp/handoff-final-tests.log`, `/private/tmp/handoff-swift.log` and `/private/tmp/handoff-swift-final.log`; these are not committed and may expire. Re-run checks rather than trusting old logs.

## Code map

| Area | Entry points |
| --- | --- |
| Existing six-stage enrichment | `pipeline/run.ts`, `pipeline/graph.ts`, `pipeline/mlx.ts`, `pipeline/worker.py` |
| Model role packaging | `pipeline/package.ts`, `pipeline/roles.ts`, `pipeline/role-data.ts` |
| Collection and durable intake | `pipeline/intake.ts`, `pipeline/github.ts`, `pipeline/slack.ts`, `pipeline/slack-files.ts`, `pipeline/twg.ts`, `pipeline/agents.ts` |
| Complete content/preservation | `pipeline/content.ts`, `pipeline/records.ts`, `pipeline/preserve.ts`, `pipeline/ingest.ts`, `pipeline/data.ts` |
| Live read-only source catalog | `pipeline/catalog.ts` |
| Versioned local datasets and ETL | `pipeline/dataset.ts` |
| Isolated CLI agent sessions and field assistance | `pipeline/sessions.ts` |
| Native workspace command bridge | `pipeline/studio.ts`, `pipeline/process.c` |
| Native macOS interface | `native/Workspace.swift`, `native/StudioViews.swift`, `native/Explorer.swift`, `native/Datasets.swift`, `native/Flows.swift`, `native/Agents.swift` |
| Processing-instance controls | `pipeline/panel.ts`, `native/Pipeline.swift` |
| Frozen releases, including runtime dependencies | `pipeline/release.ts`, `native/build.ts` |
| Declarative graph/registries | `pipeline/workflow.ts`, `config/workflow.example.json` |
| PostgreSQL schema and transactions | `pipeline/platform.sql`, `pipeline/metadata.ts` |

## Native workspace delivered in source

Source registrations provide live SQLite counts, separate process evidence, checkpoint timestamps and stale indicators. The explorer compares actual SQLite rows and actual JSONL mirrors, labels bounded/unknown results, and imports only after an operator action. Local datasets preserve immutable revisions, full JSONL, stable identities, annotations, typed links, filters, deterministic transformations, dedupe, validation dispositions, correction and resume.

Background worker admission uses guarded SQLite leases, process birth identity and a token handshake. Imports freeze resolved database bindings and verify their saved prefix on retry. ETL/import workers deny network access at the macOS OS boundary and write only operator state. The nonprivileged libproc observer is compiled and hash-pinned because macOS refuses setuid `ps` inside Seatbelt.

Structured fields offer a small previewable assistance packet and exactly three follow-ups. An explicit Ask action starts a fresh installed CLI context; collection tasks have independent sessions, reset/branch/rewind/compact and streamed events. Session help excludes global context history and source reads. Collection read roots must be explicitly configured. Codex/Claude assistance may contact its configured provider; it is separate from local MLX enrichment.

The native UI has not received a final interactive acceptance pass and no new app deployment is claimed. Build after fixing the remaining tests and verifying the local toolchain:

```sh
npm ci
npm run check
npm test
node native/build.ts /absolute/operator/panel.json /absolute/operator/studio.json
open dist/Pipeline.app
```

Use `config/studio.example.json` and [the workspace guide](docs/studio.md). Local absolute paths belong only in ignored operator configuration. The existing prepared panel registry is required by this build entrypoint. Do not incidentally prepare or restart the processing instance while rebuilding its control panel.

The full local engine tests need installed model assets. Supply `PIPELINE_CONFIG=/absolute/local/model-bindings.json` and `PIPELINE_RUNTIME=/absolute/local/uv-runtime` when running `npm test`; inspect `pipeline/local.ts` for binding lookup. Those tests use synthetic inputs, not the configured production corpus. Missing assets are a failure to diagnose, not a reason to remove verification.

## Broader platform: what remains

The supplied platform specification exceeds the existing ordered ETL workspace. The new graph core has immutable definitions, pinned registries, typed ports, scope/capability checks, graph compilation and a trusted local runner. The PostgreSQL layer has normalized entities, authorization checks, compiled-definition persistence, leases/fencing, task attempts, atomic artifact/checkpoint commits, quality gates, usage and audit integrity tests.

These are **not yet a fully integrated replacement platform**:

- The separate `definitions.ts` JSON-to-resource service and `execution.ts` durable graph runner discussed during implementation were **not created**. Do not look for them or claim they are implemented.
- Complete registry/resource provisioning, the graph runner's integration with durable PostgreSQL execution and the existing resident MLX engine, and platform controls in the native UI remain to be completed.
- The graph JSON example uses explicitly synthetic deterministic handlers. It proves graph behavior, not model quality or a production inference adapter.
- Streaming/windowed/incremental execution semantics, distributed operation, scheduled/event triggers, full connector coverage, credential resolution and the entire supplied acceptance matrix are not verified as finished.
- Local graph handler budgets are cooperative; they do not sandbox arbitrary host code. Dedicated VM isolation remains separate unfinished work. macOS process sandboxing and frozen releases are not a VM or protection against a host administrator.
- No new sustained performance claim is made. Preserve the existing continuous batching implementation and prior accepted baseline; do not chase throughput by reducing completeness.

## Next actions

1. The cumulative trace guard is repaired and covered by additional regression tests. Investigate the intermittent extractor failure and rerun the complete suite on macOS with valid **local synthetic** model/runtime assets.
2. Review and finish the new native views, test provider startup using an explicitly approved bounded request, build a frozen control release and perform a local GUI acceptance pass.
3. Join the validated graph compiler, normalized metadata service and durable execution path. Add end-to-end PostgreSQL + real artifact + worker-interruption tests before exposing production graph controls.
4. Implement remaining platform capabilities against the supplied completion criteria, failing explicitly on unsupported modes. Keep raw observations, model assertions, accepted facts, lineage and execution dependencies distinct.

## Safety and operational boundaries

- Never commit the corpus or generated data. Keep input roots read-only and all outputs outside them.
- Do not delete source archives or duplicate-looking files based on this handoff. Preservation/coverage verification is a separate explicit prerequisite.
- Do not read production records into an engineering chat. Use schemas, metadata and synthetic fixtures.
- Python environment work uses `uv` only. Do not access the user's protected `~/.local` directory, modify global Codex configuration, install plugins or silently enable external inference.
- Preserve the current 64-slot batching path and frozen running/staged configurations. Changes to a checkout must not mutate existing releases.
- Signed commits and repository rules remain in force. Push the working branch; do not bypass protections or force-push.

Related guides: [operator](docs/operator.md), [workspace](docs/studio.md), [catalog](docs/catalog.md), [datasets](docs/dataset.md), [sessions](docs/sessions.md), [workflow core](docs/workflow.md), [metadata](docs/metadata.md).
