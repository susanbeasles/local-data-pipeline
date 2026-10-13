import { realpath } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { seal } from "./seal.ts";
import { assertNetworkDenied } from "./sandbox.ts";
export type Extraction =
  | { text: string; format: string }
  | { unsupported: string };
export type Extractor = {
  extract(source: {
    path: string;
    bytes: Readonly<Uint8Array>;
  }): Promise<Extraction> | Extraction;
};
export type Extension = { directory: string; entry: string; hash: string };
/** Extensions are operator-authored local application code, never discovered in input. */
export async function inspect(extension: Extension, input: string) {
  const directory = await realpath(extension.directory),
    corpus = await realpath(input);
  if (
    directory === corpus ||
    directory.startsWith(corpus + sep) ||
    corpus.startsWith(directory + sep)
  )
    throw Error("extractor/input overlap");
  const entry = await realpath(resolve(directory, extension.entry));
  if (
    relative(directory, entry).startsWith("..") ||
    entry !== resolve(directory, extension.entry) ||
    ![".ts", ".mjs"].some((s) => entry.endsWith(s))
  )
    throw Error("invalid extractor entry");
  const actual = await seal(directory);
  if (actual.hash !== extension.hash)
    throw Error("extractor integrity mismatch");
  return { directory, entry, hash: actual.hash };
}
export async function load(
  extension: Extension,
  input: string,
): Promise<Extractor> {
  await assertNetworkDenied();
  const info = await inspect(extension, input);
  const module = await import(
    pathToFileURL(info.entry).href + "?seal=" + info.hash
  );
  if (typeof module.extract !== "function")
    throw Error("extractor must export extract()");
  await inspect(extension, input);
  return { extract: module.extract };
}

if (process.argv[1] === import.meta.filename) {
  const [command, directory, entry = "main.ts"] = process.argv.slice(2);
  if (command !== "seal" || !directory)
    throw Error(
      "Usage: node pipeline/extractor.ts seal /absolute/extension [entry.ts]",
    );
  const path = await realpath(directory);
  const actual = await seal(path);
  console.log(
    JSON.stringify({ directory: path, entry, hash: actual.hash }, null, 2),
  );
}
