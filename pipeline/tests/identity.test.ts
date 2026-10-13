import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint, type Model } from "../mlx.ts";
test("adapter settings, runtime code and generation settings affect model identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "identity-")),
    base = join(root, "base"),
    runtime = join(root, "runtime"),
    adapter = join(root, "adapter");
  for (const dir of [base, runtime, adapter]) await mkdir(dir);
  await writeFile(join(base, "config.json"), "{}");
  await writeFile(join(runtime, "engine.py"), "pass");
  await writeFile(join(adapter, "adapters.safetensors"), "fixture");
  await writeFile(join(adapter, "adapter_config.json"), '{"scale":20}');
  const model: Model = {
    base,
    runtime,
    adapters: { summarize: adapter },
    timeoutMs: 1000,
    maxTokens: 100,
    batchSize: 4,
    memoryBytes: 2 ** 30,
  };
  const initial = await fingerprint(model);
  assert.notEqual(await fingerprint({ ...model, workers: 4 }), initial);
  assert.notEqual(await fingerprint({ ...model, maxTokens: 200 }), initial);
  await writeFile(join(adapter, "adapter_config.json"), '{"scale":40}');
  assert.notEqual(await fingerprint(model), initial);
  const changed = await fingerprint(model);
  await writeFile(join(runtime, "engine.py"), "raise ValueError()");
  assert.notEqual(await fingerprint(model), changed);
});
