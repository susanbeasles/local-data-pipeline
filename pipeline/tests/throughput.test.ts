import { test } from "node:test";
import assert from "node:assert/strict";
import { throughput, type Round } from "../throughput.ts";
const roles = ["tag", "classify", "summarize", "knowledge", "reconcile", "connect"];
const spec = { seconds: 7200, stages: roles };
const rounds = (): Round[] =>
  roles.map((role) => ({
    role,
    input: "a".repeat(64),
    expected: 100,
    completed: 100,
    failed: 0,
    pending: 0,
    running: 0,
    invalid: 0,
    unsupported: 0,
    integrity: true,
    started: 1000,
    finished: 7201000,
  }));
test("all six complete verified rounds may meet the inclusive two-hour budget", () =>
  assert.equal(throughput(spec, rounds(), 7201000).met, true));
test("one fast stage cannot claim the whole pipeline target", () =>
  assert.equal(throughput(spec, rounds().slice(0, 1), 7201000).met, false));
test("unfinished source coverage fails even if scheduled work is fast", () => {
  const r = rounds();
  r[0]!.completed = 99;
  r[0]!.pending = 1;
  assert.equal(throughput(spec, r, 7201000).met, false);
});
test("long wall time is not hidden by resetting execution or counting only inference", () => {
  const r = rounds();
  r[0]!.finished = 7201001;
  assert.equal(throughput(spec, r, 7201001).met, false);
});
test("failed, unsupported or unverified sources cannot count as complete", () => {
  for (const field of ["failed", "unsupported", "running", "invalid"] as const) {
    const r = rounds();
    r[0]![field] = 1;
    assert.equal(throughput(spec, r, 7201000).met, false);
  }
  const r = rounds();
  r[0]!.integrity = false;
  assert.equal(throughput(spec, r, 7201000).met, false);
});
test("dataset changes and duplicate stage evidence fail reconciliation", () => {
  let r = rounds();
  r[1]!.input = "b".repeat(64);
  assert.equal(throughput(spec, r, 7201000).met, false);
  r = rounds();
  r.push(r[0]!);
  assert.equal(throughput(spec, r, 7201000).met, false);
});

test("truthy strings and future timestamps cannot certify a round", () => {
  const r = rounds();
  Reflect.set(r[0]!, "integrity", "true");
  assert.equal(throughput(spec, r, 7201000).met, false);
  const future = rounds();
  future[0]!.started = 7201001;
  future[0]!.finished = 7201002;
  assert.equal(throughput(spec, future, 7201000).met, false);
});
