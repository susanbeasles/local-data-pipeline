"""Preserve valid composite JSON boundary tokens omitted by LMFE's free-text shortcut."""
from lmformatenforcer import TokenEnforcer
from lmformatenforcer.tokenizerprefixtree import TokenizerPrefixTreeNode

def select(logits,allowed,mx):
    """Match ordinary greedy argmax's lowest-vocabulary-ID tie rule."""
    if not allowed:raise ValueError('schema admits no token')
    ids=mx.array(allowed,dtype=mx.int32);scores=logits[ids]
    return mx.min(mx.where(scores==mx.max(scores),ids,2147483647))

def boundaries(data):
    root=TokenizerPrefixTreeNode()
    for token,text,_ in data.regular_tokens:
        if '"' not in text:continue
        node=root
        for char in text:node=node.children.setdefault(char,TokenizerPrefixTreeNode())
        node.tokens.append(token)
    return root

class Enforcer(TokenEnforcer):
    def __init__(self,data,parser,boundary_root):
        self.boundary_root=boundary_root
        super().__init__(data,parser)
    def _collect_allowed_tokens(self,parser,tree_node,allowed_tokens,shortcut_key):
        # Keep the fast interior-token allowlist, and independently traverse only
        # quote-containing tokens through the SAME schema parser. This restores
        # valid '.","' / 'word",' tokens without permitting invalid JSON.
        super()._collect_allowed_tokens(parser,tree_node,allowed_tokens,shortcut_key)
        if isinstance(shortcut_key,tuple) and shortcut_key[0]=='json_freetext':
            super()._collect_allowed_tokens(parser,self.boundary_root,allowed_tokens,None)

import re
from lmformatenforcer import CharacterLevelParser
class References(CharacterLevelParser):
    """Conjoin schema syntax with unique references and both-endpoint evidence."""
    def __init__(self,parser,pair,text=''):
        self.parser=parser;self.pair=pair;self.text=text
    @property
    def config(self):return self.parser.config
    @config.setter
    def config(self,value):self.parser.config=value
    def add_character(self,char):return References(self.parser.add_character(char),self.pair,self.text+char)
    def cache_key(self):return None
    def shortcut_key(self):return self.parser.shortcut_key()
    def can_end(self):return self.parser.can_end()
    def _domain(self):
        matches=list(re.finditer(r'(?<!\\)"(memberIds|evidenceIds)"\s*:\s*\[',self.text))
        if matches:
            match=matches[-1];tail=self.text[match.end():]
            if ']' not in tail:
                strings=re.findall(r'"([^"\\]*)"',tail);inside=tail.count('"')%2==1
                prefix=tail.rsplit('"',1)[-1] if inside else ''
                if match.group(1)=='memberIds':domain=[m['id'] for m in self.pair.get('members',[])]
                else:
                    evidence=self.pair.get('evidence',[]);domain=[e['id'] for e in evidence]
                    if len(strings)==1:
                        seen={e['member'] for e in evidence if e['id'] in strings};domain=[e['id'] for e in evidence if e['member'] not in seen]
                return inside,prefix,[v for v in domain if v not in strings]
        matches=list(re.finditer(r'(?<!\\)"to"\s*:\s*"([^"\\]*)$',self.text))
        if matches:
            previous=re.findall(r'(?<!\\)"from"\s*:\s*"([^"\\]*)"',self.text)
            return True,matches[-1].group(1),[m['id'] for m in self.pair.get('members',[]) if not previous or m['id']!=previous[-1]]
        return None
    def get_allowed_characters(self):
        allowed=self.parser.get_allowed_characters();domain=self._domain()
        if domain is None:return allowed
        inside,prefix,values=domain
        if not inside:return allowed if values else allowed.replace('"','')
        next_chars={v[len(prefix)] for v in values if v.startswith(prefix) and len(v)>len(prefix)}
        if prefix in values:next_chars.add('"')
        return ''.join(c for c in allowed if c in next_chars)

import json
class Connection(References):
    """Conjoin the public edge schema with the model's preceding decisions."""
    def _scalar(self,key):
        matches=list(re.finditer(r'(?<!\\)"'+key+r'"\s*:\s*',self.text))
        if not matches:return None
        try:return json.JSONDecoder().raw_decode(self.text[matches[-1].end():])[0]
        except ValueError:return None
    def _domain(self):
        match=re.search(r'(?<!\\)"(actor|target|from|to)"\s*:\s*"((?:\\.|[^"\\])*)$',self.text)
        if match:
            field,prefix=match.groups();actor=self._scalar('actor');target=self._scalar('target')
            if field=='from':values=[actor] if isinstance(actor,str) else []
            elif field=='to':values=[target] if isinstance(target,str) else []
            else:values=[m['id'] for m in self.pair['members'] if field!='target' or m['id']!=actor]
            # Canonical JSON string encodings preserve quoted and Unicode IDs.
            values=list({json.dumps(v,ensure_ascii=ascii)[1:-1] for v in values for ascii in (True,False)})
            return True,prefix,values
        return super()._domain()
    def get_allowed_characters(self):
        allowed=super().get_allowed_characters()
        pending=re.search(r'(?<!\\)"linked"\s*:\s*([a-z]*)$',self.text)
        if pending and 'presence' in self.pair:
            word='true' if self.pair['presence'] else 'false';prefix=pending.group(1)
            if len(prefix)<len(word):return ''.join(c for c in allowed if c==word[len(prefix)] or (not prefix and c in ' \t\n\r'))
        if re.search(r'(?<!\\)"edges"\s*:\s*\[\s*$',self.text):
            linked=self._scalar('linked')
            if linked is False:return ''.join(c for c in allowed if c in '] \t\n\r')
            if linked is True:return allowed.replace(']','')
        return allowed
    def add_character(self,char):return Connection(self.parser.add_character(char),self.pair,self.text+char)

def project(config,result):
    policy=config['output'];assessment=None
    if 'linked' in policy['privateRoot']:
        linked=result['linked'];edges=result['edges']
        if linked!=bool(edges):raise ValueError('connection decision and edges disagree')
        for edge in edges:
            if edge['actor']!=edge['from'] or edge['target']!=edge['to'] or edge['actor']==edge['target']:raise ValueError('connection direction differs from actor/target assessment')
        assessment={'linked':linked,'edges':[{'actor':e['actor'],'target':e['target'],'relation':e['relation']} for e in edges]}
    public={k:v for k,v in result.items() if k not in policy['privateRoot']}
    if policy['privateEdge']:public['edges']=[{k:v for k,v in edge.items() if k not in policy['privateEdge']} for edge in public['edges']]
    return public,assessment
