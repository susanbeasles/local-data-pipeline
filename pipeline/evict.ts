/** Explicit per-file removal after full local SQLite + JSONL verification. */
import {DatabaseSync} from 'node:sqlite';
import files, {lstat,realpath,open,unlink,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {resolve,join,relative,sep,isAbsolute,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {Content} from './content.ts';

type Options={input:string;path:string;archive:string;source:string;digest:string;ledger:string};
export async function evict(options:Options):Promise<void>{
 const {path,source,digest}=options;
 if(!/^[a-f0-9]{64}$/.test(digest)||!path||isAbsolute(path)||path.split(/[\\/]/).includes('..'))throw Error('invalid eviction identity');
 const input=await realpath(options.input),archive=await realpath(options.archive),file=resolve(input,path),ledger=resolve(options.ledger);
 if(!file.startsWith(input+sep)||relative(input,file)!==path||ledger===input||ledger.startsWith(input+sep)||archive===input||archive.startsWith(input+sep))throw Error('eviction boundaries overlap');
 if(await realpath(dirname(file))!==dirname(file))throw Error('aliased source parent');
 const before=await lstat(file);
 if(!before.isFile()||before.isSymbolicLink())throw Error('eviction requires regular original file');
 if(await realpath(join(archive,'preservation.sqlite'))!==join(archive,'preservation.sqlite'))throw Error('aliased archive database');
 if(await realpath(dirname(ledger))!==dirname(ledger))throw Error('aliased eviction ledger directory');
 const sourceDb=new DatabaseSync(join(archive,'preservation.sqlite'),{readOnly:true});
 try{
  const content=new Content(sourceDb,archive);
  await content.verify(source,digest);
  const metadata=sourceDb.prepare('SELECT bytes FROM content_blobs WHERE hash=? AND complete=1').get(digest);
  if(!metadata||metadata.bytes!==before.size)throw Error('source size differs from preserved bytes');
 }finally{sourceDb.close()}
 const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const initial=await handle.stat();
  if(initial.ino!==before.ino||initial.dev!==before.dev)throw Error('source replaced');
  const hash=createHash('sha256');for await(const chunk of handle.createReadStream({autoClose:false}))hash.update(chunk);
  const after=await handle.stat(),current=await lstat(file);
  if(hash.digest('hex')!==digest||after.size!==initial.size||after.mtimeMs!==initial.mtimeMs||after.ctimeMs!==initial.ctimeMs||current.ino!==initial.ino||current.dev!==initial.dev||current.mtimeMs!==initial.mtimeMs||current.ctimeMs!==initial.ctimeMs)throw Error('source changed before removal');
  const quarantine=join(dirname(ledger),'quarantine');await mkdir(quarantine,{recursive:true,mode:0o700});if(await realpath(quarantine)!==quarantine)throw Error('aliased quarantine');
  const held=join(quarantine,randomUUID());
  const journal=await open(ledger,constants.O_CREAT|constants.O_WRONLY|constants.O_APPEND|constants.O_NOFOLLOW,0o600);await journal.close();
  const log=new DatabaseSync(ledger);
  try{
   log.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS deletions(path TEXT PRIMARY KEY,hash TEXT NOT NULL,record TEXT NOT NULL,state TEXT NOT NULL);');
   const record=JSON.stringify({input,path,hash:digest,bytes:initial.size,mode:initial.mode&0o777,mtimeMs:initial.mtimeMs,archive,source,inode:initial.ino,device:initial.dev,quarantine:held,verifiedAt:new Date().toISOString()});
   const prior=log.prepare('SELECT hash FROM deletions WHERE path=?').get(file);
   if(prior&&prior.hash!==digest)throw Error('eviction ledger identity conflict');
   log.prepare("INSERT INTO deletions VALUES(?,?,?,'prepared') ON CONFLICT(path) DO UPDATE SET record=excluded.record,state='prepared'").run(file,digest,record);
   // Last path identity check immediately before deleting this single directory entry.
   const final=await lstat(file);
   if(final.ino!==initial.ino||final.dev!==initial.dev||final.mtimeMs!==initial.mtimeMs||final.ctimeMs!==initial.ctimeMs)throw Error('source changed after journal preparation');
   await files.rename(file,held);
   const moved=await lstat(held);
   if(moved.ino!==initial.ino||moved.dev!==initial.dev||moved.size!==initial.size||moved.mtimeMs!==initial.mtimeMs){log.prepare("UPDATE deletions SET state='conflict' WHERE path=?").run(file);throw Error('source replaced; quarantine retained');}
   const digestNow=createHash('sha256');for await(const block of handle.createReadStream({start:0,autoClose:false}))digestNow.update(block);
   const stable=await handle.stat();
   if(digestNow.digest('hex')!==digest||stable.size!==moved.size||stable.mtimeMs!==moved.mtimeMs||stable.ctimeMs!==moved.ctimeMs){log.prepare("UPDATE deletions SET state='conflict' WHERE path=?").run(file);throw Error('quarantined source changed; retained');}
   await unlink(held);
   for(const parent of [dirname(file),quarantine]){const directory=await open(parent,'r');try{await directory.sync()}finally{await directory.close()}}
   log.prepare("UPDATE deletions SET state='deleted' WHERE path=?").run(file);
  }finally{log.close()}
 }finally{await handle.close()}
}
