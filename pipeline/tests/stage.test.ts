import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  stat,
  readFile,
  open,
  realpath,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { source } from "../source.ts";
import { Stage } from "../stage.ts";
import { hash } from "../store.ts";
test("large stages persist indexed complete chunks and detect corrupt records", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "indexed-stage-")));
  const input = join(root, "log.txt");
  const text = "Synthetic local log.\n".repeat(850000);
  await writeFile(input, text);
  const data = await source(root, input, 64 * 1024 ** 2, 6000);
  const path = join(root, data.id + ".json");
  data.chunkFile = join(root, data.id + ".jsonl");
  const digest = await Stage.write(path, data, {
    roles: ["summarize"],
    configHash: "fixture",
  });
  assert.ok((await stat(path)).size < text.length / 4);
  const stored = await new Stage(1).read(data.id, path, digest);
  let end = 0;
  const parts: string[] = [];
  for (let i = 0; i < stored.chunks.length; i++) {
    const c = await Stage.chunk(stored, i);
    assert.ok(c);
    assert.equal(c.start, end);
    end = c.end;
    parts.push(c.text);
  }
  assert.equal(hash(parts.join("")), hash(text));
  assert.equal(end, text.length);
  const file = await open(data.chunkFile, "r+");
  await file.write(Buffer.from("!"), 0, 1, 0);
  await file.close();
  await assert.rejects(Stage.chunk(stored, 0), /chunk record hash mismatch/);
  assert.equal(await readFile(input, "utf8"), text);
});

test("indexed large chunk configuration supports full evidence and corrupt-file reports", async () => {
  const { run, verify } = await import("../run.ts");
  const { mkdir } = await import("node:fs/promises");
  const root = await realpath(await mkdtemp(join(tmpdir(), "indexed-e2e-")));
  const input = join(root, "input"),
    work = join(root, "work");
  await mkdir(input);
  await writeFile(
    join(input, "large.log"),
    "Alpha local record.\n".repeat(900000),
  );
  const result = await run(
    {
      input,
      work,
      engine: "synthetic",
      model: "fixture",
      roles: ["summarize"],
      chunkSize: 10 * 1024 ** 2,
      concurrency: 2,
      attempts: 1,
      maxBytes: 64 * 1024 ** 2,
    },
    async (r) => ({
      summary: "local",
      facts: [{ claim: r.text.slice(0, 5), start: 0, end: 5 }],
      unknowns: [],
    }),
  );
  assert.equal(result.integrity, true);
  assert.equal(result.completed, 1);
  const chunkFile = join(work, "staging", result.sources[0] + ".jsonl");
  await writeFile(chunkFile, "corrupt");
  const corrupt = await verify(work, input);
  assert.equal(corrupt.integrity, false);
  assert.ok(corrupt.errors.some((e) => e.startsWith("chunk-jsonl:")));
});
