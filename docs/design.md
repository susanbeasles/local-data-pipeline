# Engineering contract
The user's conversation is the sole project authority. Preserve the existing tree; write only to this sibling project or synthetic temporary directories. Inventory streams metadata and hashes without returning corpus content. Ambiguous provenance remains protected unknown. A proposal is never executed.

Domain boundaries: Source owns byte provenance and normalization; Chunk owns complete contiguous coverage; Job owns a role/model/configuration attempt; Store owns atomic SQLite checkpoints; Worker owns persistent local inference; Run owns scheduling, backpressure and reconciliation.

Inputs are explicit canonical read-only paths. Staging, state, model adaptations, diagnostics and output live under a disjoint work directory. OS sandbox denies network and input writes for the entire runtime and descendants; an actual denied socket attempt establishes fail-closed startup. Model adaptation uses learned LoRA deltas, not system KV cache or graph compilation. Holdout behavioral evaluation is a separate gate from nonzero trained weights. Synthetic inference proves mechanics only, never model semantics or production throughput.

Acceptance: unchanged input inventory; deterministic hashes/chunk coverage; validated output provenance; restart after SIGKILL; retry and concurrent runner exclusion; malformed/corrupt artifact rejection; actual sandbox probes; sustained benchmark distinguishes simulator from MLX; role adaptation must pass held-out behavioral tests without role instructions in inference inputs. Do not claim complete until all required gates pass.
