/** Capability contracts; registering a descriptor does not implement an adapter. */
import type { Destination } from "./destination.ts";
export type Operation =
  | "read"
  | "write"
  | "append"
  | "query"
  | "transaction"
  | "snapshot"
  | "restore";
export type Adapter = {
  id: string;
  version: string;
  family: "database" | "file" | "object";
  operations: Operation[];
  locations: Destination["kind"][];
  verified: boolean;
};
export type Format = Readonly<
  Omit<Adapter, "operations" | "locations"> & {
    operations: readonly Operation[];
    locations: readonly Destination["kind"][];
  }
>;
const operations: Operation[] = [
  "read",
  "write",
  "append",
  "query",
  "transaction",
  "snapshot",
  "restore",
];
const locations: Destination["kind"][] = [
  "volume",
  "icloud",
  "google-drive",
  "cloudflare",
  "dropbox",
  "onedrive",
  "s3",
  "azure-blob",
  "gcs",
];
export class Formats {
  private entries = new Map<string, Format>();
  register(value: Adapter) {
    if (
      !value ||
      Object.keys(value).some(
        (k) => !["id", "version", "family", "operations", "locations", "verified"].includes(k),
      )
    )
      throw Error("unsupported adapter field");
    if (
      !/^[a-z][a-z0-9-]{0,47}$/.test(value.id) ||
      typeof value.version !== "string" ||
      !value.version.trim() ||
      !["database", "file", "object"].includes(value.family) ||
      typeof value.verified !== "boolean"
    )
      throw Error("invalid adapter identity");
    if (
      !Array.isArray(value.operations) ||
      !value.operations.length ||
      value.operations.some((o) => !operations.includes(o)) ||
      new Set(value.operations).size !== value.operations.length
    )
      throw Error("invalid adapter operation contract");
    if (
      !Array.isArray(value.locations) ||
      !value.locations.length ||
      value.locations.some((l) => !locations.includes(l)) ||
      new Set(value.locations).size !== value.locations.length
    )
      throw Error("invalid adapter location contract");
    if (this.entries.has(value.id)) throw Error("duplicate adapter identity");
    const entry = Object.freeze({
      ...value,
      operations: Object.freeze([...value.operations]),
      locations: Object.freeze([...value.locations]),
    });
    this.entries.set(value.id, entry);
    return entry;
  }
  require(id: string, location: Destination["kind"], required: Operation[]): Format {
    const entry = this.entries.get(id);
    if (!entry) throw Error("format adapter not installed: " + id);
    if (!entry.verified) throw Error("format adapter is not verified: " + id);
    if (!entry.locations.includes(location))
      throw Error("format adapter does not support this location: " + id);
    for (const op of required)
      if (!entry.operations.includes(op))
        throw Error("format adapter lacks required operation: " + op);
    return entry;
  }
  list(): readonly Format[] {
    return Object.freeze([...this.entries.values()].sort((a, b) => a.id.localeCompare(b.id, "en")));
  }
}
