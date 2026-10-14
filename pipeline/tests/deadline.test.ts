import { test } from "node:test";
import assert from "node:assert/strict";
import { Deadline } from "../deadline.ts";
test("queue waits pause execution while phase budgets remain cumulative", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  const errors: string[] = [];
  const deadline = new Deadline(
    { queued: 100, admitted: 40 },
    (phase) => errors.push(phase),
    () => now,
  );
  const tick = (ms: number) => {
    now += ms;
    t.mock.timers.tick(ms);
  };
  tick(70);
  deadline.transition("admitted");
  tick(25);
  deadline.transition("queued");
  tick(20);
  deadline.transition("admitted");
  tick(14);
  assert.deepEqual(errors, []);
  tick(1);
  assert.deepEqual(errors, ["admitted"]);
  deadline.close();
});
test("duplicate queue pulses cannot reset the bounded queue deadline", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  const errors: string[] = [];
  const deadline = new Deadline(
    { queued: 100, admitted: 40 },
    (phase) => errors.push(phase),
    () => now,
  );
  now = 90;
  t.mock.timers.tick(90);
  deadline.transition("queued");
  now = 100;
  t.mock.timers.tick(10);
  assert.deepEqual(errors, ["queued"]);
  deadline.close();
});
test("closing cancels all remaining deadlines", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const errors: string[] = [];
  const deadline = new Deadline({ queued: 10, admitted: 10 }, (phase) => errors.push(phase));
  deadline.close();
  t.mock.timers.tick(100);
  assert.deepEqual(errors, []);
});
