import { test } from "node:test";
import assert from "node:assert/strict";
import { Dispatch } from "../dispatch.ts";
test("idle workers receive work dynamically and queues remain bounded", async () => {
  const loads = [0, 0, 0, 0],
    peaks = [0, 0, 0, 0],
    counts = [0, 0, 0, 0];
  const dispatch = new Dispatch(
    Array.from({ length: 4 }, (_, i) => async (n: number) => {
      peaks[i] = Math.max(peaks[i], ++loads[i]);
      counts[i]++;
      await new Promise((r) => setTimeout(r, i === 0 ? 25 : 2));
      loads[i]--;
      return n * 2;
    }),
    2,
    8,
  );
  const values = await Promise.all(
    Array.from({ length: 16 }, (_, i) => dispatch.submit(i)),
  );
  assert.deepEqual(
    values,
    Array.from({ length: 16 }, (_, i) => i * 2),
  );
  assert.ok(peaks.every((n) => n <= 2));
  assert.ok(counts.every((n) => n > 0));
  assert.ok(counts[0] < counts[1]);
  assert.equal(dispatch.queued, 0);
});
test("scheduler rejects excess waiting jobs without losing accepted work", async () => {
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  const dispatch = new Dispatch(
    [
      async (n: number) => {
        await wait;
        return n;
      },
    ],
    1,
    1,
  );
  const first = dispatch.submit(1),
    second = dispatch.submit(2);
  await assert.rejects(dispatch.submit(3), /queue capacity/);
  release();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
});

test("aggregate worker capacity and memory reserve are enforced", async () => {
  const { bounds } = await import("../mlx.ts");
  const model = {
    workers: 4,
    budgetBytes: 32_000_000_000,
    memoryBytes: 7_750_000_000,
    batchSize: 16,
    runtime: "unused",
    base: "unused",
    adapters: { summarize: "unused" },
    timeoutMs: 1000,
    maxTokens: 256,
  };
  assert.equal(bounds(model).capacity, 64);
  assert.throws(
    () => bounds({ ...model, memoryBytes: 8 * 1024 ** 3 }),
    /memory budget/,
  );
  assert.throws(() => bounds({ ...model, workers: 3 }), /workers/);
});

test("resident configuration rejects invalid resource and inference limits", async () => {
  const { bounds } = await import("../mlx.ts");
  const model = {
    workers: 4,
    budgetBytes: 32_000_000_000,
    memoryBytes: 7_750_000_000,
    batchSize: 16,
    runtime: "unused",
    base: "unused",
    adapters: { summarize: "unused" },
    timeoutMs: 1000,
    maxTokens: 256,
  };
  for (const [key, value] of [
    ["memoryBytes", NaN],
    ["memoryBytes", -1],
    ["timeoutMs", 0],
    ["maxTokens", 0],
  ] as const)
    assert.throws(() => bounds({ ...model, [key]: value }), /limits/);
});
