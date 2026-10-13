import { test } from "node:test";
import assert from "node:assert/strict";
import { chunks } from "../legacy/chunks.ts";
test("preserved boundary chunker retains surrogate pairs and all source bytes", () => {
  const text = "😀 heading\n".repeat(300);
  const parts = [...chunks("a".repeat(64), text, "text", 257)];
  assert.equal(parts.map((p) => p.text).join(""), text);
  for (const p of parts) {
    assert.ok(p.text.length <= 257);
    assert.equal(Buffer.byteLength(text.slice(0, p.start)), p.byteStart);
    assert.equal(Buffer.byteLength(text.slice(0, p.end)), p.byteEnd);
    assert.ok(!/[\uD800-\uDBFF]$/.test(p.text));
  }
});
