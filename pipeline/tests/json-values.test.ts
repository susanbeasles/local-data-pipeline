import { test } from "node:test";
import assert from "node:assert/strict";
import { JsonValues } from "../json-values.ts";
const root = {
  text: "A source-supported historical incident. ".repeat(30),
  ts: "123.4",
  blocks: [{ type: "section", text: "keep this extra detail" }],
};
test("repeated thread data is factored once with complete reconstruction", () => {
  const values = new JsonValues();
  const input = {
    messages: [
      { text: "first", root },
      { text: "second", root },
    ],
  };
  values.index(input);
  const node = values.add(input);
  assert.deepEqual(values.expand(node.id), input);
  assert.equal(Object.keys(node.links).length, 2);
  assert.equal(new Set(Object.values(node.links)).size, 1);
  assert.equal(values.nodes.size, 2);
});
test("distinct historical versions remain distinct", () => {
  const values = new JsonValues();
  const input = {
    messages: [
      { root },
      { root: { ...root, text: root.text + "changed" } },
      { root },
      { root: { ...root, text: root.text + "changed" } },
    ],
  };
  values.index(input);
  const node = values.add(input);
  assert.deepEqual(values.expand(node.id), input);
  assert.equal(new Set(Object.values(node.links)).size, 2);
});
test("reserved-looking keys and JSON pointer escaping retain values", () => {
  const values = new JsonValues();
  const input = JSON.parse(
    '{"__proto__":{"data":"retained"},"~a/b":{"root":' +
      JSON.stringify(root) +
      '},"other":{"root":' +
      JSON.stringify(root) +
      '},"$record":"literal","null":null}',
  );
  values.index(input);
  const node = values.add(input);
  assert.deepEqual(values.expand(node.id), input);
  assert.equal(({} as any).data, undefined);
});
test("corrupt dictionary data cannot reconstruct as valid", () => {
  const values = new JsonValues();
  const input = { messages: [{ root }, { root }] };
  values.index(input);
  const node = values.add(input);
  (node.data as Record<string, unknown>).tampered = true;
  assert.throws(() => values.expand(node.id), /hash/);
});
test("unsafe numeric identities are rejected rather than rounded silently", () => {
  const values = new JsonValues();
  assert.throws(() => values.index({ id: 9007199254740992 }), /integer/);
});

test("negative-zero representations are not silently normalized", () =>
  assert.throws(() => new JsonValues().index({ value: -0 }), /numeric/));
