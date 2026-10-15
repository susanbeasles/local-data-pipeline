# Native macOS control panel

The SwiftUI menu-bar app uses a local TypeScript CLI bridge. It contains no WebView or hosted service. Closing the window or quitting the panel does not stop processing.

## Build and attach

Create an operator-owned JSON registry outside the input corpus:

```json
{
  "control": "/absolute/existing/production-control",
  "entry": "/absolute/existing/controller.ts",
  "project": "/absolute/pipeline/code"
}
```

Run `node pipeline/panel.ts prepare /absolute/panel.json`. This reads operational manifests, registers the existing dedicated controller process group, and freezes code plus every partition configuration in a new release. It does not pause, restart, or enrich the corpus. All controls subsequently use that pinned backend. Input and control/source directories must be disjoint.

Build with `node native/build.ts /absolute/panel.json`, then open `dist/Pipeline.app`. The app needs local Node 24 and macOS 14 or newer on Apple Silicon. Swift is required only to build; no additional dependencies are downloaded. Build output is ignored by Git. The resource bridge contains local paths, not credentials.

## Controls

- Pause stops the verified dedicated process group, preserving durable SQLite checkpoints. It does not use SIGSTOP. Unfinished extraction/inference can repeat; committed completed results remain resumable. All original sources may be rehashed on restart to detect modifications.
- Resume starts the pinned controller and frozen configurations. It continues the current partition, then remaining partitions. A completed run is not silently reprocessed.
- Restart means pause, verify the group is empty, then resume from checkpoints. It does not reboot the Mac or reset results.
- PID birth identity, command identity, dedicated process-group ownership, and group emptiness are checked. Changed identities, unresolved orphan ownership, or a shutdown timeout fail closed and block resume. No automatic SIGKILL is sent by the panel.
- Configuration changes require a new explicit preparation/revision. They do not modify the current instance. Do not prepare a new version as an incidental refresh operation.

Menu-bar controls open the native window. The window shows durable progress, configured stages, token accounting/estimates where available, bounded log tails, and explicit per-stage output samples. Sampling reads actual result JSON from SQLite, checks its digest and identity, and loads at most 2 MiB. Next sample is bounded to 10,000 positions; no sampling occurs automatically. Logs display the last 200 lines/64 KiB and refresh while the log view is open. Metadata refreshes while the window is open; no conversational agent monitors the run.

Old runs have unknown token usage; the panel does not invent totals or API charges. Pending-record counts during preparation can include checkpoint history until reconciliation. Unmaterialized downstream work is not an ETA. Token forecasts retain the limitations in `instances-and-usage.md`.

## CLI

Use the pinned backend printed in the app's `Contents/Resources/bridge.json`:

```sh
node /absolute/pinned/payload/pipeline/panel.ts status /absolute/panel.json
node /absolute/pinned/payload/pipeline/panel.ts pause /absolute/panel.json
node /absolute/pinned/payload/pipeline/panel.ts resume /absolute/panel.json
node /absolute/pinned/payload/pipeline/panel.ts logs /absolute/panel.json
node /absolute/pinned/payload/pipeline/panel.ts sample /absolute/panel.json summarize 0
```

The last two commands can display production content in your terminal. They are local operator actions; do not send their output to an external service.

The native panel is the host control plane. Its creation does not migrate the current macOS MLX runtime into the separately tested Linux VM. Full VM inference remains a separate incomplete integration.

## Verification

`node --test pipeline/tests/panel.test.ts` uses disposable processes and synthetic receipts to cover identity checks, late-worker shutdown, stale pause recovery, sealed restart, bounded logs, and sample integrity. Swift compilation verifies the native source against the installed SDK. GUI appearance and user interaction need local review; tests do not establish production pause/restart acceptance, and no such production action is performed during implementation.
