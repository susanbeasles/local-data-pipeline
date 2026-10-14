import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
test("tracked source and examples do not embed macOS account homes", async () => {
  const root = resolve(import.meta.dirname, "../..");
  const offenders: string[] = [];
  async function scan(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await scan(file);
      else if (
        /\.(ts|py|swift|json|md|txt)$/.test(entry.name) &&
        /\/Users\/[A-Za-z0-9._-]+/.test(await readFile(file, "utf8"))
      )
        offenders.push(file);
    }
  }
  for (const name of ["pipeline", "config", "native", "docs"]) await scan(join(root, name));
  assert.deepEqual(offenders, []);
});
