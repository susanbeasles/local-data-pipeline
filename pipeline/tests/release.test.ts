import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Release } from "../release.ts";
test("release pins code and configuration independently of repository edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "release-"));
  try {
    const source = join(root, "source"),
      target = join(root, "instance");
    await mkdir(join(source, "pipeline"), { recursive: true });
    await mkdir(join(source, "config"));
    await writeFile(join(source, "pipeline/code.ts"), "original");
    await writeFile(join(source, "package.json"), '{"type":"module"}');
    await writeFile(join(source, "package-lock.json"), '{"lockfileVersion":3}');
    await writeFile(join(source, "config/residency.json"), "{}");
    const config = { concurrency: 64 };
    const release = await Release.create(source, target, config);
    config.concurrency = 1;
    await writeFile(join(source, "pipeline/code.ts"), "edited");
    await release.verify();
    assert.equal(await readFile(join(target, "payload/pipeline/code.ts"), "utf8"), "original");
    assert.equal(
      JSON.parse(await readFile(join(target, "payload/instance.json"), "utf8")).concurrency,
      64,
    );
    await assert.rejects(Release.create(source, target, config));
    await chmod(join(target, "payload/pipeline/code.ts"), 0o600);
    await writeFile(join(target, "payload/pipeline/code.ts"), "tampered");
    await assert.rejects(release.verify(), /integrity/);
  } finally {
    // Owner can chmod these fixtures; readonly is not a host-user security boundary.
    const { execFileSync } = await import("node:child_process");
    execFileSync("/bin/chmod", ["-R", "u+w", root]);
    await rm(root, { recursive: true, force: true });
  }
});
