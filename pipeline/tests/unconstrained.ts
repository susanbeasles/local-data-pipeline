import { assets } from "../local.ts";
import {sandbox} from '../legacy/sandbox.ts';
import {join} from 'node:path';
const runtime=assets().runtime,base=assets().base,pkg=join(import.meta.dirname,'../../models/qwen-roles-v12'),script=join(import.meta.dirname,'unconstrained.py');
const box=await sandbox(runtime,base,script,pkg);try{const child=box.launch([script,base,pkg]);child.stdout.pipe(process.stdout);child.stderr.on('data',()=>{});process.exitCode=(await new Promise<number|null>((ok,no)=>{child.on('exit',ok);child.on('error',no)}))??1;}finally{await box.close();}
