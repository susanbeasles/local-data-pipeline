/** Fork collector checkpoints without changing any original receipt or mirror. */
import{DatabaseSync}from'node:sqlite';import{mkdir,realpath,readFile,open}from'node:fs/promises';import{join,resolve,sep}from'node:path';import{Intake,type Task}from'./intake.ts';import{hash,atomic}from'./store.ts';
export async function recover(source:string,target:string){
 source=await realpath(source);target=resolve(target);
 if(target===source||target.startsWith(source+sep)||source.startsWith(target+sep))throw Error('recovery input/output overlap');
 await mkdir(target,{mode:0o700});
 const prior=new DatabaseSync(join(source,'state/intake.sqlite'),{readOnly:true}),next=await Intake.open(target);
 const audit=await open(join(target,'state/prior-failures.jsonl'),'wx',0o600);let accepted=0,retry=0,pending=0;
 try{
  prior.exec('PRAGMA busy_timeout=5000;BEGIN');
  for(const row of prior.prepare('SELECT task FROM jobs ORDER BY rowid').iterate())next.seed([JSON.parse(String(row.task))as Task]);
  for(const row of prior.prepare('SELECT jobs.state,receipts.receipt,receipts.digest,receipts.response,receipts.id FROM jobs LEFT JOIN receipts USING(id) ORDER BY jobs.rowid').iterate()){
   if(row.state==='pending'){pending++;continue;}
   const text=String(row.receipt);if(hash(text)!==row.digest)throw Error('prior receipt hash mismatch');
   const value=JSON.parse(text);
   if(value.task.id!==row.id||JSON.stringify(value.response)!==row.response)throw Error('prior receipt identity mismatch');
   const mirror=await readFile(join(source,'staging',String(row.id)+'.jsonl'),'utf8');if(mirror!==String(row.response)+'\n')throw Error('prior mirror mismatch');
   if(row.state==='accepted'){if(value.error!==null)throw Error('accepted receipt has error');await next.accept(value.task,value.response,value.children);accepted++;}
   else{await audit.writeFile(text+'\n');retry++;}
  }
  await audit.sync();prior.exec('COMMIT');
  const result={source,target,accepted,retry,pending,originalsChanged:false};await atomic(join(target,'state/recovery.json'),result);return result;
 }finally{await audit.close();prior.close();next.close();}
}
