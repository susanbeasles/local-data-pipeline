import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,symlink,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {DatabaseSync} from 'node:sqlite';
import {crawl,selected} from '../agents.ts';
test('selects agent directories and instructions without selecting unrelated personal data',()=>{
 for(const p of ['.codex/sessions/log.jsonl','.claude/plugins/a/config.json','Library/Application Support/Cursor/User/settings.json','code/app/AGENTS.md','.config/opencode/config.json','code/app/.github/copilot-instructions.md'])assert.ok(selected(p),p);
 assert.equal(selected('Documents/bank.pdf'),false);
 for(const p of ['code/app/plugins/database.py','code/app/skills/game.txt','.config/unrelated/settings.json','code/app/.git/worktree-recovery/old/plugins/module.py'])assert.equal(selected(p),false,p);
});
test('captures full bytes, hidden agent files, symlink metadata and resumes without duplicates',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'agent-crawl-'))),home=join(root,'home'),work=join(root,'personal','AI-agent-stuff');await mkdir(join(home,'.codex','sessions'),{recursive:true});await mkdir(join(home,'code','app'),{recursive:true});await mkdir(join(home,'excluded'),{recursive:true});
 const bytes=Buffer.from([0,1,255,10]);await writeFile(join(home,'.codex','sessions','trace'),bytes);await writeFile(join(home,'code','app','AGENTS.md'),'instructions');await writeFile(join(home,'ordinary'),'not selected');await writeFile(join(home,'excluded','SKILL.md'),'excluded');await symlink('/etc',join(home,'.codex','external'));
 const config={home,work,exclude:[join(home,'excluded')]};const result=await crawl(config);assert.equal(result.complete,true);await crawl(config);
 const db=new DatabaseSync(join(work,'inventory.sqlite'));const rows=db.prepare("SELECT * FROM entries WHERE state='captured'").all();assert.equal(rows.length,3);assert.ok(db.prepare("SELECT * FROM entries WHERE path='ordinary' AND state='unselected'").get());assert.ok(db.prepare("SELECT * FROM entries WHERE path='.codex/external' AND kind='symlink'").get());db.close();
 const archive=new DatabaseSync(join(work,'content.sqlite'));const {Content}=await import('../content.ts');const store=new Content(archive,work,'brotli');const captured=rows.find(r=>r.path==='.codex/sessions/trace')!;assert.ok(store.read(String(captured.hash)).equals(bytes));await store.verify(String(captured.hash),String(captured.hash));archive.close();
 assert.ok((await readFile(join(work,'inventory.jsonl'),'utf8')).includes('excluded'));
 const queue=new DatabaseSync(join(work,'inventory.sqlite'));queue.prepare("INSERT INTO entries(path,kind,state) VALUES(?,?,?)").run('code/app/plugins/removed.py','file','pending');queue.close();
 await crawl(config);const resumed=new DatabaseSync(join(work,'inventory.sqlite'));assert.equal(resumed.prepare("SELECT state FROM entries WHERE path=?").get('code/app/plugins/removed.py')!.state,'unselected');resumed.close();
 await assert.rejects(crawl({...config,exclude:[]}),/configuration/);
});
