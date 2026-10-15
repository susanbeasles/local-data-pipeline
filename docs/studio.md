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

## Optional workflow platform

The native Flows workspace includes a Workflow JSON tab alongside ordered ETL stages. Add an explicit operator binding to the Studio configuration:

```json
"platform": { "config": "/absolute/operator/platform.json" }
```

Relative configuration paths resolve beside the Studio configuration. The operator platform configuration uses the existing `platform/1` format and an already provisioned local PostgreSQL database. Without this binding, workflow actions report that provisioning is required; ordered ETL remains available.

Use Check platform and Registry to inspect the binding, paste a `platform-definition/1` document into the editor, preview it, then publish an immutable version. Choose a published version to queue a run. Copy an existing run identifier to inspect status or pause/resume admission. A queued run requires a separately authorized supervised worker; the native bridge deliberately does not expose the `work` action. Opening the workspace and making these requests never applies migrations or starts inference.

The Studio bridge invokes only health, registry, flows, preview, publish, run, status, pause and resume. Each request opens and closes its local database binding; database grants and the configured host policy still authorize every operation. Published versions and run checkpoints live in PostgreSQL, while the JSON editor holds only an unsaved draft.

Validation: the PGlite platform fixture exercises the native dispatch boundary through preview, publication, run admission, pause, resume and status, including a forbidden worker request. Swift sources also pass compiler type checking. This does not replace installed-app or supervised Unix-socket worker acceptance.

## Persistent terminal dock

The bottom **Terminal** bar stays present while changing workspace pages. Expand it, select an available CLI, and press **Start Codex** or **Start Claude Code**. This is a real interactive PTY with terminal rendering, keyboard input, scrollback and resizing. Collapsing it keeps the process alive. **End session** stops only that CLI; closing the workspace window or quitting the app also ends it. Native CLI context commands operate normally within that session. Starting again creates a fresh private workspace; it does not automatically import prior terminal history.

Each terminal gets exactly one filesystem write boundary beneath the configured Studio state: `sessions/terminals/<id>/workspace/`. The dock's **Artifacts…** action opens this location. `notes/`, `requests/`, and `decisions/` contain templates for findings, change requests and ADRs. Proposals require human review and are never applied automatically. Private copied CLI authentication/configuration and conversation state live under `.cli/` inside the same write boundary; share only the review artifacts, not that hidden state. Global CLI configuration and rollout history are not modified or imported as conversation history.

The existing macOS filesystem sandbox and immutable guard configuration apply to the interactive process and its descendants. Corpus, application and processing output directories remain outside its write boundary. Only terminal devices and `/dev/null` have additional write access. CLI approvals stay enabled, configured MCP tools are disabled, and protected source reads stay restricted. This terminal is separate from local MLX enrichment; the chosen CLI may contact its configured model provider when used. No provider session is launched merely by opening the dashboard.

Build dependencies are pinned in `native/Package.swift` and `native/Package.resolved`. For a first build, resolve those dependencies with `swift package --package-path native --scratch-path dist/NativeBuild resolve`, then use the existing `native/build.ts` entrypoint. Builds disable automatic re-resolution. SwiftTerm supplies rendering; dashboard-owned PTY transport handles input, resizing, process groups, bounded input buffering, descriptor cleanup and termination. Provider transcript state remains under the artifact workspace; the app does not write an additional plaintext terminal recording.

Synthetic transport checks: `swift test --package-path native --scratch-path dist/NativeBuild --configuration release --disable-automatic-resolution --filter PTYTests`. They cover interactive ANSI I/O, repeated sessions, a resistant child, and an actual sandboxed single-folder write boundary. Node session tests additionally cover fresh scoped provider configuration, disabled MCP tools, and denied outside writes. They do not send provider prompts or certify an operator's login.
