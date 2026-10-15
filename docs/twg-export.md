# Background Atlassian collection with TWG

`pipeline/twg.ts` is a standalone TypeScript worker. It spawns the explicitly configured TWG executable with read-only command arguments and redirects CLI output to private attempt files. Provider data never reaches the worker's stdout. Complete response envelopes and their embedded body artifacts are stored in the existing Intake SQLite database and JSONL mirrors. The worker does not launch enrichment or modify source data.

Configuration is private operator JSON: `root`, `executable`, `site`, `cloudId`, `projects`, and optional `pauseMs`. The current operator configuration is under the collection root as `twg-config.json`; the executable and engine are frozen in `twg-engine-1`. The private pointer `state/imports/atlassian-background-current.json` records its PID, configuration, profile and entrypoint. CLI authentication is supplied by TWG's existing local setup; credentials are neither extracted nor passed through chat.

Start or resume the **same** frozen instance:

```sh
/usr/bin/sandbox-exec -f "$PROFILE" node "$ENTRY" "$CONFIG"
```

Use the paths in the private pointer. The launched instance is already detached. Stop its recorded PID with SIGTERM; let it exit and release `.twg-lock` before restarting. Pending work remains durable; committed receipts are reused. Do not start concurrent copies. After a hard crash, verify that the old process and children are dead before removing its stale lock. A graceful stop terminates the current CLI request and leaves that job pending.

Read `twg-progress.json` for metadata only. `twg-transfer/` contains complete raw attempts and CLI diagnostics; `state/intake.sqlite` and `staging/*.jsonl` are durable accepted/failed receipts. `twg-blocked.json` records connector tasks that cannot be expressed faithfully by this CLI. Requests have a three-minute subprocess deadline, bounded scheduling, a minimum pacing interval, rate-limit backoff, and a 3 GiB free-space reserve. The actual macOS profile denies inbound networking and restricts file writes to this collection root and `/dev/null`. Outside-write denial was tested. Outbound access is required for authorized provider reads; this is not the network-denied model-inference sandbox or a VM.

Confluence content, historical versions, comments including replies, and attachment metadata reuse existing supported tasks. Native Jira streams enumerate SONMD and SPR with no date cutoff, hydrate full issue/comment/remote-link records in batches of twenty, and traverse changelog/worklog pagination. Every scheduled page has a deterministic task ID. Unknown or repeated pagination cursors and partial batches fail coverage validation and retain the response; they cannot be certified complete.

TWG's Jira cursor contract differs from the old connector's REST offsets/tokens. Those older pending jobs remain visible rather than being incorrectly replayed or marked complete. Native Jira streams provide the replacement coverage; their completion still requires reconciliation against legacy scopes. TWG's content-list command lacks an archived/draft status filter, so those connector tasks remain explicitly blocked. Attachment metadata is not proof that binary originals were downloaded. The worker must report `finished-with-gaps` whenever pending/failed jobs remain; draining supported requests is not a claim of complete historical coverage.

Synthetic integration exercises the actual subprocess, full response persistence, SQLite/JSONL verification and no-call checkpoint reuse. Production startup verification checks PID ownership/liveness and new durable receipts without reading response bodies into chat. Tests do not establish that all provider history is accessible or collected.
