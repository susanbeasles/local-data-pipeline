import { test } from "node:test";
import assert from "node:assert/strict";
import { roles, validRole } from "../roles.ts";
test("all six role configurations carry fixed instructions and independent schemas", () => {
  assert.deepEqual(Object.keys(roles), [
    "tag",
    "classify",
    "summarize",
    "knowledge",
    "reconcile",
    "connect",
  ]);
  for (const role of Object.values(roles)) {
    assert.ok(role.system.length > 100);
    assert.ok(role.schema);
    assert.ok(role.maxTokens > 0);
  }
});
test("role contracts reject fabricated anchors, namespaces, entity references and pair evidence", () => {
  const context = {
    trustedNamespace: "fixture",
    candidates: {
      members: [{ id: "a" }, { id: "b" }],
      evidence: [
        { id: "x", member: "a" },
        { id: "y", member: "b" },
      ],
    },
  };
  assert.ok(
    validRole(
      "tag",
      { tags: ["SQLite"] },
      { context, spans: [{ id: 0, text: "SQLite" }] },
    ),
  );
  assert.ok(
    !validRole(
      "summarize",
      {
        summary: "x",
        facts: [
          { claim: "x", basis: "explicit", state: "current", anchorIds: [1] },
        ],
        unknowns: [],
      },
      { context, spans: [{ id: 0, text: "x" }] },
    ),
  );
  assert.ok(
    !validRole(
      "knowledge",
      {
        entities: [],
        claims: [
          {
            subject: "missing",
            predicate: "x",
            object: "x",
            time: "unknown",
            status: "observed",
            confidence: 1,
            anchorIds: [0],
          },
        ],
        unknowns: [],
      },
      { context, spans: [{ id: 0, text: "x" }] },
    ),
  );
  assert.ok(
    validRole(
      "connect",
      {
        edges: [
          {
            from: "a",
            to: "b",
            relation: "depends-on",
            basis: "explicit",
            evidenceIds: ["x", "y"],
          },
        ],
        unknowns: [],
      },
      { context },
    ),
  );
  assert.ok(
    !validRole(
      "connect",
      {
        edges: [
          {
            from: "a",
            to: "b",
            relation: "depends-on",
            basis: "explicit",
            evidenceIds: ["x"],
          },
        ],
        unknowns: [],
      },
      { context },
    ),
  );
});

test("connection generation has a private existence and direction decision without changing public output", async () => {
  const { generation } = await import("../roles.ts");
  const model = generation("connect");
  assert.equal(model.schema.required![0], "linked");
  assert.equal(model.schema.properties!.edges!.items!.required![0], "actor");
  assert.ok(model.maxTokens > roles.connect.maxTokens);
  assert.ok(
    validRole(
      "connect",
      { edges: [], unknowns: [] },
      {
        context: {
          candidates: { members: [{ id: "a" }, { id: "b" }], evidence: [] },
        },
      },
    ),
  );
  assert.ok(
    !validRole(
      "connect",
      { linked: false, edges: [], unknowns: [] },
      {
        context: {
          candidates: { members: [{ id: "a" }, { id: "b" }], evidence: [] },
        },
      },
    ),
  );
});
