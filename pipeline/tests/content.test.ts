import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store, hash } from "../store.ts";
import { Content } from "../content.ts";
test("complete binary bytes survive in SQLite and JSONL without whole-file buffers or duplicate blobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-")),
    file = join(root, "binary.zip"),
    out = join(root, "binary.jsonl"),
    bytes = Buffer.alloc(2 * 1024 * 1024 + 37);
  for (let n = 0; n < bytes.length; n++) bytes[n] = n % 251;
  await writeFile(file, bytes);
  const store = new Store(":memory:"),
    content = new Content(store.db);
  await content.capture("a", file, hash(bytes), out);
  const lines = (await readFile(out, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const restored = Buffer.concat(
    lines.filter((r) => r.kind === "bytes").map((r) => Buffer.from(r.base64, "base64")),
  );
  assert.deepEqual(restored, bytes);
  assert.equal(hash(restored), hash(bytes));
  assert.deepEqual(content.read(hash(bytes)), bytes);
  await content.capture("b", file, hash(bytes), join(root, "second.jsonl"));
  assert.equal(store.db.prepare("SELECT count(*) n FROM content_blobs").get()!.n, 1);
  assert.equal(store.db.prepare("SELECT count(*) n FROM content_sources").get()!.n, 2);
  store.close();
});
test("corrupt SQLite bytes cannot produce a completed JSONL mirror", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-corrupt-")),
    file = join(root, "input"),
    out = join(root, "out.jsonl");
  await writeFile(file, "complete text");
  const store = new Store(":memory:"),
    content = new Content(store.db);
  await content.capture("a", file, hash("complete text"), out);
  store.db.exec("UPDATE content_blocks SET data=x'00'");
  await assert.rejects(
    content.capture("b", file, hash("complete text"), join(root, "bad.jsonl")),
    /hash|coverage/,
  );
  store.close();
});
test('optional lossless compression preserves full bytes in SQLite and JSONL',async()=>{
 const {brotliDecompressSync}=await import('node:zlib');
 const root=await realpath(await mkdtemp(join(tmpdir(),'content-coded-'))),file=join(root,'input'),out=join(root,'raw.jsonl');const bytes=Buffer.alloc(2*1024*1024+19,65);await writeFile(file,bytes);
 const store=new Store(':memory:');try{
 const content=new Content(store.db,root,'brotli');await content.capture('source',file,hash(bytes),out);assert.deepEqual(content.read(hash(bytes)),bytes);
 const stored=store.db.prepare('SELECT sum(length(data)) n FROM content_blocks').get()!;assert.ok(Number(stored.n)<bytes.length/10);
 const rows=(await readFile(out,'utf8')).trim().split('\n').map(x=>JSON.parse(x));const restored=Buffer.concat(rows.filter(r=>r.kind==='bytes').map(r=>r.codec==='brotli'?brotliDecompressSync(Buffer.from(r.base64,'base64')):Buffer.from(r.base64,'base64')));assert.deepEqual(restored,bytes);
 await content.verify('source',hash(bytes));assert.deepEqual(new Content(store.db,root).read(hash(bytes)),bytes);
 store.db.exec("UPDATE content_blocks SET data=x'00'");assert.throws(()=>content.read(hash(bytes)));
 }finally{store.close()}
});
test('mirror verification reconstructs bytes independently of its recorded file digest',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'content-verify-'))),file=join(root,'input'),out=join(root,'raw.jsonl');await writeFile(file,'abc');const store=new Store(':memory:');try{const content=new Content(store.db,root);await content.capture('a',file,hash('abc'),out);const rows=(await readFile(out,'utf8')).trim().split('\n').map(x=>JSON.parse(x));rows[1].base64=Buffer.from('def').toString('base64');const altered=rows.map(x=>JSON.stringify(x)+'\n').join('');await writeFile(out,altered);store.db.prepare('UPDATE content_sources SET jsonlHash=?').run(hash(altered));await assert.rejects(content.verify('a',hash('abc')),/JSONL|mirror|hash/);}finally{store.close()}
});
