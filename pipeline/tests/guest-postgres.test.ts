/// <reference types="emscripten" />
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";
import { bootstrap, type ClusterConfig } from "../guest-postgres.ts";

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
async function fixture(t:{after(fn:()=>unknown):void}){
  const dir=await realpath(await mkdtemp('/tmp/guest-postgres-'));
  const root=join(dir,'state'),log=join(dir,'calls.jsonl'),state=join(dir,'fake.json');
  t.after(async()=>{try{const value=JSON.parse(await readFile(state,'utf8'));if(value.pid)process.kill(value.pid,'SIGTERM');}catch{}await rm(dir,{recursive:true,force:true});});
  const fake=`#!${process.execPath}
import {readFileSync,writeFileSync,appendFileSync,mkdirSync,existsSync,chmodSync} from 'node:fs';
import {basename,join} from 'node:path';
import {spawn} from 'node:child_process';
const args=process.argv.slice(2),tool=basename(process.argv[1]),log=${JSON.stringify(log)},path=${JSON.stringify(state)};
let db=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{running:false,schema:false,system:'7426751832167820001'};
const input=await new Promise(ok=>{let text='';process.stdin.on('data',b=>text+=b);process.stdin.on('end',()=>ok(text));});
appendFileSync(log,JSON.stringify({tool,args,input,env:Object.keys(process.env)})+'\\n');
const arg=(name)=>args[args.indexOf(name)+1];
if(tool==='initdb'){const data=arg('--pgdata');mkdirSync(data,{recursive:true});writeFileSync(join(data,'PG_VERSION'),'17');writeFileSync(join(data,'postgresql.conf'),'# generated\\n');}
if(tool==='pg_ctl'){if(args.includes('status'))process.exit(db.running?0:3);if(args.includes('start')){db.running=true;const conf=readFileSync(join(arg('--pgdata'),'postgresql.conf'),'utf8'),socket=conf.match(/unix_socket_directories = '([^']+)'/)[1],port=conf.match(/port = (\\d+)/)[1],file=join(socket,'.s.PGSQL.'+port),mode=conf.includes('unix_socket_permissions = 0770')?0o770:0o700;const child=spawn(process.execPath,['--input-type=module','-e','import {createServer} from "node:net";import {chmodSync} from "node:fs";const server=createServer();server.listen('+JSON.stringify(file)+',()=>{chmodSync('+JSON.stringify(file)+','+mode+');process.send("ready");});'],{detached:true,stdio:['ignore','ignore','ignore','ipc'],env:{}});await new Promise((ok,no)=>{child.once('message',ok);child.once('error',no);child.once('exit',()=>no(Error('fixture socket failed')));});db.pid=child.pid;child.disconnect();child.unref();}}
if(tool==='pg_isready'&&!db.running)process.exit(2);
if(tool==='psql'){
 if(input.includes("'kind','server'"))console.log(JSON.stringify({kind:'server',system:db.system,database:arg('--dbname'),user:arg('--username'),listen:'',sockets:arg('--host'),port:arg('--port'),data:${JSON.stringify(join(root,'data'))}}));
 else if(input.includes("'kind','schema'"))console.log(JSON.stringify({kind:'schema',exists:db.schema}));
 else if(input.includes("'kind','role'"))console.log(JSON.stringify({kind:'role',name:'pipeline_runtime',superuser:false,createdb:false,createrole:false,replication:false,bypassrls:false,login:true,memberships:0}));
 else if(input.includes("'kind','database'"))console.log(JSON.stringify({kind:'database',exists:db.database??false}));
 else if(input.includes("'kind','runtime'"))console.log(JSON.stringify({kind:'runtime',user:'pipeline_runtime',database:'pipeline',listen:'',sockets:arg('--host'),address:null}));
 else if(input.includes("'kind','migration'"))console.log(JSON.stringify({kind:'migration',versions:db.versions??[1]}));
 else if(input.includes("'kind','scope'"))console.log(JSON.stringify({kind:'scope',owned:true}));
 else if(input.includes('CREATE DATABASE'))db.database=true;
 else if(input.includes('CREATE SCHEMA platform'))db.schema=true;
}
writeFileSync(path,JSON.stringify(db));
`;
  const tools={} as ClusterConfig['tools'];
  for(const name of ['initdb','pg_ctl','pg_isready','psql'] as const){const path=join(dir,name);await writeFile(path,fake,{mode:0o700});tools[name]={path,sha256:hash(fake)};}
  const migration=join(dir,'platform.sql'),sql=await readFile(new URL('../platform.sql',import.meta.url),'utf8');
  await writeFile(migration,sql,{mode:0o600});
  const config:ClusterConfig={root,tools,migration:{path:migration,sha256:hash(sql),version:1},database:'pipeline',ownerAccount:userInfo().username,runtime:{role:'pipeline_runtime',account:'pipeline_worker'},scope:{workspace:'00000000-0000-4000-8000-000000000001',project:'00000000-0000-4000-8000-000000000002',principal:'00000000-0000-4000-8000-000000000003'}};
  return{dir,root,config,log,state,calls:async()=> (await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line) as {tool:string;args:string[];input:string;env:string[]})};
}

test('provision creates only an owned Unixsocket cluster and repeat inspection retains its identity',async t=>{
  const f=await fixture(t);
  const first=await bootstrap({...f.config,operation:'provision'});
  assert.equal(first.qualified,false);
  assert.equal(first.runtime.peerVerified,false);
  assert.equal(first.runtime.leastPrivilege,true);
  assert.equal(first.cluster.systemIdentifier,'7426751832167820001');
  for(const name of ['data','socket','logs'])assert.equal((await stat(join(f.root,name))).mode&0o777,0o700);
  const conf=await readFile(join(f.root,'data','postgresql.conf'),'utf8');
  assert.match(conf,/listen_addresses = ''/);
  assert.match(conf,/unix_socket_permissions = 0700/);
  const calls=await f.calls();
  assert.equal(calls.filter(call=>call.tool==='initdb').length,1);
  assert.ok(calls.filter(call=>call.tool==='psql').every(call=>call.args.includes(join(f.root,'socket'))));
  assert.ok(calls.every(call=>!call.env.includes('PGPASSWORD')&&!call.env.includes('AWS_ACCESS_KEY_ID')));
  assert.ok(calls.some(call=>call.input.includes('NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS')));
  const second=await bootstrap({...f.config,operation:'inspect'});
  assert.equal(second.identity,first.identity);
  assert.equal(second.configuration,first.configuration);
  await bootstrap({...f.config,operation:'provision'});
  assert.equal((await f.calls()).filter(call=>call.tool==='initdb').length,1);
});

test('unknown existing data and changed executable pins are rejected before any tool runs',async t=>{
  const f=await fixture(t);await mkdir(f.root,{mode:0o700});await mkdir(join(f.root,'data'));await writeFile(join(f.root,'data','PG_VERSION'),'17');
  await assert.rejects(bootstrap({...f.config,operation:'provision'}),/unowned|ownership/);
  await rm(f.root,{recursive:true});
  await writeFile(f.config.tools.initdb.path,'#!/bin/false\n');
  await assert.rejects(bootstrap({...f.config,operation:'provision'}),/digest|pin/);
  assert.deepEqual(await readdir(f.dir).then(names=>names.filter(name=>name==='calls.jsonl')),[]);
});

test('configuration changes and a replacement server never adopt an existing receipt',async t=>{
  const f=await fixture(t);await bootstrap({...f.config,operation:'provision'});
  await assert.rejects(bootstrap({...f.config,database:'different',operation:'provision'}),/configuration|ownership/);
  const state=JSON.parse(await readFile(f.state,'utf8'));state.system='different';await writeFile(f.state,JSON.stringify(state));
  await assert.rejects(bootstrap({...f.config,operation:'inspect'}),/identity|cluster/);
});

test('external socket permissions are inspected and never widened',async t=>{
  const f=await fixture(t),socket=join(f.dir,'shared-socket');await mkdir(socket,{mode:0o750});
  const gid=(await stat(socket)).gid;
  const config={...f.config,socket:{path:socket,group:String(gid),gid}};
  await bootstrap({...config,operation:'provision'});
  assert.equal((await stat(socket)).mode&0o777,0o750);
  assert.match(await readFile(join(f.root,'data','postgresql.conf'),'utf8'),/unix_socket_permissions = 0770/);
  await chmod(socket,0o777);
  await assert.rejects(bootstrap({...config,operation:'inspect'}),/socket.*permission|socket.*mode/);
  assert.equal((await stat(socket)).mode&0o777,0o777);
});

test('inspect does not initialize missing state and credential fields are rejected',async t=>{
  const f=await fixture(t);
  await assert.rejects(bootstrap({...f.config,operation:'inspect'}),/ownership|missing/);
  await assert.rejects(bootstrap({...f.config,password:'forbidden',operation:'provision'}),/field|credential/);
  assert.equal((await readdir(f.dir)).includes('state'),false);
});

test('a different migration version fails inspection without changing the cluster',async t=>{
  const f=await fixture(t);await bootstrap({...f.config,operation:'provision'});
  const state=JSON.parse(await readFile(f.state,'utf8'));state.versions=[99];await writeFile(f.state,JSON.stringify(state));
  await assert.rejects(bootstrap({...f.config,operation:'inspect'}),/migration/);
});

test('the generated runtime role and scope SQL execute against PostgreSQL',async t=>{
  const f=await fixture(t);await bootstrap({...f.config,operation:'provision'});
  const pg=new PGlite();t.after(()=>pg.close());
  const calls=(await f.calls()).filter(call=>call.tool==='psql');
  await pg.exec(calls.find(call=>call.input.startsWith('DO $owned$'))!.input);
  await pg.exec(await readFile(f.config.migration.path,'utf8'));
  await pg.exec(calls.find(call=>call.input.startsWith('BEGIN; INSERT INTO platform.workspaces'))!.input);
  const role=await pg.query<{json_build_object:{superuser:boolean;createdb:boolean;createrole:boolean;replication:boolean;bypassrls:boolean}}>(calls.find(call=>call.input.includes("'kind','role'"))!.input);
  assert.deepEqual(role.rows[0].json_build_object.superuser,false);
  assert.deepEqual(role.rows[0].json_build_object.createdb,false);
  assert.deepEqual(role.rows[0].json_build_object.createrole,false);
  assert.deepEqual(role.rows[0].json_build_object.replication,false);
  assert.deepEqual(role.rows[0].json_build_object.bypassrls,false);
  const scope=await pg.query<{json_build_object:{owned:boolean}}>(calls.find(call=>call.input.includes("'kind','scope'"))!.input);
  assert.equal(scope.rows[0].json_build_object.owned,true);
});

test('CLI accepts bounded nonsecret base64 and stdin protocols',async t=>{
  const f=await fixture(t),receipt=await bootstrap({...f.config,operation:'provision'});
  const request=JSON.stringify({...f.config,operation:'inspect'});
  const run=(args:string[],input?:string)=>new Promise<{code:number|null;out:string;err:string}>((resolve,reject)=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL('../guest-postgres.ts',import.meta.url)),...args],{stdio:['pipe','pipe','pipe']});let out='',err='';
    child.stdout.on('data',bytes=>out+=bytes.toString());child.stderr.on('data',bytes=>err+=bytes.toString());child.on('error',reject);child.on('close',code=>resolve({code,out,err}));child.stdin.end(input);
  });
  for(const result of [await run(['--config-base64',Buffer.from(request).toString('base64')]),await run([],request)]){
    assert.equal(result.code,0,result.err);
    assert.equal(JSON.parse(result.out).identity,receipt.identity);
    assert.equal(JSON.parse(result.out).qualified,false);
  }
});
