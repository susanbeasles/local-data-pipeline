# Complete local preservation

Preservation is separate from model analysis. It includes hidden files, unsupported/binary files and all bytes inside local `.git` stores. No extractor, model, Git hook, fetch, checkout, garbage collection or source write runs. SQLite stores actual byte blocks; JSONL stores matching base64 blocks. Source-relative paths, modes, directories and symlink targets appear in both the database inventory and `inventory.jsonl`. Live Unix sockets have metadata-only dispositions: kernel IPC endpoints have no persistent file contents and are not recreated during restore. This is file-content preservation, not an APFS volume image or an ACL/extended-attribute backup.

```sh
node pipeline/preserve.ts estimate /absolute/input
node pipeline/preserve.ts capture /absolute/input /absolute/separate/archive
node pipeline/preserve.ts verify /absolute/input /absolute/separate/archive
node pipeline/preserve.ts restore /absolute/separate/archive /absolute/new-directory
```

Capture and verification use the macOS OS sandbox: network denied, persistent writes allowed only under the archive, source paths read-only. Git's startup also needs read/write access to the `/dev/null` sink; a regression test verifies that this permits neither input nor unrelated filesystem writes nor networking. Restore uses network denial and allows writes only under a new destination. No existing destination is overwritten. Capture is restartable with the same input/archive binding. A changed/deleted source, unreadable file, unsupported special file, incomplete mirror or digest mismatch fails certification. A failed attempt retains copied bytes and leaves `report.json` incomplete. Rerun capture to resume. Do not delete originals based on a partial archive.

`report.json` becomes complete only after an independent second source walk, complete SQLite block and JSONL verification, inventory reconciliation and local Git integrity checks. The report identifies the exact root and inventory hash. Git audit uses `fsck --full --strict` without fetching, sanitizes inherited Git environment overrides, and rejects shallow history, promisor packs, alternates, storage symlinks, external Git/common storage and absolute worktree/common-directory markers requiring relocation. Preserve external Git stores explicitly; do not assume a linked worktree contains its history. An actual synthetic repository is restored and its earlier commit/tag contents are checked with the original repository unavailable. Another test relocates the complete archive before restoration; JSONL mirror references are archive-relative.

Preserving a `.git` directory directly preserves its available local objects, refs, reflogs, index, configuration and worktree metadata; it does not include working files outside that directory. Preserve the working tree separately if needed. Captures of actively changing repositories fail reconciliation; retry once their contents are stable.

The report explicitly sets `hostedHistory: false`. Local Git bytes cannot prove that every historical remote commit was fetched or retain GitHub-only issues, PR discussion, releases, Actions artifacts, LFS server objects or deleted remote history. Those require separately scoped exports and coverage reconciliation. Archive files are retained intact; enclosed repository history is not certified until unpacked into an independent work area and checked. No report claims it can recover data deleted before capture.

The model-processing checkpoint remains distinct from this preservation archive. Preservation completion does not imply six-stage enrichment completion or that a historical production checkpoint has already been imported.
