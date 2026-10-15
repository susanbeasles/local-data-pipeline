import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { progress } from "../platform-worker.ts";

test("worker progress contains execution identifiers and status without adapter error payloads", () => {
  const value = progress({
    run: "run",
    task: "task",
    attempt: "attempt",
    status: "failed",
    error: "sensitive source payload",
  });
  assert.deepEqual(value, {
    type: "task",
    run: "run",
    task: "task",
    attempt: "attempt",
    status: "failed",
  });
  assert.equal(JSON.stringify(value).includes("sensitive"), false);
});

test("worker launcher rejects absent input roots before attempting database or model startup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "platform-worker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "operator.json");
  const scope = {
    workspace: "11111111-1111-4111-8111-111111111111",
    project: "22222222-2222-4222-8222-222222222222",
    principal: "33333333-3333-4333-8333-333333333333",
  };
  await writeFile(
    file,
    JSON.stringify({
      format: "platform/1",
      state: join(root, "state"),
      scope,
      policy: {
        scope: { workspace: scope.workspace, project: scope.project, owner: scope.principal },
        capabilities: [],
        grants: [],
        budget: {
          cpuMs: 1,
          memoryBytes: 1,
          storageBytes: 0,
          timeMs: 1,
          tokens: 0,
          costMicros: 0,
          concurrency: 1,
        },
      },
      database: { socket: join(root, "state/socket"), database: "platform", user: "platform" },
      catalog: [],
    }),
  );
  const result = await new Promise<{ code: number | null; stdout: string }>((done, reject) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../platform-worker.ts", import.meta.url)), file],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", (code) => done({ code, stdout }));
  });
  assert.equal(result.code, 1);
  assert.match(JSON.parse(result.stdout).error.message, /input root.*required/i);
});
