/** Standalone TWG intake. Provider payloads go to local SQLite/JSONL, never stdout. */
import {spawn,type ChildProcess} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {mkdir,readFile,writeFile,open,rm,realpath,lstat,statfs} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {Intake,type Task} from './intake.ts';
import {task,expand} from './atlassian.ts';
import {atomic} from './store.ts';
type Value=Record<string,any>;
export type Config={root:string;executable:string;site:string;cloudId:string;projects:string[];pauseMs?:number;concurrency?:number};
const val=(v:unknown)=>{if(typeof v!=='string'&&typeof v!=='number')throw Error('missing CLI argument');return String(v);};
export function seed(cloudId:string,project:string){return task('twgJiraQuery',cloudId,{project,first:100},'jira',project);}
export function route(t:Task):string[]{
 const p=t.inputs;let a:string[];
 switch(t.name){
 case 'getConfluenceContentVersion':a=['confluence','content','versions','get','--id',val(p.contentId),'--at-version',val(p.versionNumber),'--format','html'];break;
 case 'getConfluenceContent':a=['confluence','content','get',val(p.content_id),'--format',val(p.content_format||'html')];if(p.detail)a.push('--detail',val(p.detail));if(p.draft)a.push('--draft');return a;
 case 'listConfluenceContent':if(p.status&&p.status!=='current')throw Error('unsupported TWG content status filter; checkpoint retained');a=['confluence','content','list','--space',val(p.spaceId),'--content-type',val(p.type)];break;
 case 'listConfluenceContentVersions':a=['confluence','content','versions','list','--id',val(p.contentId)];break;
 case 'listConfluenceComments':a=['confluence','content','comments','list','--id',val(p['content-id']),'--body-format','html','--include-replies','true'];if(p['content-type'])a.push('--content-type',val(p['content-type']));break;
 case 'listConfluenceAttachments':a=['confluence','content','attachments','list','--id',val(p.contentId),'--status',val(p.status||'current,archived')];break;
 case 'getConfluenceAttachment':a=['confluence','content','attachments','get','--attachment-id',val(p.attachmentId)];if(p.version)a.push('--at-version',val(p.version));return a;
 case 'twgJiraQuery':a=['jira','workitem','query','--jql','project = '+JSON.stringify(p.project)+' ORDER BY id ASC','--fields','*all','--first',val(p.first||100)];break;
 case 'twgJiraFull':if(!Array.isArray(p.keys)||p.keys.length<1||p.keys.length>100||p.keys.some(k=>typeof k!=='string'||!/^[A-Z][A-Z0-9_]*-\d+$/i.test(k)))throw Error('invalid Jira key batch');return ['jira','workitem','bulk-get',...p.keys,'--full','--strict'];
 case 'twgJiraChangelog':a=['jira','workitem','changelog','query','--issue-id',val(p.issue),'--first','100'];break;
 case 'twgJiraWorklog':a=['jira','workitem','worklog','query','--issue-id',val(p.issue),'--first','100','--expand','properties'];break;
 default:throw Error('unsupported connector transport; native Jira streams replace REST cursor jobs');
 }
 if(p.cursor)a.push('--cursor',val(p.cursor));if(p.after)a.push('--after',val(p.after));if(p.limit)a.push('--limit',val(p.limit));return a;
}
export function children(t:Task,response:Value):Task[]{
 if(response.error||response.ok===false||response.isError||response.meta?.truncated||response.meta?.isTruncated)throw Error('TWG error or truncated response');
 const data=response.data;if(data===undefined||data?.ok===false||data?.error)throw Error('TWG missing or failed data');
 if(!t.name.startsWith('twgJira')){
  const body=Array.isArray(data)?{results:data}:structuredClone(data);const info=response.pageInfo;
  if(info?.hasNextPage){if(!info.nextCursor||info.nextCursor===t.inputs.cursor)throw Error('invalid pagination cursor');body.nextCursor=info.nextCursor;}
  return expand(t,{structuredContent:{data:body}});
 }
 const jobs:Task[]=[];const add=(name:string,inputs:Value)=>jobs.push(task(name,t.cloudId,inputs,'jira',t.scope));
 if(t.name==='twgJiraQuery'){
  if(!Array.isArray(data.issues))throw Error('missing Jira issues');const keys=data.issues.map((i:Value)=>val(i.key));
  for(let i=0;i<keys.length;i+=100)add('twgJiraFull',{keys:keys.slice(i,i+100)});
  for(const issue of keys){add('twgJiraChangelog',{issue});add('twgJiraWorklog',{issue});}
 }
 if(t.name==='twgJiraFull'){
  if(data.items){if(!Array.isArray(data.items)||data.items.length!==(t.inputs.keys as unknown[]).length||data.items.some((i:Value)=>i.ok!==true))throw Error('partial Jira full-record batch');}
  else if((t.inputs.keys as unknown[]).length!==1||!data.key)throw Error('partial Jira full-record batch');
  return jobs;
 }
 const info=response.pageInfo;if(!info||typeof info.hasNextPage!=='boolean')throw Error('missing pagination coverage');
 if(info.hasNextPage){if(typeof info.nextCursor!=='string'||!info.nextCursor||info.nextCursor===t.inputs.after)throw Error('invalid pagination cursor');add(t.name,{...t.inputs,after:info.nextCursor});}
 return jobs;
}
/** Inline CLI-generated body artifacts; never follow a provider-supplied external path. */
export async function embed(response:Value,root:string):Promise<Value>{
 const files=new Set<string>();const scan=(v:any)=>{if(!v||typeof v!=='object')return;for(const[k,value]of Object.entries(v)){if(k==='outputFile'&&typeof value==='string')files.add(value);else if(k==='output_files'&&value&&typeof value==='object')for(const p of Object.values(value))if(typeof p==='string')files.add(p);else{}else scan(value);}};scan(response);
 if(!files.size)return response;const embedded=[];for(const path of files){const file=resolve(path);if(!file.startsWith(resolve(root)+sep))throw Error('CLI body artifact outside archive');if((await lstat(file)).isSymbolicLink()||await realpath(file)!==file)throw Error('aliased CLI body artifact');const bytes=await readFile(file);embedded.push({path,encoding:'base64',bytes:bytes.length,hash:createHash('sha256').update(bytes).digest('hex'),data:bytes.toString('base64')});}
 return {...response,embeddedFiles:embedded};
}
export function failure(raw:Value):'retry'|'auth'|'failed'{
 const text=JSON.stringify(raw.error??raw);
 if(/(?:status|http)[^0-9]{0,12}(?:429|50[234])\b|rate.?limit|too many requests|timed?.out/i.test(text))return 'retry';
 if(/(?:status|http)[^0-9]{0,12}401\b|unauthorized|not.auth|login.required|authentication.required/i.test(text))return 'auth';
 return 'failed';
}
export async function collect(config:Config){
 const concurrency=config.concurrency??4;
 if(!Number.isInteger(concurrency)||concurrency<1||concurrency>8)throw Error('collector concurrency must be 1..8');
 const root=await realpath(config.root),lock=join(root,'.twg-collector-lock');await mkdir(lock);
 const intake=await Intake.open(root),reader=new DatabaseSync(join(root,'state/intake.sqlite'),{readOnly:true});
 let stopping=false,done=0,retries=0,cooldown=0;const abort=new AbortController(),children=new Set<ChildProcess>(),active=new Set<string>(),blocked=new Map<string,string>();
 const stop=()=>{stopping=true;abort.abort();for(const child of children){child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),2000);timer.unref();}};
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
 let reporting=Promise.resolve();
 const status=(state:string,extra:Value={})=>reporting=reporting.then(()=>atomic(join(root,'twg-progress.json'),{updated:new Date().toISOString(),state,processed:done,retries,active:active.size,concurrency,backoffUntil:cooldown?new Date(cooldown).toISOString():null,...intake.status(),transportBlocked:blocked.size,...extra}));
 const pause=async(ms:number)=>{try{await sleep(ms,undefined,{signal:abort.signal});}catch{}};
 const defer=async(raw:unknown)=>{let seconds=60;const visit=(v:any,depth=0)=>{if(!v||typeof v!=='object'||depth>8)return;for(const[k,value]of Object.entries(v)){if(/retry.?after/i.test(k)){const n=Number(value);if(Number.isFinite(n)&&n>0)seconds=Math.max(seconds,n);}else if(typeof value==='object')visit(value,depth+1);}};visit(raw);cooldown=Math.max(cooldown,Date.now()+seconds*1000);retries++;await status('retry-wait');};
 const worker=async()=>{
  while(!stopping){
   while(!stopping&&Date.now()<cooldown)await pause(Math.min(1000,cooldown-Date.now()));
   if(stopping)break;
   let job:Task|undefined;
   for(const row of reader.prepare("SELECT task FROM jobs WHERE state='pending' ORDER BY CASE json_extract(task,'$.name') WHEN 'twgJiraQuery' THEN 0 WHEN 'twgJiraFull' THEN 1 ELSE 2 END,rowid").iterate()){
    const t=JSON.parse(String(row.task))as Task;if(blocked.has(t.id)||active.has(t.id))continue;
    try{route(t);job=t;break;}catch(e){blocked.set(t.id,String(e));}
   }
   if(!job){if(active.size){await pause(50);continue;}return;}
   active.add(job.id);
   try{
    const disk=await statfs(root);if(disk.bavail*disk.bsize<3*1024**3)throw Error('disk reserve reached');
    const base=join(root,'twg-transfer',job.id+'-'+randomUUID()),output=base+'.json';
    const out=await open(base+'.stdout','w',0o600),err=await open(base+'.stderr','w',0o600);
    let code:number|null,child:ChildProcess|undefined;
    try{
     child=spawn(config.executable,[...route(job),'--site',config.site,'--output','json','--output-summary','none','--output-file',output],{stdio:['ignore',out.fd,err.fd],env:{...process.env,TMPDIR:join(root,'twg-transfer')}});children.add(child);
     const timer=setTimeout(()=>child?.kill('SIGTERM'),180000);
     const killer=setTimeout(()=>child?.kill('SIGKILL'),182000);
     try{code=await new Promise<number|null>((ok,no)=>{child!.once('error',no);child!.once('exit',ok);});}finally{clearTimeout(timer);clearTimeout(killer);children.delete(child);}
    }finally{await out.close();await err.close();}
    if(stopping)break;
    let raw:Value;
    try{raw=JSON.parse(await readFile(output,'utf8'));}catch{
     const diagnostic=await readFile(base+'.stderr','utf8');
     if(/429|rate.limit|50[234]|timed?.out|ECONN/i.test(diagnostic)){await defer({});continue;}
     throw Error('TWG did not publish valid JSON; inspect local attempt '+base);
    }
    if(raw.error||raw.ok===false||raw.isError||code!==0){
     const kind=failure(raw);
     if(kind==='retry'){await defer(raw);continue;}
     if(kind==='auth')throw Error('TWG access blocked; inspect local attempt '+base);
     await intake.fail(job,raw,'TWG provider request failed; original response retained');
    }else{
     raw=await embed(raw,root);let next:Task[];
     try{next=childrenFor(job,raw);}catch(e){await intake.fail(job,raw,'TWG coverage validation: '+String(e));await status('coverage-error',{job:job.id});continue;}
     await intake.accept(job,raw,next);
    }
    done++;await status('running');if(config.pauseMs)await pause(Math.max(0,config.pauseMs));
   }finally{active.delete(job.id);}
  }
 };
 // Separate the child-process set from the pure expansion function.
 const childrenFor=childrenOf;
 try{
  await intake.recover();intake.seed(config.projects.map(p=>seed(config.cloudId,p)));await mkdir(join(root,'twg-transfer'),{recursive:true,mode:0o700});await status('running');
  const results=await Promise.allSettled(Array.from({length:concurrency},()=>worker().catch(e=>{stop();throw e;})));
  const failed=results.find(r=>r.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
  await atomic(join(root,'twg-blocked.json'),[...blocked].map(([id,reason])=>({id,reason})));
  if(!stopping)await intake.verify();await status(stopping?'paused':intake.status().pending||intake.status().failed?'finished-with-gaps':'complete');
 }catch(e){await atomic(join(root,'twg-blocked.json'),[...blocked].map(([id,reason])=>({id,reason})));await status('blocked',{diagnostic:String(e)});throw e;
 }finally{await reporting;reader.close();intake.close();process.off('SIGINT',stop);process.off('SIGTERM',stop);await rm(lock,{recursive:true});}
}
const childrenOf=children;

if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename)){process.umask(0o077);readFile(resolve(process.argv[2]),'utf8').then(s=>collect(JSON.parse(s))).catch(()=>{console.error('TWG collector stopped; inspect local twg-progress.json.');process.exitCode=1;});}
