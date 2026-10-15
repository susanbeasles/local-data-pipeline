# Local platform command service

`pipeline/platform.ts` composes the source catalog, dataset workspace, standard
capability registry, JSON definitions and durable PostgreSQL graph runner. It
exposes a local TypeScript service and a single-request JSON pipe for an operator
or native bridge. It does not open an HTTP endpoint.

The operator supplies a trusted configuration file outside the input corpus:

```json
{
  "format": "platform/1",
  "state": "/absolute/operator/platform",
  "scope": {
    "workspace": "11111111-1111-4111-8111-111111111111",
    "project": "22222222-2222-4222-8222-222222222222",
    "principal": "33333333-3333-4333-8333-333333333333"
  },
  "policy": {
    "scope": {
      "workspace": "11111111-1111-4111-8111-111111111111",
      "project": "22222222-2222-4222-8222-222222222222",
      "owner": "33333333-3333-4333-8333-333333333333"
    },
    "capabilities": ["data.read", "data.write", "resource.read", "rule.read"],
    "grants": [],
    "budget": {
      "cpuMs": 100000,
      "memoryBytes": 16777216,
      "storageBytes": 16777216,
      "timeMs": 300000,
      "tokens": 0,
      "costMicros": 0,
      "concurrency": 1
    }
  },
  "database": { "environment": "PLATFORM_DATABASE" },
  "catalog": []
}
```

The file establishes the host's identity and capability ceiling. It is an
operator authority boundary: protect it as application configuration. A workflow
document cannot supply a policy, grant permissions, select its principal or
install a handler. The workspace, project, principal, memberships and grants must
already exist in PostgreSQL. `Platform.open` checks migration readiness and never
applies SQL or creates ownership/grant records automatically.

`database.environment` names an environment variable containing a PostgreSQL
URL. The endpoint must be explicit loopback; URL query options and remote hosts
are rejected by `Postgres.local`. Keep database passwords out of JSON. An
isolated worker can instead use an explicit Unix socket binding:

```json
{
  "socket": "/absolute/operator/platform/postgres/socket",
  "database": "platform",
  "user": "platform_service"
}
```

This socket object replaces `database`; its canonical private directory is passed
to `Postgres.socket`. For the supervised worker it must live inside operator
state, and the OS profile must allow exactly its `.s.PGSQL.5432` Unix socket while
retaining network denial. A configuration field alone does not grant OS access.
Normal opening does not start PostgreSQL or deploy infrastructure.

Each optional `catalog` entry follows [the catalog guide](catalog.md). Source
roots, pointer-resolved live roots and optional model paths must be disjoint from
operator state. The platform resolves symlinks before creating local state and
checks that `datasets` and `artifacts` remain inside that state root. Dataset
workspace files live under `state/datasets`; committed execution files live under
`state/artifacts`. The catalog opens source SQLite databases read-only.

`connections` optionally maps approved PostgreSQL connection UUIDs to registered
catalog source IDs. These are trusted operator bindings for the standard capture
capability. Workflow resources reference the approved connection UUID; they cannot
choose an arbitrary database or filesystem path.

Use the JSON pipe with exactly one request on stdin:

```sh
node pipeline/platform.ts /absolute/operator/platform.json < request.json
```

For example, `request.json` can contain:

```json
{ "action": "flows", "input": { "limit": 100 } }
```

The process writes one JSON result to stdout. Failures write
`{"error":{"message":"..."}}` and exit with status 1. Requests, configurations
and responses are bounded to 2 MiB, with finite plain JSON and a nesting limit of 64. Definitions have their own tighter 1 MiB metadata limit. No request is
interpolated into a shell command.

| Action             | Input                                                                        | Behavior                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `health`           | `{}`                                                                         | Checks current view authorization and reports schema, batch mode and model configuration presence                        |
| `registry`         | `{}`                                                                         | Lists the host's exact pinned contracts, adapters and step types for constructing graph JSON                             |
| `sources`          | `{}`                                                                         | Reads live source status through the catalog                                                                             |
| `tables`           | `{source}`                                                                   | Lists tables and observed counts in a registered source                                                                  |
| `page`             | `{source, table, options?: {offset?, limit?, query?}}`                       | Reads a bounded source preview                                                                                           |
| `record`           | `{source, table, key}`                                                       | Reads a catalog record using a key returned by `page`                                                                    |
| `flows`            | `{limit?, after?}`                                                           | Lists scoped workflow versions with UUID pagination                                                                      |
| `preview`          | A `platform-definition/1` document                                           | Compiles and returns a graph release without executing handlers or provisioning rows                                     |
| `publish`          | A `platform-definition/1` document                                           | Atomically provisions normalized versions and publishes the validated graph                                              |
| `run`              | `{version: UUID, batch?: {mode?: "batch", key?, parameters?, maxAttempts?}}` | Creates or reuses a durable batch run                                                                                    |
| `work`             | `{worker, limit?}`                                                           | Executes one available task, or drains at most 1–100 tasks when `limit` is supplied; a single idle worker returns `null` |
| `pause` / `resume` | `{run: UUID}`                                                                | Controls task admission and returns an action acknowledgement                                                            |
| `status`           | `{run: UUID}`                                                                | Returns durable SQL task, artifact and usage state                                                                       |

Preview checks graph compilation, scopes, host capabilities and exact handler
pins. Publication additionally validates normalized resource bodies, existing
durable references and publication authorization. Unsupported execution modes fail
explicitly. `run` queues work; an operator invokes `work` separately. Restarted
service instances recover execution state from PostgreSQL rather than an in-memory
completion cache. Pausing prevents new claims; already leased work follows the
durable runner's documented fencing rules.

The optional `model` is the existing resident MLX `Model` configuration, with an
absolute runtime/base/package path, an empty `adapters` object and packaged role
instructions. `modelKey` must identify the approved model resource. Inline role
instructions and learned adapters are rejected. The existing worker limit remains
1, 2 or 4 workers and batch size 1–64. Read commands, preview and publication never
initialize the resident pool. The first actual inference requires a Unix socket
database binding, inherited worker descriptors and successful OS network-denial
verification through the existing pool. This command service does not launch a
model, create a worker supervisor or contact an inference provider itself.

For persistent work, explicitly launch:

```sh
node pipeline/platform-worker.ts /absolute/operator/platform.json
```

The launcher uses the existing isolated descriptor supervisor and keeps one
`Platform` instance and its resident pool across tasks. Configure an absolute
`input` root, or at least one catalog source whose root supplies that boundary.
The root must exist and be disjoint from operator state. Model assets must be
outside that input root and operator state. The launcher requires the explicit
Unix socket database binding and its exact OS policy allowance; it does not
enable network access. The internal supervised invocation verifies actual OS
network denial before connecting to metadata or claiming work.

An idle worker polls every 500 ms. SIGINT/SIGTERM stops new claims and waits for
active work to finish its durable checkpoint before closing the pool. JSON progress
lines contain only execution/run/task/attempt status metadata, with no source
records, adapter errors or artifact contents. This worker entrypoint does not
activate a system service or submit a production run automatically. Use `run` to
queue an explicitly selected workflow version.

An embedded host can also use
`platform.worker({worker, signal, limit?, pollMs?, onWork?})`. The optional limit
bounds attempted tasks; stopping during idle does not claim a task, and stopping
during execution affects admission after that task's durable result.

For an embedded trusted host:

```typescript
const platform = await Platform.open(operatorConfig);
try {
  const flows = await platform.command("flows", { limit: 100 });
} finally {
  await platform.close();
}
```

`Platform.open(config, {database, registry})` also accepts typed host-owned
dependencies. The same command handlers run against them; the service closes its
own PostgreSQL pool and local dataset workspace, while the caller retains the
injected database's lifecycle. This supports actual PGlite integration tests and
hosts with additional explicitly registered handlers, without JSON test flags.

`node --test pipeline/tests/platform.test.ts` covers actual PostgreSQL, SQLite,
JSONL artifacts, the command bridge, restart recovery, schema readiness,
authorization and root guards using synthetic fixtures. See
[definitions](definitions.md), [execution](execution.md) and
[metadata](metadata.md) for their narrower guarantees.

### Measured model usage and replay

The built-in `model.infer` adapter requires the admitted model's non-JSON proof annotation, matching the request identifier and role. Every inference phase must include measured input and output token counts. The adapter sums all phases, charges those tokens before validating the role response, and retains the proof with the role outcome. Missing or malformed proof fails closed; tokens are never estimated from text. Synthetic host callbacks in tests supply explicitly synthetic measurements rather than claiming to run MLX.

Each enriched record retains `inference[role]` with run, step, admitted model key, original record hash, workflow digest, pinned input revision/hash, measured tokens and phase proof. Dataset replay reads one hash-verified saved checkpoint at a time and checks this provenance plus record identity before reusing an outcome. Completed revision reuse verifies the SQLite/JSONL mirror and still checks every input against its saved outcome. A changed source, workflow or model binding therefore cannot silently reuse an old result. Already checkpointed outcomes incur no new inference charge.

Concurrent callbacks settle before an adapter failure returns, so successful measured responses are charged even when another response fails. The ordered successful prefix is checkpointed; successful responses after the first failed position can require inference again on retry because they were not committed. This preserves deterministic order and does not claim exactly-once external inference across crashes.

Synthetic tests run the actual six-role ordered graph with real dataset revisions, verify exact token totals and retained role outcomes, interrupt and resume a prefix without repeating committed inference, and reject both changed input and corrupted checkpoint rows. They do not establish MLX quality or production throughput.
