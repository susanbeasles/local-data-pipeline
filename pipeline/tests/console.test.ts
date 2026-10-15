import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store, hash } from "../store.ts";
import { consoleServer } from "../console.ts";
import { review, gates } from "../review.ts";
test("loopback console authenticates browsing and rejects arbitrary database access", async () => {
  const work = await mkdtemp(join(tmpdir(), "console-"));
  await mkdir(join(work, "state"));
  const store = new Store(join(work, "state/pipeline.sqlite"));
  store.close();
  const app = await consoleServer(work);
  try {
    const page = await fetch(app.origin);
    assert.equal(page.status, 200);
    assert.ok(page.headers.get("content-security-policy")?.includes("frame-ancestors 'none'"));
    assert.equal((await fetch(app.origin + "/api/status")).status, 403);
    const headers = { Authorization: "Bearer " + app.token };
    assert.equal((await fetch(app.origin + "/api/status", { headers })).status, 200);
    assert.equal(
      (await fetch(app.origin + "/api/rows?table=sqlite_master", { headers })).status,
      400,
    );
    assert.equal(
      (
        await fetch(app.origin + "/api/status", {
          headers: { ...headers, Origin: "https://outside.example" },
        })
      ).status,
      403,
    );
  } finally {
    await app.close();
  }
});
test("console decisions affect only durable review ledger and rejects corrupted receipts", async () => {
  const work = await mkdtemp(join(tmpdir(), "console-decide-"));
  await mkdir(join(work, "state"));
  await mkdir(join(work, "output"));
  const store = new Store(join(work, "state/pipeline.sqlite"));
  const id = "a".repeat(64),
    path = join(work, "output/receipt.json"),
    bytes = JSON.stringify({ job: id, result: { text: "<script>evil</script>" } });
  await writeFile(path, bytes);
  store.db
    .prepare(
      "INSERT INTO jobs(id,source,chunk,role,config,state,output,outputHash) VALUES(?,'source',0,'extract','scope','completed',?,?)",
    )
    .run(id, path, store.records.write(id, JSON.parse(bytes)));
  store.close();
  const app = await consoleServer(work);
  const pending = review(work, "extract", "scope", [
    { id, state: "completed", attempt: 1, outputHash: hash(bytes) },
  ]);
  try {
    let gate;
    for (let i = 0; i < 100; i++) {
      gate = (await gates(work)).find((r) => r.state === "waiting");
      if (gate) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(gate);
    const headers = { Authorization: "Bearer " + app.token, "Content-Type": "application/json" };
    const receipt = await fetch(app.origin + "/api/receipt?id=" + id, { headers });
    assert.equal(receipt.status, 200);
    assert.equal((await receipt.json()).result.text, "<script>evil</script>");
    const r = await fetch(app.origin + "/api/decision", {
      method: "POST",
      headers,
      body: JSON.stringify({ id: gate.id, decision: "approve" }),
    });
    assert.equal(r.status, 200);
    assert.equal(await pending, "approve");
    const corrupt = new Store(join(work, "state/pipeline.sqlite"));
    corrupt.db.exec("UPDATE results SET body=json_set(body,'$.result.text','corrupt')");
    corrupt.close();
    assert.equal((await fetch(app.origin + "/api/receipt?id=" + id, { headers })).status, 400);
  } finally {
    const waiting = (await gates(work)).find((r) => r.state === "waiting");
    if (waiting) {
      const { decide } = await import("../review.ts");
      decide(work, String(waiting.id), "reject");
      await pending;
    }
    await app.close();
  }
});
