import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, space, settings } from "../macos.ts";
const config = {
  name: "pipeline-check",
  runner: "/runtime/tart.app/Contents/MacOS/tart",
  home: "/instances/vms",
  image: "ghcr.io/cirruslabs/macos-tahoe-base@sha256:" + "a".repeat(64),
  diskBytes: 50_000_000_000,
  memoryBytes: 24 * 1024 ** 3,
  cpus: 4,
};
test("macOS guest settings require pinned images and bounded memory", () => {
  assert.equal(settings(config).name, config.name);
  for (const changed of [
    { image: "ghcr.io/cirruslabs/macos-tahoe-base:latest" },
    { memoryBytes: 33_000_000_000 },
    { cpus: 0 },
    { name: "../escape" },
    { runner: "tart" },
    { home: "/" },
  ])
    assert.throws(() => settings({ ...config, ...changed }));
});
test("macOS guest preflight preserves reserve and never assumes sparse capacity", () => {
  assert.throws(() => space(config, 36 * 1024 ** 3), /storage/);
  assert.doesNotThrow(() => space(config, 70 * 1024 ** 3));
});
test("guest boot forbids host network, clipboard, USB, audio and implicit mounts", () => {
  const args = boot(config);
  for (const flag of ["--no-clipboard", "--no-audio", "--no-usb-accessories", "--no-graphics"])
    assert.ok(args.includes(flag));
  assert.ok(!args.some((a) => a.startsWith("--dir") || a.startsWith("--net")));
  assert.equal(args.at(-1), config.name);
});
test("VM packet endpoint is an actual private socket with no response or forwarding", async () => {
  const { execFileSync } = await import("node:child_process");
  const { join } = await import("node:path");
  const result = execFileSync(
    "/usr/bin/python3",
    [
      "-I",
      join(import.meta.dirname, "../vmnet.py"),
      "/usr/bin/python3",
      "-I",
      "-c",
      `import socket,sys
fd=int(next(a for a in sys.argv if a.startswith('--net-fd=')).split('=')[1])
s=socket.socket(fileno=fd)
assert s.family==socket.AF_UNIX and s.type==socket.SOCK_DGRAM
s.settimeout(.1);s.send(b'synthetic Ethernet frame')
try:s.recv(1024);raise AssertionError('unexpected forwarded reply')
except socket.timeout:pass
print('isolated')`,
      "synthetic-vm",
    ],
    { encoding: "utf8", timeout: 3000 },
  );
  assert.equal(result.trim(), "isolated");
});
