/** Real-model controlled relationship acceptance. No corpus reads. */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pool, type Model } from "../mlx.ts";
import { launch, assertNetworkDenied } from "../sandbox.ts";
import { atomic } from "../store.ts";
const model: Model = {
  runtime: "/Users/avespoli/SonarMD-Dump-2026-10-09/enrichment/runtime",
  base: "/Users/avespoli/SonarMD-Dump-2026-10-09/enrichment/models/qwen2.5-3b-official",
  package: join(import.meta.dirname, "../../models/qwen-roles-v14"),
  adapters: {},

  workers: 1,
  batchSize: 64,
  prefillSize: 4,
  memoryBytes: 31000000000,
  budgetBytes: 32000000000,
  timeoutMs: 180000,
  maxTokens: 1600,
};
const cases: {
  id: string;
  names: string[];
  text: string[];
  expected: string[];
  relation?: string;
  kinds?: string[];
}[] = [
  {
    id: "reader-second",
    names: ["Alpha", "Beta"],
    text: ["Alpha stores records locally.", "Beta reads records from Alpha."],
    expected: ["second", "first"],
  },
  {
    id: "reader-first",
    names: ["Nimbus", "Terra"],
    text: [
      "Nimbus reads messages from Terra.",
      "Terra stores messages locally.",
    ],
    expected: ["first", "second"],
  },
  {
    id: "unrelated",
    names: ["Cedar", "Maple"],
    text: ["Cedar stores records locally.", "Maple displays a clock."],
    expected: [],
  },
  {
    id: "same-entity",
    names: ["Cedar", "Cedar"],
    text: ["Cedar stores records locally.", "Cedar stores records locally."],
    expected: [],
  },
  {
    id: "implements",
    names: ["Worker", "EventPort"],
    text: [
      "Worker implements the EventPort interface.",
      "EventPort is an interface for publishing events.",
    ],
    kinds: ["component", "interface"],
    expected: ["first", "second"],
    relation: "implements",
  },
  {
    id: "explains",
    names: ["Guide", "Parser"],
    text: [
      "Guide explains Parser error handling.",
      "Parser handles syntax errors.",
    ],
    kinds: ["document", "component"],
    expected: ["first", "second"],
    relation: "explains",
  },
  {
    id: "supersedes",
    names: ["Index v2", "Index v1"],
    text: [
      "Index v2 supersedes Index v1.",
      "Index v1 is the older implementation.",
    ],
    expected: ["first", "second"],
    relation: "supersedes",
  },
  {
    id: "same-entity-third-party",
    names: ["Cedar", "Cedar"],
    text: ["Cedar stores records locally.", "Maple reads records from Cedar."],
    expected: [],
  },
];
const root = process.argv[2];
if (!root) {
  const dir = await mkdtemp(
    join(import.meta.dirname, "../../state/relations-"),
  );
  await mkdir(join(dir, "input"));
  await mkdir(join(dir, "work"));
  await writeFile(join(dir, "input", "fixture.txt"), JSON.stringify(cases));
  console.log(JSON.stringify({ root: dir }));
  process.exitCode = await launch(
    join(dir, "input"),
    join(dir, "work"),
    import.meta.filename,
    [dir],
    model,
  );
} else {
  await assertNetworkDenied();
  const workers = pool(model);
  try {
    await workers.ready;
    const results = await Promise.all(
      cases.map(async (test) => {
        const result = (await workers.infer({
          id: test.id,
          role: "connect",
          attempt: 1,
          text: "",
          sourceHash: "synthetic",
          configHash: "synthetic",
          chunk: {
            id: "fixture",
            index: 0,
            start: 0,
            end: 0,
            text: "",
            hash: "synthetic",
          },
          payload: {
            spans: test.text.map((text, id) => ({ id, text })),
            context: {
              trustedNamespace: "fixture",
              independentEvidence: true,
              candidates: {
                members: test.names.map((name, index) => ({
                  id: index ? "second" : "first",
                  name,
                  kind: test.kinds?.[index] ?? "component",
                  namespace: "fixture",
                  claims: [],
                })),
                evidence: test.text.map((text, index) => ({
                  id: "proof" + index,
                  member: index ? "second" : "first",
                  sourceHash: "source" + index,
                  spanId: index,
                  anchorId: 0,
                  start: 0,
                  end: text.length,
                  text,
                })),
              },
            },
            prior: { reconcile: { groups: [], unknowns: [] } },
          },
        })) as { edges: { from: string; to: string; relation: string }[] };
        const pass = test.expected.length
          ? result.edges.length === 1 &&
            result.edges[0].from === test.expected[0] &&
            result.edges[0].to === test.expected[1] &&
            result.edges[0].relation === (test.relation ?? "depends-on")
          : result.edges.length === 0;
        return { id: test.id, result, pass };
      }),
    );
    await atomic(join(root, "work", "regression.json"), {
      results,
      metrics: await workers.stats(),
    });
    console.log(JSON.stringify({ results, metrics: await workers.stats() }));
    if (results.some((r) => !r.pass)) process.exitCode = 1;
  } finally {
    await workers.close();
  }
}
