import { test } from "node:test";
import assert from "node:assert/strict";
import { Formats, type Adapter } from "../formats.ts";
const sqlite: Adapter = {
  id: "sqlite",
  version: "1",
  family: "database",
  operations: ["read", "write", "query", "transaction", "snapshot", "restore"],
  locations: ["volume"],
  verified: true,
};
test("database format, physical destination and security are independent capabilities", () => {
  const registry = new Formats();
  registry.register(sqlite);
  assert.equal(registry.require("sqlite", "volume", ["transaction", "snapshot"]).id, "sqlite");
  assert.throws(() => registry.require("sqlite", "s3", ["transaction"]), /location/);
});
test("unsupported or unverified formats never silently fall back to SQLite or JSONL", () => {
  const registry = new Formats();
  registry.register(sqlite);
  assert.throws(() => registry.require("parquet", "volume", ["read"]), /not installed/);
  registry.register({
    id: "parquet",
    version: "1",
    family: "file",
    operations: ["read", "write"],
    locations: ["volume", "s3"],
    verified: false,
  });
  assert.throws(() => registry.require("parquet", "s3", ["write"]), /not verified/);
});
test("registry rejects duplicate identity, empty contracts, arbitrary code and missing operations", () => {
  const registry = new Formats();
  registry.register(sqlite);
  assert.throws(() => registry.register(sqlite), /duplicate/);
  assert.throws(() => registry.register({ ...sqlite, id: "bad", operations: [] }), /operation/);
  assert.throws(
    () => registry.register({ ...sqlite, id: "bad", execute: "anything" } as any),
    /unsupported/,
  );
  assert.throws(() => registry.require("sqlite", "volume", ["append"]), /operation/);
});
test("adapter contracts are copied and immutable at the public boundary", () => {
  const registry = new Formats();
  const adapter = { ...sqlite, operations: [...sqlite.operations] };
  registry.register(adapter);
  adapter.operations.length = 0;
  const result = registry.require("sqlite", "volume", ["read"]);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.operations));
});
