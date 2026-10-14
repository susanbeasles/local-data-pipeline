import { assets } from "../local.ts";
import { realpath } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { sandbox } from "../legacy/sandbox.ts";
test("installed constrained decoder permits a complete grounded summary and EOS", async () => {
  const base =
      assets().base,
    pkg = await realpath(
      assets().package,
    ),
    script = join(import.meta.dirname, "grammar.py");
  const box = await sandbox(
    assets().runtime,
    base,
    script,
    pkg,
    [join(import.meta.dirname, "../decoder.py")],
  );
  try {
    const child = box.launch([script, base, pkg]);
    let out = "",
      err = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    const code = await new Promise<number | null>((ok, no) => {
      child.on("error", no);
      child.on("exit", ok);
    });
    assert.equal(code, 0, err);
    assert.equal(JSON.parse(out).validJsonReplay, true);
  } finally {
    await box.close();
  }
});
