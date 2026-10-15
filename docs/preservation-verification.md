# Preservation verification — 2026-10-14

Implementation: `pipeline/preserve.ts` and `pipeline/content.ts`. All 115 automated tests passed; TypeScript compilation passed. Eight focused preservation tests include complete file-byte retention, hidden/binary data, normal Git history/tag restoration with the original unavailable, relocated archive restore, changed sources, damaged bare repositories, external Git object symlinks, output boundary rejection, and OS input-write/network denial. The OS policy permits `/dev/null` as a nonpersistent sink required by Git startup; other writes remain constrained.

Actual preservation job: read `state/preservation/current.json` for its private job directory and supervisor PID. That directory contains `job.json`, frozen engine manifests, per-job logs and archives. The first launcher attempt exposed Git's null-device requirement; only that preservation process group was stopped. Captured data was retained and the corrected sealed engine resumed the same checkpoints. The earlier attempt and engine remain as audit evidence.

Designated scopes:

| Scope | Source | Initial measurement |
| --- | --- | --- |
| Corpus | Existing curated `input/` tree, preserving SonarMD/personal separation | 211,996 entries; 38,027,766,461 file bytes |
| Control history | Existing `control-plane-current/.git` | 51 entries; 251,536 file bytes |
| Pipeline history | Existing `local-data-pipeline/.git`, including linked-worktree metadata | 7,586 entries; 877,289,619 file bytes |

Each archive has its own actual-byte SQLite database, content JSONL mirrors, inventory and final report. A scope is certified only when its report says `complete: true`. The supervisor is complete only after all scopes pass. No source deletion, relocation, modification, archive extraction or model inference is performed.

The control-history archive passed actual source/database/JSONL reconciliation and Git fsck. It was additionally restored into an independent directory and that restored Git store passed `fsck --full --strict`; evidence is saved in `control-restore-verification.json` under the private job directory. Remaining scopes execute asynchronously: use their current reports rather than interpreting this document as a completion claim.

This attests available local file contents and Git storage for the named roots. Hosted GitHub-only records and history never fetched locally are not covered (`hostedHistory: false`). Enclosed repositories inside archives retain their exact archive bytes but are not individually fsck-certified. No claim is made about files deleted before this capture or roots outside these scopes. See `docs/preservation.md` for commands and exact format/restore boundaries.
