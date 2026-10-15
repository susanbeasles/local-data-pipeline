import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Guest, type Mac } from "./macos.ts";
type Pin = { root: string; sha256: string };
export type Config = { mac: Mac; python: string; runtime: Pin; model: Pin };
const probe = String.raw`import sys,os,json,hashlib,platform,stat,importlib.metadata
v=json.loads(sys.argv[1]);os.environ.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',HF_HUB_DISABLE_TELEMETRY='1')
def seal(root):
 if os.path.realpath(root)!=root:raise RuntimeError('resource alias')
 files={}
 for base,dirs,names in os.walk(root,followlinks=False):
  for name in dirs:
   if os.path.islink(os.path.join(base,name)):raise RuntimeError('directory alias')
  for name in names:
   p=os.path.join(base,name)
   if not stat.S_ISREG(os.lstat(p).st_mode):raise RuntimeError('alias or special file')
   h=hashlib.sha256()
   with open(p,'rb') as f:
    for b in iter(lambda:f.read(1048576),b''):h.update(b)
   files[os.path.relpath(p,root)]=h.hexdigest()
 h=hashlib.sha256()
 for name in sorted(files):h.update((json.dumps([name,files[name]],ensure_ascii=False,separators=(',',':'))+'\n').encode())
 return h.hexdigest()
if platform.system()!='Darwin' or platform.machine()!='arm64':raise RuntimeError('Darwin arm64 guest required')
runtime=seal(v['runtime']['root']);model=seal(v['model']['root'])
if runtime!=v['runtime']['sha256'] or model!=v['model']['sha256']:raise RuntimeError('pin mismatch')
if not os.path.realpath(sys.executable).startswith(v['runtime']['root']+'/'):raise RuntimeError('Python outside runtime')
import mlx.core as mx
import mlx_lm
for module in (mx,mlx_lm):
 if not os.path.realpath(module.__file__).startswith(v['runtime']['root']+'/'):raise RuntimeError('module outside runtime')
if not mx.metal.is_available():raise RuntimeError('Metal unavailable')
mx.set_default_device(mx.gpu);x=mx.array([1,2,3]);y=mx.sum(x*x);mx.eval(y)
if y.item()!=14:raise RuntimeError('GPU arithmetic failed')
m,t=mlx_lm.load(v['model']['root'])
out=mlx_lm.generate(m,t,prompt='Synthetic qualification. Reply with the word READY.',max_tokens=8,verbose=False)
if not isinstance(out,str) or not out.strip() or len(out)>4096:raise RuntimeError('synthetic inference failed')
if seal(v['runtime']['root'])!=runtime or seal(v['model']['root'])!=model:raise RuntimeError('resource changed')
print(json.dumps(dict(nonce=v['nonce'],system=platform.system(),machine=platform.machine(),mlx=importlib.metadata.version('mlx'),metal=True,gpu=y.item(),runtime=runtime,model=model,output=out)))`;
/** Probes only an already-running isolated guest; no boot, install or host fallback. */
export async function qualify(
  config: Config,
  guest: Pick<Guest, "execute"> = new Guest(config.mac),
) {
  const path = (p: string) =>
    typeof p === "string" &&
    /^\/(?!$)/.test(p) &&
    !p.includes("\0") &&
    !p.split("/").some((s) => s === ".." || s === ".");
  for (const pin of [config.runtime, config.model])
    if (!path(pin.root) || !/^[a-f0-9]{64}$/.test(pin.sha256))
      throw Error("guest resource pin required");
  if (!path(config.python) || !config.python.startsWith(config.runtime.root + "/"))
    throw Error("pinned guest Python required");
  if (
    config.runtime.root === config.model.root ||
    config.runtime.root.startsWith(config.model.root + "/") ||
    config.model.root.startsWith(config.runtime.root + "/")
  )
    throw Error("separate guest resources required");
  const nonce = randomUUID();
  const value: unknown = JSON.parse(
    await guest.execute([
      config.python,
      "-I",
      "-B",
      "-c",
      probe,
      JSON.stringify({ runtime: config.runtime, model: config.model, nonce }),
    ]),
  );
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("invalid guest evidence");
  const e = value as Record<string, unknown>;
  if (
    e.nonce !== nonce ||
    e.system !== "Darwin" ||
    e.machine !== "arm64" ||
    e.metal !== true ||
    e.gpu !== 14 ||
    e.runtime !== config.runtime.sha256 ||
    e.model !== config.model.sha256 ||
    typeof e.mlx !== "string" ||
    !e.mlx ||
    typeof e.output !== "string" ||
    !e.output.trim() ||
    e.output.length > 4096
  )
    throw Error("guest evidence mismatch");
  return {
    format: "pipeline-qualification/1",
    scope: "synthetic-backend",
    observedAt: new Date().toISOString(),
    qualification: { vm: true, inference: true },
    evidence: e,
  };
}
if (process.argv[1] === import.meta.filename) {
  if (process.argv.length !== 3)
    throw Error("Usage: node pipeline/qualification.ts /path/nonsecret-config.json");
  console.log(JSON.stringify(await qualify(JSON.parse(await readFile(process.argv[2], "utf8")))));
}
