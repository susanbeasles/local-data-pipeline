import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Intake, type Task } from './intake.ts';

export function task(name: string, inputs: Record<string, unknown>): Task {
  const body = { name, inputs, cloudId: 'slack', kind: 'slack', scope: 'SonarMD' };
  return { id: createHash('sha256').update(JSON.stringify(body)).digest('hex'), ...body };
}
export function expand(job: Task, data: Record<string, any>): Task[] {
  if (data.ok !== true) throw Error(String(data.error || 'Slack request failed'));
  const children: Task[] = [];
  const cursor = data.response_metadata?.next_cursor?.trim();
  if (cursor) {
    if (cursor === job.inputs.cursor) throw Error('repeated cursor');
    children.push(task(job.name, { ...job.inputs, cursor }));
  }
  if (job.name === 'conversations.list') {
    if (!Array.isArray(data.channels)) throw Error('missing channel list');
    for (const channel of data.channels) children.push(task('conversations.history', { channel: channel.id, limit: 100 }));
  }
  if (job.name === 'conversations.history' || job.name === 'conversations.replies') {
    if (!Array.isArray(data.messages)) throw Error('missing messages');
    if (data.has_more && !cursor) throw Error('pagination incomplete');
    if (job.name === 'conversations.history') for (const message of data.messages) {
      if (message.reply_count > 0) children.push(task('conversations.replies', { channel: job.inputs.channel, ts: message.ts, limit: 100 }));
    }
  }
  return children;
}
async function run() {
  const root = resolve(process.argv[2]!);
  const token = (await readFile(process.argv[3]!, 'utf8')).trim();
  const intake = await Intake.open(root);
  intake.seed([task('conversations.list', { types: 'public_channel,private_channel,im,mpim', exclude_archived: false, limit: 100 })]);
  await intake.recover();
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });
  try {
    while (!stopping) {
      const job = intake.pending(1)[0];
      if (!job) break;
      let response: Response;
      try {
        response = await fetch('https://slack.com/api/' + job.name, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(Object.entries(job.inputs).map(([k,v]) => [k, String(v)])), signal: AbortSignal.timeout(60000), redirect: 'error'
        });
      } catch {
        console.log(JSON.stringify({ event: 'transport_retry', status: intake.status() }));
        await new Promise(r => setTimeout(r, 10000)); continue;
      }
      if (response.status === 429 || response.status >= 500) {
        const seconds = Math.min(3600, Math.max(5, Number(response.headers.get('retry-after')) || 30));
        console.log(JSON.stringify({ event: 'backoff', seconds, status: intake.status() }));
        await new Promise(r => setTimeout(r, seconds * 1000)); continue;
      }
      const data = await response.json() as Record<string, any>;
      if (data.error === 'invalid_auth' || data.error === 'token_revoked' || data.error === 'not_authed') throw Error('Slack authorization failed; pending jobs retained');
      try { const children = expand(job, data); await intake.accept(job, data, children); }
      catch (error) { await intake.fail(job, data, String(error)); }
      const status = intake.status();
      await writeFile(resolve(root, 'progress.json'), JSON.stringify({ updated: new Date().toISOString(), ...status }) + '\n', { mode: 0o600 });
      console.log(JSON.stringify({ event: 'progress', ...status }));
      await new Promise(r => setTimeout(r, 1200));
    }
    const verification = await intake.verify();
    console.log(JSON.stringify({ event: 'checkpoint', status: intake.status(), verification }));
  } finally { intake.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) run().catch(() => { console.error('Slack export stopped; inspect checkpoint and resume with the same arguments.'); process.exitCode = 1; });
