# Durable batch execution

`Execution` composes a published compiler release, a host-owned `Registry`, PostgreSQL metadata, and a local artifact directory. PostgreSQL owns dependency readiness, run state, leases, fencing, attempts, bindings, commits, checkpoints, lineage, and usage. Constructing another instance with the same database and artifact root resumes that authority without an in-memory task cache.

```typescript
const execution = new Execution(metadata, trusted, artifactRoot, {
  policy: hostPolicy,
  leaseSeconds: 60,
  packetBytes: 1024 ** 2,
  packets: 65536,
});
const run = await execution.start(version.id, {
  key: "import-2026-10-15",
  parameters: { source: "synthetic-fixture" },
  maxAttempts: 3,
});
await execution.drain("worker-1");
const state = await execution.status(run.id);
```

Publish versions through `Definitions` first. The stored registry manifest and compiled release are revalidated against the explicit host policy before work runs. Adapter digests resolve only to handlers registered by the host; JSON cannot import a module or choose executable code. `parameters` are bounded run metadata. Source handlers read their pinned resources; parameters do not silently become graph inputs.

`start` atomically enumerates and seals one batch task for each graph step. An optional batch key makes starts idempotent within a workflow version. Repeating a key with changed parameters or retry limits fails. `work(worker)` claims at most one SQL lease and returns its completion, retry, or failure result. `drain(worker, limit)` continues until no task is immediately claimable. Other workers can still have leased tasks when it returns. Workers may run in separate processes against PostgreSQL and must share the artifact root. The PGlite tests exercise two engine objects and real PostgreSQL queries in one process; they do not establish multi-process load behavior.

SQL prevents downstream claims until every upstream step completes. Each output port becomes a newly created JSONL file, including an empty file for an optional port with no packets. The runner checks schema, cardinality, finite JSON, packet count, packet bytes, and configured step budgets. It writes with exclusive creation, syncs file bytes and the containing directory, and removes write permissions. UUID filenames belong to one attempt and are never reused. Every consumer verifies the declared size and checksum, rejects aliased/out-of-root files, and hashes the actual input stream again.

The dataset, dataset version, representation, fenced artifact commit, downstream bindings, checkpoint, lineage, usage, and published dataset state share one SQL transaction. A failed quality gate, invalid output, expired lease, or transaction rollback exposes none of those output rows. A crash can leave an unreferenced file in the artifact directory; it cannot make that file a committed output. Retention and orphan-file cleanup belong to a separate maintenance operation.

The default maximum packet is 1 MiB, with a configurable ceiling of 16 MiB, and at most 65,536 packets per step. The complete materialized input and output also remain bounded by the step memory budget and a 16 MiB host ceiling. Larger logical data must be carried as schema-declared artifact handles, such as the workflow `ArtifactHandle` shape, referencing immutable, already committed datasets/artifacts. Handles remain small JSON packets. Trusted source and destination adapters resolve the pinned resources through their host-provided storage access. The runner does not automatically substitute a handle for a record or bypass its port contract.

Failed handler attempts retain charged usage and observed execution measurements. Automatic retries use the same durable task with a higher fence and a distinct attempt. A replacement worker can reclaim an expired lease; an old attempt cannot publish after that fence changes. The runner renews its lease while a handler runs. A process crash before usage is persisted can lose its final measurements; this API does not claim provider billing reconciliation.

`pause(run)` prevents new claims and lets already leased work finish. `resume(run)` restores claims or completes the run if all active work finished while paused. Terminal runs reject pause/resume. Runtime calls use the `execute` grant; snapshots use `view`. The constructor requires a host policy with the correct workspace and project. Registry documents never supply that policy.

Only batch execution is implemented. Incremental, streaming, windowed, scheduled, event, and replay modes fail explicitly. Packet memory and CPU measurements describe cooperative host handlers, not an OS sandbox. CPU is measured at the process level; concurrent work can make the measurement conservative. The platform host must launch any privileged adapter or inference worker through its established isolation boundary.

The existing MLX API is `pool(model).infer(request)`, where `model` is `Model` from `pipeline/mlx.ts` and `request` is `Request` from `pipeline/run.ts`. The resident pool requires the existing descriptor launcher and its `PIPELINE_WORKER_IN`, `PIPELINE_WORKER_OUT`, `PIPELINE_WORKER_ERR`, and `PIPELINE_WORKER_PID` descriptors (with indexed variants for multiple workers), together with the existing network-denial check. This runner does not fabricate inference, start an unrestricted Python worker, or infer a local deployment from a JSON model resource. A trusted host adapter must bridge a validated model/deployment pin to that already provisioned resident pool.
