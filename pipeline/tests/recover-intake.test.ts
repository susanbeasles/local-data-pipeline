import test from'node:test';import assert from'node:assert/strict';import{mkdtemp,realpath,readFile}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{Intake}from'../intake.ts';import{task}from'../atlassian.ts';import{recover}from'../recover-intake.ts';
test('recovery retains accepted data and preserves failures while requeueing in a separate store',async()=>{
 const base=await realpath(await mkdtemp(join(tmpdir(),'intake-recovery-'))),source=join(base,'source'),target=join(base,'retry');const db=await Intake.open(source);const a=task('read','c',{id:1},'jira','x'),b=task('read','c',{id:2},'jira','x');await db.accept(a,{text:'synthetic complete'},[]);await db.fail(b,{error:'429'},'rate limited');db.close();
 const result=await recover(source,target);assert.equal(result.accepted,1);assert.equal(result.retry,1);
 const old=await Intake.open(source);assert.equal(old.status().failed,1);old.close();
 const next=await Intake.open(target);assert.equal(next.status().accepted,1);assert.equal(next.status().pending,1);next.close();
 assert.match(await readFile(join(target,'state/prior-failures.jsonl'),'utf8'),/rate limited/);
});
