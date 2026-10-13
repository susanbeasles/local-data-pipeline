"""Known-valid six-role schema replay using installed tokenizer, without model inference."""
import json,sys,copy
from pathlib import Path
from transformers import AutoTokenizer
from lmformatenforcer import JsonSchemaParser,TokenEnforcerTokenizerData
import importlib.util
spec=importlib.util.spec_from_file_location("local_decoder",Path(__file__).parent.parent/"decoder.py");module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
base=Path(sys.argv[1]);root=Path(sys.argv[2]);tok=AutoTokenizer.from_pretrained(str(base),local_files_only=True,trust_remote_code=False)
zero=tok.encode('0',add_special_tokens=False)[-1];regular=[]
for token in sorted(set(tok.get_vocab().values())):
 if token in tok.all_special_ids:continue
 after=tok.decode([zero,token])[1:];single=tok.decode([token]);regular.append((token,after,len(after)>len(single)))
data=TokenEnforcerTokenizerData(regular,lambda t:tok.decode(t).rstrip('\ufffd'),[151645,151643])
schema=json.loads((root/'summarize/model.json').read_text())['schema']
schema['properties']['facts']['items']['properties']['anchorIds']['items']['enum']=[0]
text=json.dumps({'summary':'Alpha stores local records.','facts':[{'claim':'Alpha stores records locally.','basis':'explicit','state':'current','anchorIds':[0]}],'unknowns':[]},separators=(',',':'))
enforcer=module.Enforcer(data,JsonSchemaParser(schema),module.boundaries(data));prefix=[]
for token in tok.encode(text,add_special_tokens=False):
 allowed=enforcer.get_allowed_tokens(prefix)
 if token not in allowed:raise RuntimeError('Known-valid JSON token rejected: '+tok.decode(prefix[-8:])+'=>'+tok.decode([token]))
 prefix.append(token)
assert 151645 in enforcer.get_allowed_tokens(prefix)
for role,text in [('reconcile','{"groups":[],"unknowns":[]}'),('connect','{"edges":[],"unknowns":[]}'),('connect','{"edges": [ ], "unknowns": [ ]}'),('connect','{"edges": [\n ], "unknowns": []}')]:
 schema=json.loads((root/role/'model.json').read_text())['output']['schema']
 enforcer=module.Enforcer(data,JsonSchemaParser(schema),module.boundaries(data));prefix=[]
 for token in tok.encode(text,add_special_tokens=False):
  if token not in enforcer.get_allowed_tokens(prefix):raise RuntimeError('Valid empty '+role+' rejected: '+tok.decode(prefix)+'=>'+tok.decode([token]))
  prefix.append(token)
 assert 151645 in enforcer.get_allowed_tokens(prefix)
for role in ('tag','classify','summarize','knowledge','reconcile','connect'):
 config=json.loads((root/role/'model.json').read_text());system=config['system'];marker='LOCAL_DYNAMIC_PAYLOAD_BOUNDARY_0'
 prefix=tok.apply_chat_template([{'role':'system','content':system}],tokenize=False,add_generation_prompt=False,enable_thinking=False)
 template=tok.apply_chat_template([{'role':'system','content':system},{'role':'user','content':marker}],tokenize=False,add_generation_prompt=True,enable_thinking=False)
 header,footer=template[len(prefix):].split(marker)
 for content in ['{"spans":[{"id":0,"text":"Synthetic input."}]}','{"text":"Unicode \u03bb and newlines\\n"}']:
  actual=tok.encode(prefix,add_special_tokens=False)+tok.encode(header+content+footer,add_special_tokens=False)
  expected=tok.apply_chat_template([{'role':'system','content':system},{'role':'user','content':content}],tokenize=True,add_generation_prompt=True,enable_thinking=False)
  assert actual==expected,'Packaged role token boundary differs: '+role
pair={'members':[{'id':'a'},{'id':'b'}],'evidence':[{'id':'x','member':'a'},{'id':'y','member':'b'}]}
schema=json.loads((root/'connect/model.json').read_text())['output']['schema']
def refs(s):
 if s.get('enum')==['$member']:s['enum']=['a','b']
 if s.get('enum')==['$evidence']:s['enum']=['x','y']
 for child in s.get('properties',{}).values():refs(child)
 if 'items' in s:refs(s['items'])
refs(schema)
for text,valid in [('{"edges":[{"from":"b","to":"a","relation":"depends-on","basis":"explicit","evidenceIds":["x","y"]}],"unknowns":[]}',True),('{"edges":[{"from":"a","to":"a","relation":"depends-on","basis":"explicit","evidenceIds":["x","y"]}],"unknowns":[]}',False),('{"edges":[{"from":"b","to":"a","relation":"depends-on","basis":"explicit","evidenceIds":["x","x"]}],"unknowns":[]}',False)]:
 enforcer=module.Enforcer(data,module.References(JsonSchemaParser(copy.deepcopy(schema)),pair),module.boundaries(data));prefix=[];rejected=False
 for token in tok.encode(text,add_special_tokens=False):
  if token not in enforcer.get_allowed_tokens(prefix):rejected=True;break
  prefix.append(token)
 assert rejected != valid,'Reference integrity replay mismatch'
print(json.dumps({'validJsonReplay':True,'emptyGraphReplay':True,'roleTokenEquality':True,'referenceIntegrity':True}))

import mlx.core as mx
for allowed in ([4,2,1],[1,2,4]):
 assert int(module.select(mx.array([0.,0.,1.,0.,1.]),allowed,mx).item())==2
assert int(module.select(mx.array([0.,0.,1.,0.,2.]),[4,2,1],mx).item())==4

from lmformatenforcer import CharacterLevelParserConfig
config=json.loads((root/'connect/model.json').read_text());internal=copy.deepcopy(config['schema']);refs(internal)
valid='{"linked":true,"edges":[{"actor":"b","target":"a","from":"b","to":"a","relation":"depends-on","basis":"explicit","evidenceIds":["x","y"]}],"unknowns":[]}'
for text,ok in [(' {"linked":false,"edges":[],"unknowns":[]}',True),(valid,True),(valid.replace('"from":"b"','"from":"a"'),False),(valid.replace('"linked":true','"linked":false'),False)]:
 parser=JsonSchemaParser(copy.deepcopy(internal),config=CharacterLevelParserConfig(force_json_field_order=True))
 enforcer=module.Enforcer(data,module.Connection(parser,pair),module.boundaries(data));prefix=[];rejected=False
 for token in tok.encode(text,add_special_tokens=False):
  if token not in enforcer.get_allowed_tokens(prefix):rejected=True;break
  prefix.append(token)
 assert rejected!=ok,'Conditional connection replay mismatch: '+text
 if ok:assert 151645 in enforcer.get_allowed_tokens(prefix)
public,assessment=module.project(config,json.loads(valid))
assert 'linked' not in public and 'actor' not in public['edges'][0]
assert public['edges'][0]['from']=='b' and assessment['linked'] is True

parser=JsonSchemaParser(copy.deepcopy(internal),config=CharacterLevelParserConfig(force_json_field_order=True))
enforcer=module.Enforcer(data,module.Connection(parser,{**pair,'presence':True}),module.boundaries(data));prefix=[]
for token in tok.encode(valid,add_special_tokens=False):
 assert token in enforcer.get_allowed_tokens(prefix),'Bound true verdict rejects valid JSON'
 prefix.append(token)
assert 151645 in enforcer.get_allowed_tokens(prefix)
parser=JsonSchemaParser(copy.deepcopy(internal),config=CharacterLevelParserConfig(force_json_field_order=True))
enforcer=module.Enforcer(data,module.Connection(parser,{**pair,'presence':True}),module.boundaries(data));prefix=[];rejected=False
for token in tok.encode('{"linked":false,"edges":[],"unknowns":[]}',add_special_tokens=False):
 if token not in enforcer.get_allowed_tokens(prefix):rejected=True;break
 prefix.append(token)
assert rejected,'Formatter can contradict source presence verdict'
