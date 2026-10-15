# macOS guest integration status

The target is a **macOS guest** on Apple's Virtualization framework. Linux guest compatibility is not required for this backend. Tart supports paravirtualized Metal; actual MLX kernel compatibility and performance must still be tested inside the guest. Do not infer MLX compatibility from a display device alone.

The project-local runner inspected here is Tart 2.41.0. Its official release archive matched the published checksum, `codesign --verify --deep --strict` passed and Gatekeeper reported `Notarized Developer ID`. No global installation was changed. Runtime downloads stay under ignored `state/tools/`.

`pipeline/macos.ts` implements pinned-image creation, resource configuration, start/stop, inspect and guest command execution. The JSON example resolves runner/home relative to its config file. All VM storage belongs to the selected project-local home. Automatic pruning and overwrite are disabled. Creation refuses to proceed unless the declared uncompressed disk plus 10 GiB reserve fits. The pinned image manifest advertises a 50,000,000,000-byte disk and about 27 GB compressed download. This preflight is conservative; it deliberately does not assume that sparse storage will stay small.

Boot disables clipboard, audio and USB sharing. No host directory is implicitly mounted. Its only Ethernet device attaches to a private Unix datagram socket whose peer discards every frame, including IPv6. `vmnet.py` creates no NAT, bridge or external socket. Tart guest execution uses the local control socket/guest agent, independent of guest IP networking. The Linux Docker Sandbox VMs are unrelated to this macOS backend.

```sh
node pipeline/macos.ts create config/macos.example.json
node pipeline/macos.ts start config/macos.example.json
# From another terminal:
node pipeline/macos.ts exec config/macos.example.json /usr/bin/sw_vers
node pipeline/macos.ts stop config/macos.example.json
```

These commands provision and control a VM; **they do not launch production enrichment**. The provisioning download contacts the public image registry with no project data. Runtime VM traffic has no forwarding path. The image must contain the guest agent (the pinned base image does); no SSH server or host credential is required by the controller.

Verified: resource validation, pinned-image requirements, storage failure before download, boot argument policy, actual Unix-datagram packet discard, TypeScript checks, and the downloaded runner's signature. Tests do not claim to have booted macOS.

Remaining: sufficient local disk space, actual macOS guest boot, MLX/Metal execution probe, private guest runtime/assets staging, full six-stage guest acceptance and measured guest performance, then native-instance activation wiring. No production restart is justified by the launcher tests alone. Existing macOS-host pipeline tests and releases remain independently usable; no weaker isolation is substituted automatically.
