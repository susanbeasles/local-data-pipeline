import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { open, lstat, readFile, readlink } from "node:fs/promises";
import { join, dirname, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { fileHash } from "./seal.ts";
import { atomic, hash } from "./store.ts";
import { discover } from "./source.ts";
const root = resolve(process.argv[2]),
  baseline = resolve(process.argv[3]),
  out = resolve(process.argv[4]);
if (out.startsWith(root + "/")) throw Error("output inside corpus");
const db = new DatabaseSync(join(out, "inventory-index.sqlite"));
db.exec(
  "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS entries(path TEXT PRIMARY KEY,record TEXT NOT NULL,seen INTEGER NOT NULL DEFAULT 0);",
);
db.exec("BEGIN");
let n = 0;
const repos: string[] = [],
  records: string[] = [];
const put = db.prepare("INSERT OR REPLACE INTO entries VALUES(?,?,0)");
for await (const line of createInterface({
  input: createReadStream(join(baseline, "inventory.jsonl")),
  crlfDelay: Infinity,
})) {
  const r = JSON.parse(line);
  put.run(r.path, line);
  if (r.type === "directory" && r.path.endsWith("/.git"))
    repos.push(join(root, dirname(r.path)));
  if (
    r.type === "file" &&
    r.path.includes("/site-packages/") &&
    r.path.endsWith(".dist-info/RECORD")
  )
    records.push(join(root, r.path));
  if (++n % 10000 === 0) {
    db.exec("COMMIT;BEGIN");
  }
}
db.exec("COMMIT");
const deps = new Map<string, string>();
for (const path of records) {
  const dir = resolve(path, "../..");
  for (const line of (await readFile(path, "utf8")).split("\n")) {
    const m = /^([^,]+),sha256=([A-Za-z0-9_-]+),\d+$/.exec(line);
    if (!m) continue;
    const target = resolve(dir, m[1]);
    if (target.startsWith(root + "/"))
      deps.set(
        relative(root, target),
        Buffer.from(m[2], "base64url").toString("hex"),
      );
  }
}
const tracked = new Set<string>();
let repoErrors = 0;
for (const repo of repos) {
  try {
    const data = execFileSync(
      "/usr/bin/git",
      [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-C",
        repo,
        "ls-files",
        "-z",
      ],
      {
        maxBuffer: 128 * 1024 * 1024,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: "/nonexistent",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_OPTIONAL_LOCKS: "0",
        },
      },
    ).toString();
    for (const name of data.split("\0"))
      if (name) tracked.add(relative(root, join(repo, name)));
  } catch {
    repoErrors++;
  }
}
const reviewed = new Set([
  "enrichment/local-model.py",
  "enrichment/compile-role.py",
  "enrichment/stage-model.py",
  "enrichment/sandbox.ts",
  "enrichment/broker.ts",
  "enrichment/pipeline.ts",
  "enrichment/run.ts",
  "enrichment/contracts.ts",
  "enrichment/extract.ts",
  "enrichment/chunks.ts",
]);
const output = await open(join(out, "inventory.jsonl"), "w", 0o600),
  proposal = await open(join(out, "migration.jsonl"), "w", 0o600);
let changed = 0,
  missing = 0,
  added = 0,
  entries = 0;
const counts: Record<string, number> = {};
for await (const line of createInterface({
  input: createReadStream(join(baseline, "inventory.jsonl")),
  crlfDelay: Infinity,
})) {
  const r = JSON.parse(line),
    path = join(root, r.path);
  r.git = tracked.has(r.path)
    ? "tracked"
    : repos.some((repo) => path.startsWith(repo + "/"))
      ? "untracked"
      : "not-in-repository";
  if (reviewed.has(r.path) && r.format === "utf8") {
    r.classification = "application-source";
    r.evidence =
      "Independent bounded code inspection; pipeline implementation, not authoritative instructions";
  } else if (deps.get(r.path) === r.hash) {
    r.classification = "dependency";
    r.evidence =
      "Installed distribution RECORD sha256 matches observed bytes; authenticity not attested";
  } else if (
    r.path.startsWith("enrichment/models/qwen2.5-3b-official/") &&
    /\/(model[^/]*\.safetensors|config\.json|tokenizer\.json|tokenizer_config\.json|vocab\.json|merges\.txt)$/.test(
      r.path,
    )
  ) {
    r.classification = "model";
    r.evidence =
      "Independently loaded by MLX/tokenizer in synthetic sandboxed adaptation experiment";
  } else if (r.git === "tracked") {
    r.classification = "source-data";
    r.evidence =
      "Git index membership in preserved repository snapshot; origin authenticity not established";
  }
  counts[r.classification] = (counts[r.classification] ?? 0) + 1;
  let state = "unchanged";
  try {
    const now = await lstat(path);
    if (
      now.dev !== r.device ||
      now.ino !== r.inode ||
      now.size !== r.size ||
      now.mtimeMs !== r.mtime ||
      now.ctimeMs !== r.ctime
    ) {
      state = "metadata-changed";
      changed++;
      r.currentHash = now.isFile()
        ? await fileHash(path)
        : now.isSymbolicLink()
          ? hash(await readlink(path))
          : null;
      r.contentChanged = r.currentHash !== r.hash;
    }
  } catch {
    state = "missing";
    missing++;
  }
  r.reconciliation = state;
  await output.write(JSON.stringify(r) + "\n");
  const destination =
    r.classification === "application-source"
      ? join(out, "proposed", "pipeline", r.path)
      : null;
  let collision = false;
  if (destination) {
    try {
      await lstat(destination);
      collision = true;
    } catch {}
  }
  await proposal.write(
    JSON.stringify({
      source: path,
      destination,
      classification: r.classification,
      hash: r.hash,
      action: destination ? "copy-proposal-only" : "preserve",
      collision,
      evidence: r.evidence,
    }) + "\n",
  );
  entries++;
  if (entries % 100000 === 0)
    console.log(JSON.stringify({ entries, changed, missing }));
}
// Walk without reading source contents; every current entry is checked against baseline.
async function* tree(dir: string): AsyncGenerator<string> {
  const { opendir } = await import("node:fs/promises");
  for await (const e of await opendir(dir)) {
    const p = join(dir, e.name);
    yield p;
    if (e.isDirectory()) yield* tree(p);
  }
}
const additions = await open(join(out, "added.jsonl"), "w", 0o600);
for await (const path of tree(root)) {
  if (
    !db.prepare("SELECT 1 FROM entries WHERE path=?").get(relative(root, path))
  ) {
    added++;
    await additions.write(
      JSON.stringify({
        path: relative(root, path),
        classification: "protected-unknown",
        action: "preserve",
      }) + "\n",
    );
  }
}
await output.sync();
await proposal.sync();
await additions.sync();
await output.close();
await proposal.close();
await additions.close();
db.close();
const report = {
  entries,
  changed,
  missing,
  added,
  counts,
  repositories: repos.length,
  repoErrors,
  integrity: missing === 0 && added === 0 && changed === 0,
  hashPolicy:
    "baseline SHA-256 reused only when device/inode/size/mtime/ctime unchanged; changed regular files rehashed",
  migrationExecuted: false,
};
await atomic(join(out, "reconciliation.json"), report);
console.log(JSON.stringify(report));
