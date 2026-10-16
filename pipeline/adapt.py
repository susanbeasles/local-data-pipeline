"""Synthetic-only adaptation feasibility experiment; learned weights, no role prompt at inference."""
import os,sys,json,time,hashlib,socket
from pathlib import Path
for key in ('HF_HUB_OFFLINE','TRANSFORMERS_OFFLINE','HF_HUB_DISABLE_TELEMETRY'):os.environ[key]='1'
s=socket.socket()
try:s.connect(('127.0.0.1',9));raise RuntimeError('missing network isolation')
except PermissionError:pass
finally:s.close()
import mlx.core as mx
import mlx.nn as nn
import mlx.optimizers as optim
from mlx.utils import tree_flatten
from mlx_lm import load,generate
from mlx_lm.tuner.utils import linear_to_lora_layers
from mlx_lm.sample_utils import make_sampler
base=Path(sys.argv[1]).resolve();out=Path(sys.argv[2]).resolve();steps=int(sys.argv[3]);out.mkdir(parents=True,exist_ok=True)
model,tokenizer=load(str(base),tokenizer_config={'trust_remote_code':False})
model.freeze();settings={'rank':8,'scale':20.0,'dropout':0.0,'keys':['self_attn.q_proj','self_attn.v_proj']}
linear_to_lora_layers(model,4,settings);model.train();opt=optim.Adam(learning_rate=0.0002)
(out/'adapter_config.json').write_text(json.dumps({'fine_tune_type':'lora','num_layers':4,'lora_parameters':settings}))
def sample(i):
    text=f'Synthetic service {i} stores records locally. Network access is disabled.'
    result={'summary':text,'facts':[{'claim':text,'anchorIds':[0]}],'unknowns':[]}
    prefix=tokenizer.apply_chat_template([{'role':'user','content':json.dumps({'spans':[{'id':0,'text':text}]},separators=(',',':'))}],tokenize=True,add_generation_prompt=True,enable_thinking=False)
    whole=tokenizer.apply_chat_template([{'role':'user','content':json.dumps({'spans':[{'id':0,'text':text}]},separators=(',',':'))},{'role':'assistant','content':json.dumps(result,separators=(',',':'))}],tokenize=True,enable_thinking=False)
    if whole[:len(prefix)]!=prefix:raise RuntimeError('training prefix mismatch')
    return text,mx.array([whole]),len(prefix)
examples=[sample(i) for i in range(64)]
def loss(model,tokens,start):
    logits=model(tokens[:,:-1]);targets=tokens[:,1:];ce=nn.losses.cross_entropy(logits,targets)
    return ce[:,start-1:].mean()
value_grad=nn.value_and_grad(model,loss);started=time.perf_counter();losses=[]
for step in range(steps):
    _,tokens,start=examples[step%len(examples)]
    value,grad=value_grad(model,tokens,start);opt.update(model,grad);mx.eval(model.parameters(),opt.state,value);losses.append(value.item())
    if step%10==0:print(json.dumps({'step':step,'loss':losses[-1],'seconds':time.perf_counter()-started}),flush=True)
    if step%20==19:mx.save_safetensors(str(out/'checkpoint.safetensors'),dict(tree_flatten(model.trainable_parameters())))
weights=dict(tree_flatten(model.trainable_parameters()));mx.save_safetensors(str(out/'adapters.safetensors'),weights)
nonzero=sum(float(mx.sum(mx.abs(value)).item()) for name,value in weights.items() if 'lora_b' in name)
model.eval();checks=[]
for i in (101,102,103,104):
    text,_,_=sample(i);prompt=tokenizer.apply_chat_template([{'role':'user','content':json.dumps({'spans':[{'id':0,'text':text}]},separators=(',',':'))}],tokenize=True,add_generation_prompt=True,enable_thinking=False)
    begin=time.perf_counter();reply=generate(model,tokenizer,prompt=prompt,max_tokens=256,sampler=make_sampler(temp=0),verbose=False)
    try:result=json.loads(reply);passed=result=={'summary':text,'facts':[{'claim':text,'anchorIds':[0]}],'unknowns':[]}
    except Exception:passed=False
    checks.append({'case':i,'passed':passed,'output':reply,'seconds':time.perf_counter()-begin})
report={'role':'summarize','architecture':'learned-lora','systemPromptTokens':0,'holdoutPassed':all(c['passed'] for c in checks),'nonzeroDelta':nonzero,'steps':steps,'initialLoss':losses[0],'finalLoss':losses[-1],'trainingSeconds':time.perf_counter()-started,'peakBytes':mx.get_peak_memory(),'checks':checks,'scope':'narrow synthetic schema adaptation; not comprehensive semantic acceptance'}
(out/'experiment.json').write_text(json.dumps(report,indent=2));print(json.dumps({k:v for k,v in report.items() if k!='checks'}),flush=True)
