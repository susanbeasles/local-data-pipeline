import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { search, receipt } from "./records.ts";
const [command, work, value, option = "0"] = process.argv.slice(2);
if (!work)
  throw Error("Usage: node pipeline/data.ts search|chunk|results /work [query|source] [offset]");
const db = new DatabaseSync(join(resolve(work), "state/pipeline.sqlite"), { readOnly: true });
try {
  db.exec("PRAGMA busy_timeout=1000");
  if (command === "search")
    console.log(JSON.stringify(search(db, value ?? "", 10, Number(option))));
  else if (command === "chunk") {
    const row = db
      .prepare("SELECT body,digest FROM chunk_data WHERE source=? AND n=?")
      .get(value, Number(option));
    if (!row) throw Error("missing chunk");
    if (
      createHash("sha256")
        .update(String(row.body) + "\n")
        .digest("hex") !== row.digest
    )
      throw Error("chunk data integrity mismatch");
    process.stdout.write(String(row.body) + "\n");
  } else if (command === "results") {
    for (const row of db
      .prepare("SELECT id,outputHash FROM jobs WHERE state='completed' ORDER BY id")
      .iterate())
      process.stdout.write(
        JSON.stringify(receipt(db, String(row.id), String(row.outputHash), 128 * 1024 ** 2)) + "\n",
      );
  } else throw Error("unknown data command");
} finally {
  db.close();
}
