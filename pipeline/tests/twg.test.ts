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
 const jobs=children(t,data);assert.equal(jobs.filter(j=>j.name==='twgJiraFull').length,2);assert.equal(jobs.filter(j=>j.name==='twgJiraChangelog').length,21);assert.equal(jobs.filter(j=>j.name==='twgJiraWorklog').length,21);
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
 await writeFile(exe,`#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2),output=args[args.indexOf('--output-file')+1];let data;if(args.includes('versions'))data={ok:true,body:{value:'entire historical content'}};else if(args.includes('query')&&!args.includes('changelog')&&!args.includes('worklog'))data={issues:[{key:'SONMD-1',description:'complete fixture source'}]};else if(args.includes('get'))data={key:'SONMD-1',description:'full text',comments:['whole comment'],remoteLinks:[]};else data=[];fs.writeFileSync(output,JSON.stringify({data,pageInfo:{hasNextPage:false}}));`,{mode:0o700});
 const inbox=await Intake.open(root);inbox.seed([task('getConfluenceContentVersion','cloud',{contentId:'123',versionNumber:1},'confluence','space')]);inbox.close();
 const config={root,executable:exe,site:'example.test',cloudId:'cloud',projects:['SONMD'],pauseMs:1200};await collect(config);const before=(await readdir(join(root,'twg-transfer'))).length;await collect(config);assert.equal((await readdir(join(root,'twg-transfer'))).length,before);
 const saved=await Intake.open(root);assert.deepEqual(saved.status(),{pending:0,accepted:5,failed:0,unpublished:0});assert.deepEqual(await saved.verify(),{receipts:5,mirrors:5});saved.close();assert.equal(JSON.parse(await readFile(join(root,'twg-progress.json'),'utf8')).state,'complete');
 const files=await readdir(join(root,'staging'));assert.ok((await Promise.all(files.map(f=>readFile(join(root,'staging',f),'utf8')))).some(s=>s.includes('entire historical content')));
});
