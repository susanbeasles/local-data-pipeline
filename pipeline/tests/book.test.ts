import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, access, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { handoff } from "../handoff.ts";
import { Intake } from "../intake.ts";
import { hash } from "../store.ts";
import { prepareBook, runBook, publishBook, verifyBook } from "../book.ts";
import { checkDraft, bookProfile, type Packet } from "../book-data.ts";
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "handbook-")),
    repo = join(root, "repo");
  await mkdir(repo);
  await writeFile(
    join(repo, "README.md"),
    "# Consent\nConsent gates fixture message delivery. Replacing usertags requires migrating the fixture consumer. <script>bad()</script>\n",
  );
  const archive = join(root, "archive");
  await handoff({
    title: "Fixture",
    sources: [{ name: "fixture", path: repo }],
    output: archive,
    untracked: true,
  });
  const intakeRoot = join(root, "intake"),
    intake = await Intake.open(intakeRoot);
  const task = {
    id: hash("history"),
    name: "conversations.history",
    cloudId: "slack",
    kind: "slack",
    scope: "fixture",
    inputs: { channel: "C1" },
  };
  await intake.accept(
    task,
    {
      ok: true,
      messages: [
        {
          text: "Consent was added because fixture customers requested an opt-out gate.",
          ts: "123",
        },
      ],
    },
    [],
  );
  intake.seed([{ ...task, id: hash("pending"), inputs: { channel: "C2" } }]);
  intake.close();
  const config = {
    title: "Fixture handbook",
    output: join(root, "book"),
    sources: [
      { name: "repositories", kind: "handoff" as const, path: archive },
      { name: "discussions", kind: "intake" as const, path: intakeRoot },
    ],
    topics: [
      {
        id: "consent",
        title: "Consent",
        keywords: ["consent", "opt-out"],
        questions: ["Why does consent exist?", "What breaks when it changes?"],
        related: [],
      },
    ],
    excerpts: 8,
    characters: 1500,
  };
  return { root, repo, archive, intakeRoot, config };
}
function response(packet: Packet) {
  const e = packet.evidence[0]!;
  return {
    sections: [
      {
        heading: "What it does",
        paragraphs: [
          {
            text: "Consent gates fixture delivery.",
            status: "documented",
            citations: [{ id: e.id, quote: e.text.slice(0, 40) }],
          },
        ],
      },
    ],
    unknowns: ["Current deployment is not established by these excerpts."],
  };
}
test("handbook captures verified repository and discussion data, embeds model evidence in matching SQLite/JSONL and reports collection gaps", async () => {
  const f = await fixture(),
    report = await prepareBook(f.config);
  assert.equal(report.topics, 1);
  const packet = JSON.parse(
    await readFile(join(f.config.output, "input/consent.jsonl"), "utf8"),
  ) as Packet;
  assert.ok(packet.evidence.some((e) => e.origin.kind === "intake"));
  assert.ok(packet.evidence.some((e) => e.origin.kind === "handoff"));
  const db = new DatabaseSync(join(f.config.output, "state/book.sqlite"), { readOnly: true });
  assert.equal(
    String(db.prepare("SELECT body FROM packets WHERE id=?").get("consent")!.body),
    JSON.stringify(packet),
  );
  const coverage = JSON.parse(
    String(db.prepare("SELECT body FROM coverage WHERE name=?").get("discussions")!.body),
  );
  assert.equal(coverage.pending, 1);
  db.close();
  assert.equal(
    await readFile(join(f.repo, "README.md"), "utf8"),
    "# Consent\nConsent gates fixture message delivery. Replacing usertags requires migrating the fixture consumer. <script>bad()</script>\n",
  );
  await assert.rejects(prepareBook(f.config), /exists/);
});
test("handbook citation gate rejects invented evidence, fabricated quotes, empty citations and unsupported states", async () => {
  const f = await fixture();
  await prepareBook(f.config);
  const packet = JSON.parse(
    await readFile(join(f.config.output, "input/consent.jsonl"), "utf8"),
  ) as Packet;
  assert.doesNotThrow(() => checkDraft(packet, response(packet)));
  for (const mutate of [
    (v: any) => {
      v.sections[0].paragraphs[0].citations[0].id = "invented";
    },
    (v: any) => {
      v.sections[0].paragraphs[0].citations[0].quote = "This quote was never present.";
    },
    (v: any) => {
      v.sections[0].paragraphs[0].citations = [];
    },
    (v: any) => {
      v.sections[0].paragraphs[0].status = "verified-deployed";
    },
  ]) {
    const value = response(packet);
    mutate(value);
    assert.throws(() => checkDraft(packet, value), /citation|schema|evidence|quote/);
  }
});
test("full synthetic authoring retries failure, resumes without duplicate inference, publishes multipage linked searchable book and detects tampering", async () => {
  const f = await fixture();
  await prepareBook(f.config);
  let calls = 0;
  const report = await runBook(
    f.config.output,
    async (request) => {
      calls++;
      if (calls === 1) throw Error("controlled inference failure");
      return response(JSON.parse(request.text));
    },
    "synthetic-author/1",
  );
  assert.equal(report.integrity, true);
  assert.equal(calls, 2);
  await runBook(
    f.config.output,
    async () => {
      throw Error("completed work repeated");
    },
    "synthetic-author/1",
  );
  const result = await publishBook(f.config.output);
  assert.equal(result.drafted, 1);
  assert.equal(result.reviewed, 0);
  assert.equal(result.complete, false);
  const html = await readFile(join(f.config.output, "site/consent.html"), "utf8");
  assert.match(html, /Consent gates fixture delivery/);
  assert.match(html, /Model draft/);
  assert.ok(!html.includes("<script>bad()"));
  assert.match(html, /Evidence/);
  assert.match(html, /source-/);
  assert.match(await readFile(join(f.config.output, "site/index.html"), "utf8"), /find/);
  assert.equal((await verifyBook(f.config.output)).integrity, true);
  await writeFile(join(f.config.output, "site/consent.html"), "corrupt");
  await assert.rejects(verifyBook(f.config.output), /hash|integrity/);
});
test("handbook refuses aliased and overlapping inputs and corrupt provider mirrors", async () => {
  const f = await fixture();
  await assert.rejects(prepareBook({ ...f.config, output: join(f.archive, "book") }), /overlap/);
  await writeFile(join(f.intakeRoot, "staging", hash("history") + ".jsonl"), "{}\n");
  await assert.rejects(prepareBook(f.config), /mirror|integrity/);
  await assert.rejects(access(join(f.config.output, "prepared.json")));
});
test("empty topics remain visible as evidence gaps rather than fabricated chapters", async () => {
  const f = await fixture();
  f.config.topics[0]!.keywords = ["missingword"];
  await prepareBook(f.config);
  const report = await publishBook(f.config.output);
  assert.equal(report.drafted, 0);
  assert.equal(report.gaps, 1);
  assert.equal(report.complete, false);
  assert.match(
    await readFile(join(f.config.output, "site/consent.html"), "utf8"),
    /No matching evidence/,
  );
});
test("book profiles package fixed author instructions without changing six enrichment roles", () => {
  const p = bookProfile();
  assert.deepEqual(
    p.stages.map((s) => s.name),
    ["author"],
  );
  assert.match(p.stages[0]!.system, /untrusted/i);
  assert.match(p.stages[0]!.system, /why/i);
});

test("a handbook edition rejects a changed author model instead of silently mixing results", async () => {
  const f = await fixture();
  await prepareBook(f.config);
  await runBook(f.config.output, async (r) => response(JSON.parse(r.text)), "synthetic-author/1");
  await assert.rejects(
    runBook(f.config.output, async (r) => response(JSON.parse(r.text)), "synthetic-author/2"),
    /author.*changed|new edition/,
  );
});
test("standalone preparation runs under real OS network and source-write denial", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const f = await fixture();
  const path = join(f.root, "book.json");
  await writeFile(path, JSON.stringify(f.config));
  const result = await promisify(execFile)(process.execPath, [
    join(import.meta.dirname, "../book.ts"),
    "prepare",
    path,
  ]);
  assert.equal(JSON.parse(result.stdout).topics, 1);
  assert.equal(
    JSON.parse(await readFile(join(f.config.output, "prepared.json"), "utf8")).topics,
    1,
  );
});
