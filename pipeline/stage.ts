import { readFile } from "node:fs/promises";
import { hash } from "./store.ts";
import type { Source } from "./source.ts";
export class Stage {
  readonly capacity: number;
  private entries = new Map<string, Promise<Source>>();
  constructor(capacity: number) {
    this.capacity = capacity;
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
      return JSON.parse(bytes.toString("utf8")) as Source;
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
