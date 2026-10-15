import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeploymentBundle } from "../deployment.ts";
import { configuration, type Receipt } from "../provision.ts";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "deployment-"));
  const source = join(root, "source"),
    releases = join(root, "releases"),
    spec = join(root, "targets.json");
  await mkdir(join(source, "pipeline"), { recursive: true });
  await mkdir(join(source, "native"));
  for (const [file, value] of [
    ["pipeline/guest-postgres.ts", "export {};"],
    ["pipeline/run.ts", "export {};"],
    ["native/Studio.swift", "import Foundation"],
    ["package.json", "{}"],
    ["package-lock.json", "{}"],
    ["pipeline/private.json", "SECRET"],
  ])
    await writeFile(join(source, file), value);
  await writeFile(
    spec,
    JSON.stringify({
      format: "pipeline-local/1",
      repository: "susanbeasles/infra",
      activation: { requiresInfraReceipt: true, requiresQualification: true },
    }),
  );
  return {
    root,
    source,
    releases,
    spec,
    create: () => DeploymentBundle.create(source, releases, "a".repeat(40), spec),
  };
}
test("deterministic source map excludes data and binds qualification to receipt and deployment", async () => {
  const f = await fixture();
  try {
    const first = await f.create(),
      second = await f.create();
    assert.equal(first.root, second.root);
    const result = await first.verify();
    assert.deepEqual(
      result.manifest.bundles.map((b) => b.resource),
      ["pipeline.executor", "pipeline.control", "pipeline.metadata"],
    );
    for (const b of result.manifest.bundles)
      assert.doesNotMatch(await readFile(join(first.root, b.file), "utf8"), /SECRET|private.json/);
    const receipt: Receipt = {
      format: "pipeline-infra-receipt/1",
      spec: result.manifest.infrastructure.spec,
      request: "test",
      qualification: { vm: false, inference: false },
      resources: [
        "pipeline.storage",
        "pipeline.executor",
        "pipeline.control",
        "pipeline.metadata",
      ].map((id) => ({
        id,
        identity: id,
        configuration: "a".repeat(64),
        kind: id,
        qualified: false,
        observedAt: "",
        evidence: {},
      })),
    };
    const qualification = {
      format: "pipeline-qualification/1" as const,
      deployment: result.hash,
      receipt: configuration(receipt),
      vm: true,
      backend: true,
      controlBuild: true,
    };
    assert.equal((await first.activate(receipt, qualification)).qualified, true);
    await assert.rejects(
      first.activate(receipt, { ...qualification, backend: false }),
      /qualification/,
    );
    await assert.rejects(
      first.activate({ ...receipt, request: "other" }, qualification),
      /qualification/,
    );
    await assert.rejects(
      first.activate({ ...receipt, spec: "b".repeat(64) }, qualification),
      /receipt/,
    );
    await assert.rejects(
      first.activate(receipt, { ...qualification, deployment: "c".repeat(64) }),
      /qualification/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("corrupt or partial existing destinations fail without replacement", async () => {
  const f = await fixture();
  try {
    const first = await f.create(),
      { manifest } = await first.verify();
    const file = join(first.root, manifest.bundles[0].file);
    await chmod(file, 0o600);
    await writeFile(file, "{}");
    await assert.rejects(first.verify(), /integrity/);
    await assert.rejects(f.create(), /integrity/);
    assert.equal(await readFile(file, "utf8"), "{}");
    await rm(first.root, { recursive: true });
    await mkdir(first.root);
    await writeFile(join(first.root, "partial"), "partial");
    await assert.rejects(f.create());
    assert.equal(await readFile(join(first.root, "partial"), "utf8"), "partial");
    await rm(join(first.root, "partial"));
    await assert.rejects(f.create());
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
