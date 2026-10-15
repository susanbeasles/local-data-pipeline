import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Guest } from "../macos.ts";
import { request, binding } from "../platform-client.ts";
async function fixture(body: string) {
  const home = await mkdtemp(join(tmpdir(), "guest-transport-")),
    runner = join(home, "tart");
  await writeFile(runner, "#!/usr/bin/python3\nimport sys,json\n" + body, { mode: 0o700 });
  const mac = {
    name: "pipeline-test",
    runner,
    home,
    image: "ghcr.io/cirruslabs/macos-tahoe-base@sha256:" + "a".repeat(64),
    diskBytes: 50000000000,
    memoryBytes: 8 * 1024 ** 3,
    cpus: 2,
  };
  return {
    home,
    guest: new Guest(mac),
    binding: {
      mac,
      node: { path: "/runtime/node", sha256: "a".repeat(64) },
      entry: { path: "/runtime/entry", sha256: "a".repeat(64) },
    },
  };
}
test("guest pipe uses argv exec -i and bounded stdin without shell expansion", async () => {
  const f = await fixture(
    "assert sys.argv[1:5]==['exec','-i','pipeline-test','/runtime/node']\nassert sys.argv[5]=='$(never-execute)'\nprint(sys.stdin.read())\n",
  );
  try {
    assert.equal(
      (await f.guest.pipe(["/runtime/node", "$(never-execute)"], '{"synthetic":true}')).trim(),
      '{"synthetic":true}',
    );
    await assert.rejects(f.guest.pipe(["node"], "{}"), /absolute/);
    await assert.rejects(f.guest.pipe(["/node"], "x".repeat(2 * 1024 ** 2 + 1)), /input exceeds/);
  } finally {
    await rm(f.home, { recursive: true });
  }
});
test("native guest transport verifies pins and delivers JSON stdin", async () => {
  const f = await fixture(
    "if sys.argv[3]=='/usr/bin/shasum':print('a'*64+'  '+sys.argv[-1])\nelse:\n assert sys.argv[1:4]==['exec','-i','pipeline-test']\n assert sys.argv[-1]=='/guest/platform.json'\n value=json.load(sys.stdin)\n print(json.dumps({'action':value['action'],'input':value['input']}))\n",
  );
  try {
    assert.deepEqual(
      await request("/guest/platform.json", "health", { synthetic: true }, { guest: f.binding }),
      { action: "health", input: { synthetic: true } },
    );
    await assert.rejects(
      request("/guest/platform.json", "work", {}, { guest: f.binding }),
      /unsupported/,
    );
    await assert.rejects(
      request("postgres://remote/db", "health", {}, { guest: f.binding }),
      /absolute/,
    );
    assert.throws(
      () =>
        binding({ ...f.binding, entry: { path: "https://remote/entry", sha256: "a".repeat(64) } }),
      /absolute/,
    );
    await assert.rejects(
      request(
        "/guest/platform.json",
        "health",
        {},
        { guest: { ...f.binding, node: { ...f.binding.node, sha256: "b".repeat(64) } } },
      ),
      /digest mismatch/,
    );
  } finally {
    await rm(f.home, { recursive: true });
  }
});
test("guest output overflow and malformed JSON fail without host fallback", async () => {
  const f = await fixture(
    "if sys.argv[3]=='/usr/bin/shasum':print('a'*64+'  '+sys.argv[-1])\nelse:\n sys.stdin.read()\n print('x'*(2*1024**2+1))\n",
  );
  try {
    await assert.rejects(
      request("/guest/platform.json", "health", {}, { guest: f.binding }),
      /output exceeds/,
    );
  } finally {
    await rm(f.home, { recursive: true });
  }
  const g = await fixture(
    "if sys.argv[3]=='/usr/bin/shasum':print('a'*64+'  '+sys.argv[-1])\nelse:\n sys.stdin.read()\n print('{} {}')\n",
  );
  try {
    await assert.rejects(
      request("/guest/platform.json", "health", {}, { guest: g.binding }),
      /JSON/,
    );
  } finally {
    await rm(g.home, { recursive: true });
  }
});

test("guest pin changes after execution are rejected", async () => {
  const f = await fixture(
    "if sys.argv[3]=='/usr/bin/shasum':\n print(('b' if __import__('os').path.exists(__file__+'.called') else 'a')*64+'  '+sys.argv[-1])\nelse:\n sys.stdin.read()\n open(__file__+'.called','w').close()\n print('{}')\n",
  );
  try {
    await assert.rejects(
      request("/guest/platform.json", "health", {}, { guest: f.binding }),
      /digest mismatch/,
    );
  } finally {
    await rm(f.home, { recursive: true });
  }
});
