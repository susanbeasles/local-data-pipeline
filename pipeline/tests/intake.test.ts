import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rename,
  mkdir,
  rm,
  stat,
  symlink,
  writeFile,
  realpath,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Intake, type Task } from "../intake.ts";
import { hash } from "../store.ts";
const task = (name: string): Task => ({
  id: hash(name),
  name,
  cloudId: "synthetic",
  inputs: {},
  kind: "fixture",
  scope: "test",
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "intake-test-")));
  return { root, intake: await Intake.open(root) };
}
test("full nested Unicode connector response survives SQLite and JSONL with atomic children", async () => {
  const { root, intake } = await fixture();
  const parent = task("parent"),
    child = task("child");
  const response = {
    content: [{ text: 'こんにちは 🌍\n"quoted"', nested: [null, false, { n: 1 }] }],
    next: "cursor",
  };
  try {
    intake.seed([parent]);
    await intake.accept(parent, response, [child]);
    assert.deepEqual(intake.pending(), [child]);
    assert.deepEqual(intake.status(), { pending: 1, accepted: 1, failed: 0, unpublished: 0 });
    const db = new DatabaseSync(join(root, "state/intake.sqlite"));
    const row = db.prepare("SELECT response FROM receipts").get()!;
    assert.deepEqual(JSON.parse(String(row.response)), response);
    assert.equal(
      await readFile(join(root, "staging", parent.id + ".jsonl"), "utf8"),
      String(row.response) + "\n",
    );
    db.close();
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(join(root, "state/intake.sqlite"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, "staging", parent.id + ".jsonl"))).mode & 0o777, 0o600);
    await intake.accept(parent, response, [child]);
    await assert.rejects(intake.accept(parent, { changed: true }, [child]), /conflicting receipt/);
    assert.equal(intake.status().pending, 1);
  } finally {
    intake.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("invalid children roll back response and queue together", async () => {
  const { root, intake } = await fixture();
  const parent = task("parent");
  try {
    intake.seed([parent]);
    await assert.rejects(
      intake.accept(parent, {}, [task("valid"), { ...task("bad"), id: "../bad" }]),
      /identifier/,
    );
    assert.deepEqual(intake.pending(), [parent]);
    assert.equal(intake.status().accepted, 0);
  } finally {
    intake.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("restart recovers a failed publication locally without refetch or duplicated children", async () => {
  const { root, intake } = await fixture();
  const parent = task("parent"),
    child = task("child");
  await rename(join(root, "staging"), join(root, "saved"));
  await import("node:fs/promises").then((fs) => fs.writeFile(join(root, "staging"), "blocked"));
  await assert.rejects(intake.accept(parent, { full: ["response"] }, [child]));
  assert.deepEqual(intake.pending(), [child]);
  assert.equal(intake.status().unpublished, 1);
  intake.close();
  await rm(join(root, "staging"));
  await mkdir(join(root, "staging"), { mode: 0o700 });
  const reopened = await Intake.open(root);
  try {
    await reopened.recover();
    await reopened.recover();
    assert.deepEqual(
      JSON.parse(await readFile(join(root, "staging", parent.id + ".jsonl"), "utf8")),
      { full: ["response"] },
    );
    assert.deepEqual(reopened.pending(), [child]);
    assert.equal(reopened.status().unpublished, 0);
  } finally {
    reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("corrupted saved response is rejected during recovery and duplicate acceptance", async () => {
  const { root, intake } = await fixture();
  const parent = task("parent");
  try {
    await intake.accept(parent, { value: "original" }, []);
    const db = new DatabaseSync(join(root, "state/intake.sqlite"));
    db.prepare("UPDATE receipts SET response=?, published=0").run('{"value":"corrupted"}');
    db.close();
    await assert.rejects(intake.recover(), /corrupt receipt/);
    await assert.rejects(intake.accept(parent, { value: "original" }, []), /corrupt receipt/);
    assert.deepEqual(
      JSON.parse(await readFile(join(root, "staging", parent.id + ".jsonl"), "utf8")),
      { value: "original" },
    );
  } finally {
    intake.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("failed receipts retain raw response and are not scheduled again", async () => {
  const { root, intake } = await fixture();
  const parent = task("parent");
  try {
    await intake.fail(parent, { isError: true, content: ["synthetic failure"] }, "connector error");
    assert.deepEqual(intake.pending(), []);
    assert.equal(intake.status().failed, 1);
    await intake.fail(parent, { isError: true, content: ["synthetic failure"] }, "connector error");
  } finally {
    intake.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("verify checks every actual mirror and detects missing or altered published files", async () => {
  const { root, intake } = await fixture();
  const parent = task("verify");
  try {
    await intake.accept(parent, { nested: ["🌍"] }, []);
    assert.deepEqual(await intake.verify(), { receipts: 1, mirrors: 1 });
    const mirror = join(root, "staging", parent.id + ".jsonl");
    await writeFile(mirror, "{}\n");
    await assert.rejects(intake.verify(), /corrupt receipt mirror/);
    await rm(mirror);
    await assert.rejects(intake.verify(), { code: "ENOENT" });
  } finally {
    intake.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("verify detects missing receipt ownership in either direction", async () => {
  const { root, intake } = await fixture();
  const parent = task("ownership");
  try {
    await intake.accept(parent, {}, []);
    const db = new DatabaseSync(join(root, "state/intake.sqlite"));
    db.exec("PRAGMA foreign_keys=OFF");
    db.prepare("DELETE FROM jobs WHERE id=?").run(parent.id);
    await assert.rejects(intake.verify(), /ownership/);
    db.prepare("INSERT INTO jobs(id,task,state) VALUES(?,?,'accepted')").run(
      parent.id,
      JSON.stringify(parent),
    );
    db.prepare("DELETE FROM receipts WHERE id=?").run(parent.id);
    db.close();
    await assert.rejects(intake.verify(), /ownership/);
  } finally {
    intake.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("aliased roots, ancestors, directories, and databases fail before permission changes", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "intake-alias-")));
  const target = join(base, "target");
  await mkdir(target, { mode: 0o755 });
  await chmod(target, 0o755);
  const link = join(base, "link");
  await symlink(target, link);
  try {
    await assert.rejects(Intake.open(link), /aliased/);
    await assert.rejects(Intake.open(join(link, "nested")), /aliased/);
    assert.equal((await stat(target)).mode & 0o777, 0o755);
    for (const name of ["state", "staging", "database"]) {
      const root = join(base, name);
      await mkdir(root, { mode: 0o755 });
      await chmod(root, 0o755);
      if (name === "database") {
        await mkdir(join(root, "state"), { mode: 0o755 });
        const file = join(target, "fixture.sqlite");
        await writeFile(file, "", { mode: 0o644 });
        await chmod(file, 0o644);
        await symlink(file, join(root, "state/intake.sqlite"));
        await assert.rejects(Intake.open(root), /aliased/);
        assert.equal((await stat(file)).mode & 0o777, 0o644);
      } else {
        await symlink(target, join(root, name));
        await assert.rejects(Intake.open(root), /aliased/);
      }
      assert.equal((await stat(root)).mode & 0o777, 0o755);
      assert.equal((await stat(target)).mode & 0o777, 0o755);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
