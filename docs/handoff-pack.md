# Source documentation handoff pack

This command produces a portable local HTML guide from existing repository documentation and declared configuration. It does not wait for six-stage enrichment or invent a historical narrative. It preserves the full selected bytes in SQLite and JSONL and includes source hashes, working-copy revision metadata, declared commands/dependencies, starting links and local full-text search.

```sh
node pipeline/handoff.ts /absolute/handoff.json
node pipeline/handoff.ts --verify /absolute/output
```

Configure `title`, `sources` (unique repository names and paths), and a **new**, disjoint `output` directory. Relative paths resolve against the JSON file. `config/handoff.example.json` is a portable example. Run the same config with a new output path for a new snapshot; existing output is never overwritten.

By default, selection uses Git-tracked Markdown/MDX/reStructuredText, package manifests, Dockerfiles/compose, Makefiles and GitHub workflows. It captures working-copy contents, which may differ from HEAD; full change counts are not computed because Git status can execute configured content filters. Git metadata and package scripts are not proof of deployed behavior. Project scripts, hooks, filters and source instructions are never executed by this reader. Git read commands explicitly disable repository fsmonitor execution; no remote is contacted. General application source code, submodule contents and provider history are outside this pack's analysis scope.

`untracked: true` explicitly enables directory discovery for known archive or documentation roots. Use it only when that material's provenance is established. Dependency/build/cache directories are then excluded according to the recorded selection policy; symlinks are not followed. The default avoids sweeping unknown local notes into a company handoff. The operator must register only the intended organization's sources; the generic builder does not infer ownership from a name.

The CLI enforces OS network denial and source write denial. Only its new output and `/dev/null` are writable. Synthetic tests exercise the actual sandboxed command, config-relative paths, script nonexecution, exact SQLite/JSONL byte equality, tracked-only selection, corrupted stores/mirrors and generated search behavior.

`index.html` is self-contained, includes every selected document, and can be opened without a server. Its search runs locally, opens matching documents and sends no network requests. Raw HTML inside source documents is escaped; a CSP permits only the fixed search script by hash. The bundled JSONL, SQLite and integrity report remain independently retrievable.

A selected file over 8 MiB, aggregate selected bytes over 256 MiB, invalid UTF-8, a missing tracked file or a symlink receives an explicit unsupported disposition. These limits do not truncate data. Such a pack has `complete: false`; its saved records can still have verified integrity. Source changes, corrupt records or mirror mismatch prevent certification. Read `report.json`, `manifest.json` and `dispositions.jsonl` before calling a pack complete.

Generated packs contain source data. Keep them outside the input corpus and outside Git. The current local pack is located through ignored `state/handoffs/current.json`. That pack is a source-documentation deliverable, not completion of the historical enrichment pipeline.
