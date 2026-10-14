import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { guard } from "../guest.ts";
const [name] = process.argv.slice(2);
if (!name || !/^pipeline-[a-z0-9-]+-check$/.test(name))
  throw Error("Specify an existing disposable pipeline-*-check VM; it will be stopped afterward");
const root = "/home/agent/instances/check-" + crypto.randomUUID();
const exec = (args: string[]) =>
  execFileSync("sbx", ["exec", name, ...args], {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
try {
  exec([
    "python3",
    "-c",
    `from pathlib import Path
p=Path(${JSON.stringify(root)})
(p/'input').mkdir(parents=True)
(p/'work').mkdir()
(p/'input'/'original').write_text('synthetic fixture')
(p/'escape').symlink_to('/home/agent')`,
  ]);
  const program = `import pathlib,socket,json,platform
r={'linuxGuest':platform.system()=='Linux'}
p=pathlib.Path('/input/original')
try:p.write_text('modified');r['inputWriteDenied']=False
except PermissionError:r['inputWriteDenied']=True
except OSError as e:r['inputWriteDenied']=e.errno==30
pathlib.Path('/work/result').write_text('synthetic result')
r['workWritable']=True
r['sshHidden']=not pathlib.Path('/run/ssh-agent.sock').exists()
r['dockerHidden']=not pathlib.Path('/var/run/docker.sock').exists()
r['hostCorpusHidden']=not pathlib.Path('/Users/avespoli/SonarMD-Dump-2026-10-09').exists()
s=socket.socket();s.settimeout(2)
try:s.connect(('1.1.1.1',443));r['networkDenied']=False
except OSError as e:r['networkDenied']=e.errno in [1,13,101]
print(json.dumps(r))`;
  assert.throws(() =>
    exec(guard(["/usr/bin/true"], [{ source: root + "/escape", target: "/input", write: false }])),
  );
  const result = JSON.parse(
    exec(
      guard(
        ["/usr/bin/python3", "-c", program],
        [
          { source: root + "/input", target: "/input", write: false },
          { source: root + "/work", target: "/work", write: true },
        ],
      ),
    ),
  );
  assert.equal(Object.keys(result).length, 7);
  assert.ok(
    Object.values(result).every((v) => v === true),
    JSON.stringify(result),
  );
  assert.equal(
    exec([
      "python3",
      "-c",
      `from pathlib import Path; print((Path(${JSON.stringify(root)})/'input'/'original').read_text())`,
    ]).trim(),
    "synthetic fixture",
  );
  console.log(JSON.stringify({ passed: true, checks: result, productionData: false }));
} finally {
  execFileSync("sbx", ["stop", name], { stdio: "ignore", timeout: 30000 });
}
