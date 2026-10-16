# Storage and installation boundaries

Storage has separate decisions: security mode, location, record format, and redundant backup destinations. A cloud provider is not a database format. A registered capability descriptor is not an implemented adapter.

## Security modes

Standard uses the current account's `~/Library/Application Support/LocalDataPipeline`, `~/Library/Caches/LocalDataPipeline` and `~/Library/Logs/LocalDataPipeline`. Hardened targets the corresponding `/Library` paths owned by a dedicated `_pipeline` account. The storage provisioning API requires administrator execution for Hardened. It does not create system accounts, install a privileged helper, or claim the existing UI is service-account ready.

`Storage.create` creates only new roots with mode 0700, removes inherited macOS ACLs, creates a private installation record, and verifies ownership and permissions. Existing paths are not silently adopted, chmodded or overwritten. Aliases, checkout overlap and extra ACL grants are rejected. The persisted mode is an installation identity, not a per-request toggle. Do not set Hardened as installed before the account, authenticated control bridge, terminal/artifact access and model runtime are tested end to end.

The intended installer offers **Standard — private data owned by your account** and **Hardened — dedicated service account; administrator approval required**. The installer must explain the tradeoff without disparaging either choice. Standard requires no sudo. Hardened must fail visibly on cancelled authorization or failed verification; it must never fall back to Standard. The interactive installer and privileged bridge are not yet implemented.

## Location

`destination.ts` validates the independent primary destination and optional redundant destinations. Local/internal disks, external SSDs and removable volumes use a volume path. iCloud, Google Drive, Dropbox, OneDrive, Cloudflare object storage, S3, Azure Blob and Google Cloud Storage are represented by connection identifiers and object prefixes. Credentials are secret-store references, never embedded tokens or signed URLs. The configuration does not connect, upload or authorize provider access. These provider descriptors are not functional transport adapters yet.

A private local working directory is mandatory for active SQLite and local inference, even with remote archive storage. Active database files must not be placed directly in file-sync folders or object stores. Cloud and sync destinations receive coherent versioned snapshots through adapters. Each backup needs verification, visible failure status, restore testing, explicit retention and consent to transmit data. No provider selection alone authorizes upload. A disconnected primary or failed backup must never silently fall back to writing into the source checkout or discard pending work.

## Format

`Formats` records and validates adapter identity/version, database/file/object family, supported operations, compatible locations and verification status. Required operations include reading, writing, append, querying, transactions, snapshots and restore. Unknown, unverified or incompatible adapters fail explicitly. Descriptors cannot execute arbitrary code or pretend unsupported operations exist.

The target adapter inventory includes relational databases (SQLite, PostgreSQL, MySQL/MariaDB, SQL Server), document databases where needed, and common interchange/storage files (JSON/JSONL, CSV/TSV, Parquet/Arrow, Avro, ORC, XML, YAML, text and archives). Object stores are location adapters, with a separate encoding for their contents. This list is a requested support target, not an implementation claim. Each adapter needs actual lossless round trips, concurrency, recovery, type fidelity, snapshot/restore and compatibility tests before the UI can offer it as supported. Existing SQLite/JSONL behavior and some PostgreSQL platform functionality do not establish support for this whole inventory.

## Current enforcement and migration

New pipeline run configurations, intake archives, Studio state, handoff/book preparation and role-package creation reject runtime output in the implementation checkout. Default runtime/model lookup now uses external Application Support storage. Explicit read-only source model paths remain supported for the existing installation. Frozen running engines are unchanged.

**Existing ignored data under the old checkout has not yet been migrated.** It is still referenced by active engines and the installed panel. Moving it or changing ownership without coordinated checkpointing, path reconciliation and restart verification would break access. Permission policy helpers are not evidence that migration is complete. No data was uploaded or moved by adding these policy modules.
