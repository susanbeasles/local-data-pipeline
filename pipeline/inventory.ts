import { launch, assertNetworkDenied } from "./sandbox.ts";
import { opendir, lstat, readlink, open, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join, relative } from "node:path";
import { execFileSync } from "node:child_process";
const root = resolve(process.argv[2]),
  out = resolve(process.argv[3]);
if (out === root || out.startsWith(root + "/"))
  throw Error("Inventory output must be outside input");
await mkdir(out, { recursive: true });
if (process.argv[4] !== "--guarded") {
  process.exitCode = await launch(root, out, import.meta.filename, [
    root,
    out,
    "--guarded",
  ]);
} else {
  await assertNetworkDenied();
  await mkdir(out, { recursive: true });
  const inventory = await open(join(out, "inventory.jsonl"), "wx"),
    migration = await open(join(out, "migration.jsonl"), "wx");
  let count = 0,
    bytes = 0,
    errors = 0;
  const repos = new Map<string, Set<string>>();
  async function* walk(dir: string): AsyncGenerator<string> {
    for await (const e of await opendir(dir)) {
      const p = join(dir, e.name);
      yield p;
      if (e.isDirectory()) yield* walk(p);
    }
  }
  for await (const path of walk(root)) {
    const s = await lstat(path),
      name = relative(root, path);
    let hash: string | null = null,
      format = "unknown",
      error: string | undefined,
      target: string | undefined;
    if (s.isSymbolicLink()) {
      target = await readlink(path);
      hash = createHash("sha256").update(target).digest("hex");
      format = "symlink";
    } else if (s.isFile()) {
      const h = createHash("sha256");
      let head = Buffer.alloc(0);
      const f = await open(path, "r");
      try {
        for await (const b of f.createReadStream()) {
          if (!head.length) head = Buffer.from(b.subarray(0, 4096));
          h.update(b);
        }
        hash = h.digest("hex");
        if (head.subarray(0, 16).toString() === "SQLite format 3\0")
          format = "sqlite";
        else if (head.subarray(0, 4).toString() === "%PDF") format = "pdf";
        else if (head.subarray(0, 2).toString() === "PK") format = "zip";
        else if (head.includes(0)) format = "binary";
        else {
          try {
            new TextDecoder("utf8", { fatal: true }).decode(head, {
              stream: true,
            });
            format = "utf8";
          } catch {
            format = "binary";
          }
        }
      } catch (e) {
        error = String(e);
        errors++;
      } finally {
        await f.close().catch(() => {});
      }
      bytes += s.size;
    }
    const row = {
      path: name,
      type: s.isFile()
        ? "file"
        : s.isDirectory()
          ? "directory"
          : s.isSymbolicLink()
            ? "symlink"
            : "special",
      size: s.size,
      mode: s.mode,
      mtime: s.mtimeMs,
      ctime: s.ctimeMs,
      device: s.dev,
      inode: s.ino,
      hash,
      format,
      target,
      error,
      classification: "protected-unknown",
      evidence: "No authenticated provenance established",
      git: "not-in-root-repository",
    };
    // Git index is inspected only for path status; hooks and project scripts never run.
    if (s.isDirectory() && path.endsWith("/.git")) {
      try {
        const repo = resolve(path, "..");
        const tracked = new Set(
          execFileSync(
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
                GIT_OPTIONAL_LOCKS: "0",
                GIT_CONFIG_NOSYSTEM: "1",
                HOME: "/nonexistent",
              },
            },
          )
            .toString()
            .split("\0"),
        );
        repos.set(repo, tracked);
      } catch {}
    }
    for (const [repo, tracked] of repos)
      if (path.startsWith(repo + "/"))
        row.git = tracked.has(relative(repo, path)) ? "tracked" : "untracked";
    await inventory.write(JSON.stringify(row) + "\n");
    await migration.write(
      JSON.stringify({
        source: path,
        destination: null,
        classification: row.classification,
        hash,
        action: "preserve",
        collision: false,
        evidence: row.evidence,
      }) + "\n",
    );
    count++;
    if (count % 10000 === 0)
      console.log(JSON.stringify({ entries: count, bytes, errors }));
  }
  await inventory.sync();
  await migration.sync();
  await inventory.close();
  await migration.close();
  console.log(
    JSON.stringify({
      entries: count,
      bytes,
      errors,
      status: "inventory-written",
      classification: "all protected pending evidence review",
    }),
  );
}
