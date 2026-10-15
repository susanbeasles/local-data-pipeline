# Local resource provider

`pipeline/provision.ts` is the trusted local capability used by the
`susanbeasles/infra` local pipeline primitive. It accepts one bounded
`pipeline-provision-request/1` JSON document on stdin and returns a
`pipeline-infra-receipt/1` JSON receipt on stdout. Operations are `provision` and
`inspect`; neither starts a workload or boots a VM.

Requests contain `{format, operation, spec, request, config}`. `spec` is the exact
infrastructure targets-file SHA-256 and `request` is a fresh operation identity.
Configuration uses `pipeline-provision-config/1`:

- `storage`: canonical absolute `input`, `staging`, `state`, `models`, `output` roots; no two roots may overlap. Input must already exist and is never written.
- `control`: `{root}` under state. Provisioning creates the directory; native app installation remains separate.
- `executor`: `{mac, runner: {path, sha256}}`. `mac` follows `macos.ts`; `mac.runner` must equal the pinned executable. VM home belongs under state. CPU, memory and disk are inspected after configuring. VM memory plus a 4 GiB host reserve must fit the shared 32 GiB budget and actual host memory.
- `metadata`: `{placement: "pipeline.executor", bootstrap: {node, entry, config}}`. Node and entry have absolute guest paths and SHA-256 digests. Entry must match the bundled `guest-postgres.ts`. Its complete config is validated by that capability. A running guest is required, and no host database fallback exists.
- Optional `model` and `runtime`: `{root, sha256}` for preexisting sealed directories outside input. They are inspected without installation or download; runtime aliases into input are rejected.

Storage and control inspection use filesystem identity and protected owned
directories. The provider rejects aliases before creating directories. VM
provisioning verifies the supplied Tart executable digest, uses `Guest.create`
and explicit disk sizing, reobserves Tart's CPU/memory/disk/MAC identity, and
records image provenance under state. Unmarked existing VMs are not adopted or
overwritten. Repeat calls verify the prior identity/configuration and preserve
all resources on failure. No prune/delete command exists.

The infrastructure adapter verifies the entire extracted provider bundle seal,
including imported modules and `vmnet.py`, before and after execution. The
receipt's resource configuration hashes cover canonical sorted JSON for each
resource descriptor. Metadata uses the known guest bootstrap through
`Guest.execute` after checking guest Node and entry digests. Model/runtime
identities are content seals. The provider issues a complete receipt only after
all required resources succeed; absent bindings fail explicitly.

VM resources are not qualified by cloning or inspection. A separately launched
private zero-egress `vmnet.py` supervisor and actual isolation/Metal/runtime probes
are required before workload activation. VM and inference qualification remain
false in this capability's receipts, and asset observations also remain
unqualified. Synthetic tests do not establish real VM or PostgreSQL readiness.

Validation:

```sh
node --test pipeline/tests/provision.test.ts pipeline/tests/guest-postgres.test.ts
```

No VM, database service, image download, provider request or production processing
was launched while implementing this capability.
