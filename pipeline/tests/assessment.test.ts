import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { assess } from "../assess.ts";
import { hash } from "../store.ts";
test("an interrupted benchmark remains unstable without discarding passing evidence", async () => {
  const root = await mkdtemp(
    join(import.meta.dirname, "../../state/workers-test-"),
  );
  for (let w = 0; w < 3; w++) {
    const input = join(root, "input", String(w));
    await mkdir(input, { recursive: true });
    const text = `Fixture ${w}`;
    await writeFile(join(input, "fixture.txt"), text);
    for (const n of [1, 4]) {
      const output = join(root, `workers-${n}`, String(w), "output");
      await mkdir(output, { recursive: true });
      await writeFile(
        join(output, "result.json"),
        JSON.stringify({
          source: hash("fixture.txt"),
          result: {
            summary: text,
            facts: [{ claim: text, anchorIds: [0] }],
            unknowns: [],
          },
        }),
      );
    }
  }
  const reports = [1, 2, 4].map((n) =>
    n === 2
      ? { workers: n, stable: false, error: "interrupted" }
      : {
          workers: n,
          completed: 3,
          batchSize: 16,
          filesPerMinute: n === 1 ? 100 : 90,
          exitCode: 0,
          integrity: true,
          windows: [
            { elapsedSeconds: 25 },
            { elapsedSeconds: 25 },
            { elapsedSeconds: 25 },
          ],
          resources: {
            peakFootprintBytes: 10_000_000_000,
            budgetExceeded: false,
          },
        },
  );
  await writeFile(
    join(root, "comparison.json"),
    JSON.stringify({ input: join(root, "input"), reports }),
  );
  const result = await assess(root, join(root, "selection.json"));
  assert.equal(result.selection.workers, 1);
  assert.equal(result.reports[1].stable, false);
  assert.equal(result.reports[1].error, "interrupted");
  assert.equal(result.reports[2].stable, true);
  assert.equal(
    JSON.parse(await readFile(join(root, "selection.json"), "utf8")).workers,
    1,
  );
});
