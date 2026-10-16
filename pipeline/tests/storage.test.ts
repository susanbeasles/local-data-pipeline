import { Intake } from "../intake.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  lstat,
  symlink,
  writeFile,
  readFile,
  chmod,
  realpath,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { layout, Storage, validateMode } from "../storage.ts";
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "pipeline-storage-"));
  const project = join(root, "project");
  await mkdir(project);
  await mkdir(join(project, ".git"));
  return { root, project };
}
test("macOS installation modes use conventional external paths without .local or project defaults", () => {
  const standard = layout("standard", "/private/storage-fixture"),
    hardened = layout("hardened", "/private/storage-fixture");
  assert.equal(
    standard.data,
    "/private/storage-fixture/Library/Application Support/LocalDataPipeline",
  );
  assert.equal(standard.cache, "/private/storage-fixture/Library/Caches/LocalDataPipeline");
  assert.equal(standard.logs, "/private/storage-fixture/Library/Logs/LocalDataPipeline");
  assert.equal(hardened.data, "/Library/Application Support/LocalDataPipeline");
  assert.equal(hardened.account, "_pipeline");
  assert.equal(standard.account, null);
  assert.throws(() => validateMode("secure-ish"), /mode/);
});
test("standard installation creates private external directories and persists its mode without following symlinks", async () => {
  const f = await fixture(),
    paths = layout("standard", join(f.root, "home"));
  const storage = new Storage(paths, f.project);
  await storage.create(process.getuid!());
  await storage.verify(process.getuid!());
  for (const path of [paths.data, paths.cache, paths.logs])
    assert.equal((await lstat(path)).mode & 0o777, 0o700);
  const saved = JSON.parse(await readFile(join(paths.data, "installation.json"), "utf8"));
  assert.equal(saved.mode, "standard");
  assert.equal(saved.format, "pipeline-installation/1");
  await assert.rejects(storage.create(process.getuid!()), /exists/);
  const malicious = layout("standard", join(f.root, "other"));
  await mkdir(join(f.root, "other/Library"), { recursive: true });
  await symlink(paths.data, join(f.root, "other/Library/Application Support"));
  await assert.rejects(new Storage(malicious, f.project).create(process.getuid!()), /alias/);
});
test("runtime data cannot overlap the checkout or use group/world readable roots", async () => {
  const f = await fixture();
  const bad = { ...layout("standard", join(f.root, "home")), data: join(f.project, "state") };
  await assert.rejects(new Storage(bad, f.project).create(process.getuid!()), /project|checkout/);
  const paths = layout("standard", join(f.root, "home"));
  const storage = new Storage(paths, f.project);
  await storage.create(process.getuid!());
  await chmod(paths.data, 0o750);
  await assert.rejects(storage.verify(process.getuid!()), /permission/);
});
test("data creation rejects a mismatched installation identity before writing anything", async () => {
  const f = await fixture(),
    paths = layout("hardened", join(f.root, "home"));
  const storage = new Storage(paths, f.project);
  await assert.rejects(storage.create(process.getuid!()), /administrator|root/);
});

test("production entrypoints reject project-local runtime destinations before creating state", async () => {
  const { outsideProject } = await import("../storage.ts");
  await assert.rejects(
    outsideProject(join(import.meta.dirname, "../..", "state", "forbidden-new-data")),
    /project|checkout/,
  );
  await assert.rejects(
    Intake.open(join(import.meta.dirname, "../..", "state", "forbidden-new-intake")),
    /project|checkout/,
  );
});
