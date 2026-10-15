/** Local personal AI/agent archive. Only metadata and counts reach stdout. */
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {createReadStream,constants} from 'node:fs';
import {open,mkdir,lstat,opendir,readlink,readFile,realpath,rm,statfs} from 'node:fs/promises';
import {resolve,join,relative,sep,basename} from 'node:path';
import {Content} from './content.ts';import {atomic,publish} from './store.ts';
export type Config={home:string;work:string;exclude:string[];include?:string[]};
const digest=(v:string)=>createHash('sha256').update(v).digest('hex');
const inside=(root:string,path:string)=>path===root||path.startsWith(root+sep);
/** Name-based discovery, never content inspection of unrelated files. */
export function selected(path:string):boolean {
 return /(^|\/)(\.?vscode|\.?codex|\.?claude|\.?cursor|\.?agents?|\.?aider[^/]*|\.?continue|\.?windsurf|\.?cline|\.?roo|\.?kiro|\.?opencode|\.?gemini|\.?copilot|\.?openclaw|\.?mcp)(\/|$)/i.test(path)
 || /(^|\/)(AGENTS\.md|CLAUDE\.md|GEMINI\.md|SKILL\.md|\.cursorrules|\.cursorignore|\.clinerules|\.aider[^/]*|copilot-instructions\.md|mcp[^/]*\.json|[^/]+\.prompt\.md)$/i.test(path)
 || /(^|\/)(com\.(openai|anthropic)[^/]*|github\.copilot[^/]*|openai\.chatgpt[^/]*|anthropic\.claude[^/]*|saoudrizwan\.claude-dev[^/]*|rooveterinaryinc\.roo-cline[^/]*)(\/|$)/i.test(path)
 || /(^|\/)(Application Support|Logs)\/[^/]*(codex|claude|cursor|windsurf|openai|chatgpt|anthropic|gemini|copilot|lm studio|ollama|opencode)[^/]*(\/|$)/i.test(path);
}
export async function crawl(config:Config,retry=false) {
 const home=await realpath(config.home),work=resolve(config.work);
 if(home===work || inside(work,home)) throw Error('invalid archive boundary');
 await mkdir(work,{recursive:true,mode:0o700});if(await realpath(work)!==work)throw Error('aliased archive');
 const lock=join(work,'.crawl-lock');await mkdir(lock);
 let stopping=false;const stop=()=>{stopping=true;};process.once('SIGINT',stop);process.once('SIGTERM',stop);
 let db:DatabaseSync|undefined,archive:DatabaseSync|undefined;
 try {
 const binding=JSON.stringify({...config,home,work});
 try{if(await readFile(join(work,'config-binding.json'),'utf8')!==binding+'\n')throw Error('checkpoint configuration mismatch');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;await atomic(join(work,'config-binding.json'),binding+'\n',true);}
 db=new DatabaseSync(join(work,'inventory.sqlite'));archive=new DatabaseSync(join(work,'content.sqlite'));
 db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA temp_store=MEMORY;
 CREATE TABLE IF NOT EXISTS entries(path TEXT PRIMARY KEY,kind TEXT,state TEXT,reason TEXT,bytes INTEGER,mtime REAL,mode INTEGER,hash TEXT,error TEXT);
 CREATE INDEX IF NOT EXISTS entries_state ON entries(state);`);
 archive.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;');
 const content=new Content(archive,work,'brotli');await mkdir(join(work,'content'),{recursive:true,mode:0o700});
 if(retry) db.exec("UPDATE entries SET state='pending',error=NULL WHERE state='failed'");
 const insert=db.prepare('INSERT OR IGNORE INTO entries(path,kind,state,reason,bytes,mtime,mode) VALUES(?,?,?,?,?,?,?)');
 const update=db.prepare('UPDATE entries SET state=?,hash=?,error=? WHERE path=?');
 const excludes=[work,...config.exclude.map(p=>resolve(p))];
 const prune=new Set(['node_modules','.venv','venv','__pycache__']);
 const report=()=>{const counts=Object.fromEntries(db!.prepare('SELECT state,count(*) n FROM entries GROUP BY state').all().map(r=>[String(r.state),Number(r.n)]));return {updated:new Date().toISOString(),counts,bytes:Number(db!.prepare("SELECT coalesce(sum(bytes),0) n FROM entries WHERE state='captured' AND kind='file'").get()!.n),complete:!stopping&&!counts.pending&&!counts.failed,paused:stopping};};
 insert.run('','directory','pending','home enumeration',0,0,0);
 let processed=0;
 while(!stopping) {
  const row=db.prepare("SELECT * FROM entries WHERE state='pending' ORDER BY rowid LIMIT 1").get();if(!row)break;
  const path=String(row.path),file=join(home,path);
  if(row.kind!=='directory'&&!selected(path)&&!(config.include||[]).some(p=>inside(resolve(home,p),file))){db.prepare("UPDATE entries SET state='unselected',reason='selection v2: generic plugins, skills and config directories do not identify AI data' WHERE path=?").run(path);continue;}
  const space=await statfs(work);if(space.bavail*space.bsize<3*1024**3){await atomic(join(work,'progress.json'),{...report(),blocked:'disk reserve'});break;}
  try {
   if(!inside(home,await realpath(row.kind==='directory'?file:resolve(file,'..'))))throw Error('source parent outside home');
   const info=await lstat(file);
   if(row.kind==='directory') {
    if(!info.isDirectory())throw Error('directory changed type');
    // Atomic directory publication: interruption leaves it pending, insert-or-ignore makes replay safe.
    const dir=await opendir(file);db.exec('BEGIN IMMEDIATE');
    try {
     for await(const child of dir) {
      const full=join(file,child.name),path=relative(home,full);let stat;
      try{stat=await lstat(full);}catch{insert.run(path,'unknown','failed','metadata unavailable',0,0,0);continue;}
      const kind=stat.isSymbolicLink()?'symlink':stat.isDirectory()?'directory':stat.isFile()?'file':'special';
      const excluded=excludes.some(root=>inside(root,full))||(kind==='directory'&&(prune.has(child.name)||path==='Library/Caches'||path==='Library/Metadata'||path==='.Trash'||path.endsWith('/.git/objects')));
      const match=selected(path)||(config.include||[]).some(p=>inside(resolve(home,p),full));
      insert.run(path,kind,excluded?'excluded':kind==='directory'?'pending':kind==='special'?'special':match?'pending':'unselected',excluded?'explicit boundary or dependency/cache exclusion':match?'agent/configuration path match':'name-only inventory',stat.size,stat.mtimeMs,stat.mode&0o777);
     }
     update.run('enumerated',null,null,path);db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
   }else if(row.kind==='symlink'){
    if(!info.isSymbolicLink())throw Error('source changed type');const target=await readlink(file),hash=digest(target);await content.link(hash,target,join(work,'content',hash+'.jsonl'));await content.verify(hash,hash);update.run('captured',hash,null,path);
   }else {
    if(!info.isFile())throw Error('source changed type');
    const h=createHash('sha256'),source=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{for await(const block of source.createReadStream({autoClose:false}))h.update(block);}finally{await source.close();}const hash=h.digest('hex');
    const prior=archive.prepare('SELECT hash FROM content_sources WHERE source=?').get(hash);
    if(!prior)await content.capture(hash,file,hash,join(work,'content',hash+'.jsonl'));
    const after=await lstat(file);if(after.ino!==info.ino||after.size!==info.size||after.mtimeMs!==info.mtimeMs||after.ctimeMs!==info.ctimeMs)throw Error('live file changed during capture');
    await content.verify(hash,hash);db.prepare("UPDATE entries SET state='captured',hash=?,bytes=?,mtime=?,error=NULL WHERE path=?").run(hash,after.size,after.mtimeMs,path);
   }
  }catch(e){update.run('failed',null,(e as Error).message,path);}
  if(++processed%100===0)await atomic(join(work,'progress.json'),report());
 }
 if(!stopping)for(const row of db.prepare("SELECT DISTINCT hash FROM entries WHERE state='captured'").iterate()){try{await content.verify(String(row.hash),String(row.hash));}catch(e){db.prepare("UPDATE entries SET state='failed',error=? WHERE hash=?").run((e as Error).message,row.hash);}}
 await publish(join(work,'inventory.jsonl'),(function*(){for(const row of db!.prepare('SELECT * FROM entries ORDER BY path').iterate())yield JSON.stringify(row)+'\n';})());
 const result=report();await atomic(join(work,'progress.json'),result);await atomic(join(work,'report.json'),result);return result;
 }finally{db?.close();archive?.close();process.off('SIGINT',stop);process.off('SIGTERM',stop);await rm(lock,{recursive:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename)) {
 process.umask(0o077);
 readFile(resolve(process.argv[2]!),'utf8').then(text=>crawl(JSON.parse(text),process.argv.includes('--retry'))).then(result=>console.log(JSON.stringify(result))).catch(()=>{console.error('Personal agent capture stopped; checkpoint retained.');process.exitCode=1;});
}
