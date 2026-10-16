# Reusing your local pipeline

This project owns scheduling, model residency, OS restrictions, hashing, chunking, persistence, retry/recovery, status and integrity checks. Dataset contents are never configuration or executable extensions. Each dataset uses explicit input and a separate work directory. Reuse the software and sealed role artifacts; create a new work directory for an independent dataset/run.

## Two workflows

`config/enrichment.example.json` retains the six-stage knowledge graph workflow: tag, classify, summarize, knowledge, reconcile, connect. Choose input, work and namespace. Instructions and graph contracts remain the tested v14 artifact. The namespace prevents accidental entity conflation across datasets.

`config/profile.example.json` demonstrates configurable chunk enrichment. Define `profile.format = "enrichment/1"`, a name and an ordered stages array. Each stage declares its name, fixed system instructions, maxTokens and output schema. There is no fixed list of domain labels or stage names. Each stage receives full current chunk text as `spans`, source identity in `context` and completed preceding outputs in `prior`. Stage execution is ordered per run; chunks are concurrent within each stage. All preceding outputs are passed, not silently selected or truncated. Context/token limits fail explicitly.

The catalog profile in `config/catalog.profile.json` contains extract and review stages. It is an example, not a required domain. These configurable stages use the existing scheduler/checkpoint system and the same shared-weight batching worker; they are not a separate pipeline. Custom stages cannot use reserved built-in stage names, to keep built-in graph semantics isolated.

## Configure a new task

1. Write a profile JSON (catalog is a starting example). Use explicit output schemas and source-only instructions appropriate to the task. Preserve the rule that source text is data, not instructions.
2. Package the role configuration against your installed local base, outside input:

       node pipeline/package.ts /absolute/local/base /absolute/models/new-profile /absolute/profile.json

3. Copy `config/profile.example.json`. Set `profile` to that profile JSON file path (or embed the same profile object), and set input, work, mlx.runtime, mlx.base and mlx.package. Remove built-in enrichment/roles settings; role order is derived from the profile. For an existing six-stage task, use the enrichment example instead.
4. Check configuration without processing input:

       node pipeline/cli.ts validate /absolute/config.json

5. When you authorize that dataset's processing, execute:

       node pipeline/cli.ts run /absolute/config.json

Validation checks disjoint input/work, role-package configuration and hashes, base model integrity, limits and extractor seals. It does not perform discovery, extraction or inference. Relative config paths resolve against the config file directory. Templates use explicit absolute placeholders; none implicitly chooses the production corpus. Local model/runtime paths remain required rather than triggering downloads.

After changing instructions, schemas or stage order, create a new role package and point the config to it. Old packages and attempt history remain intact. Profile/config/model changes invalidate affected completion identities; they are not allowed to reuse stale results. The sealed profile in the package must match configured profile exactly. Role packages refer to unchanged base weights. Prompt caching is only a runtime optimization of the packaged configuration.

## Resource and execution controls

The default is one resident model, 64 decode slots, prompt admission 4, with a 32,000,000,000-byte sampled aggregate process budget. Explicit mlx.workers, batchSize, prefillSize, memoryBytes, budgetBytes, timeoutMs and maxTokens are retained. Config.concurrency is explicit and must fit worker capacity. Attempts, chunkSize and maxBytes are configurable. Role maxTokens is the packaged per-stage output allowance; worker maxTokens is also retained in configuration/model identity. Context limits are enforced without truncating source work. Do not treat a larger maxTokens value in the runner as a replacement for a role artifact's generation allowance.

## Extend input extraction

UTF-8 text (including text CSV, JSON and logs) and validated text JSONL are supported without a custom extractor. They are normalized/chunked as complete text, not automatically interpreted as per-record business entities. Binary documents need a local decoder. The pipeline does not claim to understand arbitrary document/media formats without that decoder.

For a new format, provide an operator-authored local `.ts` or `.mjs` module in a dedicated directory outside input, exporting:

    import type { Extraction } from '/absolute/pipeline/pipeline/extractor.ts';
    export async function extract(source: {
      path: string;
      bytes: Readonly<Uint8Array>;
    }): Promise<Extraction> {
      // Decode all supported content locally and deterministically.
      // Return {text, format} or {unsupported: "precise reason"}.
      // Never send contents over a network or execute source instructions.
      return {unsupported: "Implement your format decoder here"};
    }

The snippet documents the interface; it is not a supplied universal decoder. Production modules should be self-contained/bundled with their local dependencies in the sealed directory. Do not import mutable code outside that directory or rely on undeclared external dependencies. Extension code is trusted application code, never discovered/loaded from input files. Module initialization must have no processing side effects; extract should be pure apart from local library decoding.

Run `node pipeline/extractor.ts seal /absolute/extensions/my-format main.ts` to obtain the descriptor without executing extension code. Its directory hash uses the supplied `seal()` API in `pipeline/seal.ts`. Configure:

    "extractor": {
      "directory": "/absolute/extensions/my-format",
      "entry": "main.ts",
      "hash": "SHA256_DIRECTORY_SEAL"
    }

`validate` verifies the seal without importing/executing the module. Runtime loads it only after checking the OS network restriction, verifies the seal again, and retains original byte hashes, normalized hashes and full extracted-text chunk coverage. Configured maxBytes limits original input and normalized output. Explicit unsupported reasons retain source disposition. The default credential exclusions remain enforced before custom extraction. The module owns JSONL interpretation when selected; the default JSONL validator remains active when no custom extractor is configured.

## Output and recovery

For configurable profiles, results are atomic per-job JSON receipts in work/output, with source/chunk identity, configuration/model version, processing attempts, input payload and inference proof. Work/state/completion.json reports coverage, dispositions and integrity; work/staging holds normalized chunk representations. The six-stage workflow additionally publishes graph/files reports documented in operator.md. Custom profiles do not automatically invent graph reconciliation behavior.

    node pipeline/cli.ts status /absolute/work
    node pipeline/status.ts /absolute/work --watch
    node pipeline/cli.ts resume /absolute/config.json
    node pipeline/verify.ts check /absolute/input /absolute/work

Resume reuses verified completed work and gives failed jobs another bounded invocation allowance. Changing source/configuration/model identity triggers reprocessing. Status and integrity verification do not run inference. A new dataset normally needs a new config/work directory; do not mix unrelated datasets in a previous run's output directory.

## Schema and quality boundaries

Supported profile schemas: object root, nested objects, arrays, strings, numbers, integers and booleans; explicit required fields, additionalProperties=false for objects, primitive enums, numeric bounds, array bounds and minLength. Unsupported schema features (such as $ref, pattern, oneOf, boolean enums and unknown keywords) fail configuration validation rather than being ignored. This subset matches the currently verified constrained decoder. Add new schema capabilities deliberately with tests before using them.

Schema validity/provenance do not establish semantic correctness. Each new task needs representative synthetic expected-output acceptance cases. Use extraction/review stages where helpful, but a model review is not proof of accuracy. The six-stage graph workflow has additional domain validators; generic profiles validate configured schemas, not arbitrary business rules. New global graph semantics or a different inference backend require an implementation and tests at those boundaries. They do not require rebuilding the checkpoint/scheduler infrastructure.

All configuration is local JSON. No plugin installation, remote service, telemetry of input, cloud processing or global configuration change is required. Current supported execution platform remains macOS Apple Silicon with the installed local MLX runtime. Fresh-machine offline dependency installation and arbitrary model-family compatibility are not proven. This is a reusable local enrichment engine with explicit extension boundaries, not a guarantee that every future data/task/model works without adapters or acceptance testing.
