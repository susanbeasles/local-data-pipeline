import { test } from "node:test";
import assert from "node:assert/strict";
import { guard, kit } from "../guest.ts";
test("guest boundary separates network and PID namespaces and exposes only explicit mounts", () => {
  const args = guard(
    ["/usr/bin/node", "/pipeline/cli.ts"],
    [
      { source: "/home/agent/instances/test/release", target: "/pipeline", write: false },
      { source: "/home/agent/instances/test/work", target: "/work", write: true },
    ],
  );
  assert.ok(args.includes("--unshare-all"));
  assert.ok(args.includes("--clearenv"));
  assert.deepEqual(args.slice(-2), ["/usr/bin/node", "/pipeline/cli.ts"]);
  assert.ok(args.includes("--cap-drop"));
  assert.throws(() => guard(["/bin/true"], [{ source: "/run", target: "/work", write: true }]));
  assert.throws(() =>
    guard(
      ["/bin/true"],
      [{ source: "/home/agent/instances/test/work", target: "/run" as never, write: true }],
    ),
  );
  assert.throws(() =>
    guard(
      ["/bin/true"],
      [{ source: "/home/agent/instances/test/input", target: "/input", write: true }],
    ),
  );
});
test("JSON VM resources cannot request privilege, mutable images, excessive memory or arbitrary fields", () => {
  const spec = {
    image: "docker.io/docker/sandbox-templates:shell@sha256:" + "a".repeat(64),
    cpus: 1,
    memoryBytes: 536870912,
  };
  const value = kit(spec);
  assert.equal(value.security.privileged, false);
  assert.deepEqual(value.credentials, []);
  assert.throws(() => kit({ ...spec, memoryBytes: 64 * 1024 ** 3 }));
  assert.throws(() => kit({ ...spec, image: "latest" }));
  assert.throws(() => kit({ ...spec, privileged: true }));
});

test("guest mounts cannot cross instance roots or alias readonly sources", () => {
  const run = ["/bin/true"];
  assert.throws(
    () =>
      guard(run, [
        { source: "/home/agent/instances/a/release", target: "/pipeline", write: false },
        { source: "/home/agent/instances/b/work", target: "/work", write: true },
      ]),
    /cross instance/,
  );
  assert.throws(
    () =>
      guard(run, [
        { source: "/home/agent/instances/a/release", target: "/pipeline", write: false },
        { source: "/home/agent/instances/a/release", target: "/work", write: true },
      ]),
    /overlaps/,
  );
  assert.throws(
    () =>
      guard(run, [
        { source: "/home/agent/instances/a/tree/input", target: "/input", write: false },
        { source: "/home/agent/instances/a/tree", target: "/work", write: true },
      ]),
    /overlaps/,
  );
});
