import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { preserve, restore, verify, policy } from "../preserve.ts";

test("preservation restores hidden files, binary bytes, symlinks and complete local Git history", async () => {
  const root = await mkdtemp(join(tmpdir(), "preserve-"));
  const input = join(root, "input"),
    work = join(root, "saved"),
    output = join(root, "restored");
  await mkdir(input);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.fsmonitor=false", "-C", input, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
  git("init", "-q");
  await writeFile(join(input, "file.txt"), "first version\n");
  git("add", "file.txt");
  const commit = (message: string) =>
    git(
      "-c",
      "user.name=Synthetic",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      message,
    );
  commit("first");
  git("branch", "history");
  git("tag", "v1");
  await writeFile(join(input, "file.txt"), "second version\n");
  git("add", "file.txt");
  commit("second");
  git("gc", "--prune=never");
  await writeFile(join(input, ".hidden"), Buffer.from([0, 255, 1, 128]));
  await mkdir(join(input, "empty"));
  await symlink("file.txt", join(input, "link"));
  const head = git("rev-parse", "HEAD");
  const report = JSON.parse(
    execFileSync(
      process.execPath,
      [join(import.meta.dirname, "../preserve.ts"), "capture", input, work],
      { encoding: "utf8" },
    ),
  );
  assert.equal(report.complete, true);
  assert.equal(report.repositories, 1);
  await restore(work, output);
  await rename(input, join(root, "retained-original"));
  assert.deepEqual(await readFile(join(output, ".hidden")), Buffer.from([0, 255, 1, 128]));
  assert.equal(
    execFileSync("git", ["-C", output, "show", "v1:file.txt"], { encoding: "utf8" }),
    "first version\n",
  );
  assert.equal(
    execFileSync("git", ["-C", output, "rev-parse", "HEAD"], { encoding: "utf8" }),
    head,
  );
  await rename(join(root, "retained-original"), input);
  await rm(join(work, "content"), { recursive: true });
  await assert.rejects(verify(input, work), /ENOENT|mirror/);
});

test("missing Git dependencies and changed sources cannot be certified", async () => {
  const root = await mkdtemp(join(tmpdir(), "preserve-bad-")),
    input = join(root, "input"),
    work = join(root, "saved");
  await mkdir(input);
  await writeFile(join(input, "a"), "original");
  await preserve(input, work);
  await writeFile(join(input, "a"), "modified");
  await assert.rejects(verify(input, work), /changed|hash|inventory/);
  await writeFile(join(input, ".git"), "gitdir: ../outside\n");
  await assert.rejects(preserve(input, join(root, "external")), /Git|git|outside|external/);
  const db = new DatabaseSync(join(work, "preservation.sqlite"), { readOnly: true });
  assert.ok(db.prepare("SELECT count(*) n FROM entries").get()!.n);
  db.close();
});

test("preservation rejects nested output before placing artifacts inside input", async () => {
  const root = await mkdtemp(join(tmpdir(), "preserve-boundary-"));
  const input = join(root, "input");
  await mkdir(input);
  await assert.rejects(preserve(input, join(input, "generated")), /separate trees/);
  await assert.rejects(readFile(join(input, "generated", "report.json")), /ENOENT/);
});

test("production CLI captures and restores inside OS network-denied read-only-input boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "preserve-cli-")),
    input = join(root, "input"),
    work = join(root, "saved"),
    out = join(root, "restored");
  await mkdir(input);
  await writeFile(join(input, "x"), "complete synthetic data");
  const entry = join(import.meta.dirname, "../preserve.ts");
  execFileSync(process.execPath, [entry, "capture", input, work], { stdio: "pipe" });
  execFileSync(process.execPath, [entry, "restore", work, out], { stdio: "pipe" });
  assert.equal(await readFile(join(out, "x"), "utf8"), "complete synthetic data");
});

test("a relocated archive restores without its original archive location", async () => {
  const root = await mkdtemp(join(tmpdir(), "preserve-move-")),
    input = join(root, "input"),
    work = join(root, "saved"),
    moved = join(root, "moved"),
    out = join(root, "restored");
  await mkdir(input);
  await writeFile(join(input, "file"), "all bytes");
  await preserve(input, work);
  await rename(work, moved);
  await restore(moved, out);
  assert.equal(await readFile(join(out, "file"), "utf8"), "all bytes");
});

test("external symlinked Git objects cannot receive a complete preservation report", async () => {
  const root = await mkdtemp(join(tmpdir(), "preserve-objects-")),
    input = join(root, "input"),
    work = join(root, "saved");
  await mkdir(input);
  execFileSync("git", ["init", "-q", input], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  await rename(join(input, ".git/objects"), join(root, "external-objects"));
  await symlink(join(root, "external-objects"), join(input, ".git/objects"));
  await assert.rejects(preserve(input, work), /Git storage symlinks/);
  assert.equal(JSON.parse(await readFile(join(work, "report.json"), "utf8")).complete, false);
});

test("damaged bare repositories are not silently reclassified as ordinary files", async () => {
  const root = await mkdtemp(join(tmpdir(), "preserve-bare-")),
    input = join(root, "input"),
    work = join(root, "saved");
  execFileSync("git", ["init", "--bare", "-q", input], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  await rm(join(input, "objects"), { recursive: true });
  await assert.rejects(preserve(input, work), /git|Git/);
  assert.equal(JSON.parse(await readFile(join(work, "report.json"), "utf8")).complete, false);
});

test("Git null-device access does not permit source or unrelated filesystem writes or networking", async () => {
  const root = await mkdtemp(join(tmpdir(), "preserve-guard-")),
    input = join(root, "input"),
    work = join(root, "saved");
  await mkdir(input);
  await mkdir(work);
  await writeFile(join(input, "original"), "keep");
  const code = `const fs=require('node:fs');for(const p of ${JSON.stringify([join(input, "original"), join(root, "outside")])}){try{fs.writeFileSync(p,'bad');process.exit(3)}catch(e){if(e.code!=='EPERM')throw e}}const fd=fs.openSync('/dev/null','r+');fs.closeSync(fd);fs.writeFileSync(${JSON.stringify(join(work, "ok"))},'yes');const s=require('node:net').connect(9,'127.0.0.1');s.on('error',e=>process.exit(e.code==='EPERM'?0:4));`;
  execFileSync("/usr/bin/sandbox-exec", [
    "-p",
    await policy(input, work),
    process.execPath,
    "-e",
    code,
  ]);
  assert.equal(await readFile(join(input, "original"), "utf8"), "keep");
});
