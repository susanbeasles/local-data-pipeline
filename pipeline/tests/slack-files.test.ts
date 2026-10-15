import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { task } from '../slack.ts';
import * as files from '../slack-files.ts';

test('file pages schedule metadata, downloads and remaining pages', () => {
 const jobs=files.expand(task('files.list',{count:100,page:1}),{ok:true,files:[{id:'F1'}],paging:{page:1,pages:2}});
 assert.equal(jobs[0]!.name,'files.info');assert.equal(jobs[1]!.inputs.page,2);
 const downloads=files.expand(jobs[0]!,{ok:true,file:{id:'F1',size:3,url_private_download:'https://files.slack.com/files-pri/T-F/x'}});
 assert.equal(downloads[0]!.name,'file.download');assert.equal(downloads[0]!.inputs.bytes,3);
 assert.throws(()=>files.url('https://files.slack.com.evil.example/file'));
 assert.throws(()=>files.url('http://files.slack.com/file'));
 assert.throws(()=>files.url('https://user:pass@files.slack.com/file'));
});
test('binary contents survive in SQLite and JSONL and wrong sizes fail',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'slack-files-')));
 const db=new DatabaseSync(join(root,'files.sqlite'));
 try {
  await mkdir(join(root,'staging'));await mkdir(join(root,'tmp'));
  const body=Buffer.from([0,255,10]);
  const saved=await files.save(db,root,'F1',new Response(body),3);
  const {Content}=await import('../content.ts');
  const content=new Content(db,root);assert.deepEqual(content.read(saved.hash),body);await content.verify('F1',saved.hash);
  await assert.rejects(files.save(db,root,'F2',new Response(body),4),/size/);
 }finally{db.close();await rm(root,{recursive:true,force:true})}
});
test('native export size discrepancies preserve returned bytes and stay explicit',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'slack-export-')));const db=new DatabaseSync(join(root,'files.sqlite'));
 try{await mkdir(join(root,'staging'));await mkdir(join(root,'tmp'));const result=await files.capture(db,root,'F3',new Response('abc',{headers:{'content-length':'3'}}),4);assert.equal(result.bytes,3);assert.equal(result.declaredBytes,4);assert.equal(result.exactSize,false);const {Content}=await import('../content.ts');assert.equal(new Content(db,root).read(result.hash).toString(),'abc');}finally{db.close();await rm(root,{recursive:true,force:true})}
});
test('chunked provider responses retain actual bytes when metadata size is wrong',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'slack-chunked-'))),db=new DatabaseSync(join(root,'files.sqlite'));
 try{await mkdir(join(root,'staging'));await mkdir(join(root,'tmp'));const result=await files.capture(db,root,'F4',new Response('returned html'),3);assert.equal(result.bytes,13);assert.equal(result.exactSize,false);const {Content}=await import('../content.ts');assert.equal(new Content(db,root).read(result.hash).toString(),'returned html');}finally{db.close();await rm(root,{recursive:true,force:true})}
});
