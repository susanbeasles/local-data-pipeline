import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
const config = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw Error("Usage: node native/build.ts /absolute/panel.json");
const settings = JSON.parse(await readFile(config, "utf8"));
if (!settings.managed) throw Error("Prepare the managed instance before building the app");
const root = resolve(import.meta.dirname, ".."),
  app = join(root, "dist/Pipeline.app");
await mkdir(join(app, "Contents/MacOS"), { recursive: true });
await mkdir(join(app, "Contents/Resources"), { recursive: true });
await promisify(execFile)("/usr/bin/swiftc", [
  "-parse-as-library",
  "-target",
  "arm64-apple-macosx14.0",
  join(root, "native/Pipeline.swift"),
  "-o",
  join(app, "Contents/MacOS/Pipeline"),
]);
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
  }),
);
console.log(JSON.stringify({ app, launch: ["open", app] }));
