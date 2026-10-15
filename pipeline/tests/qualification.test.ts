import { test } from "node:test";
import assert from "node:assert/strict";
import { qualify, type Config } from "../qualification.ts";
const config = {
  python: "/runtime/bin/python3",
  runtime: { root: "/runtime", sha256: "a".repeat(64) },
  model: { root: "/model", sha256: "b".repeat(64) },
} as Config;
function guest(change: Record<string, unknown> = {}) {
  return {
    async execute(args: string[]) {
      assert.deepEqual(args.slice(0, 4), [config.python, "-I", "-B", "-c"]);
      const request = JSON.parse(args.at(-1)!);
      return JSON.stringify({
        nonce: request.nonce,
        system: "Darwin",
        machine: "arm64",
        mlx: "test-version",
        metal: true,
        gpu: 14,
        runtime: config.runtime.sha256,
        model: config.model.sha256,
        output: "READY",
        ...change,
      });
    },
  };
}
test("qualification requires live challenge and complete GPU/inference evidence", async () => {
  assert.equal((await qualify(config, guest())).scope, "synthetic-backend");
  for (const change of [
    { nonce: "replay" },
    { system: "Linux" },
    { machine: "x86_64" },
    { metal: false },
    { gpu: 0 },
    { runtime: "c".repeat(64) },
    { model: "c".repeat(64) },
    { output: "" },
  ])
    await assert.rejects(qualify(config, guest(change)), /evidence mismatch/);
});
test("guest failure cannot fall back to host or emit qualification", async () => {
  await assert.rejects(
    qualify(config, {
      async execute() {
        throw Error("guest unavailable");
      },
    }),
    /guest unavailable/,
  );
  await assert.rejects(
    qualify({ ...config, python: "/usr/bin/python3" }, guest()),
    /pinned guest Python/,
  );
});
