# Personal AI / agent archive

`node pipeline/agents.ts CONFIG.json` enumerates home-directory metadata and captures complete bytes for AI/agent, skills, plugins and configuration paths. Hidden paths are included. No file contents are printed, uploaded or passed to inference. Originals are never modified or deleted.

```json
{"home":"/absolute/home","work":"/absolute/home/personal/AI-agent-stuff","exclude":["/absolute/home/large-production-corpus"],"include":[]}
```

Use absolute canonical paths. `include` adds home-relative directory prefixes; built-in selection covers Codex, Claude, Cursor, VS Code, Windsurf, Cline, Roo, Copilot, Gemini, OpenCode, agent directories, instruction files and common macOS application-support/log locations. Generic `plugins`, `skills`, and `.config` directories alone do not identify AI data; plugins and skills within recognized agent directories remain included. Selection is explicit name-based discovery, not a guarantee of detecting arbitrarily named AI files. Review `inventory.sqlite` / `inventory.jsonl` for unselected paths and exclusions; extend `include` in a **new** archive configuration when needed.

Actual bytes are deduplicated by SHA-256 in `content.sqlite` and complete `content/<hash>.jsonl` mirrors, using lossless Brotli/base64 blocks. Inventory records retain each original path, mode, size, modification time, kind, hash and disposition. Symlink target strings are captured; links are never followed. SQLite + JSONL blocks reconstruct full content without the original paths. This is raw preservation; model normalization/classification is separate.

Dependency environments, Git object directories, macOS Library caches/metadata, Trash, configured exclusions and the archive itself are pruned explicitly. Excluded roots are recorded, not recursively inventoried. Special filesystem endpoints have metadata dispositions, not fictitious file contents. Permission errors and files changing during capture are failed visibly. Live database files are raw byte copies, **not** transaction-consistent backups of an application's database/WAL set. ACLs and extended attributes are not included.

`progress.json` has counts and captured logical bytes. SIGTERM/SIGINT checkpoints. Repeat the same command to resume; add `--retry` to retry failed entries. Captured history is immutable per snapshot: resume does not discover new files under already enumerated directories. Start a new archive root for a fresh home snapshot. After a hard crash, confirm the process is dead before removing `.crawl-lock/`. Low disk reserve stops pending work; it never frees space by deleting originals.

The launched collector is a frozen code copy with network denied and filesystem writes restricted to its archive by macOS sandbox-exec. This is a process sandbox, not a dedicated VM. The archive may contain credentials, private conversations and sensitive context: it is owner-only local data and must stay outside GitHub.

Selection revision 2 rechecks pending files before opening them. Previously captured bytes remain preserved even when their paths matched the older broader rule. Newly unselected queued files receive an explicit reason in inventory. Existing exclusions and captured history are not erased. The pending queue has a state index; SQLite temporary sorting uses memory to stay within the sandbox's write boundary. `complete` remains false when any failures remain, even after the pending queue drains.
