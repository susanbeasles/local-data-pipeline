import { test } from "node:test";
import assert from "node:assert/strict";
import { check } from "../metrics.ts";
test("benchmark rejects correct text assigned to the wrong source", () => {
  const expected = new Map([
    ["a", "alpha"],
    ["b", "beta"],
  ]);
  const outputs = [
    {
      source: "a",
      result: {
        summary: "beta",
        facts: [{ claim: "beta", anchorIds: [0] }],
        unknowns: [],
      },
    },
    {
      source: "b",
      result: {
        summary: "alpha",
        facts: [{ claim: "alpha", anchorIds: [0] }],
        unknowns: [],
      },
    },
  ];
  assert.equal(check(expected, outputs), false);
  outputs[0].source = "b";
  outputs[1].source = "a";
  assert.equal(check(expected, outputs), true);
  assert.equal(check(expected, [outputs[0], outputs[0]]), false);
});
test("fatal worker transport errors keep pending calls retryable", async () => {
  const { Worker } = await import("../mlx.ts");
  const { WorkerFailure } = await import("../errors.ts");
  let error: Error | undefined;
  const worker = Object.create(Worker.prototype);
  Object.assign(worker, {
    ended: false,
    pending: new Map([
      [
        "job",
        {
          timer: setTimeout(() => {}, 10000),
          reject: (e: Error) => (error = e),
        },
      ],
    ]),
    child: { kill: () => true },
  });
  worker.fail(Error("malformed worker frame"));
  assert.ok(error instanceof WorkerFailure);
});

test("engine prompt-phase rates use pooled phase time and label single-token forward counts", async () => {
  const { describe } = await import("../metrics.ts");
  const report = describe({
    enginePrefillTokensPerSecond: 999,
    metrics: [
      {
        engine: { promptTokens: 100, promptSeconds: 2 },
        forwards: { "decode:16": 4 },
      },
      {
        engine: { promptTokens: 100, promptSeconds: 2 },
        forwards: { "decode:16": 4 },
      },
    ],
  });
  assert.equal(report.enginePromptPhaseTokensPerSecond, 50);
  assert.equal(report.enginePrefillTokensPerSecond, undefined);
  assert.equal(report.metrics[0].forwards["token:16"], 4);
  assert.match(report.enginePromptPhaseScope, /not pure kernel/);
});
