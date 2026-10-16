import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalize } from "../normalize.ts";
import { Content } from "../content.ts";
import { hash } from "../store.ts";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "normalize-")),
    input = join(root, "input"),
    work = join(root, "work");
  await mkdir(input);
  const parent = { ts: "1", text: "Historical root; retain every detail. ".repeat(50) };
  const raw =
    JSON.stringify({
      messages: [
        { text: "reply one", root: parent },
        { text: "reply two", root: parent },
      ],
    }) + "\n";
  await writeFile(join(input, "source.jsonl"), raw);
  return { root, input, work, raw };
}
test("normalization archives exact bytes, factors repeated structures, and verifies both persistent representations", async () => {
  const f = await fixture();
  const r = await normalize(f.input, f.work);
  assert.equal(r.integrity, true);
  assert.equal(r.sources, 1);
  assert.equal(r.roots, 1);
  assert.equal(r.values, 2);
  const db = new DatabaseSync(join(f.work, "state/normalization.sqlite"), { readOnly: true });
  assert.equal(new Content(db, f.work).read(hash(f.raw)).toString(), f.raw);
  assert.equal(db.prepare("SELECT count(*) n FROM roots").get()!.n, 1);
  db.close();
  const records = (await readFile(join(f.work, "staging/values.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s));
  assert.equal(records.length, 2);
  assert.equal((await normalize(f.input, f.work)).integrity, true);
  assert.equal(await readFile(join(f.input, "source.jsonl"), "utf8"), f.raw);
});
test("a changed source cannot silently replace a normalization checkpoint", async () => {
  const f = await fixture();
  await normalize(f.input, f.work);
  await writeFile(join(f.input, "source.jsonl"), f.raw + "{}\n");
  await assert.rejects(normalize(f.input, f.work), /changed/);
});
test("corrupt stored values prevent certification", async () => {
  const f = await fixture();
  await normalize(f.input, f.work);
  const db = new DatabaseSync(join(f.work, "state/normalization.sqlite"));
  db.exec("UPDATE nodes SET digest='broken'");
  db.close();
  await assert.rejects(normalize(f.input, f.work), /corrupt/);
});
test("malformed JSONL fails while original bytes remain preserved", async () => {
  const f = await fixture();
  await writeFile(join(f.input, "source.jsonl"), "not-json\n");
  await assert.rejects(normalize(f.input, f.work), /JSON/);
  const db = new DatabaseSync(join(f.work, "state/normalization.sqlite"), { readOnly: true });
  assert.equal(new Content(db, f.work).read(hash("not-json\n")).toString(), "not-json\n");
  db.close();
});

import { execFile } from "node:child_process";
import { promisify } from "node:util";
test("standalone normalization runs under the real OS network and input-write guard", async () => {
  const f = await fixture();
  const r = await promisify(execFile)(
    process.execPath,
    [new URL("../normalize.ts", import.meta.url).pathname, f.input, f.work],
    { maxBuffer: 65536 },
  );
  assert.equal(JSON.parse(r.stdout).integrity, true);
  assert.equal(await readFile(join(f.input, "source.jsonl"), "utf8"), f.raw);
});
