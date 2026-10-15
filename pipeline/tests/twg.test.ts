import {test} from 'node:test';import assert from 'node:assert/strict';
import {route,children,seed,embed,collect} from '../twg.ts';
import {mkdtemp,realpath,writeFile,readdir,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {Intake} from '../intake.ts';
import {task} from '../atlassian.ts';
test('TWG uses typed read commands and preserves fixed history configuration',()=>{
 const t=task('getConfluenceContentVersion','cloud',{contentId:'123',versionNumber:1,content_format:'html'},'confluence','space');
 assert.deepEqual(route(t),['confluence','content','versions','get','--id','123','--at-version','1','--format','html']);
 assert.throws(()=>route({...t,name:'deleteConfluenceContent'}),/unsupported/);
 assert.throws(()=>route({...t,name:'listConfluenceContent',inputs:{spaceId:'s',type:'page',status:'archived'}}),/status/);
});
test('native Jira discovery queues full records and all-history detail streams with bounded batches',()=>{
 const t=seed('cloud','SONMD'),data={data:{issues:Array.from({length:21},(_,i)=>({key:'SONMD-'+i}))},pageInfo:{hasNextPage:true,nextCursor:'next'}};
 const jobs=children(t,data);assert.equal(jobs.filter(j=>j.name==='twgJiraFull').length,1);assert.equal(jobs.filter(j=>j.name==='twgJiraChangelog').length,21);assert.equal(jobs.filter(j=>j.name==='twgJiraWorklog').length,21);
 assert.ok(jobs.some(j=>j.name==='twgJiraQuery'&&j.inputs.after==='next'));assert.ok(route(t).includes('*all'));assert.ok(!route(t).includes('--started-after'));
 assert.throws(()=>children(t,{data:{issues:[]},pageInfo:{hasNextPage:true}}),/cursor/);
});
test('native pagination rejects loops and partial full-record batches stay unresolved',()=>{
 const t={...seed('c','SONMD'),name:'twgJiraChangelog',inputs:{issue:'SONMD-1',after:'same'}};
 assert.throws(()=>children(t,{data:[],pageInfo:{hasNextPage:true,nextCursor:'same'}}),/cursor/);
 const full={...t,name:'twgJiraFull',inputs:{keys:['SONMD-1']}};
 assert.throws(()=>children(full,{data:{items:[{input:'SONMD-1',ok:false}]}}),/partial/);
});
test('TWG response bodies are preserved without opening arbitrary output paths',async()=>{
 const data={data:{body:{value:'whole body'}}};assert.deepEqual(await embed(data,'/tmp/allowed'),data);
 await assert.rejects(embed({data:{body:{outputFile:'/etc/passwd'}}},'/tmp/allowed'),/outside/);
});
test('standalone worker persists full responses, verifies mirrors and resumes without new calls',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'twg-worker-'))),exe=join(root,'fixture');
 await writeFile(exe,`#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2),output=args[args.indexOf('--output-file')+1];let data;if(args.includes('versions'))data={ok:true,body:{value:'entire historical content'}};else if(args.includes('query')&&!args.includes('changelog')&&!args.includes('worklog'))data={issues:[{key:'SONMD-1',description:'complete fixture source'}]};else if((args.includes('get')||args.includes('bulk-get')))data={key:'SONMD-1',description:'full text',comments:['whole comment'],remoteLinks:[]};else data=[];fs.writeFileSync(output,JSON.stringify({data,pageInfo:{hasNextPage:false}}));`,{mode:0o700});
 const inbox=await Intake.open(root);inbox.seed([task('getConfluenceContentVersion','cloud',{contentId:'123',versionNumber:1},'confluence','space')]);inbox.close();
 const config={root,executable:exe,site:'example.test',cloudId:'cloud',projects:['SONMD'],pauseMs:1200};await collect(config);const before=(await readdir(join(root,'twg-transfer'))).length;await collect(config);assert.equal((await readdir(join(root,'twg-transfer'))).length,before);
 const saved=await Intake.open(root);assert.deepEqual(saved.status(),{pending:0,accepted:5,failed:0,unpublished:0});assert.deepEqual(await saved.verify(),{receipts:5,mirrors:5});saved.close();assert.equal(JSON.parse(await readFile(join(root,'twg-progress.json'),'utf8')).state,'complete');
 const files=await readdir(join(root,'staging'));assert.ok((await Promise.all(files.map(f=>readFile(join(root,'staging',f),'utf8')))).some(s=>s.includes('entire historical content')));
});

test('Jira uses the actual REST bulk-fetch command instead of per-issue get fanout',()=>{
 const t={...seed('cloud','SONMD'),name:'twgJiraFull',inputs:{keys:Array.from({length:100},(_,i)=>'SONMD-'+(i+1))}};
 const args=route(t);assert.equal(args[2],'bulk-get');assert.ok(args.includes('--full'));assert.ok(args.includes('--strict'));assert.ok(!args.includes('--batch-concurrency'));
});

test('collector executes independent requests concurrently without duplicate dispatch',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'twg-parallel-'))),exe=join(root,'fixture'),events=join(root,'events.jsonl');
 await writeFile(exe,`#!${process.execPath}\nconst fs=require('node:fs'),a=process.argv.slice(2),id=a[a.indexOf('--id')+1];fs.appendFileSync(${JSON.stringify(events)},JSON.stringify({id,phase:'start'})+'\\n');setTimeout(()=>{fs.writeFileSync(a[a.indexOf('--output-file')+1],JSON.stringify({data:{body:{value:'synthetic history'}},pageInfo:{hasNextPage:false}}));fs.appendFileSync(${JSON.stringify(events)},JSON.stringify({id,phase:'end'})+'\\n');},200);`,{mode:0o700});
 const intake=await Intake.open(root);intake.seed([1,2,3].map(i=>task('getConfluenceContentVersion','cloud',{contentId:String(i),versionNumber:1},'confluence','space')));intake.close();
 await collect({root,executable:exe,site:'example.test',cloudId:'cloud',projects:[],concurrency:3,pauseMs:0});
 let active=0,peak=0;const rows=(await readFile(events,'utf8')).trim().split('\n').map(x=>JSON.parse(x));for(const r of rows){active+=r.phase==='start'?1:-1;peak=Math.max(peak,active);}assert.equal(peak,3);assert.equal(rows.filter(r=>r.phase==='start').length,3);
 const saved=await Intake.open(root);assert.deepEqual(await saved.verify(),{receipts:3,mirrors:3});saved.close();
});

test('resource denial does not stop unrelated exports and numeric IDs are not HTTP errors',async()=>{
 const {failure}=await import('../twg.ts');
 assert.equal(failure({error:{message:'HTTP 403 forbidden for this page'}}),'failed');
 assert.equal(failure({error:{message:'HTTP 401 unauthorized'}}),'auth');
 assert.equal(failure({error:{status:429,retryAfter:90}}),'retry');
 assert.equal(failure({error:{message:'Not found: content 123401503'}}),'failed');
});
