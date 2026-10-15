# Pipeline handoff — 2026-10-15

Production is not running from this checkout. No corpus content was processed, migrated, deleted or published during this engineering pass.

## Verified implementation

- Dedicated codebase, immutable workflow versions, durable execution state and bounded scheduling.
- Native workflow editor supports exact registered capability references, preview, publication, queueing, status, pause and resume. UI actions cannot execute worker jobs directly.
- Six packaged MLX roles retain measured prompt/generated token accounting and source/model/workflow provenance. Verified committed checkpoint prefixes are reused on retry. Uncommitted inference can repeat after interruption.
- Real macOS sandbox regression verifies only the configured PostgreSQL Unix socket is reachable; other sockets and TCP remain denied. Memory enforcement and bounded shutdown remain active.
- Native app successfully compiled at `dist/Pipeline.app`; it was not installed or launched.
- Local guest-agent transport carries bounded JSON requests on stdin, validates executable/entry hashes before and after calls, and never falls back to host execution.
- Source deployment bundles map executor, control and metadata to `susanbeasles/infra` resources. They exclude production data, operator configuration, credentials and model weights. These are source artifacts, not proof of a deployed service.

## Acceptance evidence

The previous complete synthetic acceptance run passed 339/339 tests. Final additions have targeted synthetic coverage for six-stage accounting, checkpoint reuse, guest transport, deployment integrity and graceful shutdown. See the final verification report below for the fresh complete run; do not interpret mocked inference callbacks as actual GPU benchmarks.

## Actual execution blocker

There is no prepared VM in the configured isolated `state/macos-vms` location. Available disk space is roughly 46 GB, below the infrastructure target of a 64 GB VM disk plus 10 GiB reserve. No storage was deleted to bypass this requirement. VM guest Metal/MLX compatibility remains unverified. Docker `sbx` supplies Linux isolation and cannot execute this macOS MLX/Metal backend.

The deployment owner must provision the private macOS guest and metadata service, install the frozen runtime/import closure and packaged models, verify the OS/network/host-file boundary, and run `pipeline/qualification.ts` with guest-local asset bindings. This synthetic probe must pass before production activation. No host fallback is authorized.

## Operator entrypoints

- `node pipeline/platform.ts /absolute/operator/platform.json`: bounded JSON request on stdin; actions include capabilities, preview, publish, run, status, pause and resume.
- `node pipeline/platform-worker.ts /absolute/operator/platform.json`: consume queued work inside the prepared guest, using its private PostgreSQL Unix socket and network sandbox. SIGTERM requests a checkpointed stop; resume through the control action.
- `node pipeline/cli.ts validate /absolute/operator/config.json`: validate the existing six-stage packaged-model configuration without production enrichment.
- `node pipeline/cli.ts resume /absolute/operator/config.json`: legacy six-stage resume entrypoint; execute only within the qualified guest. The host launcher alone is not VM isolation.

Operator paths belong in ignored local JSON configuration. Inputs remain read-only; staging, state and outputs must be separate. Never launch a new mutable checkout over a running frozen instance.

## Guides and deployment

See `docs/platform.md`, `docs/studio.md`, `QUALIFICATION.md`, and `pipeline/DEPLOYMENT.md`. Pipeline PR: https://github.com/susanbeasles/local-data-pipeline/pull/6 . Infrastructure PR: https://github.com/susanbeasles/infra/pull/11 . Neither PR has been merged or infrastructure applied here.

No new sustained production or VM performance measurement was made. The previously accepted 313 files/minute remains historical, not a new guest benchmark. Collection completeness and current ingestion status were not audited during this pass.

## Final verification

Fresh complete synthetic suite: **349 tests passed, zero failures, zero skips** (106 seconds). TypeScript typecheck passed. Graceful shutdown and forced memory termination regressions passed. Deployment artifact verification confirms required legacy imports and residency configuration are included.

At the user's request, the compiled native dashboard was copied intact to `~/Applications/Pipeline.app` and opened successfully. The installed executable matches the built executable byte for byte. Opening the dashboard did not start or restart processing. VM provisioning is deferred; this is a dashboard installation, not production-run activation.

The data-free source deployment map is at `dist/releases/c069648927d2ea55a09752f8912a1a16c9b3b901b88c9dc584ac9b0090958ef9/deployment.json`. Compiled native application: `dist/Pipeline.app`. Generated artifacts remain ignored and local.

## Native usability update

Overview now includes processing state, durable completed/queued/failed job counts and direct links to stages, collected data and usage. A single primary processing action replaces the disabled three-button row; contacting state is explicit. Processing errors are visible throughout the workspace. Control requests have a bounded timeout and non-successful exits are surfaced; a timed-out action requires a status refresh before retry.

Usage now displays a readable per-stage table and an explanatory empty state. Missing or partially measured forecasts stay unknown. Raw accounting JSON is collapsed under technical details. Per-value assistance remains available. The Tree/JSON picker no longer wraps its unused label.

Verification: native Swift usage regression passed (unknown history, partial forecasts, aggregation); TypeScript check and complete native build passed. Updated app installed and opened without restarting processing. This is a focused Overview/Usage improvement; the explorer, collection and workflow editing screens retain their existing interfaces.

## JSON explorer update

Record views now use lazy, indented, collapsible JSON branches with syntax-colored primitives, quoted/escaped strings, visible braces and array/object summaries. Per-field and record-identity help buttons were removed from the explorer; copy value, copy JSON path and field assistance are in the context menu. SQLite and JSONL remain side by side, with Raw JSON available separately. Preview limits are explicit rather than silent, and key paths distinguish literal punctuation from nested keys.

Verification: both native synthetic tests passed, including nested key identities, JSON escaping, booleans/null, empty containers, long strings and visible depth/child bounds. Complete native app build and TypeScript check passed. Installed and opened the updated app; no processing run was restarted.

## Persistent artifact-only terminal

A collapsible native terminal dock follows all dashboard pages. It runs the actual selected CLI through an interactive PTY, keeps the process alive across page changes/collapse, and stops it explicitly or when the workspace closes. The transport is owned by the app; a tested descriptor-ownership crash in the terminal library's process transport was avoided without modifying upstream dependencies or weakening guards. SwiftTerm remains the pinned renderer.

The CLI has one writable artifact workspace. Notes, change requests and ADR templates are provided; private CLI state is hidden inside that same boundary. Artifacts open in Finder and are proposals only. Global configuration, source data, application code and processing outputs are not writable by the terminal. Approvals remain enabled, configured MCP servers are disabled, and prior global provider rollout history is excluded. Normal terminal-device access is explicitly allowed. No real provider prompt or processing run was initiated during development.

Terminal acceptance: 38 affected Node tests passed, plus 4 real PTY tests (ANSI/input, repeated reuse, scoped writes, resistant-child shutdown). Deployment integrity tests, TypeScript check and native build passed. The updated app was installed and opened; no real CLI provider session was auto-started and no production processing was restarted. Installed Codex help confirms the interactive flags; the configured Claude CLI is unavailable and labeled accordingly. Authentication and provider responses remain untested until the operator explicitly starts a CLI session.

## Dashboard fit correction

The terminal is now a sibling of the workspace in a shared vertical layout, rather than a safe-area overlay added to a workspace with its own fixed minimum. Its expansion is bounded by the actual window height. The explorer record list has an explicit maximum height and the JSON detail area can shrink with the window; each remains independently scrollable. The terminal surface follows its allocated viewport rather than keeping a larger fixed-height NSView behind a clipping frame.

Native layout regressions measure offscreen dashboard/dock sizing at bounded window dimensions using synthetic state and no operator bridge. The update does not alter the terminal's artifact-only filesystem boundary or processing behavior.

Fit verification: all 6 native layout/PTY tests passed, including actual terminal NSView containment at bounded sizes. Native build, TypeScript check and both deployment tests passed. Installed and reopened the app after verifying no active PTY child would be interrupted. No model session or processing run was started.

## Collection-only bulk recovery — enrichment intentionally stopped

The old Atlassian collector ran one TWG command at a time with a fixed inter-command delay. The queue's 505 pending entries were mixed collection jobs (pages, historical revisions, attachments, comments and Jira detail streams), not inference jobs. Historical failed error envelopes include explicit rate limits and unavailable resources; generic coverage labels hid their causes.

The collector now uses Jira REST `bulk-get` with up to 100 issue keys, 4 bounded independent workers, global cooldown on rate limiting, serialized progress persistence, and unique dispatch of queued tasks. Individual resource denials remain auditable failures; only authentication failures stop unrelated work. Numeric entity IDs are not interpreted as HTTP error codes. Existing blocked legacy transport operations remain visible rather than being discarded.

A separate recovery store preserves all 1,007 previously accepted responses, archives the 268 prior failed receipts, and requeues those plus 505 pending jobs without modifying the original store or mirrors. The first recovery execution persisted 18 additional responses before exposing an overly broad access-error stop; that guard was repaired and the same recovery store resumed with a new frozen engine. The dashboard's Atlassian pointer follows this recovery store. Payloads go directly to local SQLite/JSONL; only counts enter engineering output. Confluence's per-page PDF/Word export is not substituted for structured version history.

Verification: 10 synthetic collector/recovery/handoff tests and TypeScript check passed. Real bulk collection is running separately from model inference. This does not certify complete source coverage; unresolved permission/resource and legacy transport gaps remain in the ledger. No enrichment job was started. The tested `intake-input.ts` snapshot feature is inert and has not been applied to production data.

## Fresh enrichment launch (2026-10-15)

Local operator state `state/enrichment-runs/current.json` identifies the fresh run, frozen engine, config, log, and explicit resume command. The first wave snapshots accepted Slack and Atlassian receipts; pending/failed collection remains audited and repository waves are not included. Snapshot verification precedes model launch. The six-stage model retains 64 decode slots, with four active application requests, one prefill sequence, and a 32 GB aggregate guard. This is a bounded starting configuration, not a throughput claim.

The real packaged MLX synthetic gate completed both files and all six stages with integrity true (103.4 seconds, reported worker peak 7.04 GB). Its original semantic check incorrectly rejected “does not allow network access.” A regression-tested equivalent-phrase fix recognizes this explicit prohibition while continuing to reject enabled access; revalidation of the original saved output reports no quality errors. Original gate artifacts are preserved.

Additional local source captures are tracked separately by `state/imports/local-repos-current.json`. Consult each report: workflow and data-pipeline preservation passed; logger and star-config captures did not certify, and infra capture was ongoing at launch. None of those unresolved captures is silently counted as complete. Original sources remain untouched.
