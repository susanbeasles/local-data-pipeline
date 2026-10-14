# Local review console and production run

The console is a local application that reads your processing databases and attributable outputs. It does not initialize models, run inference or modify processing SQLite tables. Browser/API access binds only to 127.0.0.1 and requires a random session bearer token; the printed URL carries that token in its fragment. Keep that URL local. Source text and outputs are rendered with textContent, never executed as HTML.

## Open the console

    node pipeline/console.ts /absolute/work-directory 8765

Open the printed URL in your browser. It shows phase, process liveness, job counts, source inventory dispositions, per-stage progress and failures. The database browser provides paginated read-only jobs/sources/attempts from core or graph SQLite, with a stage filter for jobs. Completed-job receipt buttons show the source spans, configured provenance, inference trace and model result. Corrupt receipt hashes and paths outside the work directory are rejected. Browser previews are limited to 8 MiB; larger local artifacts remain preserved.

Processing databases are state/pipeline.sqlite and state/graph.sqlite. Review decisions use a separate state/review.sqlite WAL/FULL ledger. Arbitrary SQL and direct checkpoint editing are not exposed by the console. The application runner owns all processing-state transitions.

## Enable durable pauses for a future run

Add to a run config before starting:

    "review": {
      "after": ["tag", "classify", "summarize", "knowledge", "reconcile", "connect"]
    }

For a custom profile, use its stage names. You can select fewer stages. Existing configs without review retain automatic progression. The active production run was launched using the existing main runner and has automatic progression; opening its console does not add pause gates or alter loaded code.

A review-enabled runner finishes the selected stage, persists a gate bound to its exact job/attempt/output-hash snapshot, and waits. The local model remains resident. The console offers:

- Approve: permits the next stage; incomplete stages cannot be approved.
- Retry: the runner requeues that stage, invalidates dependent completion, and gives the new attempt a bounded retry allowance. Previous attempts and review decisions remain auditable. A new receipt snapshot requires a new review.
- Reject: stops progression and preserves checkpoints. Explicit resume reopens the review; do not edit database rows to force completion.

Verified approvals are reused after restart only for identical receipt snapshots. Changed outputs, attempts, model/configuration identity or invalidated dependencies produce new gates. Kernel processing locks and atomic receipt persistence remain intact. Console actions update only the decision ledger; the owning runner applies retries to its own database.

## API

GET /api/status, /api/rows?db=core&table=jobs&offset=0&role=tag, /api/receipt?db=core&id=JOB_ID; POST /api/decision with JSON {id:GATE_ID,decision:approve|retry|reject}. Every API request requires Authorization: Bearer SESSION_TOKEN. Cross-origin and unexpected Host requests are rejected. Decisions for consumed/stale gates are rejected. The console intentionally does not launch a production run remotely.

## Curation integrity and recovery

Curation preserves exclusive manifest memberships and protects ambiguous inputs. Restart rechecks copied bytes, source hashes, independent file identity and read-only permissions. Unexpected files and symlinks in the designated input partitions remain untouched and fail integrity; the command exits unsuccessfully. Failed or invalid source preparation blocks stage approval. Correct the diagnosed input/configuration issue and explicitly resume; approval cannot waive incomplete coverage.
