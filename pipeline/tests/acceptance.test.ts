import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptance } from "../acceptance.ts";
test("semantic acceptance rejects valid JSON that copies placeholders and conflates entities", () => {
  const errors = acceptance([
    { id: "a", name: "Alpha", namespace: "fixture", claims: [{ predicate: "behavior", object: "fact" }] },
    { id: "b", name: "Beta", namespace: "fixture", claims: [] },
  ], [{ memberIds: ["a", "b"] }], [{ from: "a", to: "b", relation: "related-history" }]);
  assert.ok(errors.includes("schema placeholder copied into claim"));
  assert.ok(errors.includes("different components grouped as aliases"));
  assert.ok(errors.includes("missing reader dependency"));
});
test("semantic acceptance requires supported facts and directed dependency", () => {
  assert.deepEqual(acceptance([
    { id: "a", name: "Alpha", namespace: "fixture", claims: [{ predicate: "stores", object: "records locally" }, { predicate: "network access", object: "disabled" }] },
    { id: "b", name: "Beta", namespace: "fixture", claims: [{ predicate: "reads", object: "records from Alpha" }, { predicate: "network access", object: "disabled" }] },
  ], [], [{ from: "b", to: "a", relation: "depends-on" }]), []);
});
