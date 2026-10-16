import { test } from "node:test";
import assert from "node:assert/strict";
import { destinations, capabilities } from "../destination.ts";
const local = { kind: "volume", path: "/Volumes/Private/pipeline" };
test("storage selection is independent of security and keeps remote archives separate from active SQLite", () => {
  const result = destinations({
    format: "pipeline-storage/1",
    mode: "hardened",
    workspace: "/Library/Application Support/LocalDataPipeline",
    primary: {
      kind: "cloudflare",
      remote: "archive",
      prefix: "company/pipeline",
      credential: "pipeline-r2",
    },
    backups: [local],
  });
  assert.equal(result.mode, "hardened");
  assert.equal(result.primary.kind, "cloudflare");
  assert.equal(result.backups.length, 1);
  assert.equal(capabilities("cloudflare").liveDatabase, false);
  assert.equal(capabilities("volume").liveDatabase, true);
});
test("all requested cloud providers use object or synchronized snapshots rather than live database files", () => {
  for (const kind of ["icloud", "google-drive", "cloudflare", "dropbox", "onedrive"] as const) {
    assert.equal(capabilities(kind).liveDatabase, false);
    assert.equal(
      destinations({
        format: "pipeline-storage/1",
        mode: "standard",
        workspace: "/private/storage-fixture/Library/Application Support/LocalDataPipeline",
        primary: { kind, remote: "archive", prefix: "data", credential: "keychain-item" },
        backups: [],
      }).primary.kind,
      kind,
    );
  }
});
test("storage configuration rejects credentials, unsafe paths, duplicate destinations and ambiguous modes", () => {
  const config = {
    format: "pipeline-storage/1",
    mode: "standard",
    workspace: "/private/workspace",
    primary: local,
    backups: [],
  };
  assert.throws(
    () => destinations({ ...config, primary: { ...local, token: "do not store secrets" } }),
    /unsupported/,
  );
  assert.throws(
    () =>
      destinations({
        ...config,
        primary: {
          kind: "dropbox",
          remote: "https://user:password@host",
          prefix: "data",
          credential: "item",
        },
      }),
    /remote/,
  );
  assert.throws(
    () =>
      destinations({
        ...config,
        primary: { kind: "cloudflare", remote: "archive", prefix: "../escape", credential: "item" },
      }),
    /prefix/,
  );
  assert.throws(() => destinations({ ...config, backups: [local] }), /duplicate/);
  assert.throws(() => destinations({ ...config, mode: "automatic" }), /mode/);
  assert.throws(() => destinations({ ...config, workspace: "relative" }), /absolute/);
});
test("chosen configuration is copied and cannot be changed through the caller object", () => {
  const input = {
    format: "pipeline-storage/1",
    mode: "standard",
    workspace: "/private/workspace",
    primary: { ...local },
    backups: [],
  };
  const saved = destinations(input);
  input.primary.path = "/changed";
  assert.equal(saved.primary.kind === "volume" && saved.primary.path, "/Volumes/Private/pipeline");
});
