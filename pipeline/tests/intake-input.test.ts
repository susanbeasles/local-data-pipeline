import test from 'node:test';import assert from 'node:assert/strict';import{mkdtemp,mkdir,writeFile,readFile,rm,chmod}from'node:fs/promises';import{join}from'node:path';import{tmpdir}from'node:os';import{DatabaseSync}from'node:sqlite';import{hash}from'../store.ts';import{capture}from'../intake-input.ts';
test('intake snapshot exports complete accepted JSONL and accounts for pending and failed requests',async()=>{
 const root=await mkdtemp(join(tmpdir(),'intake-input-'));try{
 const input=join(root,'source');await mkdir(join(input,'state'),{recursive:true});await mkdir(join(input,'staging'));
 const db=new DatabaseSync(join(input,'state/intake.sqlite'));db.exec('CREATE TABLE jobs(id TEXT,state TEXT);CREATE TABLE receipts(id TEXT,receipt TEXT,digest TEXT,response TEXT,published INTEGER)');
 const id='a'.repeat(64),response={text:'synthetic complete content'},receipt=JSON.stringify({task:{id},response,error:null,children:[]});
 db.prepare('INSERT INTO jobs VALUES(?,?)').run(id,'accepted');db.prepare('INSERT INTO jobs VALUES(?,?)').run('b'.repeat(64),'pending');db.prepare('INSERT INTO jobs VALUES(?,?)').run('c'.repeat(64),'failed');db.prepare('INSERT INTO receipts VALUES(?,?,?,?,1)').run(id,receipt,hash(receipt),JSON.stringify(response));db.close();
 await writeFile(join(input,'staging',id+'.jsonl'),JSON.stringify(response)+'\n');
 const out=join(root,'output');const result=await capture([{id:'demo',root:input}],out);
 assert.equal(result.sources[0].accepted,1);assert.equal(result.sources[0].deferred,2);
 assert.equal(await readFile(join(out,'input/demo',id+'.jsonl'),'utf8'),JSON.stringify(response)+'\n');
 assert.equal((await readFile(join(out,'state/dispositions.jsonl'),'utf8')).trim().split('\n').length,3);
 await writeFile(join(input,'staging',id+'.jsonl'),'{}\n');
 await assert.rejects(capture([{id:'demo',root:input}],join(root,'corrupt')),/mirror/);
 await assert.rejects(capture([{id:'demo',root:input}],join(input,'nested')),/overlap/);
 }finally{for(const p of ['output/input','output/input/demo'])await chmod(join(root,p),0o700).catch(()=>{});await rm(root,{recursive:true,force:true});}
});
