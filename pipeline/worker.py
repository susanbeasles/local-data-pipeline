"""Role-packaged local MLX runtime. Normal base loading; no weight adapters/training."""
import os,sys,json,time,socket,hashlib,copy,re
from pathlib import Path
for key in ('HF_HUB_OFFLINE','TRANSFORMERS_OFFLINE','HF_HUB_DISABLE_TELEMETRY','HF_HUB_DISABLE_IMPLICIT_TOKEN'):os.environ[key]='1'
probe=socket.socket()
try:probe.connect(('127.0.0.1',9));raise RuntimeError('network sandbox absent')
except PermissionError:pass
finally:probe.close()
import mlx.core as mx
from mlx_lm import load
from mlx_lm.sample_utils import make_sampler
from mlx_lm.generate import BatchGenerator
from mlx_lm.models.cache import make_prompt_cache
base=Path(sys.argv[1]).resolve();root=Path(sys.argv[2]).resolve()
capacity=int(sys.argv[3]);memory=int(sys.argv[4]);prefill=int(sys.argv[5]);mode=sys.argv[6]
if not 1<=prefill<=capacity<=64 or memory<1024**3 or mode not in ('packaged','inline'):raise SystemExit('invalid runtime configuration')
manifest=json.loads((root/'manifest.json').read_text())
if manifest.get('format')!='local-role/1' or manifest.get('weightChanges') is not False or manifest.get('adapter') is not None or Path(manifest['base']['path']).resolve()!=base:raise SystemExit('sealed role package required; weight adapters unsupported')
for name,digest in manifest['base']['files'].items():
    file=base/name
    if file.resolve()!=file or not file.is_file():raise SystemExit('base file alias rejected')
    h=hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda:stream.read(4*1024**2),b''):h.update(block)
    if h.hexdigest()!=digest:raise SystemExit('base weight integrity mismatch')
configs={}
for entry in manifest['roles']:
    file=root/entry['path']
    if file.resolve()!=file or hashlib.sha256(file.read_bytes()).hexdigest()!=entry['hash']:raise SystemExit('role artifact integrity mismatch')
    config=json.loads(file.read_text())
    if config.get('role')!=entry['role'] or config.get('adapter') is not None or config.get('weightChanges') is not False:raise SystemExit('invalid role artifact')
    configs[entry['role']]=config
if not manifest.get('profile') and set(configs)!=set(('tag','classify','summarize','knowledge','reconcile','connect')):raise SystemExit('six role artifacts required')
mx.set_memory_limit(memory);mx.set_cache_limit(min(memory//8,1024**3));started=time.perf_counter()
model,tokenizer=load(str(base),tokenizer_config={'trust_remote_code':False});model.eval()
context=json.loads((base/'config.json').read_text()).get('max_position_embeddings',32768)
from lmformatenforcer import JsonSchemaParser,TokenEnforcerTokenizerData,CharacterLevelParserConfig
import importlib.util
_spec=importlib.util.spec_from_file_location("local_decoder",Path(__file__).with_name("decoder.py"));_decoder=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(_decoder)
underlying=tokenizer._tokenizer;zero=underlying.encode('0',add_special_tokens=False)[-1];regular=[]
for token in sorted(set(underlying.get_vocab().values())):
    if token in underlying.all_special_ids:continue
    after=underlying.decode([zero,token])[1:];single=underlying.decode([token]);regular.append((token,after,len(after)>len(single)))
stop=set(getattr(tokenizer,'eos_token_ids',[tokenizer.eos_token_id]))
token_data=TokenEnforcerTokenizerData(regular,lambda tokens:underlying.decode(tokens).rstrip('\ufffd'),list(stop))
boundary_root=_decoder.boundaries(token_data)
initialized={};initial={'roleArtifactsLoaded':len(configs),'systemTokenizations':0,'systemPrefillTokens':0,'templateConstructions':0,'weightChanges':False,'mode':mode}
forms=list(configs.items())+[(role+':presence',config['presence']) for role,config in configs.items() if 'presence' in config]
initial['instructionSets']=len(forms)
if mode=='packaged':
    for role,config in forms:
        prefix_text=tokenizer.apply_chat_template([{'role':'system','content':config['system']}],tokenize=False,add_generation_prompt=False,enable_thinking=False)
        marker='LOCAL_DYNAMIC_PAYLOAD_BOUNDARY_0'
        full=tokenizer.apply_chat_template([{'role':'system','content':config['system']},{'role':'user','content':marker}],tokenize=False,add_generation_prompt=True,enable_thinking=False)
        if not full.startswith(prefix_text):raise RuntimeError('template prefix mismatch')
        header,footer=full[len(prefix_text):].split(marker)
        tokens=tokenizer.encode(prefix_text,add_special_tokens=False);cache=make_prompt_cache(model)
        model(mx.array([tokens]),cache=cache);mx.eval([c.state for c in cache])
        initialized[role]={'prefix':tokens,'header':header,'footer':footer,'state':[(type(c),c.state,c.meta_state) for c in cache]}
        initial['systemTokenizations']+=1;initial['templateConstructions']+=1;initial['systemPrefillTokens']+=len(tokens)
forwards={}
class Meter:
    def __getattr__(self,name):return getattr(model,name)
    def __call__(self,inputs,**kwargs):
        key=('prefill' if inputs.shape[1]>1 else 'token')+':'+str(inputs.shape[0]);forwards[key]=forwards.get(key,0)+1
        return model(inputs,**kwargs)
def schema(config,payload):
    result=copy.deepcopy(config['schema']);context=payload.get('context',{});pair=context.get('candidates',{})
    if config['role']=='presence':return result
    if config['role'] in ('reconcile','connect'):
        key='groups' if config['role']=='reconcile' else 'edges';result['properties'][key]['items']['properties']['evidenceIds']['maxItems']=len(pair.get('evidence',[]))
    if config['role']=='reconcile' and len(pair.get('members',[]))==2 and pair['members'][0]['name']!=pair['members'][1]['name']:
        result['properties']['groups']['items']['properties']['method']['enum'].remove('exact')
    values={'$namespace':[context.get('trustedNamespace','ambiguous')],'$anchor':[a['id'] for a in payload.get('spans',[])],'$member':[m['id'] for m in pair.get('members',[])],'$evidence':[e['id'] for e in pair.get('evidence',[])]}
    def visit(s):
        if len(s.get('enum',[]))==1 and isinstance(s['enum'][0],str) and s['enum'][0] in values:s['enum']=values[s['enum'][0]] or ['__NO_ALLOWED_REFERENCES__']
        for child in s.get('properties',{}).values():visit(child)
        if 'items' in s:visit(s['items'])
    visit(result);return result
class Constraint:
    def __init__(self,config,payload):
        self.tokens=[];self.kind=config['role'];self.choices={};parser=JsonSchemaParser(schema(config,payload),config=CharacterLevelParserConfig(force_json_field_order=bool(config['output']['privateRoot'])))
        if config['role'] in ('reconcile','connect'):parser=(_decoder.Connection if config['output']['privateRoot'] else _decoder.References)(parser,{**payload['context']['candidates'],**({'presence':payload['context']['presence']} if 'presence' in payload['context'] else {})})
        self.enforcer=_decoder.Enforcer(token_data,parser,boundary_root)
    def allowed(self):return self.enforcer.get_allowed_tokens(self.tokens)
    def consume(self,token):self.tokens.append(token)
class Engine(BatchGenerator):
    refills=0
    def __init__(self,*args,**kwargs):self.constraints={};self.prefill_uids=None;self.sampling_uids=None;super().__init__(*args,sampler=self.sample,**kwargs)
    def _process_prompts(self,prompts):
        if self.active_batch is not None and any(n>0 for n in self.active_batch.num_tokens):self.refills+=1
        self.prefill_uids=[p[0] for p in prompts]
        try:return super()._process_prompts(prompts)
        finally:self.prefill_uids=None
    def _step(self,tokens,cache):
        self.sampling_uids=self.prefill_uids if self.prefill_uids is not None else self.active_batch.uids
        return super()._step(tokens,cache)
    def sample(self,logits):
        pending=[]
        for row,uid in enumerate(self.sampling_uids):
            constraint=self.constraints[uid];allowed=constraint.allowed()
            if constraint.kind=='presence' and not constraint.tokens:
                words=('true','false','True','False');ids=[underlying.encode(word,add_special_tokens=False)[0] for word in words];scores=logits[row,mx.array(ids)];mx.eval(scores)
                constraint.choices={word:{'allowed':token in allowed,'score':float(score)} for word,token,score in zip(words,ids,scores.tolist())}
            pending.append((constraint,allowed,_decoder.select(logits[row],allowed,mx)))
        mx.eval([p[2] for p in pending]);selected=[]
        for constraint,allowed,index in pending:
            token=int(index.item());constraint.consume(token);selected.append(token)
        return mx.array(selected)
generator=Engine(Meter(),stop_tokens=stop,completion_batch_size=capacity,prefill_batch_size=prefill)
import queue,threading,math
from collections import deque
_admit_spec=importlib.util.spec_from_file_location("local_admission",Path(__file__).with_name("admission.py"));_admission=importlib.util.module_from_spec(_admit_spec);_admit_spec.loader.exec_module(_admission)
model_config=json.loads((base/"config.json").read_text())
heads=model_config["num_attention_heads"];kv_heads=model_config.get("num_key_value_heads",heads);dim=model_config.get("head_dim",model_config["hidden_size"]//heads)
# Measure the resident role-cache representation rather than assuming that the
# weights' dtype equals the KV dtype. Inline benchmarking uses sealed model dtype.
kv_bytes=model_config["num_hidden_layers"]*2*kv_heads*dim*(2 if model_config.get("torch_dtype") in ("float16","bfloat16") else 4)
if initialized:
    sample=next(iter(initialized.values()))
    measured=sum(value.nbytes for _,values,_ in sample['state'] for value in values if hasattr(value,'nbytes'))
    if not measured:raise RuntimeError("cannot measure model KV cache layout")
    kv_bytes=max(kv_bytes,math.ceil(measured/len(sample['prefix'])))
# Reserve forward scratch space and allocator cache in addition to resident weights.
kv_budget=memory-mx.get_active_memory()-max(4*1024**3,int(memory*.20))-min(memory//8,1024**3)
if kv_budget<=0:raise RuntimeError("model initialization leaves no safe KV reservation budget")
waiting=deque()
incoming=queue.Queue(maxsize=capacity)
def read_requests():
    for line in sys.stdin:incoming.put(line)
    incoming.put(None)
threading.Thread(target=read_requests,daemon=True).start()
active={};eof=False;reused=0;request_templates=0;request_system_tokenizations=0;last_progress=time.monotonic()
initial['memoryAdmission']={'kvBytesPerToken':kv_bytes,'kvBudgetBytes':kv_budget,'slots':capacity,'paddingBlock':256}
print(json.dumps({'ready':True,'loadSeconds':time.perf_counter()-started,'architecture':'role-package','initialization':initial}),flush=True)

def submit(request,stage='main',history=None):
    global reused,request_templates,request_system_tokenizations
    role=request['role'];primary=configs[role];config=primary['presence'] if stage=='presence' else primary
    payload=copy.deepcopy(request['payload'])
    if stage=='presence':
        checks=[]
        for span in payload.get('spans',[]):
            checks.extend(part for part in re.split(r'(?<=[.!?])(?=\s)|(?<=\n)',span['text']) if part.strip())
        checks.append('\n'.join(span['text'] for span in payload.get('spans',[])))
        checks.append('\n'.join(span['text'] for span in reversed(payload.get('spans',[]))))
        index=len(history or []);names=[m['name'] for m in payload['context']['candidates']['members']];view={'entities':names if index%2==0 else list(reversed(names)),'spans':[{'id':index//2,'text':checks[index//2]}]}
        check_count=len(checks)*2
    else:
        if history:payload.setdefault('context',{})['presence']=any(step['result'] for step in history)
        policy=config['input'];view={}
        if 'spans' in payload:view['spans']=payload['spans']
        view['context']={key:payload.get('context',{})[key] for key in policy['context'] if key in payload.get('context',{})}
        view['prior']={key:payload.get('prior',{})[key] for key in policy['prior'] if key in payload.get('prior',{})}
        if 'candidateMembers' in policy and 'candidates' in view['context']:
            pair=view['context']['candidates']
            view['context']['candidates']={'members':[{key:m[key] for key in policy['candidateMembers'] if key in m} for m in pair['members']],'evidence':[{key:e[key] for key in policy['candidateEvidence'] if key in e} for e in pair['evidence']]}
    content=(('Entities: '+', '.join(view['entities'])+'\n'+'\n'.join(span['text'] for span in view['spans'])) if stage=='presence' and config['input']['format']=='text' else json.dumps(view,ensure_ascii=True,separators=(',',':'))).replace('<','\\u003c')
    if mode=='packaged':
        state=initialized[role+(':presence' if stage=='presence' else '')];prompt=tokenizer.encode(state['header']+content+state['footer'],add_special_tokens=False)
        cache=[cls.from_state(values,meta) for cls,values,meta in state['state']];prefix_tokens=len(state['prefix']);reused+=prefix_tokens
    else:
        prompt=tokenizer.apply_chat_template([{'role':'system','content':config['system']},{'role':'user','content':content}],tokenize=True,add_generation_prompt=True,enable_thinking=False)
        cache=None;prefix_tokens=0;request_templates+=1;request_system_tokenizations+=1
    if prefix_tokens+len(prompt)+config['maxTokens']>context:raise ValueError('context budget exceeded; complete input rejected without truncation')
    reserved=prefix_tokens+len(prompt)+config['maxTokens']
    if not _admission.allows([],reserved,kv_bytes,kv_budget,capacity):
        raise ValueError('complete sequence cannot fit safe KV memory budget; input was not truncated')
    waiting.append({'prompt':prompt,'cache':cache,'config':config,'payload':payload,'item':{'request':request,'stage':stage,'history':history or [],'tokens':[],'inputTokens':len(prompt),'inputHash':hashlib.sha256(content.encode()).hexdigest(),'systemHash':hashlib.sha256(config['system'].encode()).hexdigest(),'checkCount':check_count if stage=='presence' else 0,'reservedTokens':reserved}})

    print(json.dumps({'id':request['id'],'queued':True}),flush=True)

def admit():
    while waiting:
        prepared=waiting[0]
        if not _admission.allows([item['reservedTokens'] for item in active.values()],prepared['item']['reservedTokens'],kv_bytes,kv_budget,capacity):break
        waiting.popleft()
        try:
            constraint=Constraint(prepared['config'],prepared['payload'])
            uid=generator.insert([prepared['prompt']],max_tokens=prepared['config']['maxTokens'],caches=[prepared['cache']])[0]
            generator.constraints[uid]=constraint;active[uid]=prepared['item']
            print(json.dumps({'id':prepared['item']['request']['id'],'admitted':True}),flush=True)
        except Exception as error:
            print(json.dumps({'id':prepared['item']['request']['id'],'error':type(error).__name__+': '+str(error)}),flush=True)

def emit(item,result,assessment,history):
    print(json.dumps({'id':item['request']['id'],'result':result,'inputTokens':sum(p['inputTokens'] for p in history),'outputTokens':sum(p['outputTokens'] for p in history),'peakBytes':mx.get_peak_memory(),'trace':{'assessment':assessment,'phases':history,'id':item['request']['id'],'role':item['request']['role'],'inputHash':item['inputHash'],'systemHash':hashlib.sha256(configs[item['request']['role']]['system'].encode()).hexdigest(),'resultHash':hashlib.sha256(json.dumps(result,sort_keys=True,separators=(',',':')).encode()).hexdigest()},'engineStats':{'refills':generator.refills,'promptTokens':generator._stats.prompt_tokens,'promptSeconds':generator._stats.prompt_time,'generationTokens':generator._stats.generation_tokens,'generationSeconds':generator._stats.generation_time,'fixedTokensReused':reused,'requestSystemTokenizations':request_system_tokenizations,'requestTemplates':request_templates},'forwards':forwards}),flush=True)

try:
    while not eof or active or waiting:
        while not eof and len(active)+len(waiting)<capacity:
            try:line=incoming.get(timeout=0.01 if active else 0.1)
            except queue.Empty:break
            if line is None:eof=True;break
            request={}
            try:
                request=json.loads(line);config=configs[request['role']]
                if mode=='packaged' and 'system' in request:raise ValueError('packaged requests contain dynamic data only')
                if mode=='inline' and request.get('system')!=config['system']:raise ValueError('baseline instructions differ from artifact')
                submit(request,'presence' if 'presence' in config else 'main')
            except Exception as error:print(json.dumps({'id':request.get('id'),'error':type(error).__name__+': '+str(error)}),flush=True)
        admit()
        if not active:continue
        responses=generator.next()
        now=time.monotonic()
        if now-last_progress>=2:
            print(json.dumps({'progress':True,'active':len(active),'queued':len(waiting),'reservedKVBytes':_admission.footprint([item['reservedTokens'] for item in active.values()],kv_bytes),'kvBudgetBytes':kv_budget,'generationTokens':generator._stats.generation_tokens,'promptTokens':generator._stats.prompt_tokens,'peakBytes':mx.get_peak_memory()}),flush=True)
            last_progress=now
        for response in responses:
            item=active[response.uid]
            if response.finish_reason!='stop':item['tokens'].append(response.token)
            if response.finish_reason is not None:
                choices=generator.constraints[response.uid].choices
                del active[response.uid];del generator.constraints[response.uid]
                try:
                    if response.finish_reason!='stop':raise ValueError('output token budget exhausted; incomplete analysis rejected')
                    result=json.loads(tokenizer.decode(item['tokens']))
                    history=item['history']+[{'choices':choices,'phase':item['stage'],'result':result if item['stage']=='presence' else None,'inputTokens':item['inputTokens'],'outputTokens':len(item['tokens']),'inputHash':item['inputHash'],'systemHash':item['systemHash'],'resultHash':hashlib.sha256(json.dumps(result,sort_keys=True,separators=(',',':')).encode()).hexdigest()}]
                    if item['stage']=='presence':
                        if not isinstance(result,bool):raise ValueError('presence decision must be boolean')
                        if len(history)<item['checkCount']:submit(item['request'],'presence',history)
                        elif any(step['result'] for step in history):submit(item['request'],'main',history)
                        else:emit(item,{'edges':[],'unknowns':[]},{'linked':False,'edges':[]},history)
                    else:
                        result,assessment=_decoder.project(configs[item['request']['role']],result)
                        emit(item,result,assessment,history)
                except Exception as error:print(json.dumps({'id':item['request']['id'],'error':type(error).__name__+': '+str(error),'partial':tokenizer.decode(item['tokens']),'outputTokens':len(item['tokens']),'inference':item['history']}),flush=True)
finally:generator.close()
