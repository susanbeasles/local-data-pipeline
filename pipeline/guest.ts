import { posix } from "node:path";
export type Resources = { image: string; cpus: number; memoryBytes: number };
export type Mount = {
  source: string;
  target: "/pipeline" | "/input" | "/models" | "/work";
  write: boolean;
};
/** Returns a credential-free, non-privileged descriptor; JSON is valid YAML. */
export function kit(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("invalid VM resources");
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some((k) => !["image", "cpus", "memoryBytes"].includes(k)) ||
    typeof v.image !== "string" ||
    !/^docker\.io\/docker\/sandbox-templates:shell@sha256:[a-f0-9]{64}$/.test(v.image) ||
    !Number.isSafeInteger(v.cpus) ||
    Number(v.cpus) < 1 ||
    Number(v.cpus) > 64 ||
    !Number.isSafeInteger(v.memoryBytes) ||
    Number(v.memoryBytes) < 512 * 1024 ** 2 ||
    Number(v.memoryBytes) > 32_000_000_000
  )
    throw Error("invalid or unsupported VM resources");
  return {
    schemaVersion: "2",
    kind: "sandbox",
    name: "pipeline",
    security: { privileged: false },
    credentials: [],
    sandbox: {
      image: v.image,
      entrypoint: ["/bin/bash"],
      command: { default: ["-l"] },
      resources: { cpu: v.cpus, memory: String(v.memoryBytes) },
    },
  };
}
const validate = `import os,sys,json,stat
mounts=json.loads(sys.argv[1])
roots=set()
for mount in mounts:
 path=mount['source']
 if os.path.realpath(path)!=path or not stat.S_ISDIR(os.lstat(path).st_mode):
  raise SystemExit('guest mount must be a canonical directory without symlinks')
 root='/'.join(path.split('/')[:5])
 if root=='/home/agent/instances' or not path.startswith(root+'/'):
  raise SystemExit('guest mount requires an instance root')
 roots.add(root)
if len(roots)>1: raise SystemExit('guest mounts cross instance roots')
for a in mounts:
 for b in mounts:
  if a is b or not (a['write'] or b['write']): continue
  if a['source']==b['source'] or a['source'].startswith(b['source']+'/') or b['source'].startswith(a['source']+'/'):
   raise SystemExit('writable guest mount overlaps a protected mount')
os.execv(sys.argv[2],sys.argv[2:])`;
/** Validates real guest paths before applying the irreversible namespace boundary. */
export function guard(command: string[], mounts: Mount[] = []) {
  if (!command.length || !command[0].startsWith("/") || command.some((v) => v.includes("\0")))
    throw Error("invalid guest command");
  const args = [
    "bwrap",
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    "--ro-bind",
    "/usr",
    "/usr",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/run",
    "--dir",
    "/etc",
    "--clearenv",
    "--setenv",
    "PATH",
    "/usr/bin:/bin",
    "--setenv",
    "HOME",
    "/tmp",
    "--setenv",
    "HF_HUB_OFFLINE",
    "1",
    "--setenv",
    "TRANSFORMERS_OFFLINE",
    "1",
    "--setenv",
    "HF_HUB_DISABLE_TELEMETRY",
    "1",
    "--setenv",
    "PYTHONDONTWRITEBYTECODE",
    "1",
  ];
  const seen = new Set<string>();
  const roots = new Set<string>();
  for (const mount of mounts) {
    if (
      !mount.source.startsWith("/home/agent/instances/") ||
      posix.normalize(mount.source) !== mount.source ||
      mount.source.includes("\0") ||
      !["/pipeline", "/input", "/models", "/work"].includes(mount.target) ||
      seen.has(mount.target) ||
      typeof mount.write !== "boolean" ||
      (mount.write && mount.target !== "/work")
    )
      throw Error("invalid guest mount");
    const root = mount.source.split("/").slice(0, 5).join("/");
    if (mount.source === root) throw Error("guest mount requires an instance root");
    roots.add(root);
    if (roots.size > 1) throw Error("guest mounts cross instance roots");
    for (const other of mounts) {
      if (other === mount || !(other.write || mount.write)) continue;
      if (
        other.source === mount.source ||
        other.source.startsWith(mount.source + "/") ||
        mount.source.startsWith(other.source + "/")
      )
        throw Error("writable guest mount overlaps a protected mount");
    }
    seen.add(mount.target);
    args.push(mount.write ? "--bind" : "--ro-bind", mount.source, mount.target);
  }
  return [
    "/usr/bin/python3",
    "-I",
    "-c",
    validate,
    JSON.stringify(mounts),
    "/usr/bin/bwrap",
    ...args.slice(1),
    "--",
    ...command,
  ];
}
