import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile, realpath, cp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { Release } from "../pipeline/release.ts";
const config = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw Error("Usage: node native/build.ts /absolute/panel.json");
const settings = JSON.parse(await readFile(config, "utf8"));
if (!settings.managed) throw Error("Prepare the managed instance before building the app");
const root = resolve(import.meta.dirname, ".."),
  app = join(root, "dist/Pipeline.app");
const studioConfig = process.argv[3] ? await realpath(resolve(process.argv[3])) : undefined;
let studioScript: string | undefined;
if (studioConfig) {
  const releases = join(homedir(), "Library/Application Support/Local Data Pipeline/control-releases");
  await mkdir(releases, { recursive: true, mode: 0o700 });
  const release = await Release.create(root, join(releases, randomUUID()), { revision: "studio-control", panel: config, studio: studioConfig });
  studioScript = join(release.root, "payload/pipeline/studio.ts");
}
await mkdir(join(app, "Contents/MacOS"), { recursive: true });
await mkdir(join(app, "Contents/Resources"), { recursive: true });
const buildArgs = ["build", "--package-path", join(root,"native"), "--scratch-path", join(root,"dist/NativeBuild"), "--configuration", "release", "--disable-automatic-resolution"];
await promisify(execFile)("/usr/bin/swift", [...buildArgs,"--product","Pipeline"], {maxBuffer:16*1024*1024});
const output = await promisify(execFile)("/usr/bin/swift", [...buildArgs,"--show-bin-path"]);
await cp(join(output.stdout.trim(),"Pipeline"),join(app,"Contents/MacOS/Pipeline"));
for (const [name,file] of [["SwiftTerm","SwiftTerm/LICENSE"],["SwiftSystem","swift-system/LICENSE.txt"],["SwiftSubprocess","swift-subprocess/LICENSE"]])
  await cp(join(root,"dist/NativeBuild/checkouts",file),join(app,"Contents/Resources",name+"-LICENSE.txt"));
await writeFile(
  join(app, "Contents/Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Pipeline</string><key>CFBundleIdentifier</key><string>com.susanbeasles.pipeline</string><key>CFBundleName</key><string>Pipeline</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>LSMinimumSystemVersion</key><string>14.0</string><key>LSUIElement</key><true/><key>NSHighResolutionCapable</key><true/></dict></plist>`,
);
await writeFile(
  join(app, "Contents/Resources/bridge.json"),
  JSON.stringify({
    node: await realpath(process.execPath),
    script: join(settings.managed, "payload/pipeline/panel.ts"),
    config,
    studioScript,
    studioConfig,
  }),
);
console.log(JSON.stringify({ app, launch: ["open", app] }));
