import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { sandbox } from "../legacy/sandbox.ts";
test("installed MLX generator advances batched rows and admits new sequences during decode", async () => {
  const box = await sandbox(
    "/Users/avespoli/SonarMD-Dump-2026-10-09/enrichment/runtime",
    "/Users/avespoli/SonarMD-Dump-2026-10-09/enrichment/models/qwen2.5-3b-official",
    join(import.meta.dirname, "engine.py"),
    join(import.meta.dirname, "../../models/anchors-experiment"),
  );
  try {
    const child = box.launch([join(import.meta.dirname, "engine.py")]);
    let out = "",
      err = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    const code = await new Promise<number | null>((ok, no) => {
      child.once("error", no);
      child.once("exit", ok);
    });
    assert.equal(code, 0, err);
    const result = JSON.parse(out);
    assert.ok(result.maxRows > 1);
    assert.ok(result.refills > 0);
    assert.equal(result.finished, 4);
  } finally {
    await box.close();
  }
});
