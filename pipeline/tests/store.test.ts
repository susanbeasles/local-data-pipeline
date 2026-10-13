import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store.ts";
test("group commits acknowledge only durable atomic state transitions", async () => {
  const root = await mkdtemp(join(tmpdir(), "commit-test-")),
    path = join(root, "state.sqlite"),
    store = new Store(path);
  store.db.exec("CREATE TABLE fixture(id INTEGER PRIMARY KEY)");
  await Promise.all([
    store.commit(() => {
      store.db.prepare("INSERT INTO fixture VALUES(?)").run(1);
    }),
    store.commit(() => {
      store.db.prepare("INSERT INTO fixture VALUES(?)").run(2);
    }),
  ]);
  store.close();
  const reopened = new Store(path);
  assert.equal(
    reopened.db.prepare("SELECT COUNT(*) n FROM fixture").get()!.n,
    2,
  );
  reopened.close();
});
test("failed commit batch rolls back every transition and acknowledges none", async () => {
  const root = await mkdtemp(join(tmpdir(), "rollback-test-")),
    store = new Store(join(root, "state.sqlite"));
  store.db.exec("CREATE TABLE fixture(id INTEGER PRIMARY KEY)");
  const results = await Promise.allSettled([
    store.commit(() => {
      store.db.exec("INSERT INTO fixture VALUES(1)");
    }),
    store.commit(() => {
      throw Error("controlled rollback");
    }),
  ]);
  assert.ok(results.every((r) => r.status === "rejected"));
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM fixture").get()!.n, 0);
  store.close();
});
