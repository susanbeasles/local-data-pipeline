import type { Extractor } from "./extractor.ts";
import { opendir, lstat, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { relative, join } from "node:path";
import { hash } from "./store.ts";
import { chunks } from "./legacy/chunks.ts";
import { exclude } from "./legacy/extract.ts";
export type Chunk = {
  id: string;
  index: number;
  start: number;
  end: number;
  text: string;
  hash: string;
};
export type Source = {
  id: string;
  path: string;
  hash: string | null;
  state: "pending" | "invalid" | "unsupported" | "failed";
  reason?: string;
  format?: string;
  normalizedHash?: string;
  chunkFile?: string;
  chunkHash?: string;
  chunks: Chunk[];
};
export async function* discover(
  root: string,
  dir = root,
): AsyncGenerator<string> {
  const entries = [];
  for await (const e of await opendir(dir)) entries.push(e);
  entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* discover(root, p);
    else yield p;
  }
}
export async function source(
  root: string,
  path: string,
  maxBytes: number,
  size: number,
  extractor?: Extractor,
): Promise<Source> {
  const name = relative(root, path),
    info = await lstat(path),
    id = hash(name);
  const row: Source = {
    id,
    path: name,
    hash: null,
    state: "pending",
    chunks: [],
  };
  if (!info.isFile()) {
    row.state = "unsupported";
    row.reason = "symlinks and special files are not followed";
    return row;
  }
  const denied = exclude(path);
  if (denied) {
    row.state = "unsupported";
    row.reason = denied;
    return row;
  }
  const f = await open(path, "r"),
    h = createHash("sha256");
  const blocks: Buffer[] = [];
  let bytes = 0,
    binary = false;
  try {
    for await (const b of f.createReadStream()) {
      if (!extractor) {
        binary ||=
          b.includes(0) ||
          (bytes === 0 &&
            (b.subarray(0, 4).toString() === "%PDF" ||
              b.subarray(0, 2).toString() === "PK"));
      }
      h.update(b);
      bytes += b.length;
      if (bytes <= maxBytes) blocks.push(Buffer.from(b));
      else blocks.length = 0;
    }
    row.hash = h.digest("hex");
  } finally {
    await f.close();
  }
  const after = await lstat(path);
  if (
    after.ino !== info.ino ||
    after.size !== info.size ||
    after.mtimeMs !== info.mtimeMs
  ) {
    row.state = "invalid";
    row.reason = "source changed during extraction";
    return row;
  }
  if (!extractor && binary) {
    row.state = "unsupported";
    row.reason = "binary format has no installed extractor";
    return row;
  }
  if (bytes > maxBytes) {
    row.state = "failed";
    row.reason =
      "source memory budget exceeded; increase maxBytes or provide streaming extractor";
    return row;
  }
  const raw = Buffer.concat(blocks);
  let text: string;
  if (extractor) {
    const result = await extractor.extract({ path: name, bytes: raw });
    if (
      result &&
      typeof result === "object" &&
      "unsupported" in result &&
      typeof result.unsupported === "string"
    ) {
      row.state = "unsupported";
      row.reason = result.unsupported;
      return row;
    }
    if (
      !result ||
      !("text" in result) ||
      typeof result.text !== "string" ||
      typeof result.format !== "string" ||
      !result.format
    )
      throw Error("invalid extractor result");
    text = result.text;
    row.format = result.format;
    if (Buffer.byteLength(text) > maxBytes) {
      row.state = "failed";
      row.reason = "normalized extraction exceeds memory budget";
      return row;
    }
  } else {
    if (
      raw.includes(0) ||
      raw.subarray(0, 4).toString() === "%PDF" ||
      raw.subarray(0, 2).toString() === "PK"
    ) {
      row.state = "unsupported";
      row.reason = "binary format has no installed extractor";
      return row;
    }

    try {
      text = new TextDecoder("utf8", { fatal: true }).decode(raw);
    } catch {
      row.state = "invalid";
      row.reason = "invalid UTF-8";
      return row;
    }
    if (/[\u0001-\u0008\u000b\u000e-\u001f\u007f]/.test(text)) {
      row.state = "unsupported";
      row.reason = "binary control characters detected";
      return row;
    }
  }
  text = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (!extractor && name.endsWith(".jsonl")) {
    try {
      for (const line of text.split("\n")) if (line.trim()) JSON.parse(line);
    } catch {
      row.state = "invalid";
      row.reason = "malformed JSONL";
      return row;
    }
  }
  row.normalizedHash = hash(text);
  for (const c of chunks(row.hash!, text, "text", size))
    row.chunks.push({
      id: hash(id + ":" + c.id),
      index: c.ordinal,
      start: c.start,
      end: c.end,
      text: c.text,
      hash: c.hash,
    });
  if (!row.chunks.length)
    row.chunks.push({
      id: hash(id + ":" + row.hash + ":empty"),
      index: 0,
      start: 0,
      end: 0,
      text: "",
      hash: hash(""),
    });
  return row;
}
