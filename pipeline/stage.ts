import { readFile, open, realpath } from "node:fs/promises";
import { hash, publish } from "./store.ts";
import type { Source, Chunk } from "./source.ts";
import type { Config } from "./run.ts";
type Index = Omit<Chunk, "text"> & {
  offset: number;
  bytes: number;
  recordHash: string;
};
export type Snapshot = Omit<Source, "chunks"> & { chunks: (Chunk | Index)[] };
export class Stage {
  readonly capacity: number;
  private entries = new Map<string, Promise<Snapshot>>();
  constructor(capacity: number) {
    this.capacity = capacity;
  }
  static async write(
    path: string,
    source: Source,
    context: Pick<Config, "roles" | "enrichment" | "profile"> & {
      configHash: string;
    },
  ) {
    if (!source.chunkFile) throw Error("chunk file required");
    const indexed =
      source.chunks.reduce((n, c) => n + Buffer.byteLength(c.text), 0) >
      16 * 1024 ** 2;
    const index: Index[] = [];
    function* rows() {
      let offset = 0;
      for (const c of source.chunks) {
        const line =
          JSON.stringify({
            source: source.id,
            sourceHash: source.hash,
            normalizedHash: source.normalizedHash,
            ...c,
          }) + "\n";
        const bytes = Buffer.byteLength(line);
        const { text: _text, ...metadata } = c;
        if (indexed)
          index.push({ ...metadata, offset, bytes, recordHash: hash(line) });
        offset += bytes;
        yield line;
      }
    }
    source.chunkHash = await publish(source.chunkFile, rows());
    return publish(path, [
      JSON.stringify({
        ...source,
        chunks: indexed ? index : source.chunks,
        ...context,
      }) + "\n",
    ]);
  }
  static async chunk(
    data: Snapshot,
    index: number,
  ): Promise<Chunk | undefined> {
    const pointer = data.chunks[index];
    if (!pointer) return undefined;
    if (!("offset" in pointer)) return pointer;
    if (
      !data.chunkFile ||
      !Number.isSafeInteger(pointer.offset) ||
      pointer.offset < 0 ||
      !Number.isSafeInteger(pointer.bytes) ||
      pointer.bytes < 1
    )
      throw Error("invalid indexed chunk bounds");
    if ((await realpath(data.chunkFile)) !== data.chunkFile)
      throw Error("aliased chunk file");
    const file = await open(data.chunkFile, "r");
    let bytes: Buffer;
    try {
      const info = await file.stat();
      if (
        pointer.offset > info.size ||
        pointer.bytes > info.size - pointer.offset
      )
        throw Error("incomplete chunk record");
      bytes = Buffer.alloc(pointer.bytes);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await file.read(
          bytes,
          offset,
          bytes.length - offset,
          pointer.offset + offset,
        );
        if (!result.bytesRead) throw Error("incomplete chunk record");
        offset += result.bytesRead;
      }
    } finally {
      await file.close();
    }
    if (hash(bytes) !== pointer.recordHash)
      throw Error("chunk record hash mismatch");
    const chunk = JSON.parse(bytes.toString("utf8"));
    if (
      chunk.id !== pointer.id ||
      chunk.index !== index ||
      chunk.hash !== pointer.hash ||
      chunk.start !== pointer.start ||
      chunk.end !== pointer.end ||
      chunk.source !== data.id ||
      chunk.sourceHash !== data.hash ||
      typeof chunk.text !== "string" ||
      hash(chunk.text) !== chunk.hash
    )
      throw Error("indexed chunk attribution mismatch");
    return chunk;
  }
  async read(id: string, path: string, digest: string) {
    let entry = this.entries.get(id);
    if (entry) {
      this.entries.delete(id);
      this.entries.set(id, entry);
      return entry;
    }
    entry = (async () => {
      const bytes = await readFile(path);
      if (hash(bytes) !== digest) throw Error("staging hash mismatch");
      const data = JSON.parse(bytes.toString("utf8")) as Snapshot;
      if (data.id !== id || !Array.isArray(data.chunks))
        throw Error("invalid staging snapshot");
      return data;
    })();
    this.entries.set(id, entry);
    while (this.entries.size > this.capacity)
      this.entries.delete(this.entries.keys().next().value!);
    try {
      return await entry;
    } catch (e) {
      this.entries.delete(id);
      throw e;
    }
  }
}
