# Instance versions, observability, and isolation

Status: isolated-worktree implementation; not deployed to the active production run.

## Stage a version

`node pipeline/instance.ts stage /absolute/config.json /absolute/new-instance`

The destination must not exist. This captures pipeline code, repository configuration/defaults, resolved JSON settings, profile definitions, and hashes for the referenced Node, Python runtime, base model, role package, and extractor. It reads artifact bytes for hashing; it does not discover or enrich corpus contents. Source changes during capture fail staging. Each instance gets its own work directory. Editing the source repository or original JSON does not alter its snapshot. `node pipeline/instance.ts verify /absolute/instance` checks the captured application/configuration seal.

Activation is deliberately unavailable until the dedicated VM execution path passes acceptance. Staging is not deployment. External runtime/model bindings are currently sealed references, not private copies. Snapshot verification does not recheck those external references. Read-only mode and hash checks protect against accidental edits; the host owner can change permissions and seals. They are not a hostile-host security boundary. Package-lock/runtime bundling, VM-private artifact imports, activation, upgrades, and instance lifecycle controls remain incomplete.

## Local usage

New runs launched through the modified CLI record numeric per-call usage in `work/state/usage.sqlite` (SQLite WAL, FULL durability). Every inference attempt is recorded before dispatch. Successful returned proof contributes prompt and generated tokens across all internal phases. Failures without complete token proof retain NULL counts. Abrupt termination leaves a running row, shown as interrupted-or-active. Retry attempts remain separate. No prompt, source content, model output, or error text is copied to this ledger.

The authenticated console status endpoint includes `usage.history` and `usage.forecast`. History is grouped by model/configuration/stage. Forecasts use historical successful calls matching a job configuration and role, multiplied by materialized pending/running jobs. Missing samples return null, not zero. Archived graph generations are excluded. Unmaterialized graph cardinality, future retry overhead, fixed-state initialization, and unknown failed/interrupted tokens are excluded. These estimates are not exact tokenizer counts, confidence intervals, immutable forecast snapshots, or monetary prices. First-run estimates without history remain unavailable. Call durations include queue wait and must not be summed as wall time. Returned calls do not mean validated completed files.

The existing active run predates this instrumentation. Its console must report usage unavailable rather than inventing historical measurements. No production restart was performed to activate the feature.

## Dedicated VM acceptance boundary

VM execution must use a separate guest kernel, no live repository mounts, no inherited host credentials, no Docker socket, no external network, bounded CPU/memory, explicitly imported immutable artifacts, and controlled output export. A host administrator/hypervisor remains trusted. Do not describe containers with a shared kernel as equivalent isolation. Linux KVM provides a VM option where supported. Host-side privileged operators can still affect a guest; CPU, GPU, memory and disk are finite shared physical resources.

The existing MLX/Metal worker is macOS-specific. It must not be silently moved to a host bridge or replaced with a CPU/hosted engine. Any Linux guest inference implementation requires separate compatibility, quality and throughput acceptance.

On 2026-10-13 the installed `sbx` v0.45.0 could not start an empty no-mount 512 MiB/one-CPU sandbox. The daemon reported `hv_vm_create failed with HV_DENIED`, but its suggestion to check signing was not the cause established by investigation. Signature checks inside Codex's restricted tool environment falsely reported invalid signatures. Repeating outside that environment verified both the helper and full app successfully; Gatekeeper accepted the app as Notarized Developer ID, and the helper has the hypervisor entitlement. The actual host setting was `kern.hv_disable=1`. Setting it to zero requires administrator authentication, unavailable to the agent. No installation replacement or re-signing was performed. The initial local sandbox network policy was set to deny-all and a standard shell template was cached. No VM or production migration succeeded. Do not infer binary corruption from sandbox-restricted verification results.


### Hypervisor enablement follow-up

The operator enabled `kern.hv_disable=0`. The same cached image then created `pipeline-isolation-check` successfully: Linux guest kernel 7.0.12, one CPU, 512 MiB, no host workspace mounts, shared skills disabled, and a per-sandbox deny-all network rule. Guest probes could not see the known host corpus or repository. A TCP connect reached the transparent interception endpoint, but TLS negotiation was terminated with SSLEOFError; TCP connect alone is not a valid egress-acceptance test. The default shell-docker image exposed a guest Docker socket and an SSH-agent socket. This does not establish that the Docker socket was the host Docker socket; Docker's documented -docker templates include a guest Docker daemon. SSH forwarding and credential capabilities require explicit removal or isolation before acceptance. The test VM was stopped and retained; no production inputs were imported. No VM inference backend or throughput has been verified.


### Verified inner guest boundary

`pipeline/guest.ts` generates a non-privileged VM kit from JSON `{image, cpus, memoryBytes}`. The image must be an immutable digest of Docker's minimal shell image, CPU/memory are bounded, unknown resource fields are rejected, and the kit declares no credentials. Its generated JSON descriptor passes the installed `sbx kit validate` parser. Provisioning is not wired into production activation yet.

`guard()` builds the Linux Bubblewrap command: private network/PID/user namespaces, dropped capabilities, cleared environment, no `/run` broker sockets, read-only OS files, and only explicitly declared imported guest mounts. `/input`, `/pipeline`, and `/models` are read-only; `/work` is writable. It does not mount host paths. Sources are restricted to `/home/agent/instances/`. Trusted import code still needs to validate canonical paths and immutable artifact seals before binding them; this argument builder alone is not an artifact importer.

Manual synthetic acceptance: `node pipeline/tests/guest.acceptance.ts pipeline-minimal-check`. This uses an existing disposable VM, creates only new synthetic fixtures, verifies input protection, work writes, network denial and hidden credential/Docker sockets, then stops the VM. It does not launch models or access production data. Actual guest testing passed these controls after hypervisor enablement. The simple default shell image without this guard remains unsuitable because its broker SSH socket can expose host identities.
