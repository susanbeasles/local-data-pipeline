/** Deterministic local source separation; reads manifests as metadata, never instructions. */
import { DatabaseSync } from "node:sqlite";
import { createReadStream, constants } from "node:fs";
import { createInterface } from "node:readline";
import {
  mkdir,
  lstat,
  realpath,
  copyFile,
  rename,
  chmod,
  access,
  readdir,
} from "node:fs/promises";
import { join, resolve, relative, dirname, sep } from "node:path";
import { hash, atomic } from "./store.ts";
import { fileHash } from "./seal.ts";
import { exclude } from "./legacy/extract.ts";
import { launch, assertNetworkDenied } from "./sandbox.ts";
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return join(await canonical(dirname(path)), path.split(sep).at(-1)!);
  }
}
async function directory(path: string) {
  if ((await canonical(path)) !== path)
    throw Error("aliased curation directory");
  await mkdir(path, { recursive: true });
  if ((await realpath(path)) !== path)
    throw Error("aliased curation directory");
}
export async function curate(source: string, work: string) {
  source = await realpath(source);
  work = await canonical(resolve(work));
  if (
    work === source ||
    work.startsWith(source + sep) ||
    source.startsWith(work + sep)
  )
    throw Error("curation/source overlap");
  await directory(join(work, "state"));
  const db = new DatabaseSync(join(work, "state/curation.sqlite"));
  db.exec(
    `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS entries(path TEXT PRIMARY KEY, mask INTEGER NOT NULL, uncertain INTEGER NOT NULL, expected TEXT, bytes INTEGER, state TEXT NOT NULL DEFAULT 'pending',reason TEXT,destination TEXT,digest TEXT); CREATE TABLE IF NOT EXISTS manifests(path TEXT PRIMARY KEY,digest TEXT NOT NULL);`,
  );
  try {
    for (const [pile, mask] of [
      ["SonarMD", 1],
      ["Anthony", 2],
    ] as const) {
      const file = join(source, pile, "manifest.jsonl"),
        digest = await fileHash(file);
      const previous = db
        .prepare("SELECT digest FROM manifests WHERE path=?")
        .get(pile);
      if (previous) {
        if (previous.digest !== digest)
          throw Error("source manifest changed; use a new curation directory");
        continue;
      }
      let n = 0;
      db.exec("BEGIN IMMEDIATE");
      try {
        for await (const line of createInterface({
          input: createReadStream(file),
          crlfDelay: Infinity,
        })) {
          if (!line.trim()) continue;
          const r = JSON.parse(line);
          if (
            typeof r.archivePath !== "string" ||
            !r.archivePath ||
            r.archivePath.startsWith("/") ||
            r.archivePath
              .split("/")
              .some((x: string) => x === ".." || x === "." || x === "") ||
            !["raw", "remote", "git"].includes(r.archivePath.split("/")[0])
          )
            throw Error("invalid archive path in source manifest");
          const uncertain =
            r.bucket === "review" ||
            r.bucket === "both" ||
            r.unstable === true ||
            r.kind === "retained-source-symlink";
          const expected =
            typeof r.sha256 === "string" && /^[a-f0-9]{64}$/.test(r.sha256)
              ? r.sha256
              : null;
          db.prepare(
            `INSERT INTO entries(path,mask,uncertain,expected,bytes) VALUES(?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET mask=mask|excluded.mask,uncertain=max(uncertain,excluded.uncertain,CASE WHEN bytes!=excluded.bytes OR (expected IS NOT NULL AND excluded.expected IS NOT NULL AND expected!=excluded.expected) THEN 1 ELSE 0 END)`,
          ).run(
            r.archivePath,
            mask,
            uncertain ? 1 : 0,
            expected,
            Number.isSafeInteger(r.bytes) ? r.bytes : null,
          );
          if (++n % 5000 === 0) {
            db.exec("COMMIT");
            console.log(
              JSON.stringify({ phase: "manifest-index", pile, records: n }),
            );
            db.exec("BEGIN IMMEDIATE");
          }
        }
        db.prepare("INSERT INTO manifests VALUES(?,?)").run(pile, digest);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }
    db.prepare(
      "UPDATE entries SET state='protected',reason='shared or ambiguous split; original preserved' WHERE mask=3 OR uncertain=1",
    ).run();
    await directory(join(work, "staging"));
    for (const pile of ["SonarMD", "avespoli"])
      await directory(join(work, "input", pile));
    let done = 0,
      cursor = "";
    for (;;) {
      const rows = db
        .prepare(
          "SELECT * FROM entries WHERE state IN ('pending','copied') AND path>? ORDER BY path LIMIT 100",
        )
        .all(cursor);
      if (!rows.length) break;
      for (const row of rows) {
        cursor = String(row.path);
        const path = join(source, String(row.path)),
          pile = row.mask === 1 ? "SonarMD" : "avespoli",
          dest = join(work, "input", pile, String(row.path)),
          temp = join(work, "staging", hash(String(row.path)) + ".copy");
        try {
          const info = await lstat(path);
          if (!info.isFile() || (await realpath(path)) !== path)
            throw Error("symlink/special source protected");
          const denied = exclude(path);
          if (denied) throw Error(denied);
          if (/(?:\.DS_Store|\.(?:part|tmp))$/.test(path))
            throw Error("metadata or incomplete artifact protected");
          if (row.bytes !== null && row.bytes !== info.size)
            throw Error("source size no longer matches manifest");
          await directory(dirname(dest));
          let existing = false;
          try {
            await access(dest);
            existing = true;
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          }
          if (!existing) {
            try {
              await copyFile(
                path,
                temp,
                constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL,
              );
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
            }
          }
          const candidate = existing ? dest : temp;
          const candidateInfo = await lstat(candidate);
          if (
            !candidateInfo.isFile() ||
            candidateInfo.nlink !== 1 ||
            (await realpath(candidate)) !== candidate ||
            (candidateInfo.dev === info.dev && candidateInfo.ino === info.ino)
          )
            throw Error("destination is not an independent regular copy");
          const original = await fileHash(path),
            copied = await fileHash(existing ? dest : temp),
            after = await lstat(path);
          if (
            original !== copied ||
            (row.expected && row.expected !== original) ||
            info.ino !== after.ino ||
            info.size !== after.size ||
            info.mtimeMs !== after.mtimeMs
          )
            throw Error("copy/source/hash integrity mismatch");
          if (!existing) {
            await directory(dirname(dest));
            await rename(temp, dest);
          }
          await chmod(dest, 0o444);
          if ((await lstat(dest)).mode & 0o222)
            throw Error("copy is not read-only");
          db.prepare(
            "UPDATE entries SET state='copied',destination=?,digest=? WHERE path=?",
          ).run(dest, original, row.path);
        } catch (e) {
          let published = false;
          try {
            await lstat(dest);
            published = true;
          } catch {}
          db.prepare(
            "UPDATE entries SET state=?,reason=?,destination=? WHERE path=?",
          ).run(
            published || row.state === "copied" ? "invalid" : "protected",
            String(e),
            published ? dest : row.destination,
            row.path,
          );
        }
        if (++done % 100 === 0)
          console.log(
            JSON.stringify({
              phase: "verified-copy",
              processed: done,
              ...db
                .prepare(
                  "SELECT count(*) total,sum(state='copied') copied,sum(state='protected') protected,sum(state='pending') pending FROM entries",
                )
                .get(),
            }),
          );
      }
    }
    db.exec(
      "CREATE TABLE IF NOT EXISTS unexpected(path TEXT PRIMARY KEY,reason TEXT NOT NULL)",
    );
    db.exec("DELETE FROM unexpected");
    async function inspect(path: string): Promise<void> {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const file = join(path, entry.name);
        if (entry.isDirectory()) await inspect(file);
        else if (
          !entry.isFile() ||
          !db
            .prepare(
              "SELECT 1 FROM entries WHERE destination=? AND state='copied'",
            )
            .get(file)
        )
          db.prepare("INSERT INTO unexpected VALUES(?,?)").run(
            file,
            "untracked or nonregular input; preserved",
          );
      }
    }
    for (const pile of ["SonarMD", "avespoli"])
      await inspect(join(work, "input", pile));
    const report = {
      unexpected: db.prepare("SELECT * FROM unexpected ORDER BY path").all(),
      integrity:
        !db.prepare("SELECT 1 FROM unexpected LIMIT 1").get() &&
        !db
          .prepare("SELECT 1 FROM entries WHERE state='invalid' LIMIT 1")
          .get(),
      source,
      work,
      manifests: db.prepare("SELECT * FROM manifests").all(),
      counts: db
        .prepare(
          "SELECT state,mask,count(*) files,sum(bytes) bytes FROM entries GROUP BY state,mask",
        )
        .all(),
      inputs: {
        SonarMD: join(work, "input/SonarMD"),
        avespoli: join(work, "input/avespoli"),
      },
      policy:
        "Existing exclusive source memberships only. Shared, ambiguous, aliases, incomplete, protected and integrity failures remain at their original paths, recorded in curation.sqlite. No source files moved or modified.",
    };
    await atomic(join(work, "state/curation-report.json"), report);
    return report;
  } finally {
    db.close();
  }
}
if (process.argv[1] === import.meta.filename) {
  const [source, work, guarded] = process.argv.slice(2);
  if (!source || !work)
    throw Error(
      "Usage: node pipeline/curate.ts /source-dump /new-curation-directory",
    );
  if (guarded === "guarded") {
    await assertNetworkDenied();
    const report = await curate(source, work);
    console.log(JSON.stringify(report));
    if (!report.integrity) process.exitCode = 1;
  } else
    process.exitCode = await launch(
      resolve(source),
      resolve(work),
      import.meta.filename,
      [resolve(source), resolve(work), "guarded"],
    );
}
