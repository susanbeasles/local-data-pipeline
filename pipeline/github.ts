/** Read-only GitHub export. No source contents are logged or sent to models. */
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, open, rename, readFile, rm, realpath, statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { Intake, type Task } from './intake.ts';
import { atomic } from './store.ts';
const exec = promisify(execFile);
const base = 'https://api.github.com';
const hash = (s:string) => createHash('sha256').update(s).digest('hex');
export function job(path:string, name='api'):Task {
  return {id:hash(name+':'+path), name, cloudId:'github', kind:'github', scope:'GitHub', inputs:{path}};
}
function safe(path:string):string {
  const url = new URL(path,base);
  if (url.origin !== base || url.username || url.password) throw Error('unsafe GitHub URL');
  return url.pathname+url.search;
}
export function expand(task:Task, data:unknown, link:string, org:string):Task[] {
  const path = safe(String(task.inputs.path)); const out:Task[]=[];
  const next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1];
  if(next) { const target=safe(next); if(target===path) throw Error('repeated page'); out.push(job(target)); }
  const repos = path.startsWith('/orgs/');
  const pulls = /^\/(?:repos\/[^/]+\/[^/]+|repositories\/\d+)\/pulls\?/.test(path);
  if (!Array.isArray(data)) throw Error('expected a GitHub list page');
  for(const row of data as Record<string,any>[]) {
    if(repos) {
      const full = String(row.full_name);
      if(!new RegExp('^'+org.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/[A-Za-z0-9_.-]+$','i').test(full)) throw Error('repository outside selected organization');
      out.push(job(full,'git'));
      const root='/repos/'+full;
      for(const endpoint of ['issues?state=all','pulls?state=all','issues/comments?','issues/events?','pulls/comments?','comments?','releases?','milestones?state=all','labels?','branches?','tags?'])
        out.push(job(root+'/'+endpoint+(endpoint.endsWith('?')?'':'&')+'per_page=100'));
    } else if(pulls) {
      if(!Number.isSafeInteger(row.number)||row.number<1) throw Error('invalid PR number');
      out.push(job(path.split('?')[0]+'/'+row.number+'/reviews?per_page=100'));
    }
  }
  return out;
}
export function delay(headers:Headers, now=Date.now()):number {
  const retry=headers.get('retry-after');
  const wait=retry ? (/^\d+$/.test(retry)?Number(retry)*1000:Date.parse(retry)-now):0;
  const reset=headers.get('x-ratelimit-remaining')==='0'?Number(headers.get('x-ratelimit-reset'))*1000-now+2000:0;
  return Math.max(1000,wait||0,reset||0);
}
function gitEnv(token?:string):NodeJS.ProcessEnv {
  const env={...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',GIT_LFS_SKIP_SMUDGE:'1'};
  return {...env,GIT_CONFIG_COUNT:token?'4':'3',GIT_CONFIG_KEY_0:'core.hooksPath',GIT_CONFIG_VALUE_0:'/dev/null',GIT_CONFIG_KEY_1:'protocol.allow',GIT_CONFIG_VALUE_1:'never',GIT_CONFIG_KEY_2:'protocol.https.allow',GIT_CONFIG_VALUE_2:'always',...(token?{GIT_CONFIG_KEY_3:'http.https://github.com/.extraheader',GIT_CONFIG_VALUE_3:'AUTHORIZATION: basic '+Buffer.from('x-access-token:'+token).toString('base64')}:{})};
}
async function git(repo:string,args:string[],token?:string) {
  const running=exec('git',['-C',repo,...args],{env:gitEnv(token),maxBuffer:8*1024*1024});
  let low=false;
  const guard=setInterval(()=>{void statfs(repo).then(s=>{if(s.bavail*s.bsize<2*1024**3){low=true;running.child.kill('SIGTERM');}}).catch(()=>{});},1000);
  guard.unref();
  try {const result=await running;if(low) throw Error('disk reserve reached');return result;}
  finally {clearInterval(guard);}
}
/** One cat-file process streams all raw objects; no per-commit network/API calls. */
export async function exportGit(repo:string, root:string, repository:string):Promise<void> {
  await mkdir(root,{recursive:true,mode:0o700});
  await git(repo,['fsck','--full','--strict']);
  const shallow=(await git(repo,['rev-parse','--is-shallow-repository'])).stdout.trim();
  if(shallow!=='false') throw Error('shallow history is incomplete');
  const db=new DatabaseSync(join(root,'git.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS objects(oid TEXT,part INTEGER,kind TEXT,record TEXT NOT NULL,PRIMARY KEY(oid,part));
    CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  const old=db.prepare("SELECT value FROM metadata WHERE key='repository'").get();
  if(old && old.value!==repository) {db.close(); throw Error('Git archive repository mismatch');}
  db.prepare("INSERT OR IGNORE INTO metadata VALUES('repository',?)").run(repository);
  const child=spawn('git',['-C',repo,'cat-file','--batch-all-objects','--batch','--unordered'],{env:gitEnv(),stdio:['ignore','pipe','ignore']});
  const exited=new Promise<void>((ok,fail)=>{child.on('error',fail);child.on('close',code=>code===0?ok():fail(Error('Git object stream failed')));});
  // Attach immediately, including while stdout is consumed.
  void exited.catch(()=>{});
  let buffer:Buffer=Buffer.alloc(0), current:{oid:string;kind:string;size:number;remaining:number;part:number;digest:ReturnType<typeof createHash>}|undefined;
  let trailer=false;
  const insert=db.prepare('INSERT OR IGNORE INTO objects VALUES(?,?,?,?)');
  const lookup=db.prepare('SELECT record FROM objects WHERE oid=? AND part=?');
  const format=(await git(repo,['rev-parse','--show-object-format'])).stdout.trim();
  if(!['sha1','sha256'].includes(format)) throw Error('unknown Git object format');
  let records=0;db.exec('BEGIN IMMEDIATE');
  try {
    for await(const chunk of child.stdout) {
      buffer=Buffer.concat([buffer,chunk]);
      for(;;) {
        if(trailer) { if(!buffer.length) break; if(buffer[0]!==10) throw Error('invalid Git object framing'); buffer=buffer.subarray(1); trailer=false; }
        if(!current) {
          const end=buffer.indexOf(10); if(end<0) break;
          const match=/^([a-f0-9]+) (blob|tree|commit|tag) (\d+)$/.exec(buffer.subarray(0,end).toString());
          if(!match) throw Error('invalid Git object header');
          const size=Number(match[3]); if(!Number.isSafeInteger(size)) throw Error('invalid Git object size');
          current={oid:match[1]!,kind:match[2]!,size,remaining:size,part:0,digest:createHash(format).update(match[2]+' '+size+'\0')}; buffer=buffer.subarray(end+1);
        }
        const length=Math.min(current.remaining,1024*1024); if(buffer.length<length) break;
        const data=buffer.subarray(0,length); buffer=buffer.subarray(length); current.digest.update(data);
        const utf8=data.toString('utf8');
        const record=JSON.stringify({repository,oid:current.oid,kind:current.kind,size:current.size,part:current.part,encoding:'base64',data:data.toString('base64'),...(current.part===0&&length===current.size&&Buffer.from(utf8).equals(data)?{text:utf8}:{})});
        const prior=lookup.get(current.oid,current.part);
        if(prior && prior.record!==record) throw Error('corrupt or conflicting Git object');
        insert.run(current.oid,current.part,current.kind,record);
        if(++records%128===0) {db.exec('COMMIT; BEGIN IMMEDIATE');const space=await statfs(root);if(space.bavail*space.bsize<2*1024**3) throw Error('disk reserve reached during Git export');}
        current.part++; current.remaining-=length;
        if(current.part%128===0) {const space=await statfs(root);if(space.bavail*space.bsize<2*1024**3) throw Error('disk reserve reached during Git export');}
        if(!current.remaining) { if(current.digest.digest('hex')!==current.oid) throw Error('Git object hash mismatch'); current=undefined; trailer=true; }
      }
    }
    await exited; if(buffer.length || current || trailer) throw Error('truncated Git object stream');
    db.exec('COMMIT');
    const refs=(await git(repo,['for-each-ref','--format=%(objectname) %(refname)'])).stdout;
    db.prepare("INSERT OR REPLACE INTO metadata VALUES('refs',?)").run(refs);
    // Rebuild the mirror from committed records, atomically: crash/restart cannot append duplicates.
    const file=await open(join(root,'objects.jsonl.tmp'),'w',0o600);
    try { for(const row of db.prepare('SELECT record FROM objects ORDER BY oid,part').iterate()) await file.writeFile(String(row.record)+'\n'); await file.sync(); } finally {await file.close();}
    await rename(join(root,'objects.jsonl.tmp'),join(root,'objects.jsonl'));
    await atomic(join(root,'refs.jsonl'),JSON.stringify({repository,refs})+'\n',true);
  } finally {child.kill();if(db.isTransaction) db.exec('ROLLBACK');db.close();}
}

async function run() {
  process.umask(0o077);
  const [configPath]=process.argv.slice(2); if(!configPath) throw Error('usage: node pipeline/github.ts CONFIG.json');
  const config=JSON.parse(await readFile(configPath,'utf8')) as {root:string;org:string;account:string};
  if(!/^[A-Za-z0-9-]+$/.test(config.org)||!/^[A-Za-z0-9-]+$/.test(config.account)) throw Error('invalid organization/account');
  const root=resolve(config.root); await mkdir(root,{recursive:true,mode:0o700});
  if(await realpath(root)!==root) throw Error('aliased output root');
  const lock=join(root,'.collector-lock'); await mkdir(lock); // Exclusive, fail closed after an unclean exit.
  const intake=await Intake.open(root);
  let stopping=false, requests=0;
  const abort=new AbortController();
  const stop=()=>{stopping=true;abort.abort();};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  const pause=async(ms:number)=>{try{await sleep(ms,undefined,{signal:abort.signal});}catch{}};
  const progress=async(state:string)=>atomic(join(root,'progress.json'),JSON.stringify({state,updated:new Date().toISOString(),requests,...intake.status()})+'\n',true);
  try {
    const binding=JSON.stringify({org:config.org,account:config.account});
    try { if((await readFile(join(root,'binding.json'),'utf8'))!==binding+'\n') throw Error('checkpoint configuration mismatch'); }
    catch(e) {if((e as NodeJS.ErrnoException).code!=='ENOENT') throw e; await atomic(join(root,'binding.json'),binding+'\n',true);}
    const token=(await exec('gh',['auth','token','--hostname','github.com','--user',config.account])).stdout.trim();
    const headers={Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
    const identity=await fetch(base+'/user',{headers,redirect:'error',signal:AbortSignal.timeout(60000)});
    if(!identity.ok || String((await identity.json() as {login:string}).login).toLowerCase()!==config.account.toLowerCase()) throw Error('GitHub identity mismatch');
    await intake.recover(); intake.seed([job('/orgs/'+config.org+'/repos?type=all&per_page=100')]);
    while(!stopping) {
      const task=intake.pending(1)[0]; if(!task) break;
      const space=await statfs(root);if(space.bavail*space.bsize<3*1024**3) throw Error('less than 3 GiB disk reserve; pending work retained');
      await progress('running');
      if(task.name==='git') {
        const full=String(task.inputs.path), repo=join(root,'git',hash(full));
        await mkdir(repo,{recursive:true,mode:0o700});
        await git(repo,['init','--bare','--quiet']);
        // One bulk fetch for heads, tags and GitHub PR refs; no checkout or repository hooks.
        let fetched=false;
        for(let attempt=0;attempt<5&&!stopping;attempt++) {
          try {await git(repo,['-c','http.followRedirects=false','fetch','--force','--prune','https://github.com/'+full+'.git','+refs/*:refs/*'],token);fetched=true;break;}
          catch {await progress('git-retry');await pause(Math.min(300000,30000*2**attempt));}
        }
        if(!fetched) throw Error('Git fetch blocked; pending repository retained');
        await exportGit(repo,repo,full);
        await intake.accept(task,{repository:full,archive:'git/'+hash(full),verified:true},[]);
      } else {
        let response:Response;
        try {response=await fetch(base+safe(String(task.inputs.path)),{headers,redirect:'error',signal:AbortSignal.timeout(90000)});requests++;}
        catch {await progress('transport-retry');await pause(10000);continue;}
        if(response.status===429 || response.status>=500 || (response.status===403 && (response.headers.get('retry-after') || response.headers.get('x-ratelimit-remaining')==='0'))) {
          const ms=Math.max(response.status===403?60000:1000,delay(response.headers));await response.body?.cancel();await progress('rate-limit-wait');await pause(ms);continue;
        }
        if(!response.ok) {
          const problem=await response.json().catch(()=>({})) as {message?:string};
          if(response.status===403 && /secondary rate|abuse/i.test(problem.message||'')) {await progress('rate-limit-wait');await pause(Math.max(60000,delay(response.headers)));continue;}
          throw Error('GitHub HTTP '+response.status+'; pending page retained');
        }
        const data=await response.json();
        if(!Array.isArray(data)) throw Error('GitHub returned an invalid page');
        await intake.accept(task,data,expand(task,data,response.headers.get('link')||'',config.org));
        await pause(delay(response.headers));
      }
      await progress('running');
    }
    if(!stopping) await intake.verify();
    await progress(stopping?'paused':'complete');
  } catch(error) {await progress('blocked');await atomic(join(root,'diagnostic.json'),JSON.stringify({error:error instanceof Error?error.message.replace(/(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g,'[redacted]'):'collector failure'})+'\n',true);throw error;}
  finally {intake.close();await rm(lock,{recursive:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename)) run().catch(()=>{console.error('GitHub collector stopped. Check progress.json; pending work is retained.');process.exitCode=1;});
