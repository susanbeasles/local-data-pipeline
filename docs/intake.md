# Local source intake

`pipeline/intake.ts` persists actual complete connector responses in SQLite and private JSONL files. It does not send records to a model or GitHub. The deterministic Atlassian planner schedules issue lists, comments, changelogs, worklogs, remote links, Confluence content by type/status, current bodies, historical bodies, comments/replies and attachment metadata. Metadata containing a download link is not a downloaded attachment. Binary downloading, macro expansion and hosted retention/permission coverage must be reconciled separately before claiming a complete source export.

```sh
node pipeline/receive.ts init /absolute/intake-config.json
node pipeline/receive.ts next /absolute/intake-instance 4
node pipeline/receive.ts accept /absolute/intake-instance /absolute/response-envelope.json
node pipeline/receive.ts status /absolute/intake-instance
```

The transport supplies an envelope `{ "id": "request-sha256", "response": <full connector result> }`. Route provider results directly into local envelopes programmatically; never print document/message bodies into a conversational agent. `next` returns request metadata only. Authentication and API retrieval belong to the configured connector or local CLI transport; this local receiver does not invent credentials or perform authenticated API calls itself.

SQLite resides at `state/intake.sqlite`. `jobs.task` retains the original request and scope. `receipts.response` contains the full returned JSON; `receipts.receipt` adds attribution and queued children with a checked digest. `staging/<request-id>.jsonl` contains the matching full returned JSON. A response and its child requests commit atomically; failed JSONL publication recovers from SQLite without refetching. `Intake.verify()` streams checks across all receipt digests and actual mirrors. This verifies captured records, not that a remote service exposed every historical record.

API errors, malformed pages and truncation indicators remain full local receipts and become failed tasks. They are not counted as successful coverage. The current planner rejects repeated immediate cursors; a longer cursor cycle and upstream omissions still need collection-level reconciliation. `accepted` means the individual response was stored and expanded, not that an entire project/space is complete. Failed tasks are terminal within this initial intake implementation; retry/repair requires an explicit subsequent collection attempt while retaining the earlier receipts.

The macOS receiver enforces OS network denial and writes only below the designated work directory. Source retrieval uses the separately authorized connector/CLI; model workers remain network denied. Root/state/staging/database alias checks run before permission changes. Create a fresh dedicated work directory, outside the source corpus and ignored by Git. Pin code/config for each collection instance; upgrading application code must not implicitly replace a running instance's implementation.

The planner is tested with synthetic cursor pages, offsets, malformed results and rich nested Unicode data. Runtime provider schemas can still differ from fixture schemas and must fail visibly. Confluence current/archived listings are supported by the tested connector; draft/trashed attempts return explicit unsupported-status errors and block claims of full retention coverage. The connector's HTML rendering is retained as returned; this is not a claim that it exports original native storage/ADF bytes or every provider extension.

Slack/Miro retrieval requires a confirmed authorized connector or CLI. No app is installed, permissions broadened, browser session extracted, token printed, or security policy bypassed by this receiver. For Slack the intended scope is the user's accessible public/private channels, DMs and group DMs, with explicit thread pagination. The current intake implementation does not yet provide a Slack or Miro collector.
