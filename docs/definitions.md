# JSON workflow definitions

`pipeline/definitions.ts` joins the JSON graph compiler and normalized PostgreSQL
metadata. `Definitions.publish` validates the document, provisions immutable
registry/resource versions, saves the compiled graph and publishes it in one
database transaction. A failed graph, reference, permission or database constraint
leaves no partial provisioning behind.

The service accepts this envelope:

```typescript
import { Definitions } from "../pipeline/definitions.ts";

// The trusted host constructs Metadata with authenticated UUID scope, registers
// exact adapter handlers, and supplies the allowed capabilities and budget.
const definitions = new Definitions(metadata, trustedRegistry, hostPolicy);
const saved = await definitions.publish({
  format: "platform-definition/1",
  registry: registry.manifest(), // registry/1: contracts, adapters, types, resources
  workflow: definition, // workflow/1: the complete typed DAG
});
const { workflow, registry: pinned } = await definitions.open(saved.id);
const versions = await definitions.list({ limit: 100 });
```

The envelope and every registry, graph and resource value must be finite, acyclic
plain JSON. Unknown fields, functions, accessors and executable module/command
fields fail validation. The complete document is snapshotted before any
asynchronous operation, with a 1 MiB size limit and a nesting limit of 64. Larger
payloads belong in committed artifacts.

The host policy never comes from the document. The workflow and every manifest
entry must match the authenticated metadata workspace/project/principal; the
principal supplies the graph's `scope.owner`. This service does not provision
principals, memberships, grants or credentials. It accepts only adapter
definitions whose complete immutable identity already resolves to a handler in
the host's trusted registry. A JSON file cannot install an executor.

Publication requires both `configure` and `publish`. `open` and `list` require
`view`, without requiring `configure`. PostgreSQL grants may be direct or supplied
through the existing role bindings. Disabled principals/memberships fail the
metadata authorization checks. `list` uses UUID ordering and returns at most 100
versions by default; `limit` is 1–1000 and `after` accepts the last returned UUID.
`open` accepts only a published version UUID in the authenticated project and
recompiles its release under the current host policy and exact trusted handlers.

Contract, adapter, step type and resource identity includes the pinned SHA-256
digest. Reusing an existing key/version requires identical normalized contents.
Changed contents require a new version. The graph definition and the complete
manifest are immutable after publication; an identical publication returns the
same version UUID and hash. Database columns retain the original graph in
`workflow_versions.definition`, its verified release in `compiled_release`, and
the pinned manifest in `execution_policy.registry`. The durable execution service
uses these same persisted pins.

Each `registry.resources` entry contains `id`, `version`, `scope`, `kind` and
`body`. Bodies use the following exact shapes; all fields are required unless
marked optional.

| Kind         | Body                                                                                                   | Normalized PostgreSQL relation                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `model`      | `{provider, model, capabilities: string[], modalities: string[], parameters: object, context: object}` | `models`; `model` maps to `model_key`, `context` to `context_limits`                       |
| `prompt`     | `{template, variables: object, contract: Ref}`                                                         | `prompts`; the contract must resolve in the manifest                                       |
| `rule`       | `{language: "json-logic", expression: Json, input: Ref, output?: Ref, config: object}`                 | `logic`; input/output contracts must resolve in the manifest                               |
| `schema`     | `{type: "json-schema", schema: Schema, compatibility: object}`                                         | `schemas`; the schema passes the existing schema validator                                 |
| `dataset`    | `{revision: UUID}`                                                                                     | `dataset_resources`; references an existing published dataset revision in the same project |
| `artifact`   | `{artifact: UUID}`                                                                                     | `artifact_resources`; references an existing committed artifact in the same project        |
| `connection` | `{connection: UUID}`                                                                                   | `connection_resources`; references an existing active connection in the same workspace     |

`Ref` is `{id, version, digest}`. Every resource also receives its normalized
`resources` row; required step bindings and resource kinds are checked by the
graph compiler and metadata service. Model modalities must be nonempty. Model
metadata and declarative rule expressions are registered as data; execution
belongs to the pinned host handler. This service neither invokes providers nor
evaluates expressions during publication.

Dataset and artifact bodies bind existing durable records; they do not manufacture
physical files or receipts. Connections and credentials are provisioned by the
trusted operator path. Publishing a reference to a credentialed connection also
requires `secret-use` in the same transaction. Neither credentials nor secret
values are copied into the manifest.

`node --test pipeline/tests/definitions.test.ts` exercises actual PostgreSQL through
PGlite, with synthetic scopes and local artifacts. It covers normalized
provisioning, idempotent immutable versions, exact trusted handlers, view-only
reads, publication rollback, typed bodies, committed artifact references,
credential authorization and input snapshotting. This does not establish a
separate-server deployment or multi-host concurrency behavior.
