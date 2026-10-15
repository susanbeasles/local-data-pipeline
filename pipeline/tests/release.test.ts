import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Release } from "../release.ts";
test("release pins code and configuration independently of repository edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "release-"));
  try {
    const source = join(root, "source"),
      target = join(root, "instance");
    await mkdir(join(source, "pipeline"), { recursive: true });
    await mkdir(join(source, "config"));
    await writeFile(join(source, "pipeline/code.ts"), "original");
    await writeFile(join(source, "package.json"), '{"type":"module"}');
    await writeFile(join(source, "package-lock.json"), '{"lockfileVersion":3}');
    await writeFile(join(source, "config/residency.json"), "{}");
    const config = { concurrency: 64 };
    const release = await Release.create(source, target, config);
    config.concurrency = 1;
    await writeFile(join(source, "pipeline/code.ts"), "edited");
    await release.verify();
    assert.equal(await readFile(join(target, "payload/pipeline/code.ts"), "utf8"), "original");
    assert.equal(
      JSON.parse(await readFile(join(target, "payload/instance.json"), "utf8")).concurrency,
      64,
    );
    await assert.rejects(Release.create(source, target, config));
    await chmod(join(target, "payload/pipeline/code.ts"), 0o600);
    await writeFile(join(target, "payload/pipeline/code.ts"), "tampered");
    await assert.rejects(release.verify(), /integrity/);
  } finally {
    // Owner can chmod these fixtures; readonly is not a host-user security boundary.
    const { execFileSync } = await import("node:child_process");
    execFileSync("/bin/chmod", ["-R", "u+w", root]);
    await rm(root, { recursive: true, force: true });
  }
});

test('release captures installed production dependencies without dev packages or live links',async t=>{
 const root=await mkdtemp(join(tmpdir(),'release-deps-'));t.after(async()=>{const {execFileSync}=await import('node:child_process');execFileSync('/bin/chmod',['-R','u+w',root]);await rm(root,{recursive:true,force:true});});
 const source=join(root,'source'),target=join(root,'release');for(const dir of ['pipeline','config','node_modules/local-pg','node_modules/dev-only'])await mkdir(join(source,dir),{recursive:true});
 await writeFile(join(source,'package.json'),JSON.stringify({dependencies:{'local-pg':'1.0.0'}}));
 await writeFile(join(source,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{'':{dependencies:{'local-pg':'1.0.0'}},'node_modules/local-pg':{version:'1.0.0'},'node_modules/dev-only':{version:'1.0.0',dev:true}}}));
 await writeFile(join(source,'node_modules/local-pg/package.json'),JSON.stringify({name:'local-pg',version:'1.0.0'}));await writeFile(join(source,'node_modules/local-pg/index.js'),'original dependency');
 const release=await Release.create(source,target,{});await writeFile(join(source,'node_modules/local-pg/index.js'),'edited dependency');
 assert.equal(await readFile(join(target,'payload/node_modules/local-pg/index.js'),'utf8'),'original dependency');
 await assert.rejects(readFile(join(target,'payload/node_modules/dev-only/index.js')),{code:'ENOENT'});await release.verify();
});
