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
