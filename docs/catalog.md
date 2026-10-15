# Read-only source catalog

`pipeline/catalog.ts` provides source observations and database exploration. Register `Source` objects with an ID, display name, kind and root directory. An explicit `database` can be absolute within the root or relative to it. A generic `sqlite` registration browses new database tables without a new adapter. Catalog operations never initialize a source or repair a mirror. Operator state must remain disjoint from source roots, including resolved pointer targets and directory aliases.

```typescript
const catalog = new Catalog(sources, operatorState);
await catalog.sources();
await catalog.tables(sourceId);
const page = await catalog.page(sourceId, table, { offset: 0, limit: 50, query: "literal text" });
const record = await catalog.record(sourceId, table, page.rows[0].key);
for await (const record of catalog.records(sourceId, table)) {
  // Explicit full-record dataset capture; not a mirror-integrity certification.
}
```

Each call rereads its pointer and opens a new read-only SQLite connection. Record display and mirror comparison share one SQLite read transaction. A concurrent database commit or file replacement makes mirror status `limited`, with an explicit snapshot diagnostic. A pointer supports `root` or `work`, optional database/progress/process-file paths, and process identity fields. A controller's `production.json` can select its active `configs` entry using `progress.pile`, then obtain `work` from that configuration. A separate `processFile` supports job ownership metadata. A present PID requires matching birth and command, or a matching registered `entry` argument, to establish liveness. A PID alone leaves liveness unknown; an absent PID is dead. Entry-only identity does not establish process birth, which the metric definition states.

`SourceStatus` keeps process liveness, the stored phase and checkpoint age independent. Checkpoint timestamp fields are `updatedAt`, `updated`, `at` and `observedAt`; an absent timestamp uses the metadata file's modification time with an explicit diagnostic. Missing evidence remains visible. A checkpoint older than five minutes is stale by default. Counts are newly queried SQLite row counts. Intake response counts represent connector responses, which can be pages, details or errors; they are not file or entity totals. Numeric and boolean checkpoint fields, including nested fields up to three components, receive their own qualified metrics and provenance. Metadata observation is bounded to 64 KiB and 128 checkpoint metrics.

Pages use quoted schema identifiers and prepared values. Search is a literal substring, including percent signs and underscores. Limits are 1–100 rows, offsets are 0–1,000,000, and search strings are at most 4,096 characters. Keys encode source/database/table identity and primary-key values; rowid handles ordinary tables without a primary key and disambiguates nullable SQLite primary keys. Keep the returned token intact. A token from a different database root is rejected. Keys are bounded to 64 KiB; a table that hides every rowid alias and has no primary key cannot be addressed. External rewrites or replacement of a source can invalidate its record keys.

The default preview budget is 16 KiB of SQLite field payload per row, divided across columns. Truncated previews are explicit. `records()` deliberately streams full rows beyond these preview and page limits, holding one SQLite row at a time and closing the reader when iteration ends or is cancelled. BLOBs become `{encoding: "base64", bytes, base64}`; integers outside JavaScript's exact range become decimal strings. No model, network, write or mirror-reconstruction action occurs.

Mirror adapters read actual files. Intake `receipts` compare `staging/<id>.jsonl` with stored response bytes and validate receipt digest/task/response identity. Git `objects` compare the selected record in `objects.jsonl`; inventory `entries` compare its selected record in `inventory.jsonl`. `content_sources` compares its referenced artifact's hash, JSONL framing and header identity to the stored metadata. Content block coverage is not audited by this preview. Unsupported table schemas report `unavailable`; SQLite rows are never serialized into a supposed mirror. Missing files/records, invalid JSON, mismatched bytes, escaping paths, changing files and scan bounds remain explicit statuses.

The default mirror observation is bounded to 2 MiB and 4,096 lines. Selected Git/inventory records may match inside that window without auditing the rest of the artifact. Content-artifact hash checks require a complete bounded read. `CatalogOptions` can set `staleSeconds`, `previewBytes`, `mirrorBytes` and `mirrorLines` within enforced upper limits. Preview hashes describe the normalized SQLite record or its preview as identified by `digest.scope`; `digest.jsonl` hashes the actual selected JSONL line bytes, or the complete content artifact. `digest.expected` and `digest.valid`, when present, describe the adapter's recorded integrity reference. SQLite-record hashes and JSONL hashes have different scopes and need not equal each other.

Synthetic validation: `node --test pipeline/tests/catalog.test.ts`. Tests cover committed WAL freshness, live pointers, process identity, literal search and pagination, key isolation, full-record capture, corrupt/missing/escaping mirrors, framing, byte bounds, dynamic metrics and state boundaries.
