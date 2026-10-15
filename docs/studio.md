# Native data workspace

The menu-bar application is a local TypeScript control plane with a native SwiftUI interface. It observes collectors separately from the pinned processing instance. Opening it does not start enrichment or copy source records.

## Setup

Install the exact Node dependencies with `npm ci`. Python environments continue to use `uv` only. Build on Apple Silicon macOS 14+ with Node 24.19 and Apple's command-line developer tools. No Docker or hosted telemetry is required.

Copy `config/studio.example.json` to an ignored operator configuration such as `state/native/studio.json`. Paths resolve relative to that file. Register each source with an ID, name, read-only root, database, and optional collector pointer/progress/ownership manifest. Use explicit absolute executable paths for installed `codex` or `claude` providers; an empty providers list supports data review without an agent. Never put credentials in these configurations.

```sh
node native/build.ts /absolute/operator/panel.json /absolute/operator/studio.json
open dist/Pipeline.app
```

The first argument is the existing prepared processing-instance registry. The second configures the separate live workspace. Building freezes code and installed production dependencies into a new control release; editing the repository cannot modify that release. It does not prepare, restart or change the processing instance. Operator configuration deliberately remains editable for source registrations; active imports freeze resolved source bindings, including the actual database, and ETL runs freeze their parent revision and rules.

## Use

- **Data sources:** committed SQLite counts, process evidence, checkpoint timestamps/age and stale indicators. Response, object-part and file counts retain their actual units. Unknown liveness is not running. Refresh reads fresh evidence; a checkpoint labeled running does not prove its worker is alive.
- **Data explorer:** choose a source/table, search and page actual SQLite rows, inspect a row beside its actual JSONL mirror. Match/mismatch/missing/unavailable/limited are distinct. Tree views are bounded; a preview is never a complete preservation audit. Capture selected records or explicitly import a complete table into a new operator dataset.
- **Datasets & links:** immutable SQLite+JSONL revisions, background import counters and recovery, annotations, source/tag/keyword/category/rating filters, explicit object relationships and edited child revisions. Sources and historical revisions are preserved. Importing duplicates full content and needs additional disk space.
- **Flows & validation:** author an ordered JSON rule list or use the stage builder. Save a content-addressed version; run against a selected immutable revision. Filter, edit, dedupe, validate and quarantine outcomes remain attributable. Pause, inspect failures, save corrections and resume. Review outcomes separately from accepted output. No arbitrary JavaScript or shell expressions execute from rule JSON.
- **Agent sessions:** installed CLI subprocesses with visible streamed events, per-task native context, free-form follow-up, stop, reset, branch, rewind and compact. Missing provider capabilities fail with a diagnostic. Collection can read only explicitly approved `readRoots`; the agent writes its private workspace. Registration of a source does not grant an agent read access. Credentials/config/rules are private snapshots; global context history is excluded.
- **Stages, tokens and logs:** the existing pinned processing instance. Collection changes do not change these historical counters. A per-stage sample is an explicit local read, not automatic model enrichment.

Every structured field and operational metric offers scoped help. Preview the small prompt, optionally include a selected record field, then explicitly ask an available agent or copy the prompt. Each initial question has a fresh session and exactly three suggested follow-ups. Codex/Claude CLI may contact its configured provider: this action is distinct from entirely local MLX processing. No prompt is sent merely by opening help, and no engineering verification invokes a real provider.

## Integrity and recovery

Imports stream full SQLite records into a separately stored revision. A retry with the same import ID verifies every saved prefix record and reuses the durable suffix position. Changed/truncated source replay fails instead of silently mixing snapshots. Publication verifies the complete JSONL and SQLite revision; a successful import alone does not certify the original collection's completeness. Stable record IDs derive from source/table/key identity, not a mutable display label.

Local worker launches use atomic leases, kernel process-birth identity and a startup handshake. ETL/import workers run inside the macOS network-denied sandbox and can write only operator state. The small compiled `process.c` helper uses nonprivileged libproc because macOS refuses setuid `/bin/ps` inside a sandbox; its bytes are pinned and verified. No security guard is disabled. This process boundary is not the dedicated VM previously requested and does not protect against the host administrator.

The TypeScript bridge also works from a terminal:

```sh
printf '%s' '{}' | node pipeline/studio.ts sources /absolute/operator/studio.json
printf '%s' '{"id":"IMPORT_UUID"}' | node pipeline/studio.ts import-resume /absolute/operator/studio.json
printf '%s' '{"id":"RUN_UUID"}' | node pipeline/studio.ts flow-pause /absolute/operator/studio.json
printf '%s' '{"id":"RUN_UUID"}' | node pipeline/studio.ts flow-resume /absolute/operator/studio.json
```

Do not commit `state/`, local configurations, databases, JSONL, credentials, logs, generated apps or model artifacts. All generated files stay outside registered inputs.
