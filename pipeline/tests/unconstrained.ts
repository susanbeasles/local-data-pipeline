import {sandbox} from '../legacy/sandbox.ts';
import {join} from 'node:path';
const runtime='/Users/avespoli/SonarMD-Dump-2026-10-09/enrichment/runtime',base='/Users/avespoli/SonarMD-Dump-2026-10-09/enrichment/models/qwen2.5-3b-official',pkg=join(import.meta.dirname,'../../models/qwen-roles-v12'),script=join(import.meta.dirname,'unconstrained.py');
const box=await sandbox(runtime,base,script,pkg);try{const child=box.launch([script,base,pkg]);child.stdout.pipe(process.stdout);child.stderr.on('data',()=>{});process.exitCode=(await new Promise<number|null>((ok,no)=>{child.on('exit',ok);child.on('error',no)}))??1;}finally{await box.close();}
