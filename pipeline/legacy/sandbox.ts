import { realpath, mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
export type Sandbox = {
  directory: string;
  profile: string;
  env: NodeJS.ProcessEnv;
  python: string;
  launch: (args: string[]) => ChildProcessWithoutNullStreams;
  close: () => Promise<void>;
};
const quote = (value: string) => JSON.stringify(value);
/** Fail closed: direct Python launch is deliberately unavailable. */
export async function sandbox(
  runtime: string,
  model: string,
  script: string,
  adapter: string,
  modules: string[] = [],
): Promise<Sandbox> {
  if (process.platform !== "darwin") throw Error("sandbox-unavailable");
  await access("/usr/bin/sandbox-exec");
  const originalScript = script,
    originalModel = model;
  runtime = await realpath(runtime);
  model = await realpath(model);
  script = await realpath(script);
  adapter = await realpath(adapter);
  modules = await Promise.all(modules.map((path) => realpath(path)));
  const directory = await realpath(
      await mkdtemp(join(tmpdir(), "enrichment-sandbox-")),
    ),
    profile = join(directory, "runtime.sb");
  const python = join(runtime, "bin/python"),
    actual = await realpath(python),
    framework =
      "/Applications/Xcode.app/Contents/Developer/Library/Frameworks/Python3.framework";
  const metadata = new Set<string>();
  for (const path of [
    actual,
    framework,
    runtime,
    model,
    adapter,
    script,
    directory,
    ...modules,
  ]) {
    let parent = dirname(path);
    while (parent !== "/") {
      metadata.add(parent);
      parent = dirname(parent);
    }
  }
  const text = `(version 1)
(deny default)
(import "dyld-support.sb")
(allow process-exec (literal ${quote(python)}) (literal ${quote(actual)}) (literal ${quote(framework + "/Versions/3.9/Resources/Python.app/Contents/MacOS/Python")}))
(deny process-fork)
(deny network*)
(deny file-write*)
(allow file-read* (subpath "/System/Library") (subpath "/usr/lib") (subpath "/System/Volumes/Preboot/Cryptexes/OS/usr/lib") (subpath "/System/Volumes/Preboot/Cryptexes/OS/System/Library") (subpath "/private/var/db/dyld") (subpath "/Library/Apple") (subpath ${quote(framework)}) (subpath ${quote(runtime)}) (subpath ${quote(model)}) (subpath ${quote(adapter)}) (literal ${quote(script)}) ${modules.map((path) => "(literal " + quote(path) + ")").join(" ")} (literal ${quote(actual)}) (subpath ${quote(directory)}) (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random") (literal "/private/etc/localtime") (subpath "/usr/share/locale"))
(allow file-read-metadata (literal "/") (literal "/Users") (literal "/Users/avespoli") ${[...metadata].map((path) => "(literal " + quote(path) + ")").join(" ")})
(allow file-map-executable (subpath "/System/Library") (subpath "/usr/lib") (subpath "/System/Volumes/Preboot/Cryptexes/OS/usr/lib") (subpath "/System/Volumes/Preboot/Cryptexes/OS/System/Library") (subpath "/private/var/db/dyld") (subpath ${quote(framework)}) (subpath ${quote(runtime)}) (literal ${quote(actual)}))
(allow process-info* (target self))
(allow syscall-unix)
(allow syscall-mach)
(allow system-fcntl)
(allow system-mac-syscall)
(allow sysctl-read)
(allow mach-lookup (global-name "com.apple.MTLCompilerService") (global-name "com.apple.cvmsServ"))
(allow iokit-open (iokit-user-client-class "AGXDeviceUserClient") (iokit-user-client-class "IOSurfaceRootUserClient"))
`;
  await writeFile(profile, text, { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    TMPDIR: directory,
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
    VIRTUAL_ENV: runtime,
    PYTHONPATH: join(runtime, "lib/python3.9/site-packages"),
    HF_HOME: directory,
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    HF_DATASETS_OFFLINE: "1",
    HF_HUB_DISABLE_TELEMETRY: "1",
    HF_HUB_DISABLE_IMPLICIT_TOKEN: "1",
    TOKENIZERS_PARALLELISM: "false",
    LC_ALL: "en_US.UTF-8",
  };
  return {
    directory,
    profile,
    env,
    python: actual,
    launch: (args) =>
      spawn(
        "/usr/bin/sandbox-exec",
        [
          "-f",
          profile,
          actual,
          ...args.map((arg) =>
            arg === originalScript
              ? script
              : arg === originalModel
                ? model
                : arg,
          ),
        ],
        { cwd: directory, env, stdio: ["pipe", "pipe", "pipe"] },
      ),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
