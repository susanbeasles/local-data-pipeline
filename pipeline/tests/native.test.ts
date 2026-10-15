import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const exec = promisify(execFile);
test("native usage distinguishes missing history, partial forecasts and recorded totals", {skip: process.platform !== "darwin"}, async () => {
  const root = await mkdtemp(join(tmpdir(), "native-usage-"));
  try {
    const binary = join(root, "usage");
    const source = resolve(import.meta.dirname, "../..");
    await exec("/usr/bin/swiftc", [join(source,"native/UsageData.swift"), join(source,"native/tests/UsageTest.swift"), "-o", binary], {timeout: 60000, maxBuffer: 1024*1024});
    const result = await exec(binary, [], {timeout:10000});
    assert.match(result.stdout, /Usage presentation checks passed/);
  } finally { await rm(root, {recursive:true, force:true}); }
});
