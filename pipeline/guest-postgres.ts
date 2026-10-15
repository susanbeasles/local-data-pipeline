import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, open, readFile, readdir, realpath, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { userInfo } from "node:os";

export type Tool = {path:string;sha256:string};
export type ClusterConfig = {
  root:string;
  tools:{initdb:Tool;pg_ctl:Tool;pg_isready:Tool;psql:Tool};
  migration:Tool & {version:number};
  database:string;
  ownerAccount:string;
  runtime:{role:string;account:string};
  scope:{workspace:string;project:string;principal:string};
  socket?:{path:string;group:string;gid:number};
  port?:number;
  timeoutMs?:number;
};
export type Receipt = {
  format:'guest-postgres/1';identity:string;configuration:string;qualified:boolean;observedAt:string;
  cluster:{systemIdentifier:string;data:string;socket:string;database:string;port:number};
  runtime:{role:string;account:string;leastPrivilege:boolean;peerVerified:boolean;isolation:boolean};
  scope:ClusterConfig['scope'];migration:{sha256:string;version:number};
  evidence:{listenerLocal:boolean;socketVerified:boolean;reason:string};
};
type Intent = {format:'postgres-owner/1';id:string;configuration:string;owner:number;files?:Record<string,string>};
type Row=Record<string,unknown>;
const names=['initdb','pg_ctl','pg_isready','psql'] as const;
const hex=/^[a-f0-9]{64}$/,uid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
function fields(value:unknown,allowed:readonly string[],label:string):asserts value is Row{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype||Object.getOwnPropertySymbols(value).length)throw Error('invalid '+label);
  for(const[key,descriptor]of Object.entries(Object.getOwnPropertyDescriptors(value)))if(!allowed.includes(key)||!Object.hasOwn(descriptor,'value')||!descriptor.enumerable)throw Error('invalid '+label+' fields');
}
function text(value:unknown,label:string):asserts value is string{if(typeof value!=='string'||!value.length||value.length>4096||/[\x00-\x1f\x7f]/.test(value))throw Error('invalid '+label);}
function path(value:unknown):asserts value is string{text(value,'path');if(!isAbsolute(value)||resolve(value)!==value||value==='/')throw Error('path must be absolute and canonical');}
function integer(value:unknown,label:string,min:number,max:number):asserts value is number{if(!Number.isSafeInteger(value)||Number(value)<min||Number(value)>max)throw Error('invalid '+label);}
function account(value:unknown):asserts value is string{text(value,'account');if(!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(value))throw Error('invalid account');}
function name(value:unknown):asserts value is string{text(value,'SQL name');if(!/^[a-z][a-z0-9_]{0,62}$/.test(value))throw Error('invalid SQL name');}
function tool(value:unknown):asserts value is Tool{fields(value,['path','sha256'],'tool');path(value.path);if(typeof value.sha256!=='string'||!hex.test(value.sha256))throw Error('invalid tool digest pin');}
function stable(value:unknown):string{if(value&&typeof value==='object'){if(Array.isArray(value))return'['+value.map(stable).join(',')+']';return'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stable((value as Row)[key])).join(',')+'}';}return JSON.stringify(value);}
function request(value:unknown):{config:ClusterConfig;operation:'provision'|'inspect'}{
  fields(value,['operation','root','tools','migration','database','ownerAccount','runtime','scope','socket','port','timeoutMs'],'bootstrap');
  if(!['provision','inspect'].includes(String(value.operation)))throw Error('unsupported bootstrap operation');
  path(value.root);fields(value.tools,names,'tools');for(const key of names)tool(value.tools[key]);
  fields(value.migration,['path','sha256','version'],'migration');tool({path:value.migration.path,sha256:value.migration.sha256});integer(value.migration.version,'migration version',1,1000000);
  name(value.database);account(value.ownerAccount);
  if(value.ownerAccount!==userInfo().username)throw Error('bootstrap owner account must be the current existing OS account');
  fields(value.runtime,['role','account'],'runtime');name(value.runtime.role);account(value.runtime.account);
  if(value.runtime.role===value.ownerAccount)throw Error('runtime SQL role must differ from the cluster administrator');
  fields(value.scope,['workspace','project','principal'],'scope');for(const key of ['workspace','project','principal'])if(typeof value.scope[key]!=='string'||!uid.test(String(value.scope[key])))throw Error('invalid scope UUID');
  if(value.socket!==undefined){fields(value.socket,['path','group','gid'],'socket');path(value.socket.path);text(value.socket.group,'socket group');if(!/^[A-Za-z0-9_.-]{1,64}$/.test(value.socket.group))throw Error('invalid socket group');integer(value.socket.gid,'socket group ID',0,2147483647);}
  integer(value.port??5432,'port',1,65535);integer(value.timeoutMs??60000,'timeout',1000,120000);
  const{operation,...config}=value;
  return{operation:operation as 'provision'|'inspect',config:JSON.parse(JSON.stringify({...config,port:value.port??5432,timeoutMs:value.timeoutMs??60000})) as ClusterConfig};
}
async function exists(path:string):Promise<boolean>{try{await lstat(path);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}}
async function pinned(value:Tool,executable=true):Promise<string>{
  const info=await lstat(value.path);
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||await realpath(value.path)!==value.path||(info.mode&0o022)!==0||(executable&&(info.mode&0o111)===0))throw Error('pinned file must be canonical, regular and protected');
  const file=await open(value.path,'r');try{const before=await file.stat({bigint:true}),digest=createHash('sha256');for await(const bytes of file.createReadStream({autoClose:false}))digest.update(bytes);const after=await file.stat({bigint:true});if(digest.digest('hex')!==value.sha256||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)throw Error('file digest pin mismatch');}finally{await file.close();}
  return value.path;
}
async function directory(path:string,mode:number,create=false):Promise<void>{
  if(!await exists(path)){if(!create)throw Error('missing owned directory');await mkdir(path,{mode});}
  const info=await lstat(path);
  if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==path||info.uid!==process.getuid?.()||(info.mode&0o777)!==mode)throw Error('directory ownership or permission mismatch');
}
async function ownedFile(path:string):Promise<void>{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.uid!==process.getuid?.()||(info.mode&0o777)!==0o600||await realpath(path)!==path)throw Error('owned file permission or alias mismatch');}
async function write(path:string,value:string,replace=false):Promise<void>{
  const temp=path+'.'+randomUUID();const file=await open(temp,'wx',0o600);
  try{await file.writeFile(value);await file.sync();}finally{await file.close();}
  if(!replace&&await exists(path))throw Error('owned file already exists');
  await rename(temp,path);const parent=await open(dirname(path),'r');try{await parent.sync();}finally{await parent.close();}
}
function literal(value:string):string{return"'"+value.replaceAll("'","''")+"'";}
function quoted(value:string):string{return'"'+value.replaceAll('"','""')+'"';}
function setting(value:string):string{return"'"+value.replaceAll('\\','\\\\').replaceAll("'","''")+"'";}

class Cluster {
  readonly config:ClusterConfig;
  readonly configuration:string;
  readonly data:string;
  readonly socket:string;
  readonly logs:string;
  constructor(config:ClusterConfig){this.config=config;this.configuration=hash(stable(config));this.data=join(config.root,'data');this.logs=join(config.root,'logs');this.socket=config.socket?.path??join(config.root,'socket');if(Buffer.byteLength(join(this.socket,'.s.PGSQL.'+config.port))>100)throw Error('Unixsocket path exceeds portable byte bound');}
  private async call(name:typeof names[number],args:string[],input='',accepted=[0]):Promise<{stdout:string;code:number}>{
    const executable=await pinned(this.config.tools[name]);
    return new Promise((resolve,reject)=>{
      const child=spawn(executable,args,{cwd:this.config.root,env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',TZ:'UTC',PGPASSFILE:'/dev/null'},stdio:['pipe','pipe','pipe'],shell:false});
      let stdout='',stderr='',settled=false;const finish=(error?:Error,result?:{stdout:string;code:number})=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(result!);};
      const timer=setTimeout(()=>{child.kill('SIGKILL');finish(Error('PostgreSQL tool timeout: '+name));},this.config.timeoutMs);
      child.stdout.on('data',(bytes:Buffer)=>{stdout+=bytes.toString('utf8');if(Buffer.byteLength(stdout)>262144){child.kill('SIGKILL');finish(Error('PostgreSQL tool output bound exceeded'));}});
      child.stderr.on('data',(bytes:Buffer)=>{stderr+=bytes.toString('utf8');if(Buffer.byteLength(stderr)>65536){child.kill('SIGKILL');finish(Error('PostgreSQL diagnostic bound exceeded'));}});
      child.on('error',()=>finish(Error('PostgreSQL tool could not execute: '+name)));
      child.on('close',code=>{if(code===null||!accepted.includes(code))finish(Error('PostgreSQL tool failed: '+name+' ('+String(code)+')'));else finish(undefined,{stdout:stdout.trim(),code});});
      child.stdin.on('error',()=>{});child.stdin.end(input);
    });
  }
  private async sql(sql:string,database=this.config.database,user=this.config.ownerAccount):Promise<string>{
    return(await this.call('psql',['--no-psqlrc','--no-password','--set=ON_ERROR_STOP=1','--tuples-only','--no-align','--quiet','--host',this.socket,'--port',String(this.config.port),'--username',user,'--dbname',database],sql)).stdout;
  }
  private async query(sql:string,database?:string,user?:string):Promise<Row>{const output=await this.sql(sql,database,user);const value:unknown=JSON.parse(output);if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid PostgreSQL proof');return value as Row;}
  private async socketCheck():Promise<void>{
    try{await directory(this.socket,this.config.socket?0o750:0o700);const info=await lstat(this.socket);if(this.config.socket&&info.gid!==this.config.socket.gid)throw Error('socket group mismatch');}catch{throw Error('socket ownership, group or permission mismatch');}
  }
  private async socketFile():Promise<void>{
    const file=join(this.socket,'.s.PGSQL.'+this.config.port),info=await lstat(file);
    if(!info.isSocket()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o777)!==(this.config.socket?0o770:0o700)||(this.config.socket&&info.gid!==this.config.socket.gid))throw Error('effective Unixsocket ownership, group or mode mismatch');
  }
  private async owned(operation:'provision'|'inspect'):Promise<{intent:Intent;receipt?:Receipt}>{
    const root=this.config.root;
    if(!await exists(root)){if(operation==='inspect')throw Error('missing cluster ownership receipt');if(await realpath(dirname(root))!==dirname(root))throw Error('state root parent is not canonical');await directory(root,0o700,true);}
    await directory(root,0o700);
    const owner=join(root,'owner.json');
    let intent:Intent;
    if(!await exists(owner)){
      if(operation==='inspect'||(await readdir(root)).length)throw Error('unowned cluster state cannot be adopted');
      intent={format:'postgres-owner/1',id:randomUUID(),configuration:this.configuration,owner:process.getuid?.()??-1};
      await write(owner,JSON.stringify(intent));
    }else{
      await ownedFile(owner);
      intent=JSON.parse(await readFile(owner,'utf8')) as Intent;
      if(intent.format!=='postgres-owner/1'||intent.configuration!==this.configuration||intent.owner!==process.getuid?.())throw Error('cluster ownership configuration mismatch');
    }
    const receiptPath=join(root,'receipt.json');
    let receipt:Receipt|undefined;
    if(await exists(receiptPath)){await ownedFile(receiptPath);receipt=JSON.parse(await readFile(receiptPath,'utf8')) as Receipt;}
    if(receipt&&(receipt.format!=='guest-postgres/1'||receipt.configuration!==this.configuration))throw Error('cluster receipt configuration mismatch');
    if(operation==='inspect'&&!receipt)throw Error('missing completed ownership receipt');
    await directory(this.data,0o700,operation==='provision');await directory(this.logs,0o700,operation==='provision');
    if(!this.config.socket)await directory(this.socket,0o700,operation==='provision');await this.socketCheck();
    return{intent,receipt};
  }
  private async initialize(intent:Intent):Promise<void>{
    if(!await exists(join(this.data,'PG_VERSION'))){
      if((await readdir(this.data)).length)throw Error('owned partial cluster requires explicit recovery');
      await this.call('initdb',['--pgdata',this.data,'--username',this.config.ownerAccount,'--auth-local=peer','--auth-host=reject','--encoding=UTF8','--no-locale','--no-instructions']);
      const conf=await readFile(join(this.data,'postgresql.conf'),'utf8');
      await write(join(this.data,'postgresql.conf'),conf+'\n# Owned local pipeline listener\nlisten_addresses = \'\'\nunix_socket_directories = '+setting(this.socket)+'\nunix_socket_permissions = '+(this.config.socket?'0770':'0700')+'\n'+(this.config.socket?'unix_socket_group = '+setting(this.config.socket.group)+'\n':'')+'port = '+this.config.port+'\nlogging_collector = off\n',true);
      await write(join(this.data,'pg_hba.conf'),'local all '+quoted(this.config.ownerAccount)+' peer\nlocal '+quoted(this.config.database)+' '+quoted(this.config.runtime.role)+' peer map=pipeline\nlocal all all reject\nhost all all 0.0.0.0/0 reject\nhost all all ::0/0 reject\n',true);
      await write(join(this.data,'pg_ident.conf'),'pipeline '+quoted(this.config.runtime.account)+' '+quoted(this.config.runtime.role)+'\n',true);
      intent.files={};for(const name of ['postgresql.conf','pg_hba.conf','pg_ident.conf'])intent.files[name]=hash(await readFile(join(this.data,name)));
      await write(join(this.config.root,'owner.json'),JSON.stringify(intent),true);
    }
    await this.files(intent);
  }
  private async files(intent:Intent):Promise<void>{
    if(!intent.files)throw Error('cluster configuration ownership is incomplete');
    for(const name of ['postgresql.conf','pg_hba.conf','pg_ident.conf']){
      const file=join(this.data,name);await ownedFile(file);
      if(hash(await readFile(file))!==intent.files[name])throw Error('owned cluster configuration changed');
    }
  }
  private async start():Promise<void>{
    const status=await this.call('pg_ctl',['--pgdata',this.data,'status'],'',[0,3]);
    if(status.code===3){
      const log=join(this.logs,'postgres.log');if(!await exists(log)){const file=await open(log,'wx',0o600);await file.close();}
      const info=await lstat(log);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.uid!==process.getuid?.()||(info.mode&0o077)!==0)throw Error('server log ownership mismatch');
      await this.call('pg_ctl',['--pgdata',this.data,'--log',log,'--wait','--timeout',String(Math.ceil(this.config.timeoutMs!/1000)),'start']);
    }
    await this.call('pg_isready',['--host',this.socket,'--port',String(this.config.port),'--username',this.config.ownerAccount,'--dbname','postgres','--timeout','3']);
  }
  private async server():Promise<Row>{
    const server=await this.query("SELECT json_build_object('kind','server','system',system_identifier::text,'database',current_database(),'user',current_user,'listen',current_setting('listen_addresses'),'sockets',current_setting('unix_socket_directories'),'port',current_setting('port'),'data',current_setting('data_directory')) FROM pg_control_system();",'postgres');
    if(typeof server.system!=='string'||!/^\d{10,32}$/.test(server.system)||server.listen!==''||server.sockets!==this.socket||server.data!==this.data||Number(server.port)!==this.config.port||server.user!==this.config.ownerAccount||server.database!=='postgres')throw Error('effective PostgreSQL server identity or local listener mismatch');
    return server;
  }
  private async provision():Promise<void>{
    const role=quoted(this.config.runtime.role),database=quoted(this.config.database);
    await this.sql('DO $owned$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='+literal(this.config.runtime.role)+') THEN CREATE ROLE '+role+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $owned$;','postgres');
    const exists=await this.query("SELECT json_build_object('kind','database','exists',EXISTS(SELECT 1 FROM pg_database WHERE datname="+literal(this.config.database)+'));','postgres');
    if(!exists.exists)await this.sql('CREATE DATABASE '+database+';','postgres');
    await this.sql('REVOKE ALL ON DATABASE '+database+' FROM PUBLIC; GRANT CONNECT ON DATABASE '+database+' TO '+role+';','postgres');
    const schema=await this.query("SELECT json_build_object('kind','schema','exists',EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='platform'));");
    if(!schema.exists)await this.sql(await readFile(this.config.migration.path,'utf8'));
    const scope=this.config.scope,w=literal(scope.workspace),p=literal(scope.project),principal=literal(scope.principal);
    await this.sql('BEGIN; INSERT INTO platform.workspaces(id,name,slug) VALUES('+w+",'Local pipeline',"+w+') ON CONFLICT(id) DO NOTHING; INSERT INTO platform.principals(id,kind,identity_ref) VALUES('+principal+",'service_account',"+literal('local-bootstrap:'+scope.principal)+') ON CONFLICT(id) DO NOTHING; INSERT INTO platform.memberships(workspace_id,principal_id) VALUES('+w+','+principal+') ON CONFLICT DO NOTHING; INSERT INTO platform.projects(workspace_id,id,name) VALUES('+w+','+p+",'Local pipeline') ON CONFLICT DO NOTHING; "+['view','configure','execute','publish'].map(permission=>'INSERT INTO platform.grants(workspace_id,project_id,principal_id,permission) VALUES('+w+','+p+','+principal+','+literal(permission)+') ON CONFLICT DO NOTHING;').join(' ')+' GRANT USAGE ON SCHEMA platform TO '+role+'; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA platform TO '+role+'; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA platform TO '+role+'; COMMIT;');
  }
  private async role():Promise<void>{
    const role=await this.query("SELECT json_build_object('kind','role','name',rolname,'superuser',rolsuper,'createdb',rolcreatedb,'createrole',rolcreaterole,'replication',rolreplication,'bypassrls',rolbypassrls,'login',rolcanlogin,'memberships',(SELECT count(*) FROM pg_auth_members WHERE member=r.oid)) FROM pg_roles r WHERE rolname="+literal(this.config.runtime.role)+';','postgres');
    if(role.name!==this.config.runtime.role||role.superuser!==false||role.createdb!==false||role.createrole!==false||role.replication!==false||role.bypassrls!==false||role.login!==true||Number(role.memberships)!==0)throw Error('runtime SQL role is not least privilege');
  }
  private async schema():Promise<void>{
    const migration=await this.query("SELECT json_build_object('kind','migration','versions',coalesce(json_agg(version ORDER BY version),'[]'::json)) FROM platform.migrations;");
    if(!Array.isArray(migration.versions)||!migration.versions.includes(this.config.migration.version)||migration.versions.some(version=>!Number.isSafeInteger(version)||Number(version)<1||Number(version)>this.config.migration.version))throw Error('database migration version mismatch');
    const scope=this.config.scope,w=literal(scope.workspace),p=literal(scope.project),principal=literal(scope.principal);
    const proof=await this.query("SELECT json_build_object('kind','scope','owned',EXISTS(SELECT 1 FROM platform.projects WHERE workspace_id="+w+' AND id='+p+') AND EXISTS(SELECT 1 FROM platform.principals p JOIN platform.memberships m ON m.principal_id=p.id WHERE p.id='+principal+' AND p.identity_ref='+literal('local-bootstrap:'+scope.principal)+" AND p.kind='service_account' AND p.status='active' AND m.workspace_id="+w+" AND m.status='active') AND (SELECT count(DISTINCT permission)=4 FROM platform.grants WHERE workspace_id="+w+' AND project_id='+p+' AND principal_id='+principal+" AND permission IN ('view','configure','execute','publish')) AND has_schema_privilege("+literal(this.config.runtime.role)+",'platform','USAGE') AND NOT has_schema_privilege("+literal(this.config.runtime.role)+",'platform','CREATE'));");
    if(proof.owned!==true)throw Error('database scope ownership or runtime grants mismatch');
  }
  async run(operation:'provision'|'inspect'):Promise<Receipt>{
    for(const name of names)await pinned(this.config.tools[name]);await pinned(this.config.migration,false);
    const{intent,receipt}=await this.owned(operation);
    if(operation==='provision'){await this.initialize(intent);await this.start();}else{await this.files(intent);await this.call('pg_isready',['--host',this.socket,'--port',String(this.config.port),'--username',this.config.ownerAccount,'--dbname','postgres','--timeout','3']);}
    await this.socketFile();const server=await this.server();
    const identity=hash(stable({owner:intent.id,system:server.system,database:this.config.database,configuration:this.configuration}));
    if(receipt&&receipt.identity!==identity)throw Error('owned cluster identity changed');
    if(operation==='provision')await this.provision();await this.role();await this.schema();
    let peerVerified=false;
    if(this.config.runtime.account===userInfo().username){
      const runtime=await this.query("SELECT json_build_object('kind','runtime','user',current_user,'database',current_database(),'listen',current_setting('listen_addresses'),'sockets',current_setting('unix_socket_directories'),'address',inet_server_addr());",this.config.database,this.config.runtime.role);
      peerVerified=runtime.user===this.config.runtime.role&&runtime.database===this.config.database&&runtime.listen===''&&runtime.sockets===this.socket&&runtime.address===null;
      if(!peerVerified)throw Error('actual runtime peer connection did not match the owned cluster');
    }
    const result:Receipt={format:'guest-postgres/1',identity,configuration:this.configuration,qualified:false,observedAt:new Date().toISOString(),cluster:{systemIdentifier:String(server.system),data:this.data,socket:this.socket,database:this.config.database,port:this.config.port!},runtime:{...this.config.runtime,leastPrivilege:true,peerVerified,isolation:false},scope:this.config.scope,migration:{sha256:this.config.migration.sha256,version:this.config.migration.version},evidence:{listenerLocal:true,socketVerified:true,reason:peerVerified?'Runtime peer connected under the cluster owner account; separate OS identity isolation remains unverified.':'A service probe under the existing runtime OS account must verify peer access and isolation.'}};
    if(operation==='provision')await write(join(this.config.root,'receipt.json'),JSON.stringify(result),true);
    return result;
  }
}

/** Credential-free guest protocol. Provisioning touches only explicitly bound storage. */
export async function bootstrap(value:unknown):Promise<Receipt>{const{config,operation}=request(value);return new Cluster(config).run(operation);}

if(process.argv[1]===import.meta.filename){
  try{
    let input:string;
    if(process.argv.length===4&&process.argv[2]==='--config-base64'){
      const encoded=process.argv[3];if(encoded.length>131072||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))throw Error('invalid bounded base64 configuration');input=Buffer.from(encoded,'base64').toString('utf8');
    }else if(process.argv.length===2){input='';for await(const bytes of process.stdin){input+=bytes.toString();if(Buffer.byteLength(input)>65536)throw Error('bootstrap configuration exceeds bound');}}
    else throw Error('use stdin JSON or --config-base64 with nonsecret configuration');
    if(Buffer.byteLength(input)>65536)throw Error('bootstrap configuration exceeds bound');
    process.stdout.write(JSON.stringify(await bootstrap(JSON.parse(input)))+'\n');
  }catch(error){process.stderr.write(JSON.stringify({error:error instanceof Error?error.message:'guest PostgreSQL bootstrap failed'})+'\n');process.exitCode=1;}
}
