# Engineering handbook

The handbook explains behavior, documented rationale, dependencies, change impact, operating procedures and history. It is separate from the deterministic source-document pack. Source prose, code and history are evidence; none is executed or treated as instructions. Company data stays local and generated editions stay outside Git.

Configure the complete chapter map in `config/book.example.json`. Topic IDs, headings, keyword aliases, questions, related chapters, registered evidence sources and bounded context sizes are JSON configuration. Add a topic without changing TypeScript. No cloud services or dependencies are installed.

## Produce an edition

1. Build an explicit engineering snapshot with `pipeline/handoff.ts`: add `"selection":"engineering"` to a handoff config and use a new output path. This includes selected code/infrastructure extensions alongside documentation. Git-tracked sources are read without scripts, hooks or filters. Lockfiles are excluded from additional engineering selection. It is a captured working copy, not a deployment certificate. Read unsupported dispositions.
2. Register that handoff output as a `handoff` source and existing local provider archives as `intake` sources. An intake source reads committed accepted SQLite receipts and verifies their JSONL mirrors. For GitHub intake, set `repositories` to an explicit array of repository leaf names; organization enumeration records and other repositories are excluded. Git object archives/diffs are not yet an adapter: PR/issue/comment receipts and captured current code do not establish complete commit-history coverage.
3. Prepare a new, disjoint edition:

   ```sh
   node pipeline/book.ts prepare /absolute/book.json
   node pipeline/book.ts publish /absolute/edition
   ```

   Preparation runs under macOS OS network and source-write denial. Model evidence is embedded as full excerpt text in matching SQLite and JSONL packets, not file pointers. The evidence database also retains registered document/receipt bodies. Closed WAL databases are opened immutable and rechecked; a live WAL reader uses SQLite's read-only snapshot and fails if permissions cannot support it. Original archives are never modified.
4. Supply explicit model settings in a local JSON file: `runtime`, `base`, a **new** role `package`, empty `adapters`, `roleMode: packaged`, `workers: 1`, `batchSize: 64`, `prefillSize: 1`, `memoryBytes`, `budgetBytes`, `timeoutMs`, `maxTokens`, and an absolute `uv` executable. Optional `observeRoots` lists existing pipeline supervisor PIDs whose complete descendant memory must count toward the same budget. The new supervisor never terminates those observed processes; if the shared budget is exceeded it terminates its own children. Normal existing launches are unchanged.

   ```sh
   node pipeline/book.ts draft /absolute/edition /absolute/model.json
   ```

   Fixed author instructions and output schema are sealed into a new role package using existing packaging. Base weights remain unchanged; role attention state initializes once per resident worker. This does not modify the six enrichment roles, their packages or the running instance. All model execution stays under the existing descriptor supervisor and network-denied model sandbox.

The CLI publishes the book after authoring exits. Rerun the same draft command to resume; completed jobs are retained and not regenerated. The edition refuses a changed author identity. Change questions, evidence or model in a **new edition**. Stop the foreground command with Ctrl-C; its committed checkpoint survives. The shared-budget supervisor has quarter-second sampling, not a claim of hardware-enforced instantaneous cross-process memory partitioning.

## Read and verify

Open `EDITION/site/index.html`. Each chapter is a separate HTML page with related chapters, questions, narrative, explicit unknowns and expandable original evidence. The index searches all generated prose and selected evidence locally, including keyword aliases. HTML is escaped, no remote resources load, and a CSP permits only the fixed search script by hash.

```sh
node pipeline/book.ts publish /absolute/edition
node pipeline/book.ts verify /absolute/edition
```

`state/book.sqlite`, `evidence.jsonl`, `input/*.jsonl`, `prepared.json`, `report.json`, and `run/state/pipeline.sqlite` retain the evidence, source hashes, retrieval scope, output provenance and checkpoint. Existing usage.sqlite records author tokens and timing.

The first edition is explicitly a **model draft**. Every factual paragraph needs an existing evidence ID and an exact quotation of at least 12 characters. Invalid references, fabricated quotes, changed packets or corrupt output receipts are rejected. This checks citation mechanics, not semantic entailment. There is currently no human review/signoff workflow, so the publisher deliberately never labels the book fully reviewed or complete.

Keyword retrieval is bounded and not exhaustive dependency analysis. One excerpt is selected per matching source record; exact copies are deduplicated and sources are represented before remaining ranked matches. Each chapter records matching, selected and omitted counts. A missing match never proves no consumer exists. Source collection counts remain visible; pending/failed collection and all-time coverage cannot be hidden by successful book generation. Existing deployment state, historical rationale and regulatory obligations must not be invented. Unknowns and contradictions remain visible.
