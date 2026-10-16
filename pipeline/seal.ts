import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { opendir, realpath, lstat, readlink } from "node:fs/promises";
import { join, relative } from "node:path";
export async function fileHash(path: string) {
  const h = createHash("sha256");
  for await (const bytes of createReadStream(path)) h.update(bytes);
  return h.digest("hex");
}
export async function seal(root: string, links = false) {
  root = await realpath(root);
  const files: Record<string, string> = {};
  async function visit(dir: string) {
    for await (const e of await opendir(dir)) {
      const path = join(dir, e.name);
      if (e.isDirectory()) await visit(path);
      else if (e.isFile()) files[relative(root, path)] = await fileHash(path);
      else if (links && e.isSymbolicLink()) {
        const target = await realpath(path);
        if (!(await lstat(target)).isFile())
          throw Error("runtime directory alias unsupported");
        files[relative(root, path)] =
          (await fileHash(target)) + ":" + (await readlink(path));
      } else throw Error("model seal rejects symlinks/special files");
    }
  }
  await visit(root);
  const h = createHash("sha256");
  for (const name of Object.keys(files).sort())
    h.update(JSON.stringify([name, files[name]]) + "\n");
  return { hash: h.digest("hex"), files };
}
