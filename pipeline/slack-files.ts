/** Supplementary read-only Slack file/profile collection. No message contents in logs. */
import { DatabaseSync } from 'node:sqlite';
import { mkdir, open, readFile, statfs, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Intake, type Task } from './intake.ts';
import { task } from './slack.ts';
import { Content } from './content.ts';
import { atomic } from './store.ts';

export function url(value: string): URL {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || !['files.slack.com', 'slack.com'].includes(parsed.hostname) || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) throw Error('untrusted Slack download URL');
  return parsed;
}
export function expand(job: Task, data: Record<string, any>): Task[] {
  if (data.ok !== true) throw Error(String(data.error || 'Slack request failed'));
  const children: Task[] = [];
  if (job.name === 'files.list') {
    if (!Array.isArray(data.files) || !data.paging || !Number.isSafeInteger(data.paging.pages)) throw Error('invalid file pagination');
    for (const file of data.files) {
      if (!/^F[A-Z0-9]+$/.test(file.id)) throw Error('invalid file ID');
      children.push(task('files.info', { file: file.id, limit: 100 }));
    }
    if (data.paging.page !== job.inputs.page) throw Error('file page mismatch');
    if (data.paging.page < data.paging.pages) children.push(task(job.name, { ...job.inputs, page: data.paging.page + 1 }));
  }
  if (job.name === 'files.info') {
    const file = data.file;
    if (!file || file.id !== job.inputs.file) throw Error('file identity mismatch');
    if (!job.inputs.cursor) {
      const address = file.url_private_download || file.url_private;
      if (!address || !Number.isSafeInteger(file.size) || file.size < 0) throw Error('file has no downloadable original; metadata preserved');
      children.push(task('file.download', { file: file.id, url: url(address).href, bytes: file.size }));
    }
  }
  const cursor = data.response_metadata?.next_cursor?.trim();
  if (cursor) {
    if (cursor === job.inputs.cursor) throw Error('repeated cursor');
    children.push(task(job.name, { ...job.inputs, cursor }));
  }
  if (job.name === 'users.list' && !Array.isArray(data.members)) throw Error('invalid user list');
  return children;
}
export async function save(db: DatabaseSync, root: string, id: string, response: Response, bytes: number): Promise<{hash: string; bytes: number}> {
  if (!/^F[A-Z0-9]+$/.test(id) || !Number.isSafeInteger(bytes) || bytes < 0) throw Error('invalid file metadata');
  if (!response.ok || !response.body) throw Error('file download failed');
  const disk = await statfs(root);
  if (disk.bavail * disk.bsize < bytes * 2.7 + 1024 ** 3) throw Error('insufficient disk for SQLite and JSONL file contents');
  const path = join(root, 'tmp', id + '.part');
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  const digest = createHash('sha256');
  let count = 0;
  try {
    for await (const block of response.body) {
      count += block.byteLength;
      if (count > bytes) throw Error('download size mismatch');
      digest.update(block);
      let offset = 0;
      while (offset < block.byteLength) {
        const written = await file.write(block, offset, block.byteLength - offset);
        if (!written.bytesWritten) throw Error('download write stalled');
        offset += written.bytesWritten;
      }
    }
    if (count !== bytes) throw Error('download size mismatch');
    await file.sync();
  } finally { await file.close(); }
  const hash = digest.digest('hex');
  const content = new Content(db, root);
  await content.capture(id, path, hash, join(root, 'staging', id + '.jsonl'));
  await content.verify(id, hash);
  await unlink(path); // Only our verified, reproducible download spool.
  return { hash, bytes: count };
}
async function run() {
  process.umask(0o077);
  const root = resolve(process.argv[2]!);
  const token = (await readFile(process.argv[3]!, 'utf8')).trim();
  const intake = await Intake.open(root);
  await mkdir(join(root, 'tmp'), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(root, 'files.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  const content = new Content(db, root);
  intake.seed([task('files.list', { count: 100, page: 1 }), task('users.list', { limit: 100 })]);
  await intake.recover();
  let stop = false;
  process.on('SIGTERM', () => { stop = true; });
  process.on('SIGINT', () => { stop = true; });
  try {
    while (!stop) {
      const job = intake.pending(1)[0];
      if (!job) break;
      try {
        if (job.name === 'file.download') {
          const id = String(job.inputs.file);
          const prior = db.prepare('SELECT s.hash,b.bytes FROM content_sources s JOIN content_blobs b ON b.hash=s.hash WHERE s.source=?').get(id);
          let saved: {hash: string; bytes: number};
          if (prior) { await content.verify(id, String(prior.hash)); saved = { hash: String(prior.hash), bytes: Number(prior.bytes) }; }
          else {
            const response = await fetch(url(String(job.inputs.url)), { headers: { Authorization: `Bearer ${token}` }, redirect: 'manual', signal: AbortSignal.timeout(300000) });
            if (response.status === 429 || response.status >= 500) { const delay = Math.max(5, Number(response.headers.get('retry-after')) || 30); await new Promise(r => setTimeout(r, delay * 1000)); continue; }
            if (!response.ok) { await intake.fail(job, { ok: false, status: response.status, file: id }, 'File original unavailable from provider'); continue; }
            saved = await capture(db, root, id, response, Number(job.inputs.bytes));
          }
          const receipt = { ok: saved.bytes === Number(job.inputs.bytes), file: id, ...saved, declaredBytes: Number(job.inputs.bytes), exactSize: saved.bytes === Number(job.inputs.bytes), content: 'SQLite BLOB blocks and base64 JSONL' };
          if (receipt.exactSize) await intake.accept(job, receipt, []);
          else await intake.fail(job, receipt, 'Provider download size differs from source metadata; returned bytes retained, original completeness unresolved');
        } else {
          if (!['files.list', 'files.info', 'users.list'].includes(job.name)) throw Error('unsupported Slack read method');
          const response = await fetch('https://slack.com/api/' + job.name, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(Object.entries(job.inputs).map(([k,v]) => [k,String(v)])), redirect: 'error', signal: AbortSignal.timeout(60000) });
          if (response.status === 429 || response.status >= 500) { await new Promise(r => setTimeout(r, Math.max(5, Number(response.headers.get('retry-after')) || 30) * 1000)); continue; }
          const data = await response.json() as Record<string, any>;
          if (['invalid_auth','token_revoked','not_authed'].includes(data.error)) throw Error('authorization unavailable');
          let children: Task[];
          try { children = expand(job, data); }
          catch { await intake.fail(job, data, 'provider response incomplete or file unavailable; inspect local receipt'); continue; }
          await intake.accept(job, data, children);
        }
      } catch {
        await atomic(join(root, 'progress.json'), { updated: new Date().toISOString(), state: 'blocked', ...intake.status(), diagnostic: 'Current request retained pending; network, disk, file access or integrity check failed.' });
        throw Error('collection blocked; current job remains pending');
      }
      await atomic(join(root, 'progress.json'), { updated: new Date().toISOString(), state: 'running', ...intake.status() });
      await new Promise(r => setTimeout(r, 1200));
    }
    const verification = await intake.verify();
    await atomic(join(root, 'progress.json'), { updated: new Date().toISOString(), state: stop ? 'paused' : 'finished', ...intake.status(), verification });
  } finally { db.close(); intake.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) run().catch(() => { console.error('Slack file collection stopped; pending checkpoint retained.'); process.exitCode = 1; });

export async function capture(db: DatabaseSync, root: string, id: string, response: Response, declaredBytes: number): Promise<{hash: string; bytes: number; declaredBytes: number; exactSize: boolean}> {
 if (!/^F[A-Z0-9]+$/.test(id)||!Number.isSafeInteger(declaredBytes)||declaredBytes<0||!response.ok||!response.body)throw Error('Invalid download');
 const disk=await statfs(root);if(disk.bavail*disk.bsize<declaredBytes*2.7+1024**3)throw Error('insufficient disk for SQLite and JSONL file contents');
 const path=join(root,'tmp',id+'.part'),file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC|constants.O_NOFOLLOW,0o600),digest=createHash('sha256');let bytes=0,checked=0;
 try{
  for await(const block of response.body){bytes+=block.byteLength;if(bytes-checked>=16*1024**2){const free=await statfs(root);if(free.bavail*free.bsize<bytes*1.7+1024**3)throw Error('disk reserve reached during download');checked=bytes;}digest.update(block);let offset=0;while(offset<block.byteLength){const written=await file.write(block,offset,block.byteLength-offset);if(!written.bytesWritten)throw Error('download write stalled');offset+=written.bytesWritten;}}
  await file.sync();
 }finally{await file.close();}
 const hash=digest.digest('hex'),content=new Content(db,root);await content.capture(id,path,hash,join(root,'staging',id+'.jsonl'));await content.verify(id,hash);await unlink(path);
 return {hash,bytes,declaredBytes,exactSize:bytes===declaredBytes};
}
