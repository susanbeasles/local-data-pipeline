import { test } from "node:test";
import assert from "node:assert/strict";
import { bounds, type Model } from "../mlx.ts";
test("bounded continuous batching supports one shared model with 64 decode slots and smaller prefill", () => {
  const model: Model = {
    workers: 1,
    batchSize: 64,
    prefillSize: 4,
    memoryBytes: 31_000_000_000,
    budgetBytes: 32_000_000_000,
    runtime: "unused",
    base: "unused",
    adapters: { summarize: "unused" },
    timeoutMs: 180000,
    maxTokens: 256,
  };
  assert.equal(bounds(model).capacity, 64);
  assert.throws(() => bounds({ ...model, prefillSize: 65 }), /prefill/);
  assert.throws(() => bounds({ ...model, batchSize: 65 }), /batch/);
  assert.throws(() => bounds({ ...model, prefillSize: 0 }), /prefill/);
});
