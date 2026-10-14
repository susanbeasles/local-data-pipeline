import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assets } from "../local.ts";
test("asset bindings resolve relative to explicit configuration and allow local overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-config-"));
  try {
    await mkdir(join(root, "config"));
    const path = join(root, "config/run.json");
    await writeFile(
      path,
      JSON.stringify({
        mlx: { runtime: "../runtime", base: "../models/base", package: "../models/roles" },
      }),
    );
    const selected = assets({ PIPELINE_CONFIG: path });
    assert.equal(selected.runtime, join(root, "runtime"));
    assert.equal(selected.base, join(root, "models/base"));
    assert.equal(
      assets({ PIPELINE_CONFIG: path, PIPELINE_BASE: join(root, "other") }).base,
      join(root, "other"),
    );
    assert.equal(assets({}).runtime, resolve(import.meta.dirname, "../../.venv"));
    await assert.rejects(async () => assets({ PIPELINE_RUNTIME: "" }), /invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsupported interpreter layouts cannot grant recursive access to broad prefixes",async()=>{
 const {framework}=await import('../legacy/sandbox.ts');
 assert.throws(()=>framework('/usr/local/bin/python3'),/unsupported/);
 assert.throws(()=>framework(join(tmpdir(),'home','bin','python3')),/unsupported/);
 assert.equal(framework('/Library/Frameworks/Python.framework/Versions/3.12/bin/python3'),'/Library/Frameworks/Python.framework');
});
