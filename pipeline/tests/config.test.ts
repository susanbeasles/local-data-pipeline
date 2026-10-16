import { test } from "node:test";
import assert from "node:assert/strict";
import { configure } from "../config.ts";
const config = {
  input: "/input",
  work: "/work",
  chunkSize: 6000,
  concurrency: 4,
  attempts: 2,
  maxBytes: 1024,
  roles: ["summarize"],
  model: "fixture",
  engine: "mlx" as const,
  mlx: {
    runtime: "/runtime",
    base: "/base",
    adapters: { summarize: "/adapter" },
    maxTokens: 1400,
    timeoutMs: 120000,
  },
};
const selected = {
  workers: 2,
  batchSize: 16,
  memoryBytes: 15_500_000_000,
  budgetBytes: 32_000_000_000,
  concurrency: 32,
};
test("production defaults use measured residency while preserving analysis configuration", () => {
  const result = configure(config, selected);
  assert.equal(result.mlx.workers, 2);
  assert.equal(result.mlx.batchSize, 16);
  assert.equal(result.concurrency, 4);
  assert.equal(result.mlx.maxTokens, 1400);
  assert.equal(result.mlx.base, config.mlx.base);
  assert.equal(config.concurrency, 4);
});
test("explicit four-worker settings override the measured default", () => {
  const result = configure(
    {
      ...config,
      concurrency: 64,
      mlx: {
        ...config.mlx,
        workers: 4,
        batchSize: 16,
        memoryBytes: 7_750_000_000,
      },
    },
    selected,
  );
  assert.equal(result.mlx.workers, 4);
  assert.equal(result.concurrency, 64);
});
test("64-slot default preserves four-sequence prompt admission", () => {
  const result = configure(config, {
    workers: 1,
    batchSize: 64,
    prefillSize: 4,
    memoryBytes: 31_000_000_000,
    budgetBytes: 32_000_000_000,
    concurrency: 64,
  });
  assert.equal(result.mlx.workers, 1);
  assert.equal(result.mlx.batchSize, 64);
  assert.equal(result.mlx.prefillSize, 4);
  assert.equal(result.concurrency, 4);
});
test("explicit batching and resource settings survive default application", () => {
  const result = configure(
    {
      ...config,
      concurrency: 2,
      mlx: { ...config.mlx, batchSize: 2, memoryBytes: 4_000_000_000 },
    },
    {
      workers: 1,
      batchSize: 64,
      prefillSize: 4,
      memoryBytes: 31_000_000_000,
      budgetBytes: 32_000_000_000,
      concurrency: 64,
    },
  );
  assert.equal(result.mlx.batchSize, 2);
  assert.equal(result.mlx.memoryBytes, 4_000_000_000);
  assert.equal(result.concurrency, 2);
});
