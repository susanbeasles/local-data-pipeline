/** Lossless inventory ingestion. Deletion is opt-in and follows independent verification. */
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdir,realpath,lstat,readlink,readFile,opendir,readdir} from 'node:fs/promises';
import {join,resolve,relative,sep,isAbsolute,dirname} from 'node:path';
import {spawn} from 'node:child_process';
import {Content} from './content.ts';
import {hash,atomic,publish} from './store.ts';
import {fileHash} from './seal.ts';
import {evict} from './evict.ts';
import {Lock} from './lock.ts';

type Config={input:string;work:string;inventory:string;archives:string[];deleteVerified:boolean;protect:string[];codec:'none'|'brotli';deletions?:string[];excluded?:Record<string,string>};
type Entry={path:string;kind:string;bytes:number;hash?:string;source?:string;archive?:string;mode?:number;inode?:number;device?:number;mtimeMs?:number;ctimeMs?:number;target?:string;state:string;reason?:string};
async function workPath(work:string){let ancestor=work;for(;;){try{if(await realpath(ancestor)!==ancestor)throw Error('aliased work ancestor');break;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;ancestor=dirname(ancestor);}}}
export async function ingest(config:Config){
 const input=await realpath(config.input),work=resolve(config.work);
 if(work===input||work.startsWith(input+sep)||input.startsWith(work+sep))throw Error('input and work overlap');
 await workPath(work);await mkdir(work,{recursive:true,mode:0o700});if(await realpath(work)!==work)throw Error('aliased work directory');
 if(!['none','brotli'].includes(config.codec)||typeof config.deleteVerified!=='boolean')throw Error('invalid ingestion configuration');
 const lock=await Lock.acquire(join(work,'ingest.lock'));
 const inventory=new DatabaseSync(config.inventory,{readOnly:true}),db=new DatabaseSync(join(work,'preservation.sqlite'));
 db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS entries(path TEXT PRIMARY KEY,body TEXT NOT NULL,state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS binding(body TEXT NOT NULL);');
 const columns=inventory.prepare('PRAGMA table_info(entries)').all().map(r=>String(r.name));const fields=['path','kind','bytes',...['device','inode','blocks'].filter(k=>columns.includes(k))];
 const fingerprint=()=>{const digest=createHash('sha256');for(const row of inventory.prepare('SELECT '+fields.join(',')+' FROM entries ORDER BY path').iterate())digest.update(JSON.stringify(fields.map(k=>row[k]))+'\n');return digest.digest('hex')};
 const inventoryHash=fingerprint();const expected=Number(inventory.prepare('SELECT count(*) n FROM entries').get()!.n);
 const binding=JSON.stringify({...config,input,work,inventoryHash});const old=db.prepare('SELECT body FROM binding').get();if(old&&old.body!==binding){inventory.close();db.close();await lock.close();throw Error('checkpoint configuration or inventory differs');}if(!old)db.prepare('INSERT INTO binding VALUES(?)').run(binding);
 await mkdir(join(work,'content'),{recursive:true,mode:0o700});
 const content=new Content(db,work,config.codec),archives=new Map<string,{db:DatabaseSync;content:Content}>();
 const deleted=new Map<string,Record<string,any>>();
 const counts=new Map<string,number>(db.prepare('SELECT state,count(*) n FROM entries GROUP BY state').all().map(r=>[String(r.state),Number(r.n)]));let recorded=[...counts.values()].reduce((n,v)=>n+v,0),processed=0;
 const find=db.prepare('SELECT body,state FROM entries WHERE path=?'),upsert=db.prepare('INSERT OR REPLACE INTO entries VALUES(?,?,?)');
 const save=(entry:Entry)=>{const old=find.get(entry.path);upsert.run(entry.path,JSON.stringify(entry),entry.state);if(old)counts.set(String(old.state),(counts.get(String(old.state))||0)-1);else recorded++;counts.set(entry.state,(counts.get(entry.state)||0)+1);};
 let stopping=false;const stop=()=>{stopping=true};process.on('SIGTERM',stop);process.on('SIGINT',stop);
 const report=()=>({complete:recorded===expected&&!counts.get('failed')&&!counts.get('running'),expected,recorded,failed:counts.get('failed')||0,states:Object.fromEntries(counts),updated:new Date().toISOString()});
 try{
  for(const root of config.archives){const actual=await realpath(root);const source=new DatabaseSync(join(actual,'preservation.sqlite'),{readOnly:true});archives.set(actual,{db:source,content:new Content(source,actual)});}
  for(const path of [...(config.deletions||[]),join(work,'deletions.sqlite')]){try{await lstat(path)}catch(error){if(path===join(work,'deletions.sqlite')&&(error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error}const ledger=new DatabaseSync(path,{readOnly:true});try{for(const row of ledger.prepare("SELECT record FROM deletions WHERE state IN ('prepared','deleted')").iterate()){const r=JSON.parse(String(row.record));if(r.input===input)deleted.set(r.path,r);}}finally{ledger.close()}}
  for(const row of inventory.prepare('SELECT '+fields.join(',')+' FROM entries ORDER BY rowid').iterate()){
   if(stopping)break;
   const path=String(row.path),kind=String(row.kind),file=resolve(input,path);
   if(isAbsolute(path)||relative(input,file)!==path||path.split('/').includes('..'))throw Error('inventory path escapes input');
   const prior=find.get(path);
   const protectedPath=config.protect.some(prefix=>path===prefix||path.startsWith(prefix+'/'));
   if(prior&&(['deleted','directory','transient','excluded'].includes(String(prior.state))||(prior.state==='preserved'&&(!config.deleteVerified||kind==='symlink'||protectedPath))))continue;
   let entry:Entry={path,kind,bytes:Number(row.bytes),state:'running'};
   save(entry);
   try{
    if(config.excluded?.[path]){save({...entry,state:'excluded',reason:config.excluded[path]});continue;}
    const reclaimed=deleted.get(path);
    let absent=false;try{await lstat(file)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')absent=true;else throw error}
    if(reclaimed&&absent){if(kind!=='file'||reclaimed.path!==path||reclaimed.bytes!==entry.bytes)throw Error('deletion receipt differs from source inventory');const owner=reclaimed.archive===work?{content}:archives.get(reclaimed.archive);if(!owner)throw Error('deletion refers to an undeclared archive');await owner.content.verify(reclaimed.source,reclaimed.hash);const stored=owner.content.db.prepare('SELECT bytes FROM content_blobs WHERE hash=? AND complete=1').get(reclaimed.hash);if(!stored||stored.bytes!==entry.bytes)throw Error('archived deletion bytes differ from inventory');save({...entry,hash:reclaimed.hash,source:reclaimed.source,archive:reclaimed.archive,mode:reclaimed.mode,state:'deleted',reason:'previous verified deletion receipt'});continue;}
    if(kind==='directory'){const info=await lstat(file);if(!info.isDirectory())throw Error('directory changed');save({...entry,mode:info.mode&0o777,state:'directory'});continue;}
    if(kind==='socket'){save({...entry,state:'transient',reason:'kernel socket endpoint; no persistent file bytes'});continue;}
    if(kind!=='file'&&kind!=='symlink')throw Error('unsupported filesystem entry');
    if(await realpath(dirname(file))!==dirname(file))throw Error('source parent alias');const info=await lstat(file);entry.mode=info.mode&0o777;entry.inode=info.ino;entry.device=info.dev;entry.mtimeMs=info.mtimeMs;entry.ctimeMs=info.ctimeMs;
    if(kind==='symlink'){
     if(!info.isSymbolicLink())throw Error('source type changed');const target=await readlink(file),digest=hash(target);await content.link(digest,target,join(work,'content',digest+'.jsonl'));await content.verify(digest,digest);save({...entry,target,hash:digest,source:digest,archive:work,state:'preserved',reason:'symlink target stored; directory entry retained'});continue;
    }
    if(!info.isFile()||info.size!==entry.bytes)throw Error('source type or size changed');
    const digest=await fileHash(file);let owner=work,source=digest,reader=content;
    for(const [root,store]of archives){const match=store.db.prepare('SELECT source FROM content_sources WHERE hash=? LIMIT 1').get(digest);if(match){owner=root;source=String(match.source);reader=store.content;break;}}
    if(owner===work){const prior=db.prepare('SELECT hash FROM content_sources WHERE source=?').get(source);if(!prior)await content.capture(source,file,digest,join(work,'content',digest+'.jsonl'));}
    await reader.verify(source,digest);
    entry={...entry,hash:digest,source,archive:owner,state:'preserved'};save(entry);
    if(config.deleteVerified&&!protectedPath){await evict({input,path,archive:owner,source,digest,ledger:join(work,'deletions.sqlite')});entry.state='deleted';save(entry);}
    else if(protectedPath){entry.reason='protected active asset; contents preserved, original retained';save(entry);}
   }catch(error){entry={...entry,state:'failed',reason:error instanceof Error?error.message:'ingestion failure'};save(entry);if(/disk|SQLITE_FULL|ENOSPC/.test(entry.reason!)){await atomic(join(work,'progress.json'),{...report(),blocked:'disk capacity',path});break;}}
   if(++processed%100===0)await atomic(join(work,'progress.json'),report());
  }
  if(!stopping&&recorded===expected&&!counts.get('failed')){
   async function audit(directory:string):Promise<void>{for await(const child of await opendir(directory)){const file=join(directory,child.name),path=relative(input,file),info=await lstat(file),found=find.get(path);if(!found){save({path,kind:info.isDirectory()?'directory':info.isFile()?'file':info.isSymbolicLink()?'symlink':'special',bytes:info.size,state:'failed',reason:'new source not present in sealed inventory'});}else{const entry=JSON.parse(String(found.body)) as Entry;if(entry.state==='deleted'||entry.state==='excluded')save({...entry,state:'failed',reason:'source reappeared after disposition'});else if(entry.state==='preserved'){if(entry.kind==='symlink'){if(!info.isSymbolicLink()||await readlink(file)!==entry.target)save({...entry,state:'failed',reason:'retained symlink changed'});}else if(!info.isFile()||info.size!==entry.bytes||info.ino!==entry.inode||info.dev!==entry.device||info.mtimeMs!==entry.mtimeMs||info.ctimeMs!==entry.ctimeMs)save({...entry,state:'failed',reason:'retained source changed'});}}if(info.isDirectory())await audit(file);}}
   await audit(input);
   if(fingerprint()!==inventoryHash)throw Error('source inventory changed during ingestion');
  }
  // Reconstruct every retained content reference before issuing a completion report.
  const seen=new Set<string>();if(!stopping&&recorded===expected&&!counts.get('failed'))for(const row of db.prepare("SELECT body FROM entries WHERE state IN ('deleted','preserved')").iterate()){
   const entry=JSON.parse(String(row.body)) as Entry,key=entry.archive+':'+entry.source;if(seen.has(key))continue;const reader=entry.archive===work?content:archives.get(entry.archive!)?.content;if(!reader)throw Error('archive unavailable');await reader.verify(entry.source!,entry.hash!);seen.add(key);
  }
  await publish(join(work,'inventory.jsonl'),(function*(){for(const row of db.prepare('SELECT body FROM entries ORDER BY path').iterate())yield String(row.body)+'\n';})());
  let quarantined=0;try{quarantined=(await readdir(join(work,'quarantine'))).length}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  const result={...report(),complete:report().complete&&!quarantined&&!stopping,unresolvedQuarantine:quarantined,inventoryHash,paused:stopping,deletedBytes:Number(db.prepare("SELECT coalesce(sum(json_extract(body,'$.bytes')),0) n FROM entries WHERE state='deleted'").get()!.n)};
  await atomic(join(work,'report.json'),result);await atomic(join(work,'progress.json'),result);return result;
 }finally{for(const store of archives.values())store.db.close();inventory.close();db.close();process.off('SIGTERM',stop);process.off('SIGINT',stop);await lock.close();}
}
async function main(){
 process.umask(0o077);const config=JSON.parse(await readFile(resolve(process.argv[2]!), 'utf8')) as Config;
 if(!process.argv.includes('--sandboxed')){
  if(process.platform!=='darwin')throw Error('only the verified macOS ingestion sandbox is supported');
  const input=await realpath(config.input),work=resolve(config.work);if(work===input||work.startsWith(input+sep)||input.startsWith(work+sep))throw Error('input/work overlap');await workPath(work);await mkdir(work,{recursive:true,mode:0o700});if(await realpath(work)!==work)throw Error('aliased work directory');
  const protect=config.protect.map(p=>resolve(input,p));if(protect.some(p=>!p.startsWith(input+sep)))throw Error('protection escapes input');
  const guard='(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (subpath '+JSON.stringify(work)+'))'+(config.deleteVerified?'(allow file-write-unlink (subpath '+JSON.stringify(input)+'))':'')+protect.map(p=>'(deny file-write* (subpath '+JSON.stringify(p)+'))').join('');
  const child=spawn('/usr/bin/sandbox-exec',['-p',guard,process.execPath,process.argv[1],resolve(process.argv[2]),'--sandboxed'],{stdio:'inherit',env:{PATH:'/usr/bin:/bin',HOME:work,TMPDIR:work}});process.exit(await new Promise<number>((ok,no)=>{child.on('error',no);child.on('exit',c=>ok(c??1))}));
 }
 const {assertNetworkDenied}=await import('./sandbox.ts');await assertNetworkDenied();console.log(JSON.stringify(await ingest(config)));
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename))main().catch(()=>{console.error('Ingestion stopped; originals without verified deletion receipts are retained. Inspect the local progress/report.');process.exitCode=1});
