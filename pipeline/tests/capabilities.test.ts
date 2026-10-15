import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {Catalog} from '../catalog.ts';
import {Dataset} from '../dataset.ts';
import {library} from '../capabilities.ts';
import {Workflow,type Budget,type Definition,type Policy,type Context} from '../workflow.ts';

async function fixture(t:TestContext){
 const root=await realpath(await mkdtemp(join(tmpdir(),'capabilities-')));t.after(()=>rm(root,{recursive:true,force:true}));const raw=join(root,'raw');await mkdir(raw);
 const db=new DatabaseSync(join(raw,'data.sqlite'));db.exec("CREATE TABLE docs(id TEXT PRIMARY KEY,text TEXT); INSERT INTO docs VALUES('a','alpha'),('b','alpha'),('c','beta')");db.close();
 const dataset=new Dataset(join(root,'operator/datasets'));t.after(()=>dataset.close());
 const catalog=new Catalog([{id:'fixture',name:'Synthetic',kind:'sqlite',root:raw,database:'data.sqlite'}],join(root,'operator'));
 const scope={workspace:randomUUID(),project:randomUUID(),owner:randomUUID()},connection=randomUUID();
 const lib=await library(scope,{catalog,dataset,connections:{[connection]:'fixture'}});
 const source=lib.registry.registerResource({id:'source',version:1,scope,kind:'connection',body:{connection}});
 const small:Budget={cpuMs:10000,memoryBytes:1024**2,storageBytes:1024**2,timeMs:30000,tokens:0,costMicros:0,concurrency:1},large={...small,cpuMs:100000,memoryBytes:8*1024**2,storageBytes:8*1024**2,timeMs:120000};
 const policy:Policy={scope,capabilities:['data.read','data.write','resource.read'],budget:large,grants:[]};
 return{root,raw,dataset,catalog,scope,connection,lib,source,small,large,policy};
}

test('real catalog capture and revision transforms consume either SQLite or JSONL ports',async t=>{
 const f=await fixture(t),before=await readFile(join(f.raw,'data.sqlite'));
 const definition:Definition={format:'workflow/1',id:'review',version:1,scope:f.scope,name:'Review',budget:f.large,stages:[{id:'main',name:'Main',budget:f.large}],steps:[
  {id:'capture',stage:'main',type:f.lib.types['dataset.capture'],config:{table:'docs',name:'Captured'},pins:{source:f.source},budget:f.small},
  {id:'clean',stage:'main',type:f.lib.types['dataset.transform'],config:{name:'Clean',steps:JSON.stringify([{op:'dedupe',paths:['$.text']},{op:'set',path:'$.reviewed',value:true}]),pauseOnFailure:true},pins:{},budget:f.small},
  {id:'audit',stage:'main',type:f.lib.types['dataset.verify'],config:{},pins:{},budget:f.small}
 ],edges:[{id:'one',from:{step:'capture',port:'sqlite'},to:{step:'clean',port:'sqlite'}},{id:'two',from:{step:'clean',port:'jsonl'},to:{step:'audit',port:'jsonl'}}]};
 const workflow=Workflow.publish(definition,f.lib.registry,f.policy),run=await workflow.run(f.lib.registry);assert.equal(run.state,'completed');
 const handle=run.outputs.audit.jsonl[0] as {revision:string;count:number;hash:string};assert.equal(handle.count,2);assert.equal((await f.dataset.verify(handle.revision)).intact,true);
 assert.equal(f.dataset.page(handle.revision).records[0].body&&((f.dataset.page(handle.revision).records[0].body) as any).reviewed,true);
 assert.deepEqual(await readFile(join(f.raw,'data.sqlite')),before);
 assert.equal(f.dataset.revisions().length,2);
});

test('handler retries reuse the same complete dataset operation and unknown bindings fail',async t=>{
 const f=await fixture(t);const type=f.lib.registry.type(f.lib.types['dataset.capture']),handler=f.lib.registry.executor(type.adapter as any);
 const context={run:randomUUID(),step:'capture',config:{table:'docs',name:'Full'},pins:{source:{body:{connection:f.connection}}},budget:f.small,signal:new AbortController().signal} as unknown as Context;
 const first=await handler(context),second=await handler(context);assert.deepEqual(first,second);assert.equal(f.dataset.revisions().length,1);
 await assert.rejects(Promise.resolve().then(()=>handler({...context,pins:{source:{body:{connection:randomUUID()}}}} as unknown as Context)),/connection|binding/);
});

test('model operators fail closed without an admitted resident local model',async t=>{
 const f=await fixture(t),type=f.lib.registry.type(f.lib.types['model.infer']),handler=f.lib.registry.executor(type.adapter as any);
 await assert.rejects(Promise.resolve().then(()=>handler({config:{role:'tag',payload:'$.payload'},pins:{},inputs:{},signal:new AbortController().signal} as unknown as Context)),/resident|model/);
});
