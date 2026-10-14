import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { curate } from "../curate.ts";
test("curation maintains exclusive partitions, protects shared inputs and verifies restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "curate-")),
    source = join(root, "source"),
    work = join(root, "work");
  for (const p of ["SonarMD", "Anthony", "raw"])
    await mkdir(join(source, p), { recursive: true });
  for (const p of ["company", "personal", "shared"])
    await writeFile(join(source, "raw", p), "Alpha");
  const row = (name: string) => ({
    archivePath: "raw/" + name,
    bytes: 5,
    bucket: "canonical",
    kind: "source",
    unstable: false,
  });
  await writeFile(
    join(source, "SonarMD/manifest.jsonl"),
    [row("company"), row("shared")].map((r) => JSON.stringify(r)).join("\n"),
  );
  await writeFile(
    join(source, "Anthony/manifest.jsonl"),
    [row("personal"), row("shared")].map((r) => JSON.stringify(r)).join("\n"),
  );
  await curate(source, work);
  assert.equal(
    await readFile(join(work, "input/SonarMD/raw/company"), "utf8"),
    "Alpha",
  );
  assert.equal(
    await readFile(join(work, "input/avespoli/raw/personal"), "utf8"),
    "Alpha",
  );
  await assert.rejects(access(join(work, "input/SonarMD/raw/shared")));
  await curate(source, work);
  assert.equal(await readFile(join(source, "raw/shared"), "utf8"), "Alpha");
  const extra = join(work, "input/SonarMD/unmanifested");
  await writeFile(extra, "protected unknown");
  const report = await curate(source, work);
  assert.equal(report.integrity, false);
  assert.equal(report.unexpected.length, 1);
  assert.equal(await readFile(extra, "utf8"), "protected unknown");
});
test("curation refuses aliased work and detects corrupt copied files on restart", async () => {
  const { symlink, chmod } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "curate-alias-")),
    source = join(root, "source"),
    work = join(root, "work");
  for (const p of ["SonarMD", "Anthony", "raw"])
    await mkdir(join(source, p), { recursive: true });
  await writeFile(join(source, "raw/x"), "Alpha");
  await writeFile(
    join(source, "SonarMD/manifest.jsonl"),
    JSON.stringify({
      archivePath: "raw/x",
      bytes: 5,
      bucket: "canonical",
      kind: "source",
    }),
  );
  await writeFile(join(source, "Anthony/manifest.jsonl"), "");
  const alias = join(root, "alias");
  await symlink(source, alias);
  await assert.rejects(curate(source, alias), /overlap/);
  await curate(source, work);
  const dest = join(work, "input/SonarMD/raw/x");
  await chmod(dest, 0o600);
  await writeFile(dest, "WRONG");
  const report = await curate(source, work);
  assert.equal(report.integrity, false);
  assert.equal(await readFile(join(source, "raw/x"), "utf8"), "Alpha");
});
