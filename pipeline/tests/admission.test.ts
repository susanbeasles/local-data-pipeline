import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
test("KV admission keeps 64 slots for short sequences and defers padded long sequences without discarding work", () => {
  const result = execFileSync(
    "/usr/bin/python3",
    [
      "-I",
      "-c",
      `import importlib.util
s=importlib.util.spec_from_file_location('admission',${JSON.stringify(join(import.meta.dirname, "../admission.py"))});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
assert m.allows([256]*63,256,10,64*256*10,64)
assert not m.allows([256]*64,256,10,999999999,64)
assert not m.allows([256]*63,8192,10,64*256*10,64)
assert m.allows([],8192,10,8192*10,64)
assert m.footprint([1,4097],10)==4352*2*10
jobs=[256,8192,512,8192,1024];pending=jobs[:];done=[]
while pending:
 batch=[]
 while pending and m.allows(batch,pending[0],10,8192*10*2,64):batch.append(pending.pop(0))
 assert batch
 assert m.footprint(batch,10)<=8192*10*2
 done.extend(batch)
assert done==jobs
print('ok')`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.trim(), "ok");
});
