# SQLite owns inference data

Ingestion reads source files and normalizes their contents. Before any inference job starts, the complete normalized text is persisted in `state/pipeline.sqlite`: `source_data` contains source provenance and coverage metadata; `chunk_data` contains the actual chunk JSON, including its text. The `model_data` view exposes text directly for SQL inspection. These rows are not paths to external data.

All four chunk roles obtain text and prior-stage results from SQLite. Graph roles obtain entity evidence and reconciliation results from SQLite as well. The model worker receives dynamic data through the existing JSONL pipe. It never resolves a source, staging or result path. Role artifacts, model loading, fixed instructions and 64-slot continuous batching are unchanged.

`results` stores complete result envelopes as JSON. Each result and its completed job state commit in the same SQLite transaction. `attempt_data` stores the request before the call, returned data and failed-call diagnostics/partial output. Core data resides in `pipeline.sqlite`; graph jobs/results reside in `graph.sqlite`. Each job's data and state share its database and transaction. This is not a claim of one transaction spanning both databases.

Every stored source/chunk/result has a checked digest. Coverage verification reconstructs normalized content from SQLite chunks and verifies source/chunk attribution, role output schemas and complete job coverage. Missing or corrupt database data cannot pass completion. Export problems are reported separately in `exportErrors`; they cannot cause successful inference to be retried or replace authoritative database records.

Complete original bytes are retained in `content_blobs`/`content_blocks` and mirrored in per-source `.content.jsonl` records using base64 blocks. Normalized chunk JSONL is also required and verified against the SQLite chunk records. Only optional per-job JSON receipt exports may fail independently of completed inference. Models receive actual dynamic JSONL records through their worker pipe; scheduling and prior-result retrieval use SQLite. Existing source-file hash validation remains available to the verifier for source reconciliation. Native data review and the authenticated local console now read result JSON from SQLite with size and digest checks; they do not open receipt paths. Progress, token accounting, logs, pause and resume remain available.

## Existing checkpoints

Old checkpoints contain external JSON/JSONL pointers. They are **not already migrated** merely because new tables exist. The new runner blocks them before scheduling; it does not silently rerun completed work.

With the instance stopped and its state backed up, explicitly import its existing generated data:

```sh
node pipeline/migrate.ts /absolute/instance/work /absolute/read-only/input
```

This command takes the instance locks, verifies contained paths, staging/JSONL hashes, contiguous complete chunks, normalized hashes and completed result attribution, and imports real JSON into SQLite. It performs no inference and does not modify source files. Import readiness is published only after all sources and completed outputs pass. The command is resumable after a failure; it refuses missing/corrupt legacy artifacts. It does not unpack ZIP archives or turn unsupported sources into model inputs.

## Inspect or export locally

```sh
sqlite3 state/pipeline.sqlite 'SELECT source,n,text FROM model_data ORDER BY source,n LIMIT 10;'
sqlite3 state/pipeline.sqlite 'SELECT body FROM chunk_data ORDER BY source,n;' > chunks.jsonl
sqlite3 state/pipeline.sqlite 'SELECT body FROM results ORDER BY job;' > results.jsonl
```

These commands display/export actual data locally. Do not send their output to an external service. Indexed retrieval is available through `node pipeline/data.ts search /absolute/work "search terms"` and returns actual chunk contents, not filesystem pointers.

Original archives are not proven redundant by an inventory row or hash. Archive extraction/import coverage remains a separate requirement before deleting archival originals.

## Verification

Synthetic integration deletes optional staging metadata and result exports before every model call across all six stages, then verifies SQLite coverage and resume without repeated inference. Additional tests cover corruption, missing chunks/results, partial failures, legacy migration and export failure without duplicate calls. Native and console tests verify database-backed samples and reject altered receipt bodies. Production data migration and production inference are separate operator actions; synthetic acceptance alone does not establish that an existing corpus is fully imported.
