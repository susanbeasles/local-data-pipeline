# Continuation verification - 2026-10-15

Base: `10ea749` on `work/review-console`. Host: Linux x64. Node: **24.22.0**, the latest 24.x version returned by the npm registry during this session; installed into a task-local directory without changing project dependencies or the host runtime.

## Results

- `npm run check`: passes.
- `npm test`: **272 total, 209 passed, 62 failed, 1 skipped**, exit 1.
- All 27 workflow tests, all 11 PostgreSQL metadata tests and the observer preflight test pass in that full run.
- The full command ran every test file. No production inference, collection restart, corpus migration or native app deployment occurred.
- An earlier run hung because the descriptor supervisor started children before its required macOS library could load. Moving observer initialization before child creation prevents that leak; the final full run completes.

## Regression evidence

The original cumulative trace regression failed before the fix with a missing expected rejection. Additional reproductions exposed failure traces exceeding 16 MiB through retained rejected output, unbounded error text and packet separators omitted from input accounting. Each failure was observed before its corresponding repair. Tests also confirm that trace metadata is reserved before adapter execution and a valid 9 MiB output with a 12 MiB allocation still executes.

The supervisor regression forces only the OS library loader to fail and launches the real Python supervisor. Before repair both worker and application wrote startup markers; after repair neither starts.

## Environment limits and remaining work

The full suite is **not green**. Missing macOS `sandbox-exec`, the libproc observer, scoped filesystem boundaries and local MLX/model assets prevent their acceptance tests. Process identity tests also fail because `/bin/ps` reports `fatal library error, lookup self` in this host. Some assertions consequently see prerequisite failures before reaching their intended branch. These observations do not establish whether the native macOS run has additional defects.

The earlier intermittent sealed-extractor failure remains undiagnosed on macOS. Swift compiler/plugin compatibility and GUI acceptance cannot be verified here. Keep the existing sandbox and identity requirements intact.

The pure-JSON provisioning service and durable graph execution integration remain unfinished. The complete platform specification/acceptance matrix referenced by the original handoff is absent from this checkout. No replacement architecture or production readiness is claimed.

## Exact failures in the final full run

### `pipeline/tests/budget.test.ts`

- aggregate memory breach kills children even when they ignore SIGTERM
- supervisor termination escalates and cannot hang on a resistant application

### `pipeline/tests/catalog.test.ts`

- live pointers refresh roots and process birth plus command prevents PID reuse
- a live PID without identity remains unknown and a missing process is dead

### `pipeline/tests/dataset.test.ts`

- audit review pages failures and outcomes without loading the entire run
- capture preserves complete original data, identities, searchable annotations and typed links across restart
- JSON stages retain every disposition and create an immutable child with edited content
- pause, restart, correction and resume match a fresh corrected run without replay or duplication
- quarantine continues and retains rejected bodies with diagnostics
- unsafe paths, invalid JSON and duplicate captures fail before any publication
- integrity checks detect damaged JSONL and SQLite content
- streamed imports publish all records atomically and retain no partial revision on iterator failure
- a manual pause checkpoints between records and an unclaimed paused worker cannot start
- setting an array JSON path can append nested objects without holes
- a killed detached worker resumes its committed prefix with identical complete output
- stable IDs keep equal human keys in separate source tables distinct
- field checks accept unrelated fields and resume corrected required values
- field checks quarantine short values and distinguish optional missing fields
- an object field check rejects null
- stable imports reuse a saved prefix and reject changed or truncated replay inputs
- a stable import recovers publication after the mirror was written but the revision commit failed
- a killed import resumes its durable prefix without rewriting or duplicating records
- a stale owner with an unrelated live reused PID does not block resume

### `pipeline/tests/engine.test.ts`

- installed MLX generator advances batched rows and admits new sequences during decode

### `pipeline/tests/extractor.test.ts`

- sealed extractor executes only under OS restrictions and participates in resume

### `pipeline/tests/grammar.test.ts`

- installed constrained decoder permits a complete grounded summary and EOS

### `pipeline/tests/inventory.test.ts`

- inventory never executes a repository-configured fsmonitor hook

### `pipeline/tests/panel.test.ts`

- native control reads bounded logs and pauses only its registered process tree
- native resume executes sealed code and frozen configs despite editable project changes

### `pipeline/tests/preserve.test.ts`

- preservation restores hidden files, binary bytes, symlinks and complete local Git history
- production CLI captures and restores inside OS network-denied read-only-input boundaries
- Git null-device access does not permit source or unrelated filesystem writes or networking

### `pipeline/tests/residency.test.ts`

- four independent resident processes feed centralized durable results and resume

### `pipeline/tests/sandbox.test.ts`

- OS denies network and input writes, permits designated work writes
- model sandbox denies network, arbitrary file reads, all writes and process fork

### `pipeline/tests/sessions.test.ts`

- providers report missing binaries without installation or model calls
- detached sessions durably stream events, retain provider IDs, and resume with stdin
- collection workspaces are separate and use confined provider writes
- busy turns reject overlap and hanging workers stop with visible final state
- reset, provider branch, transcript rewind and generated compaction preserve parent
- session IDs, prompts and event offsets are bounded before provider execution
- metadata directory symlinks cannot redirect session storage
- worker interruption terminates its owned orphan and permits durable resume
- oversized provider lines fail visibly and stop output growth
- stop refuses to signal an unrelated reused worker PID
- a full durable event log rejects new turns before launching a provider
- compaction of a long transcript uses a visible bounded excerpt and fresh continuation
- controller exit releases its durable control lock for the next turn
- malformed provider output remains visible without crashing the owned worker
- metadata help denies source and global rollout reads while preserving copied guards
- provider output limits escalate against a subprocess ignoring SIGTERM
- turn deadline terminates an owned hostile process group
- help protection overrides collection read approvals and protected sources reject state storage
- unverifiable external MCP restrictions fail before any prompt reaches the provider

### `pipeline/tests/studio.test.ts`

- bridge preserves source bytes while capturing, linking and running immutable validation stages
- detached local import and pause-correct-resume preserve source and complete mirrors
- concurrent import resumes admit one worker and publish one revision
- concurrent flow resumes retain one lease and one result publication
- worker lease aliases reject writes before touching a source database
- unpublished startup token expires before dataset creation
- worker snapshots preserve pointer-selected custom SQLite filenames
- bridge pages failure and outcome audits with explicit totals
