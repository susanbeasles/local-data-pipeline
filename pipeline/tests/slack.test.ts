import { test } from 'node:test';
import assert from 'node:assert/strict';
import { task, expand } from '../slack.ts';
test('Slack discovery includes histories, cursor pages and thread replies', () => {
 const list=task('conversations.list',{limit:100});
 const jobs=expand(list,{ok:true,channels:[{id:'C1'}],response_metadata:{next_cursor:'next'}});
 assert.equal(jobs.length,2);
 assert.equal(jobs[1]!.name,'conversations.history');
 const threads=expand(jobs[1]!,{ok:true,messages:[{ts:'1.0',reply_count:3}],has_more:false});
 assert.equal(threads[0]!.name,'conversations.replies');
 assert.equal(task('a',{b:1}).id,task('a',{b:1}).id);
});
test('Slack refuses errors, repeated cursors and incomplete pagination',()=>{
 assert.throws(()=>expand(task('conversations.list',{}),{ok:false,error:'missing_scope'}));
 assert.throws(()=>expand(task('conversations.list',{cursor:'x'}),{ok:true,channels:[],response_metadata:{next_cursor:'x'}}));
 assert.throws(()=>expand(task('conversations.history',{}),{ok:true,messages:[],has_more:true}));
});
