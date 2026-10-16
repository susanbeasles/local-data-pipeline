import { test } from "node:test";
import assert from "node:assert/strict";
import { Refs } from "../refs.ts";
test("compact inference references round-trip without rewriting source evidence", () => {
  const payload = {
    context: {
      candidates: {
        members: [
          {
            id: "source-A",
            name: "Alpha",
            claims: [{ subject: "source-A", object: "source-B" }],
          },
          { id: "source-B", name: "Beta" },
        ],
        evidence: [
          {
            id: "proof-A",
            member: "source-A",
            text: "source-A is literal source text.",
          },
          { id: "proof-B", member: "source-B", text: "Beta reads Alpha." },
        ],
      },
    },
  };
  const refs = new Refs(payload),
    encoded = refs.encode(payload);
  assert.equal(encoded.context!.candidates!.members[0].id, "Alpha");
  assert.equal(
    encoded.context!.candidates!.evidence[0].text,
    "source-A is literal source text.",
  );
  assert.deepEqual(
    refs.restore({
      edges: [{ from: "Beta", to: "Alpha", evidenceIds: ["r1", "r0"] }],
      unknowns: ["m0 is literal explanation"],
    }),
    {
      edges: [
        {
          from: "source-B",
          to: "source-A",
          evidenceIds: ["proof-B", "proof-A"],
        },
      ],
      unknowns: ["m0 is literal explanation"],
    },
  );
  assert.equal(payload.context.candidates.members[0].id, "source-A");
});
test("unknown output references remain invalid rather than becoming another endpoint", () => {
  const refs = new Refs({
    context: {
      candidates: { members: [{ id: "a" }, { id: "b" }], evidence: [] },
    },
  });
  assert.deepEqual(
    refs.restore({ edges: [{ from: "m9", to: "m0", evidenceIds: [] }] }),
    { edges: [{ from: "m9", to: "a", evidenceIds: [] }] },
  );
});
test("concurrent requests never share inference reference bindings", () => {
  const first = new Refs({
    context: { candidates: { members: [{ id: "first" }], evidence: [] } },
  });
  const second = new Refs({
    context: { candidates: { members: [{ id: "second" }], evidence: [] } },
  });
  assert.deepEqual(first.restore({ groups: [{ memberIds: ["m0"] }] }), {
    groups: [{ memberIds: ["first"] }],
  });
  assert.deepEqual(second.restore({ groups: [{ memberIds: ["m0"] }] }), {
    groups: [{ memberIds: ["second"] }],
  });
});
