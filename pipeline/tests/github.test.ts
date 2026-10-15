import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { expand, job, delay, exportGit } from '../github.ts';

test('repository pages expand bulk endpoints and reviews without per-commit requests', () => {
  const jobs = expand(job('/orgs/SonarMD/repos?per_page=100&type=all'), [{full_name:'SonarMD/app'}], '<https://api.github.com/orgs/SonarMD/repos?per_page=100&page=2>; rel="next"', 'SonarMD');
  assert.ok(jobs.some(j => j.name === 'git'));
  assert.ok(jobs.some(j => String(j.inputs.path).includes('/issues/comments')));
  assert.ok(jobs.some(j => String(j.inputs.path).includes('page=2')));
  assert.ok(!jobs.some(j => String(j.inputs.path).includes('/commits')));
  const pulls = expand(job('/repos/SonarMD/app/pulls?state=all&per_page=100'), [{number:7}], '', 'SonarMD');
  assert.ok(pulls.some(j => j.inputs.path === '/repos/SonarMD/app/pulls/7/reviews?per_page=100'));
  const numeric = expand(job('/repositories/123/pulls?state=all&per_page=100&page=2'), [{number:8}], '', 'SonarMD');
  assert.ok(numeric.some(j => j.inputs.path === '/repositories/123/pulls/8/reviews?per_page=100'));
  assert.throws(() => expand(job('/orgs/SonarMD/repos'), [], '<https://evil.test/data>; rel="next"', 'SonarMD'));
});
test('rate limit delays honor reset and Retry-After', () => {
  assert.ok(delay(new Headers({'retry-after':'120'}), 0) >= 120000);
  assert.ok(delay(new Headers({'x-ratelimit-remaining':'0','x-ratelimit-reset':'200'}), 100000) >= 100000);
});
test('Git export includes exact historical binary contents and resumes without duplication', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'github-test-')));
  const repo = join(root, 'repo'); await mkdir(repo);
  const git = (...args:string[]) => execFileSync('git', ['-C',repo,...args], {env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null'}});
  git('init','-q'); git('config','user.name','Fixture'); git('config','user.email','fixture@example.test');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(repo,'data'), Buffer.from([0,1,2,255])); git('add','data'); git('-c','commit.gpgsign=false','commit','-qm','first');
  await writeFile(join(repo,'large'),Buffer.alloc(2*1024*1024+17,42));git('add','large');
  await writeFile(join(repo,'data'), 'changed'); git('add','data'); git('-c','commit.gpgsign=false','commit','-qm','second');
  await exportGit(repo,join(root,'export'),'SonarMD/fixture');
  await exportGit(repo,join(root,'export'),'SonarMD/fixture');
  const db = new DatabaseSync(join(root,'export','git.sqlite'));
  assert.equal(db.prepare("SELECT count(*) AS n FROM objects WHERE kind='commit'").get()!.n,2);
  const rows = db.prepare('SELECT record FROM objects').all();
  const records = rows.map(r=>JSON.parse(String(r.record)));
  assert.ok(records.some(r=>Buffer.from(r.data,'base64').equals(Buffer.from([0,1,2,255]))));
  const lines = (await readFile(join(root,'export','objects.jsonl'),'utf8')).trim().split('\n');
  assert.equal(lines.length, rows.length); assert.equal(new Set(lines).size, lines.length);
  assert.deepEqual(lines.map(line=>JSON.parse(line)).sort((a,b)=>a.oid.localeCompare(b.oid)),records.sort((a,b)=>a.oid.localeCompare(b.oid)));
  const large=records.filter(r=>r.kind==='blob'&&r.size===2*1024*1024+17).sort((a,b)=>a.part-b.part);
  assert.equal(large.length,3);assert.ok(Buffer.concat(large.map(r=>Buffer.from(r.data,'base64'))).equals(Buffer.alloc(2*1024*1024+17,42)));
  db.prepare("UPDATE objects SET record='{}' WHERE oid=?").run(records[0].oid);
  await assert.rejects(exportGit(repo,join(root,'export'),'SonarMD/fixture'),/corrupt|conflicting/);
  db.close();
});

test('empty Git repositories are valid archives',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'github-empty-')));const repo=join(root,'repo');await mkdir(repo);execFileSync('git',['init','--bare','-q',repo]);
 await exportGit(repo,join(root,'export'),'SonarMD/empty');assert.equal(await readFile(join(root,'export','objects.jsonl'),'utf8'),'');
});
