# Dataset workspace

`pipeline/dataset.ts` provides a deterministic local editing and ETL service. It
opens only the supplied operator root; it never opens a source database, calls a
provider, or starts a collector. Callers must keep this root outside source roots.

Before creating directories, opening SQLite or changing permissions, the service
canonicalizes the root and rejects custom symlinks in its ancestors, its SQLite
file and sidecars, and the revisions directory. Aliased regular files are also
rejected. macOS `/var` and `/tmp` aliases are canonicalized.

A record has a stable `id`, a source identifier, a literal human `key`, and a JSON
`body`. IDs can include source and table scope. Equal human keys in separate
tables remain separate records. Reusing an ID with a different source or human
key is rejected. The first captured body remains the record's immutable original.
Tags, keywords, summary, category and rating are operator annotations keyed by ID;
they apply across revisions. Typed links require both referenced records to exist.

`capture(name, records)` accepts an array, iterable, or async iterable of
`RecordInput`. Each complete record is staged durably in SQLite. JSONL publication
streams from those rows, and the revision becomes visible in one final database
transaction. An interrupted or invalid import exposes no partial revision.
Failed staging rows remain in `drafts`/`draft_items` for local diagnosis. Pass `capture(name, records, {id: jobUuid})` for resumable imports. This uses the
stable revision ID `rev-<jobUuid>`. Replay the source iterator from its beginning;
the service verifies saved record IDs, sources, human keys and content hashes,
keeps the durable prefix, and inserts only the suffix. Changed or truncated
prefix input is rejected. An already published retry verifies the same input
and mirror, then returns the original revision without duplicating it. A crash
after mirror publication but before revision commit can be retried the same way.

Revisions contain immutable record bodies in original order, a SHA-256 hash,
complete byte and record counts, and a JSONL path. `edit(parent,id,body)` and
`run(parent,steps)` create children and preserve the parent. `verify(revision)`
independently streams the SQLite records and JSONL mirror and checks both against
the revision hash and byte count. Page reads check record and original digests.
They return full selected records with bounded pagination (1–100 records).

## JSON stages

A recipe is a JSON array of `Step`. `validateSteps(unknown)` checks its shape and
returns a detached copy without side effects. A run persists and hashes this
plan before executing. Supported operations are:

- `set`: replace the root or a value at `path`; create missing object containers
  and append array values without holes.
- `remove`: remove a field or array element at `path`. Removing an array element
  shifts later indices. Removing the root is rejected.
- `include` / `exclude`: compare `equals`, string `contains`, or field `exists`.
  Multiple supplied comparisons must all match.
- `dedupe`: compare selected `paths`, or the entire current body. The first
  accepted record wins, in parent revision order. Missing and null are distinct.
- `check`: validate one field with `required`, `type`, and/or `minLength` while
  allowing unrelated fields. Missing values pass unless `required:true`.
  `minLength` counts Unicode code points for strings or elements for arrays.
  Supported types are string, number, boolean, object and array; null is not an
  object. Arbitrary regular expressions are not supported.
- `validate`: use the existing restricted JSON schema validator for the whole
  current body. Object schemas require explicit properties and
  `additionalProperties:false`. Diagnostics identify the failing field and rule.

Paths support simple JSON paths (`$.items[0].name`) or JSON Pointers
(`/items/0/name`, with `~0` and `~1` escaping). Prototype keys are rejected.
Records must be complete JSON: cycles, undefined, sparse arrays, non-finite
numbers and non-JSON object types are rejected rather than silently changed.

```json
[
  { "op": "check", "path": "$.id", "required": true, "type": "string", "minLength": 1 },
  { "op": "include", "path": "$.active", "equals": true },
  { "op": "dedupe", "paths": ["$.id"] },
  { "op": "remove", "path": "$.temporary" },
  { "op": "set", "path": "$.reviewed", "value": true }
]
```

## Worker lifecycle and correction

`start(parent,steps,options)` synchronously creates a durable run and returns its
ID. A detached worker calls `execute(id)`. `run(...)` wraps those calls for inline
execution. `pause(id)` requests a pause between records; `resume(id)` reclaims a
dead worker or continues a paused run. Worker ownership records the PID, birth time and command proof. A live matching
worker prevents overlapping execution; an unrelated reused PID can be reclaimed
without signalling it. An unclaimed worker respects a pause that arrived before it started.

Every record's output, disposition, dedupe keys and cursor transition share one
SQLite transaction. The worker yields between records. If a process dies, resume
continues after the last committed accepted record without rewriting that prefix.
Completed output is published as an immutable child revision. A failed final
publication can be retried from durable run outcomes.

Validation failures pause by default. Both `check` and `validate` accept
`onFailure:"reject"` or `"quarantine"`. With `pauseOnFailure:false`, they retain
the failed record and continue, excluding it from accepted output. Rejected,
quarantined, excluded and duplicate bodies are retained in `outcomes(id)`;
`failures(id)` retains diagnostics and failed bodies. Reports count current
record dispositions plus distinct corrected records. `cursor` is the next input
position; a paused failure remains at that position.

For a paused failure, call `correct(runId,recordId,body)` with a full replacement
for that record's **input to the run**, then `resume(runId)`. Correction history is
append-only, and stages run again only for that record and remaining inputs.
Failure bodies show the value at the failing stage; read the parent revision for
the input value. A completed run stays immutable: edit its parent into a new
revision and start a new run to change previously quarantined records.
