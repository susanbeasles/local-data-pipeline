/** Serializable storage intent. Provider selection is not proof an adapter is installed. */
import { isAbsolute, normalize } from "node:path";
import { validateMode, type Mode } from "./storage.ts";
export type Cloud =
  | "icloud"
  | "google-drive"
  | "cloudflare"
  | "dropbox"
  | "onedrive"
  | "s3"
  | "azure-blob"
  | "gcs";
export type Destination =
  | { kind: "volume"; path: string }
  | { kind: Cloud; remote: string; prefix: string; credential: string };
export type Destinations = {
  format: "pipeline-storage/1";
  mode: Mode;
  workspace: string;
  primary: Destination;
  backups: Destination[];
};
const clouds: Cloud[] = [
  "icloud",
  "google-drive",
  "cloudflare",
  "dropbox",
  "onedrive",
  "s3",
  "azure-blob",
  "gcs",
];
function record(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("invalid storage object");
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((k) => !allowed.includes(k)))
    throw Error("unsupported storage field; credentials belong in a secret store");
}
function absolute(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    normalize(value) !== value ||
    value.includes("\0")
  )
    throw Error("canonical absolute storage path required");
}
function destination(value: unknown): Destination {
  record(value);
  if (value.kind === "volume") {
    keys(value, ["kind", "path"]);
    absolute(value.path);
    return { kind: "volume", path: value.path };
  }
  keys(value, ["kind", "remote", "prefix", "credential"]);
  if (!clouds.includes(value.kind as Cloud)) throw Error("unknown storage destination");
  if (typeof value.remote !== "string" || !/^[-a-zA-Z0-9_]{1,80}$/.test(value.remote))
    throw Error("remote must be a registered connection identifier, not a URL or credentials");
  if (
    typeof value.prefix !== "string" ||
    !value.prefix ||
    value.prefix.startsWith("/") ||
    value.prefix
      .split("/")
      .some((p) => !p || p === "." || p === ".." || p.includes("\\") || /[\x00-\x1f]/.test(p))
  )
    throw Error("invalid object prefix");
  if (typeof value.credential !== "string" || !/^[-a-zA-Z0-9_./]{1,160}$/.test(value.credential))
    throw Error("credential must identify a secret-store entry");
  return {
    kind: value.kind as Cloud,
    remote: value.remote,
    prefix: value.prefix,
    credential: value.credential,
  };
}
export function capabilities(kind: Destination["kind"]) {
  if (kind !== "volume" && !clouds.includes(kind)) throw Error("unknown storage destination");
  return {
    liveDatabase: kind === "volume",
    snapshots: true,
    requiresAdapter: kind !== "volume",
    remote: kind !== "volume",
  };
}
export function destinations(value: unknown): Destinations {
  record(value);
  keys(value, ["format", "mode", "workspace", "primary", "backups"]);
  if (
    value.format !== "pipeline-storage/1" ||
    !Array.isArray(value.backups) ||
    value.backups.length > 8
  )
    throw Error("invalid storage configuration");
  const mode = validateMode(value.mode);
  absolute(value.workspace);
  const primary = destination(value.primary),
    backups = value.backups.map(destination),
    ids = [primary, ...backups].map((d) =>
      d.kind === "volume" ? "volume:" + d.path : d.kind + ":" + d.remote + ":" + d.prefix,
    );
  if (new Set(ids).size !== ids.length) throw Error("duplicate primary/backup destination");
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++)
      if (ids[i]!.startsWith(ids[j]! + "/") || ids[j]!.startsWith(ids[i]! + "/"))
        throw Error("overlapping primary/backup destinations");
  return { format: "pipeline-storage/1", mode, workspace: value.workspace, primary, backups };
}
