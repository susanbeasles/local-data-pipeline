"""Synthetic MLX backend contract probe; no model loading or corpus reads."""
import os,socket,json
os.environ['HF_HUB_OFFLINE']='1';os.environ['TRANSFORMERS_OFFLINE']='1'
probe=socket.socket()
try:
    probe.connect(('127.0.0.1',9));raise RuntimeError('network guard absent')
except PermissionError:pass
finally:probe.close()
import mlx.core as mx
from mlx_lm.generate import BatchGenerator
class Model:
    layers=[None]
    max_rows=0
    def __call__(self,inputs,cache):
        b,l=inputs.shape
        self.max_rows=max(self.max_rows,b)
        cache[0].update_and_fetch(mx.zeros((b,1,l,1)),mx.zeros((b,1,l,1)))
        return mx.where(mx.arange(8)[None,None,:]==((inputs+1)%8)[:,:,None],0.0,-100.0)
class Engine(BatchGenerator):
    refills=0
    def _process_prompts(self,prompts):
        if self.active_batch is not None and any(n>0 for n in self.active_batch.num_tokens):self.refills+=1
        return super()._process_prompts(prompts)
model=Model();engine=Engine(model,stop_tokens={7},completion_batch_size=4,prefill_batch_size=1)
results={};finished=set()
def collect(responses):
    for r in responses:
        results.setdefault(r.uid,[]).append(r.token)
        if r.finish_reason:
            assert r.finish_reason=='stop';assert r.uid not in finished;finished.add(r.uid)
try:
    first=engine.insert([[1,1],[3,3,3]],max_tokens=16);collect(engine.next())
    assert engine.active_batch is not None
    second=engine.insert([[0,0],[2,2]],max_tokens=16)
    for _ in range(20):
        collect(engine.next())
        if len(finished)==4:break
    for uid,last in zip(first+second,[1,3,0,2]):assert results[uid]==list(range(last+1,8)),(uid,results[uid])
    assert len(finished)==4 and engine.refills>0 and model.max_rows==4
    print(json.dumps({'maxRows':model.max_rows,'refills':engine.refills,'finished':len(finished)}),flush=True)
finally:engine.close()
