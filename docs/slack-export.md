# Local Slack export

The message collector preserves accessible public/private channel histories, direct messages, group messages, and thread replies. The supplementary collector preserves the accessible file inventory, original downloadable file bytes, file metadata/comments, and user directory.

Use a user OAuth token with `channels:read`, `channels:history`, `groups:read`, `groups:history`, `im:read`, `im:history`, `mpim:read`, `mpim:history`, `users:read`, and `files:read`. Keep it in a mode-0600 file outside the repository's tracked files. Never pass the token itself as a command-line argument.

```sh
node pipeline/slack.ts "$WORK/messages" "$TOKEN_FILE"
node pipeline/slack-files.ts "$WORK/files" "$TOKEN_FILE"
```

Both work roots must be dedicated private output directories outside the input corpus. Freeze the executable code and dependencies for a running instance. Do not alter an instance's frozen engine while it runs.

Each collector stores complete API response JSON in `state/intake.sqlite` and response JSONL in `staging/`. The file collector additionally stores original bytes in `files.sqlite` BLOB blocks, with lossless base64 JSONL mirrors in `staging/F*.jsonl`. Filenames from the source are metadata, never local output paths. Download spool files are removed only after both persistent representations pass hash verification.

Stop gracefully with SIGTERM. Resume using the same frozen entrypoint, work directory, and token file. Pending jobs survive restart; the SQLite receipt and child-task insertion is atomic. Completed file downloads are checked and reused after restart. HTTP rate limits honor Retry-After. A file/network/disk/integrity failure leaves the current download pending and stops the supplementary collector with a blocked progress record. Inspect the local checkpoint before retrying. Only one process may execute a given work queue; do not start concurrent copies against it.

Read `progress.json` for counters without exposing messages. Message counters count API responses, not conversations, files, or model-enriched records. `pending=0` alone does not prove complete access: failed jobs and unavailable files must also be reconciled. Original failed receipts remain auditable even after separate repair attempts.

The exporter cannot recover deleted messages, retention-expired history, conversations inaccessible to the authenticated account, or externally hosted document contents for which Slack has only a link. Such gaps must remain visible. File downloads accept only HTTPS Slack hosts, never forward the token to external hosts, and refuse redirects. External files and unavailable originals require explicit unresolved dispositions; metadata is not a substitute for file bytes.

Source ingestion is separate from model inference. Exporting does not launch enrichment, send data to hosted models, or add data to Git. Raw byte JSONL is a lossless archival representation; model-ready normalization and chunking are separate pipeline stages.
