"""Bounded synthetic diagnosis using unmodified MLX-LM generation."""
import json,sys
from pathlib import Path
from mlx_lm import load,generate
from mlx_lm.sample_utils import make_sampler
model,tok=load(sys.argv[1],tokenizer_config={'trust_remote_code':False})
role=json.loads((Path(sys.argv[2])/'connect/model.json').read_text())
for name,system,content in [
 ('basic','Return one JSON object answering the question.','Alpha stores records locally. Beta reads records from Alpha. Which component reads, and which component provides records? Return reader and provider names.'),
 ('boolean-positive','Answer with exactly true or false.','Sentence 1: Alpha stores records locally. Sentence 2: Beta reads records from Alpha. Does either sentence describe Beta using records from Alpha?'),
 ('presence-json',role['presence']['system'],json.dumps({'entities':['Alpha','Beta'],'spans':[{'id':0,'text':'Alpha stores records locally.'},{'id':1,'text':'Beta reads records from Alpha.'}]},separators=(',',':'))),
 ('boolean','Answer the question with exactly true or false, no explanation.','Sentence 1: Cedar stores records locally. Sentence 2: Maple displays a clock. Does either sentence describe Cedar using, implementing, replacing, documenting, contradicting, or interacting with Maple?'),
 ('basic-negative','Return one JSON object answering the question.','Cedar stores records locally. Maple displays a clock. What action connects these two entities? If no interaction is stated, return subject=none, object=none, relation=none.'),
 ('negative',role['system'],json.dumps({'context':{'trustedNamespace':'fixture','candidates':{'members':[{'id':'Cedar#0','name':'Cedar','kind':'component','namespace':'fixture','claims':[]},{'id':'Maple#1','name':'Maple','kind':'component','namespace':'fixture','claims':[]}],'evidence':[{'id':'r0','member':'Cedar#0','text':'Cedar stores records locally.'},{'id':'r1','member':'Maple#1','text':'Maple displays a clock.'}]}},'prior':{'reconcile':{'groups':[],'unknowns':[]}}}))]:
 prompt=tok.apply_chat_template([{'role':'system','content':system},{'role':'user','content':content}],tokenize=True,add_generation_prompt=True)
 result=generate(model,tok,prompt=prompt,max_tokens=300,sampler=make_sampler(temp=0),verbose=False)
 print(json.dumps({'case':name,'text':result}),flush=True)
