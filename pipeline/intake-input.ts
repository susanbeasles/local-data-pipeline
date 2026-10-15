/** Verified collector handoff. Payload bytes stay on disk and never reach progress output. */
import{DatabaseSync}from'node:sqlite';
import{mkdir,realpath,readFile,open,writeFile,chmod}from'node:fs/promises';
import{join,resolve,dirname,sep}from'node:path';
import{hash,atomic}from'./store.ts';
import{launch,assertNetworkDenied}from'./sandbox.ts';
type Source={id:string;root:string};
export async function capture(sources:Source[],destination:string){
 const root=join(await realpath(dirname(resolve(destination))),resolve(destination).split(sep).at(-1)!);
 const inputs=await Promise.all(sources.map(async s=>({...s,root:await realpath(s.root)})));
 if(new Set(inputs.map(s=>s.id)).size!==inputs.length||inputs.some(s=>!/^[-a-zA-Z0-9]+$/.test(s.id)))throw Error('invalid source identities');
 if(inputs.some(s=>root===s.root||root.startsWith(s.root+sep)||s.root.startsWith(root+sep)))throw Error('input/output overlap');
 await mkdir(root,{mode:0o700});await mkdir(join(root,'input'));await mkdir(join(root,'state'));
 const audit=await open(join(root,'state/dispositions.jsonl'),'wx',0o600);
 const counts:{id:string;root:string;accepted:number;deferred:number;bytes:number}[]=[];
 try{
 for(const source of inputs){
  const out=join(root,'input',source.id);await mkdir(out);
  const count={...source,accepted:0,deferred:0,bytes:0};
  const db=new DatabaseSync(join(source.root,'state/intake.sqlite'),{readOnly:true});
  try{
   db.exec('PRAGMA busy_timeout=5000;BEGIN');
   for(const row of db.prepare('SELECT jobs.id,jobs.state,receipts.receipt,receipts.digest,receipts.response,receipts.published FROM jobs LEFT JOIN receipts USING(id) ORDER BY jobs.id').iterate()){
    const id=String(row.id),state=String(row.state);
    if(!/^[a-f0-9]{64}$/.test(id))throw Error('invalid receipt identity');
    if(state!=='accepted'){count.deferred++;await audit.writeFile(JSON.stringify({source:source.id,id,state,disposition:'deferred',receipt:row.digest??null})+'\n');continue;}
    const text=String(row.receipt);
    if(hash(text)!==row.digest)throw Error('receipt hash mismatch');
    const receipt=JSON.parse(text);
    if(receipt.task?.id!==id||receipt.error!==null||JSON.stringify(receipt.response)!==row.response||row.published!==1)throw Error('receipt integrity mismatch');
    const expected=Buffer.from(String(row.response)+'\n');
    const mirror=await readFile(join(source.root,'staging',id+'.jsonl'));
    if(!expected.equals(mirror))throw Error('JSONL mirror mismatch');
    await writeFile(join(out,id+'.jsonl'),mirror,{flag:'wx',mode:0o444});
    await audit.writeFile(JSON.stringify({source:source.id,id,state,disposition:'ready',hash:hash(mirror),receipt:row.digest,bytes:mirror.length})+'\n');
    count.accepted++;count.bytes+=mirror.length;
   }
   db.exec('COMMIT');
  }finally{db.close();}
  await chmod(out,0o555);counts.push(count);
 }
 await audit.sync();
 }finally{await audit.close();}
 const manifest={format:'intake-input/1',createdAt:new Date().toISOString(),scope:'committed collector responses at snapshot time; pending/failed collection is explicitly deferred',sources:counts};
 await atomic(join(root,'state/manifest.json'),manifest);await chmod(join(root,'input'),0o555);
 return manifest;
}
if(process.argv[1]===import.meta.filename){
 const inside=process.argv[2]==='--inside';const file=process.argv[inside?3:2];const out=process.argv[inside?4:3];
 try{
  if(!file||!out)throw Error('Usage: node intake-input.ts /config.json /new-output');
  const config=JSON.parse(await readFile(file,'utf8'));
  const input=await realpath(config.readonly);
  for(const s of config.sources){const p=await realpath(s.root);if(!p.startsWith(input+sep))throw Error('source outside declared read-only root');}
  if(!inside)process.exitCode=await launch(input,dirname(resolve(out)),import.meta.filename,['--inside',resolve(file),resolve(out)]);
  else{await assertNetworkDenied();console.log(JSON.stringify(await capture(config.sources,out)));}
 }catch(error){console.error(error instanceof Error?error.message:'snapshot failed');process.exitCode=1;}
}
