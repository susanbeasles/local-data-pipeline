import { Script } from "node:vm";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { handoff, verifyHandoff } from "../handoff.ts";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "handoff-"));
  const source = join(root, "repo");
  await mkdir(join(source, "docs"), { recursive: true });
  await writeFile(
    join(source, "README.md"),
    '# Application\n\nSource-authored setup instructions.\n\n```sh\nnpm run build\n```\n\n<script>alert("untrusted")</script>\n',
  );
  await writeFile(
    join(source, "docs/runbook.md"),
    "# Operations\n\nRestart only after checking the checkpoint.\n",
  );
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({
      name: "fixture",
      scripts: { build: "echo build", prepare: "touch " + join(root, "executed") },
      dependencies: { sqlite: "1.0.0" },
    }),
  );
  return {
    root,
    source,
    config: {
      title: "Engineering handoff",
      untracked: true,
      sources: [{ name: "application", path: source }],
      output: join(root, "output"),
    },
  };
}
test("handoff packs complete selected bytes in SQLite and JSONL, publishes readable docs and never executes project scripts", async () => {
  const f = await fixture();
  const r = await handoff(f.config);
  assert.equal(r.integrity, true);
  assert.equal(r.documents, 3);
  const rows = (await readFile(join(f.config.output, "documents.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s));
  const db = new DatabaseSync(join(f.config.output, "documents.sqlite"), { readOnly: true });
  for (const row of rows) {
    assert.equal(row.text, await readFile(join(f.source, row.path), "utf8"));
    assert.deepEqual(Buffer.from(row.base64, "base64"), await readFile(join(f.source, row.path)));
    const saved = db.prepare("SELECT body,bytes FROM documents WHERE id=?").get(row.id)!;
    assert.equal(JSON.parse(String(saved.body)).text, row.text);
    assert.deepEqual(Buffer.from(saved.bytes as Uint8Array), Buffer.from(row.base64, "base64"));
  }
  db.close();
  const html = await readFile(join(f.config.output, "index.html"), "utf8");
  assert.match(html, /Source-authored setup instructions/);
  assert.match(html, /Content-Security-Policy/);
  assert.ok(!html.includes("<script>alert"));
  assert.match(html, /Declared scripts/);
  assert.ok(html.includes("Declared dependencies"));
  assert.ok(html.includes('id="find"'));
  assert.ok(html.includes("Starting points"));
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  assert.doesNotThrow(() => new Script(script));
  await assert.rejects(access(join(f.root, "executed")));
  assert.equal((await verifyHandoff(f.config.output)).integrity, true);
});
test("handoff refuses overlapping output and records symlinks without following them", async () => {
  const f = await fixture();
  await assert.rejects(handoff({ ...f.config, output: join(f.source, "output") }), /overlap/);
  await symlink(join(f.source, "README.md"), join(f.source, "link.md"));
  const r = await handoff(f.config);
  assert.equal(r.unsupported, 1);
  assert.equal(r.complete, false);
  assert.match(await readFile(join(f.config.output, "dispositions.jsonl"), "utf8"), /symlink/);
});
test("tampered SQLite bytes, missing mirrors and duplicate output records fail verification", async () => {
  for (const kind of ["sqlite", "duplicate", "missing"]) {
    const f = await fixture();
    await handoff(f.config);
    if (kind === "sqlite") {
      const db = new DatabaseSync(join(f.config.output, "documents.sqlite"));
      db.exec("UPDATE documents SET bytes=x'00'");
      db.close();
    } else if (kind === "duplicate") {
      const p = join(f.config.output, "documents.jsonl");
      await writeFile(p, (await readFile(p, "utf8")).repeat(2));
    } else await writeFile(join(f.config.output, "documents.jsonl"), "");
    await assert.rejects(
      verifyHandoff(f.config.output),
      /integrity|mirror|hash|duplicate|coverage/,
    );
  }
});

test("standalone handoff entrypoint enforces the local OS guard and preserves input", async () => {
  const f = await fixture();
  const config = join(f.root, "handoff.json");
  await writeFile(
    config,
    JSON.stringify({
      ...f.config,
      sources: [{ name: "application", path: "repo" }],
      output: "output",
    }),
  );
  const { promisify } = await import("node:util");
  const { execFile } = await import("node:child_process");
  const result = await promisify(execFile)(
    process.execPath,
    [new URL("../handoff.ts", import.meta.url).pathname, config],
    { maxBuffer: 65536 },
  );
  assert.equal(JSON.parse(result.stdout).integrity, true);
  assert.equal((await verifyHandoff(f.config.output)).documents, 3);
  await assert.rejects(access(join(f.root, "executed")));
});

test("default handoff scope excludes unknown untracked material", async () => {
  const f = await fixture();
  const { promisify } = await import("node:util");
  const { execFile } = await import("node:child_process");
  const git = promisify(execFile);
  const env = { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  await git("/usr/bin/git", ["-C", f.source, "init", "-q"], { env });
  await git(
    "/usr/bin/git",
    ["-c", "core.fsmonitor=false", "-C", f.source, "add", "README.md", "package.json"],
    { env },
  );
  const r = await handoff({ ...f.config, untracked: false });
  assert.equal(r.documents, 2);
  const text = await readFile(join(f.config.output, "documents.jsonl"), "utf8");
  assert.ok(!text.includes("Restart only after"));
  const config = join(f.root, "tracked.json");
  await writeFile(
    config,
    JSON.stringify({ ...f.config, untracked: false, output: join(f.root, "guarded") }),
  );
  const result = await git(
    process.execPath,
    [new URL("../handoff.ts", import.meta.url).pathname, config],
    { maxBuffer: 65536 },
  );
  assert.equal(JSON.parse(result.stdout).documents, 2);
});

test("generated search filters full source text locally and expands matching documents", async () => {
  const f = await fixture();
  await handoff(f.config);
  const html = await readFile(join(f.config.output, "index.html"), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  const rows = (await readFile(join(f.config.output, "documents.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s));
  const docs = rows.map((row) => ({
    textContent: row.path + " " + row.text,
    hidden: false,
    open: false,
  }));
  let change = () => {};
  const input = {
    value: "",
    addEventListener: (_name: string, fn: () => void) => {
      change = fn;
    },
  };
  const status = { textContent: "" };
  const section = { hidden: false, querySelectorAll: () => docs };
  const { runInNewContext } = await import("node:vm");
  runInNewContext(
    script,
    {
      document: {
        getElementById: (id: string) => (id === "find" ? input : status),
        querySelectorAll: (query: string) => (query === "details[data-doc]" ? docs : [section]),
      },
      setTimeout: (fn: () => void) => {
        fn();
        return 0;
      },
      clearTimeout: () => {},
      fetch: () => {
        throw Error("External access forbidden");
      },
    },
    { timeout: 1000 },
  );
  input.value = "CHECKPOINT";
  change();
  assert.equal(docs.filter((d) => !d.hidden).length, 1);
  assert.equal(docs.filter((d) => d.open).length, 1);
  assert.equal(status.textContent, "1 matching documents");
  input.value = "no matching source";
  change();
  assert.equal(section.hidden, true);
  input.value = "";
  change();
  assert.equal(docs.filter((d) => !d.hidden).length, 3);
  assert.equal(section.hidden, false);
});

test("repository metadata inspection never invokes configured clean filters", async () => {
  const f = await fixture();
  const { promisify } = await import("node:util");
  const { execFile } = await import("node:child_process");
  const exec = promisify(execFile);
  const env = { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (args: string[]) =>
    exec("/usr/bin/git", ["-c", "core.fsmonitor=false", "-C", f.source, ...args], { env });
  await git(["init", "-q"]);
  await git(["add", "README.md", "package.json"]);
  await git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--no-gpg-sign",
    "-m",
    "Synthetic fixture",
  ]);
  const marker = join(f.root, "filter-executed");
  await git(["config", "filter.fixture.clean", "touch " + marker + "; cat"]);
  await writeFile(join(f.source, ".gitattributes"), "*.md filter=fixture\n");
  const size = (await readFile(join(f.source, "README.md"))).length;
  await writeFile(
    join(f.source, "README.md"),
    "# Modified source\n\nKeep all source evidence.\n".padEnd(size, " "),
  );
  await handoff({ ...f.config, untracked: false });
  await assert.rejects(access(marker));
});

test('engineering selection includes captured code and infrastructure while default documentation scope remains narrow', async()=>{
 const f=await fixture();await writeFile(join(f.source,'consumer.ts'),'export const usertags = ["fixture"];\n');await writeFile(join(f.source,'policy.yaml'),'fixture: consent\n');
 const docs=await handoff(f.config);assert.equal(docs.documents,3);
 const full=await handoff({...f.config,output:join(f.root,'engineering'),selection:'engineering'});assert.equal(full.documents,5);
 assert.match(await readFile(join(f.root,'engineering/documents.jsonl'),'utf8'),/consumer.ts/);
 assert.equal((await verifyHandoff(join(f.root,'engineering'))).integrity,true);
});
