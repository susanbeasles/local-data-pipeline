import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pack, inspect } from "../package.ts";
test("role artifacts package instructions and seal unchanged local base weights", async () => {
  const root = await mkdtemp(join(tmpdir(), "roles-")),
    base = join(root, "base"),
    out = join(root, "roles");
  await mkdir(base);
  await writeFile(join(base, "config.json"), "{}");
  await writeFile(join(base, "weights.safetensors"), "synthetic model bytes");
  await pack(base, out);
  const before = await readFile(join(base, "weights.safetensors"), "utf8");
  const pkg = await inspect(out, base);
  assert.equal(pkg.roles.length, 6);
  const role = JSON.parse(await readFile(join(out, "tag/model.json"), "utf8"));
  assert.ok(role.system.includes("technical tags"));
  assert.equal(role.weightChanges, false);
  assert.equal(role.adapter, null);
  role.system = "tampered";
  await writeFile(join(out, "tag/model.json"), JSON.stringify(role));
  await assert.rejects(inspect(out, base), /role artifact/);
  assert.equal(
    await readFile(join(base, "weights.safetensors"), "utf8"),
    before,
  );
});

test("packaging rejects destination aliases inside preserved base artifacts", async () => {
  const { symlink } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "roles-alias-")),
    base = join(root, "base");
  await mkdir(base);
  await writeFile(join(base, "weights"), "preserved");
  await symlink(base, join(root, "alias"));
  await assert.rejects(pack(base, join(root, "alias", "nested")), /separate/);
  await assert.rejects(readFile(join(base, "nested", "manifest.json")));
});
