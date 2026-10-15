# GitHub collector

Run from the standalone pipeline project, with Node 24 and an authenticated GitHub CLI. Nothing is pushed to GitHub. Credentials are obtained from `gh auth token --user`; they are never written to the export or printed. The collector validates `/user` before downloading.

Create a private configuration outside the corpus:

```json
{"org":"SonarMD","account":"avespoli-sonarmd","root":"/absolute/path/outside/corpus/github-snapshot"}
```

```sh
node pipeline/github.ts /path/to/config.json
```

The same command resumes pending work. SIGTERM/SIGINT pauses after the current durable operation. Only one collector may use an export root. After a hard crash, confirm the old process is dead before removing `.collector-lock/` under that root. New snapshots need a new root: a completed export is deliberately not refreshed in place. Keep sufficient disk capacity; Git, SQLite, and JSONL each hold data. Low-space guards stop collection rather than delete anything.

## Stored locally

- Every repository visible to the selected account in the organization, including archived repositories.
- A bulk Git fetch of all server-advertised refs, including available branch, tag, and PR refs. `fsck --full --strict` and object-ID verification are required. No checkout, hooks, or project scripts execute.
- All downloaded Git objects (commits, trees, tags, historical file blobs) as complete base64 contents in each repository's `git.sqlite` and `objects.jsonl`, with repository, object ID, type, total size and ordered part number. Large objects use 1 MiB parts. Small lossless UTF-8 objects also have `text`. Reassemble ordered parts and decode base64 for exact bytes; raw trees retain their original Git representation. Ref mappings are in SQLite metadata and `refs.jsonl`.
- Repository metadata, all-state PRs/issues, issue comments/events, review comments, commit comments, reviews, releases, milestones, labels, branches and tags. Full API response pages are stored in `state/intake.sqlite` and `staging/*.jsonl`; no content pointers substitute for those responses. API job expansion and receipts commit together. Publication recovers after a crash.

`progress.json` contains counts and running/paused/blocked/complete status. `diagnostic.json` records a blocked operation. SQLite `jobs` retains pending work. Failed requests do not become successful receipts. Completed Git receipts reference separately stored actual Git contents, not a substitute for storing them.

## Request economy and limits

Git objects use bulk protocol fetches, not one API request per commit/file. REST lists use 100 records per page, repository-wide comments endpoints and one serial request stream. Reviews require per-PR pagination. GitHub cannot export arbitrary organization history in a handful of requests. Retry-After, rate-reset, secondary throttling, server errors and transport interruptions are handled with waits and durable pending jobs. Permission failures stop visibly. Git fetch retries are bounded. See [GitHub's rate-limit documentation](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

## Coverage limits

This preserves what GitHub exposes to this account during collection, not an atomic historical snapshot. Deleted repositories, unreachable/deleted Git objects, inaccessible records, Git LFS payloads, submodule repositories outside the selected organization, wikis, Discussions, Actions artifacts/logs, packages and release-asset binary downloads are **not included**. Release metadata includes asset descriptions, not their binary bodies. A repository becoming unavailable stops the collector; do not equate pending work with preserved data. Git data is captured independently of semantic enrichment; collection does not start classification or claim downstream classification readiness.

Export roots, configuration and logs belong under ignored local `state/`, never in Git. No production files are removed or modified.
