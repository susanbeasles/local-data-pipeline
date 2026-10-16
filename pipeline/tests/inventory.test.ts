import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
test("inventory never executes a repository-configured fsmonitor hook", async () => {
  const root = await mkdtemp(join(tmpdir(), "inventory-hooks-")),
    input = join(root, "input"),
    output = join(root, "inventory"),
    marker = join(root, "executed");
  await mkdir(input);
  execFileSync("/usr/bin/git", ["init", input], { stdio: "ignore" });
  const hook = join(input, ".git", "hooks", "monitor");
  await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\nprintf '1\\0'\n`, {
    mode: 0o755,
  });
  execFileSync("/usr/bin/git", ["-C", input, "config", "core.fsmonitor", hook]);
  await writeFile(join(input, "text"), "fixture");
  execFileSync(
    process.execPath,
    [new URL("../inventory.ts", import.meta.url).pathname, input, output],
    { stdio: "pipe" },
  );
  await assert.rejects(access(marker));
  const rows = (await readFile(join(output, "inventory.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(rows.some((r) => r.path === "text" && r.hash.length === 64));
});
