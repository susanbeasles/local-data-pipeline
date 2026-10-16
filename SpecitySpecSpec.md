Yes, bro. I have the entire original response, including the full production-grade specification you were responding to. You shouldn't have lost all that just because you replied to one section.

I'm restoring it below, including the architecture, entity model, complete implementation specification, example workflow, and completion criteria.

I'm preserving the original structure rather than replacing it with a shorter summary.

## 1. The conceptual architecture

You're describing something substantially more powerful than a conventional ETL builder. You're building a declarative, model-driven data processing platform where ingestion, transformation, inference, validation, enrichment, correlation, and delivery are all configurable operations within the same execution system.

And yes, your cardinality model is fundamentally right:

1 Workflow → N Sources, N Inputs, N Outputs, N Filters, N Transforms, N Categories, N Models, N Steps, N Rules, N Stages, N Destinations.

But I'd change how those relationships are represented.

A workflow is a versioned directed graph of executable operations connected by typed data contracts.

That gives you linear pipelines, branching pipelines, parallel processing, conditional execution, streaming, fan-out/fan-in, iterative enrichment, and eventually agent-generated workflows without having to redesign the backend.

Your architecture has four distinct domains:

| Domain     | Responsibility                                                                       |
| ---------- | ------------------------------------------------------------------------------------ |
| Definition | What should happen, with which data, models, rules, and parameters                   |
| Data       | Logical datasets, schemas, representations, artifacts, provenance, and relationships |
| Execution  | Scheduling, orchestration, checkpoints, retries, resource allocation, and results    |
| Governance | Validation, permissions, lineage, cost, observability, and auditability              |

Separating these domains means a user can edit a pipeline without modifying historical execution data, and one dataset can be reused by multiple workflows.

## 2. The most important modeling distinction

These are not interchangeable:

- Source: Where data originates. PostgreSQL, S3, an API, Kafka, a ZIP archive, or a filesystem.
- Input: A reference to data consumed by a particular operation.
- Dataset: A logical collection of records, independent of its storage format.
- Representation: An encoding or storage arrangement of a dataset, such as JSONL, SQLite, Parquet, XML, or BSON.
- Artifact: A specific immutable produced object or dataset snapshot, with a location, version, checksum, and metadata.
- Output: A typed product of an operation, which may be a dataset, tags, classification results, metrics, decisions, or a report.
- Destination: A configured endpoint where an output is published or delivered.

One logical dataset might have five representations and twenty historical materializations. Those must not become twenty unrelated datasets.

Similarly, a model is not a step, and a rule is not a filter.

A model is a configured inference resource. A step is an operation that might invoke it. A rule is reusable logic that might execute as a filter, validation, routing condition, policy, or escalation criterion.

This separation is what makes the system composable.

## 3. The production entity model

I'd start with these entities as the authoritative domain model. Not every entity needs a dedicated SQL table, but every concept should have a clearly defined identity and lifecycle.

| Domain        | Entities                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| Ownership     | `Workspace`, `Project`, `Principal`, `Role`, `Permission`                                               |
| Workflow      | `Workflow`, `WorkflowVersion`, `Stage`, `Step`, `Port`, `Edge`, `Trigger`                               |
| Connections   | `ConnectorDefinition`, `Connection`, `Source`, `Destination`, `CredentialReference`                     |
| Data          | `Dataset`, `DatasetVersion`, `SchemaDefinition`, `Representation`, `Artifact`, `RecordIdentity`         |
| Processing    | `TransformDefinition`, `FilterDefinition`, `RuleDefinition`, `Taxonomy`, `Category`, `ValidationPolicy` |
| AI            | `ModelDefinition`, `ModelDeployment`, `ModelConfiguration`, `PromptTemplate`, `InferenceProfile`        |
| Runtime       | `WorkflowRun`, `StageRun`, `StepRun`, `Task`, `TaskAttempt`, `Checkpoint`, `ArtifactBinding`            |
| Observability | `ExecutionEvent`, `LineageEdge`, `Metric`, `QualityResult`, `UsageRecord`, `AuditEvent`                 |

Some relationships are direct, others are many-to-many through binding and reference tables.

The most important rules are:

1. A `Workflow` has many immutable `WorkflowVersions`.
2. A `WorkflowVersion` has many `Stages`, `Steps`, `Ports`, and `Edges`.
3. A `Stage` groups steps but doesn't own the data itself.
4. A `Step` consumes input ports and produces output ports.
5. An `Edge` connects compatible ports, potentially across stages.
6. A `Dataset` exists independently of any specific workflow.
7. A `DatasetVersion` identifies a logical snapshot or revision.
8. A `Representation` describes how that version can be encoded.
9. An `Artifact` represents a particular physical materialization.
10. A `WorkflowRun` references exactly one published workflow version.
11. Every executed operation has traceable inputs, outputs, configuration, and results.
12. Models, prompts, rules, schemas, taxonomies, and connection references are versioned or pinned as appropriate.

An important addition is to distinguish a stage template from a stage instance. You could define a reusable "LLM Tagging" template once, then insert three differently configured instances into a workflow.

## 4. How the graph works

You want three distinct graph structures:

The execution graph: Which operations depend on which others.

The data lineage graph: Which datasets, records, fields, and artifacts contributed to other data.

The semantic relationship graph: What the data means, including cross-references, entity associations, classifications, inferred relationships, and confidence.

These should interact, but not be stored as one giant table of generic edges. Their identities, constraints, and lifecycles are different.

For instance, when your cross-reference stage discovers that two documents concern the same person, that's a semantic relationship. It isn't an execution dependency.

## 5. The complete implementation specification

This is the full document you were responding to, restored as a standalone editable document.

# Dynamic Data Pipeline Platform

## Production Domain Model and Backend Implementation Specification

**Status:** Proposed architecture specification\
**Primary metadata database:** PostgreSQL\
**Architecture:** Versioned declarative execution graph with pluggable processing adapters\
**Scope:** Batch, incremental, streaming, AI enrichment, analytics, anomaly detection, and event-driven workflows

### 1. Objective

Implement a production-grade, extensible backend that allows users or AI agents to construct complex data pipelines through declarative configuration.

The system must support:

- N heterogeneous sources per workflow.
- N stages, steps, inputs, outputs, filters, transformations, models, schemas, rules, and destinations.
- Data normalization into a reusable canonical dataset.
- Multiple physical representations of the same logical dataset.
- Branching, fan-out, fan-in, conditional execution, and joins.
- Model-driven enrichment, classification, extraction, summarization, and cross-referencing.
- Configurable inference parameters, batching, chunking, prompts, and output contracts.
- Record-level, batch-level, dataset-level, and window-level processing.
- Batch, scheduled, incremental, event-driven, and streaming execution.
- Immutable workflow versioning, lineage, replay, observability, and auditing.
- Multi-tenant ownership and permission boundaries.
- Configurable quality gates, retries, error handling, and cost controls.

The platform must not hardcode specific providers, storage formats, model vendors, task types, or processing sequences.

### 2. Core Design Principles

1. **Workflow definitions are immutable once published.** Changes create a new version.
2. **Data definitions and execution records are separate.** An execution references the exact definitions used.
3. **Steps communicate through typed ports.** They do not implicitly consume the entire output of the preceding stage.
4. **Datasets are logical entities.** Storage formats and artifacts are separate resources.
5. **Every executable step uses a registered step type.** Each type declares its configuration schema, input/output contracts, capabilities, and executor adapter.
6. **All external resources are referenced, not embedded.** Secrets and credentials never appear in workflow definitions.
7. **Data operations must support reproducibility.** Record input versions, configuration digests, code versions, model versions, and output identities.
8. **Failure is explicitly modeled.** Partial success, rejected records, retries, compensation, and dead-letter handling are first-class.
9. **Runtime state must support horizontal execution.** No correctness dependency on local process memory.
10. **All graph mutations must be validated before publication.** Invalid workflows cannot execute.
11. **Untrusted source data remains data.** It must not become execution instructions, elevated permissions, or connector configuration.
12. **Every published workflow must have an explicit resource, security, and execution policy.**

### 3. Authoritative Domain Entities

#### 3.1 Ownership and Access

**Workspace**

- id
- name
- slug
- settings
- quotas
- created_at
- updated_at

**Project**

- id
- workspace_id
- name
- description
- settings
- created_at

**Principal**

- id
- kind: user | service_account | agent
- identity_reference
- status

**Role / Permission / RoleBinding**

- Scope access to workspaces, projects, workflows, datasets, connections, models, and runs.
- Support distinct view, configure, execute, publish, administer, and secret-use permissions.

#### 3.2 Workflow Definitions

**Workflow**

- id
- workspace_id
- project_id
- key
- name
- description
- owner_id
- status
- current_published_version_id
- created_at
- updated_at
- archived_at

**WorkflowVersion**

- id
- workflow_id
- version_number
- status: draft | published | retired
- graph_schema_version
- definition_hash
- default_execution_policy
- default_resource_policy
- metadata
- created_by
- created_at
- published_at

**Stage**

- id
- workflow_version_id
- key
- name
- description
- kind
- execution_policy
- error_policy
- resource_policy
- display_order
- metadata

**Step**

- id
- workflow_version_id
- stage_id
- key
- name
- step_type_id
- step_type_version
- configuration
- retry_policy
- timeout_policy
- resource_policy
- enabled
- metadata

**Port**

- id
- step_id
- key
- direction: input | output
- data_contract_id
- required
- cardinality: one | many
- accepts_stream
- metadata

**Edge**

- id
- workflow_version_id
- source_port_id
- target_port_id
- routing_condition_id
- transfer_policy
- metadata

**Trigger**

- id
- workflow_id
- trigger_type
- configuration
- enabled
- concurrency_policy

All stages and steps must belong to the same workflow version as their edges. Stable keys are unique within the appropriate scope. Graph edges may connect steps across stages; stages provide organizational and execution boundaries, not artificial data ownership boundaries.

Workflow publication must verify graph validity, type compatibility, contract compatibility, step configurations, referenced resource accessibility, cycle policy, and resource limits.

Default to acyclic execution graphs. Iteration must use an explicit bounded-loop construct or a versioned feedback mechanism with termination conditions, rather than arbitrary cycles.

#### 3.3 Extensible Processing Registry

**StepTypeDefinition**

- id
- key
- version
- display_name
- category
- configuration_json_schema
- input_port_specification
- output_port_specification
- executor_adapter_id
- supported_execution_modes
- supported_data_kinds
- capabilities
- security_requirements

**ExecutorAdapter**

- id
- key
- version
- runtime_kind
- artifact_reference
- artifact_digest
- runtime_contract_version
- required_capabilities
- isolation_policy

Required initial step categories:

- ingest
- normalize
- parse
- encode
- decode
- transform
- filter
- map
- reduce
- join
- aggregate
- split
- merge
- infer
- embed
- classify
- extract
- summarize
- validate
- deduplicate
- correlate
- calculate
- detect_anomaly
- evaluate_rule
- route
- publish
- notify
- custom_adapter

A step category is not the executable implementation. Registered adapters provide implementations and declare their supported contracts.

Custom adapters must be versioned, authorized, resource-limited, and sandboxed according to capability requirements.

#### 3.4 Connectivity and External Resources

**ConnectorDefinition**

- id
- key
- version
- connector_kind
- configuration_schema
- supported_operations
- supported_authentication_methods
- capability_manifest
- adapter_reference

**Connection**

- id
- workspace_id
- connector_definition_id
- name
- nonsecret_configuration
- credential_reference_id
- status
- ownership_policy

**Source**

- id
- workspace_id
- connection_id
- resource_locator
- source_kind
- discovery_configuration
- change_detection_strategy
- default_schema_id

**Destination**

- id
- workspace_id
- connection_id
- resource_locator
- destination_kind
- write_capabilities
- default_write_policy

**CredentialReference**

- id
- workspace_id
- secret_provider
- secret_identifier
- access_policy
- rotation_metadata

Support databases, object stores, filesystems, archives, HTTP APIs, queues, streams, warehouses, and custom resource connectors.

Do not assume sources are readable only once, or that destinations are exclusively write-only.

Credentials must be resolved by authorized executors at runtime. Never serialize secret values into graph definitions, log messages, artifacts, or prompt contexts.

#### 3.5 Dataset and Storage Model

**Dataset**

- id
- workspace_id
- key
- name
- description
- dataset_kind
- identity_strategy
- retention_policy
- classification
- created_at

**SchemaDefinition**

- id
- workspace_id
- name
- version
- schema_type
- schema_body
- compatibility_policy
- schema_hash

**DatasetVersion**

- id
- dataset_id
- version_number
- schema_id
- parent_version_ids
- manifest_reference
- content_fingerprint
- record_count
- byte_count
- statistics
- state
- created_at

**Representation**

- id
- dataset_version_id
- format
- format_version
- encoding_configuration
- logical_schema_mapping
- storage_layout
- compatibility_metadata

**Artifact**

- id
- representation_id
- uri
- storage_backend_id
- media_type
- byte_size
- checksum_algorithm
- checksum
- partition_key
- manifest_metadata
- produced_by_step_run_id
- created_at
- retention_until

**RecordIdentity**

- dataset_id
- logical_record_id
- identity_algorithm
- source_identity_reference
- first_observed_at

**RecordRevision**

- id
- dataset_version_id
- logical_record_id
- content_hash
- source_lineage_reference
- event_time
- ingestion_time
- validity_metadata

Use record revision indexes only when required by the dataset's capabilities. Do not mandate a PostgreSQL row per record for large object-store datasets.

Dataset manifests must identify partitions, artifacts, offsets, and counts. Physical representations can be sharded. A logical SQLite representation may consist of multiple partitioned SQLite files rather than a single enormous file.

Support both snapshot-style and incrementally updated datasets with explicit consistency semantics.

#### 3.6 Transformations, Rules, and Taxonomies

**TransformDefinition**

- id
- workspace_id
- key
- version
- transform_type
- configuration_schema
- implementation_reference
- input_contract
- output_contract

**FilterDefinition**

- id
- workspace_id
- key
- version
- expression_language
- expression
- input_contract

**RuleDefinition**

- id
- workspace_id
- key
- version
- rule_kind
- expression
- condition_configuration
- action_configuration
- priority
- evaluation_policy

**Taxonomy**

- id
- workspace_id
- key
- name
- version
- metadata

**Category**

- id
- taxonomy_id
- parent_category_id
- key
- label
- description
- attributes

**ValidationPolicy**

- id
- workspace_id
- key
- version
- contract_id
- assertions
- severity_configuration
- failure_action
- sampling_policy

Rule definitions must be executable through a constrained, deterministic rule evaluator unless explicitly assigned to a separate inference operation.

A category is a domain label, not a workflow stage. Categories can be hierarchical and must support stable identifiers across label changes.

#### 3.7 Models and AI Configuration

**ModelDefinition**

- id
- provider
- model_key
- model_family
- capabilities
- supported_modalities
- parameter_schema
- context_constraints
- output_constraints

**ModelDeployment**

- id
- model_definition_id
- runtime_provider
- endpoint_reference
- model_revision
- tokenizer_reference
- deployment_configuration
- availability_status

**ModelConfiguration**

- id
- workspace_id
- model_deployment_id
- configuration_version
- generation_parameters
- reasoning_parameters
- decoding_parameters
- resource_parameters
- response_format
- provider_specific_parameters

**PromptTemplate**

- id
- workspace_id
- key
- version
- template
- variable_schema
- expected_output_contract
- template_hash

**InferenceProfile**

- id
- workspace_id
- model_configuration_id
- prompt_template_id
- input_mapping
- output_mapping
- batching_configuration
- context_assembly_policy
- inference_strategy
- validation_policy_id
- fallback_policy
- cost_policy

Support provider-specific parameters such as temperature, top_p, token limits, reasoning effort, seed, structured output modes, and tool configuration only when supported by the selected provider/model.

Prompt compilation, prefix caching, local model adapters, and fine-tuning are distinct optimization strategies. Record which strategy is used, the artifact or cache identity, and the configuration hash. Never claim prompt instructions have been embedded into model weights unless actual weight-level adaptation occurred and is verified.

Provider-enforced safety controls and model capabilities cannot be bypassed through arbitrary configuration.

#### 3.8 Execution and Runtime State

**WorkflowRun**

- id
- workflow_id
- workflow_version_id
- trigger_id
- execution_mode
- status
- execution_parameters
- effective_configuration_hash
- initiated_by
- started_at
- completed_at

**StageRun**

- id
- workflow_run_id
- stage_id
- status
- started_at
- completed_at
- statistics

**StepRun**

- id
- workflow_run_id
- stage_run_id
- step_id
- status
- effective_configuration_hash
- started_at
- completed_at
- statistics
- error_summary

**Task**

- id
- step_run_id
- partition_reference
- batch_reference
- status
- scheduled_at
- lease_owner
- lease_expires_at

**TaskAttempt**

- id
- task_id
- attempt_number
- worker_id
- status
- started_at
- completed_at
- error_code
- error_details
- resource_usage

**Checkpoint**

- id
- workflow_run_id
- step_run_id
- partition_reference
- cursor_state
- state_artifact_reference
- committed_at

**ArtifactBinding**

- id
- step_run_id
- port_id
- artifact_id
- binding_direction
- partition_reference

**ExecutionEvent**

- id
- workflow_run_id
- entity_kind
- entity_id
- event_type
- timestamp
- event_payload
- trace_id
- correlation_id

A logical task may execute more than once. Attempts are explicitly modeled.

Step outputs must not be considered committed until their declared artifact commit policy succeeds.

Retries must be idempotent where possible. External side effects require an idempotency key, transaction support, or an explicitly defined compensation policy.

#### 3.9 Data Lineage and Semantic Relationships

**LineageEdge**

- id
- workflow_run_id
- producing_step_run_id
- source_artifact_id
- target_artifact_id
- lineage_kind
- transformation_reference
- metadata

**SemanticEntity**

- id
- workspace_id
- entity_type
- canonical_identifier
- attributes
- confidence
- resolution_status

**SemanticRelationship**

- id
- workspace_id
- source_entity_id
- target_entity_id
- relationship_type
- confidence
- evidence_reference
- producing_step_run_id
- valid_from
- valid_to

**InferenceAssertion**

- id
- subject_reference
- predicate
- value
- model_deployment_id
- inference_profile_id
- confidence
- evidence_references
- validation_status
- produced_at

Keep source observations distinct from inferred assertions and accepted canonical facts.

A model-generated relationship must retain its evidence and provenance. A later model run must not silently overwrite the historical assertion.

Support record-level and field-level lineage through optional indexed lineage manifests instead of writing billions of relationships to PostgreSQL.

#### 3.10 Observability, Cost, and Audit

**Metric**

- id
- run_reference
- metric_name
- metric_value
- dimensions
- observed_at

**QualityResult**

- id
- step_run_id
- validation_policy_id
- assertion_id
- passed
- observed_value
- expected_constraint
- sample_reference

**UsageRecord**

- id
- task_attempt_id
- resource_kind
- usage_quantity
- usage_unit
- estimated_cost
- actual_cost
- pricing_version

**AuditEvent**

- id
- workspace_id
- actor_id
- action
- target_type
- target_id
- occurred_at
- change_summary
- request_correlation_id

Record execution logs, tool invocations, process commands, adapter calls, resource usage, network access decisions, and data publication events through an independently protected observability channel.

Logs must redact credentials and sensitive payloads according to explicit policies. Audit records must be tamper-evident and inaccessible for modification by ordinary workflow executors.

### 4. Execution Modes

The graph engine must support:

- **Batch:** finite input snapshots.
- **Incremental:** process only changed records/partitions.
- **Streaming:** process continuously arriving events.
- **Windowed:** evaluate bounded temporal or count-based windows.
- **Scheduled:** time-based execution.
- **Event-driven:** trigger on source or external events.
- **Manual:** user-initiated execution.
- **Replay:** deterministic or best-effort historical reprocessing.
- **Dry run:** execute validation and bounded samples without committing side effects.

Support processing granularities:

- record
- document
- object
- batch
- partition
- table
- dataset
- time_window
- custom_group

Batch size, concurrency, ordering, partitioning, checkpoint intervals, and backpressure policies are configurable independently.

### 5. Mandatory Graph and Data Invariants

- Published definitions cannot be modified.
- All graph identifiers resolve within the correct workflow version.
- Required input ports have valid bindings.
- Port connections satisfy declared data-contract compatibility.
- No implicit type coercion or format conversion without a registered adapter.
- Every artifact has a verifiable immutable identity or explicitly declared mutable snapshot policy.
- Logical dataset identity is independent of storage representation.
- Every step run is associated with a workflow run and definition version.
- Rejected records do not silently disappear.
- Checkpoint commits and output publication have documented transactional boundaries.
- Concurrent attempts cannot both become authoritative for the same idempotent task.
- Dataset writes use explicit append, replace, upsert, merge, or versioned-snapshot semantics.
- Workflow runners cannot retrieve unauthorized connection credentials.
- Models cannot obtain undeclared tools, source access, or execution privileges from prompt content.
- Deleting definitions must not invalidate retained historical lineage.
- Pinned models, prompts, schemas, rule versions, and adapter digests must remain resolvable for the defined retention period.
- Quality gates control downstream publication when configured as blocking.
- Runtime budgets can limit money, tokens, CPU, memory, storage, execution time, and concurrency.

### 6. Persistence Architecture

Use PostgreSQL for transactional metadata, relational integrity, definitions, workflow versions, and execution indexes.

Use object storage for large immutable artifacts, manifests, checkpoints, payloads, and batch data.

Use a durable event/queue system for distributed work dispatch.

Use a dedicated telemetry backend or durable event sink for high-volume logs, spans, metrics, and audit streams.

Use search indexes or graph-oriented projections for semantic entity discovery when required.

Avoid storing large source records, inference payloads, or raw event streams directly inside general workflow metadata tables.

JSONB is appropriate for type-validated, extensible configurations and provider-specific parameters. It is not a substitute for relational foreign keys, workflow graph integrity, or stable entity identities.

### 7. Implementation Deliverables

The implementation must include:

1. Normalized PostgreSQL migrations with keys, constraints, indexes, and referential integrity.
2. Versioned domain schemas and typed application entities.
3. Step-type and connector registries with schema validation.
4. Workflow graph compiler and publication validator.
5. CRUD and version lifecycle services.
6. Execution state machine and durable task orchestration contracts.
7. Dataset, artifact, representation, and manifest interfaces.
8. Resource, inference, and validation policy services.
9. Lineage recording interfaces.
10. Audit and observability event contracts.
11. API contracts for building, publishing, validating, executing, and inspecting workflows.
12. Example fixture implementing the five-source, dual-format, multi-stage AI enrichment workflow.
13. Automated unit, integration, concurrency, retry, failure-injection, and security tests.
14. Documentation of consistency guarantees, extension points, retention, and operational limits.

### 8. Completion Criteria

Implementation is not complete until tests prove:

- Five heterogeneous sources can be mapped into one canonical dataset.
- Two independently verifiable representations can be generated from that dataset.
- A downstream stage can consume either representation or both through explicit ports.
- Parallel branches and fan-in joins preserve correct dependencies and lineage.
- A tagging stage can emit structured, validated classifications with evidence.
- A downstream model can process previous-stage outputs using a different model configuration.
- A failing validation gate blocks publication and preserves rejected records.
- A deduplication operation preserves provenance and canonical identity.
- A cross-reference operation produces evidence-backed semantic relationships.
- A workflow can be modified and republished without changing historical runs.
- Failed workers can recover work without unauthorized duplicate output commits.
- Incremental execution processes only the intended changes.
- Streaming execution enforces declared delivery, ordering, and checkpoint semantics.
- Model, prompt, rule, adapter, and dataset versions are traceable for each execution.
- Unauthorized connections and cross-tenant references are rejected.
- Every task attempt has observable execution status, resource usage, and audit events.
- Large datasets can be handled without loading entire datasets into orchestrator memory.
- Retry storms, resource exhaustion, invalid inputs, poisoned model output, and malformed artifacts are handled according to explicit policies.

**Do not replace missing capabilities with stubs while claiming implementation completion. Report unsupported functionality explicitly and test against the completion criteria.**

## 6. A concrete workflow definition

Here's what the tagging portion of your example could look like as a declarative configuration.

```
workflow:
  key: intelligence-enrichment
  version: 1

stages:
  - key: tagging
    name: Initial Semantic Tagging

    steps:
      - key: infer-tags
        type: infer
        version: 1

        inputs:
          records:
            from: normalize.canonical_records

        processing:
          granularity: record
          batch_size: 128
          concurrency: 16
          partition_by: record_id

        inference:
          profile: semantic-tagger-v2
          model: qwen-3b-local
          prompt: tagging-prompt-v4

          parameters:
            temperature: 0.1
            max_output_tokens: 512

          output_contract: tag-result-v1

        outputs:
          tagged_records:
            dataset: tagged-records

          rejected_records:
            dataset: tagging-rejections

      - key: validate-tags
        type: validate

        inputs:
          records:
            from: infer-tags.tagged_records

        configuration:
          policy: tag-validation-v2
          failure_action: quarantine

        outputs:
          valid:
            dataset: validated-tags

          invalid:
            dataset: invalid-tags
```

Your graph compiler would resolve references, verify every input/output contract, pin the model and prompt versions, check permissions, and produce an executable plan.

A user shouldn't have to understand any of that. They should be able to tell an agent:

> I've got five messy sources. Normalize everything, tag records using this taxonomy, classify them with a more capable model, identify duplicates, cross-reference related entities, and send a daily summary of suspicious patterns.

The agent constructs this graph. The backend validates it. The user previews it. Then the execution engine runs it.

## 7. Where I'd be especially strict

Three design decisions will determine whether this remains manageable at scale.

First, make ports and data contracts first-class entities. Without them, the system becomes a collection of arbitrary JSON configurations, and correctness becomes dependent on what individual adapters happen to return.

Second, make runtime execution separate from workflow definitions. With ten million records, one inference step might fan out into tens of thousands of tasks. Your metadata schema cannot assume that a step executes exactly once.

Third, make artifacts immutable and lineage-preserving. If your deduplication stage collapses ten records into one, you still need to know which ten original records contributed to that result. Similarly, if an LLM generates a conclusion, you need to know the source records, prompt, model revision, validation outcome, and evidence supporting that conclusion.

## 8. The three registries

Build the system around three registries from the beginning:

- Processing registry: What operations can be executed?
- Resource registry: What data sources, destinations, models, and compute backends are available?
- Contract registry: What structures, semantics, and validation rules must data satisfy?

That gives you a backend where new functionality is introduced by registering capabilities rather than altering the central workflow schema.

It also means the same inference step can operate against local Qwen, a remote model provider, or a specialized fine-tuned deployment without the workflow engine needing to know their internal implementations.

The implementation order I'd recommend is the relational domain model and registries first, then the graph compiler, then the data/artifact contracts, and finally the distributed execution and inference adapters.

The fundamental design goal: Adding an entirely new kind of processing operation should not require a database migration, a new workflow entity type, or changes to the orchestration engine. Only a registered capability, its contracts, its configuration schema, and its execution adapter.

That's the difference between building a collection of configurable pipelines and building a platform that can construct pipelines.

And to preserve the correction you were making: Ollama Modelfile-based persistent system instructions belong in the model build and deployment model as a first-class feature, rather than being treated as a fine-tuning requirement.