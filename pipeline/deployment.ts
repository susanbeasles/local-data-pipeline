import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configuration, type Receipt } from "./provision.ts";
const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const digest = (v: string) => /^[a-f0-9]{64}$/.test(v);
const encode = (v: unknown) => JSON.stringify(v) + "\n";
const limit = 32 * 1024 * 1024;
const code =
  /^(pipeline\/(legacy\/)?[a-z0-9-]+\.(ts|py|c|sql)|config\/residency\.json|native\/(tests\/(TerminalPTY\/)?[A-Za-z0-9]+\.swift|pty\/(pty\.c|include\/CPty\.h)|Package\.resolved|[A-Za-z0-9]+\.(swift|ts))|package(-lock)?\.json)$/;
type Resource = "pipeline.executor" | "pipeline.control" | "pipeline.metadata";
type Source = {
  format: "pipeline-source/1";
  files: { path: string; sha256: string; base64: string }[];
};
export type Deployment = {
  format: "pipeline-deployment/1";
  infrastructure: { repository: "susanbeasles/infra"; revision: string; spec: string };
  bundles: { resource: Resource; kind: "source"; file: string; sha256: string }[];
  activation: { receipt: true; vm: true; backend: true; controlBuild: true };
};
export type Qualification = {
  format: "pipeline-qualification/1";
  deployment: string;
  receipt: string;
  vm: boolean;
  backend: boolean;
  controlBuild: boolean;
};
async function bytes(path: string) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * limit)
    throw Error("Bounded regular file required");
  const data = await readFile(path);
  if (data.length > 2 * limit) throw Error("Byte bound exceeded");
  return data;
}
async function source(root: string, paths: string[]): Promise<Source> {
  const files: Source["files"] = [];
  let size = 0;
  for (const path of paths.sort()) {
    if (!code.test(path)) throw Error("Non-code source forbidden");
    const data = await bytes(join(root, path));
    size += data.length;
    if (size > limit) throw Error("Bundle byte bound exceeded");
    files.push({ path, sha256: hash(data), base64: data.toString("base64") });
  }
  return { format: "pipeline-source/1", files };
}
/** Deterministic source handoff. Never installs, boots, compiles, or claims runtime readiness. */
export class DeploymentBundle {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  static async create(sourceRoot: string, releases: string, revision: string, specPath: string) {
    if (!/^[a-f0-9]{40}$/.test(revision)) throw Error("Full infrastructure commit required");
    for (const name of ["pipeline", "native"]) {
      const stat = await lstat(join(sourceRoot, name));
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw Error("Code directory aliases forbidden");
    }
    const specBytes = await bytes(specPath),
      spec = JSON.parse(specBytes.toString());
    if (
      spec.format !== "pipeline-local/1" ||
      spec.repository !== "susanbeasles/infra" ||
      spec.activation?.requiresInfraReceipt !== true ||
      spec.activation?.requiresQualification !== true
    )
      throw Error("Infrastructure-first specification required");
    const pipeline = (await readdir(join(sourceRoot, "pipeline")))
      .filter((n) => /^[a-z0-9-]+\.(ts|py|c|sql)$/.test(n))
      .map((n) => "pipeline/" + n);
    const native = (await readdir(join(sourceRoot, "native")))
      .filter((n) => /^[A-Za-z0-9]+\.(swift|ts)$/.test(n) || n === "Package.resolved")
      .map((n) => "native/" + n);
    if (native.includes("native/Package.swift")) {
      for (const path of ["native/Package.resolved","native/pty/pty.c","native/pty/include/CPty.h","native/tests/TerminalPTY/PTYTests.swift","native/tests/UsageTest.swift","native/tests/JsonTest.swift"]) {
        await bytes(join(sourceRoot,path));
        if (!native.includes(path)) native.push(path);
      }
    }
    const legacy = join(sourceRoot, "pipeline", "legacy");
    try {
      const stat = await lstat(legacy);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Legacy aliases forbidden");
      pipeline.push(...(await readdir(legacy)).filter(n => /^[a-z0-9-]+\.(ts|py|c|sql)$/.test(n)).map(n => "pipeline/legacy/" + n));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await bytes(join(sourceRoot, "config/residency.json"));
      pipeline.push("config/residency.json");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!pipeline.length || !native.length) throw Error("Executor and control sources required");
    const groups: [Resource, string[]][] = [
      ["pipeline.executor", [...pipeline, "package.json", "package-lock.json"]],
      ["pipeline.control", native],
      ["pipeline.metadata", ["pipeline/guest-postgres.ts", "package.json", "package-lock.json"]],
    ];
    const payloads = new Map<string, string>(),
      bundles: Deployment["bundles"] = [];
    for (const [resource, paths] of groups) {
      const payload = encode(await source(sourceRoot, paths)),
        sha256 = hash(payload),
        file = sha256 + ".json";
      payloads.set(file, payload);
      bundles.push({ resource, kind: "source", file, sha256 });
    }
    const manifest: Deployment = {
      format: "pipeline-deployment/1",
      infrastructure: { repository: "susanbeasles/infra", revision, spec: hash(specBytes) },
      bundles,
      activation: { receipt: true, vm: true, backend: true, controlBuild: true },
    };
    // Reject mixed snapshots if an editor changes source while bundles are composed.
    for (const payload of payloads.values())
      for (const file of (JSON.parse(payload) as Source).files) {
        if (hash(await bytes(join(sourceRoot, file.path))) !== file.sha256)
          throw Error("Source changed during composition");
      }
    const content = encode(manifest),
      id = hash(content),
      root = join(releases, id);
    await mkdir(releases, { recursive: true });
    let exists = false;
    try {
      await lstat(root);
      exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (exists) {
      const result = new DeploymentBundle(root);
      await result.verify();
      return result;
    }
    const temp = join(
      releases,
      "." + id + "-" + process.pid + "-" + Math.random().toString(16).slice(2),
    );
    await mkdir(temp);
    try {
      for (const [file, payload] of payloads)
        await writeFile(join(temp, file), payload, { flag: "wx", mode: 0o444 });
      await writeFile(join(temp, "targets.json"), specBytes, { flag: "wx", mode: 0o444 });
      await writeFile(join(temp, "deployment.json"), content, { flag: "wx", mode: 0o444 });
      try {
        await rename(temp, root);
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
          throw error;
      }
      const result = new DeploymentBundle(root);
      await result.verify();
      return result;
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
  async verify(): Promise<{ hash: string; manifest: Deployment }> {
    if ((await lstat(this.root)).isSymbolicLink()) throw Error("Deployment aliases forbidden");
    const raw = await bytes(join(this.root, "deployment.json")),
      manifest = JSON.parse(raw.toString()) as Deployment,
      id = hash(raw);
    if (
      this.root.split("/").at(-1) !== id ||
      manifest.format !== "pipeline-deployment/1" ||
      manifest.infrastructure.repository !== "susanbeasles/infra" ||
      !/^[a-f0-9]{40}$/.test(manifest.infrastructure.revision) ||
      !digest(manifest.infrastructure.spec) ||
      hash(await bytes(join(this.root, "targets.json"))) !== manifest.infrastructure.spec ||
      configuration(manifest.activation) !==
        configuration({ receipt: true, vm: true, backend: true, controlBuild: true })
    )
      throw Error("Deployment integrity mismatch");
    if (
      manifest.bundles.length !== 3 ||
      new Set(manifest.bundles.map((b) => b.resource)).size !== 3
    )
      throw Error("Resource mapping incomplete");
    const shared = new Map<string, string>();
    for (const b of manifest.bundles) {
      if (
        !["pipeline.executor", "pipeline.control", "pipeline.metadata"].includes(b.resource) ||
        b.kind !== "source" ||
        !digest(b.sha256) ||
        b.file !== b.sha256 + ".json"
      )
        throw Error("Invalid bundle mapping");
      const raw = await bytes(join(this.root, b.file));
      if (hash(raw) !== b.sha256) throw Error("Bundle integrity mismatch");
      const bundle = JSON.parse(raw.toString()) as Source;
      if (
        bundle.format !== "pipeline-source/1" ||
        !Array.isArray(bundle.files) ||
        !bundle.files.length
      )
        throw Error("Invalid source bundle");
      const names = new Set<string>();
      let size = 0;
      for (const f of bundle.files) {
        if (!code.test(f.path) || names.has(f.path)) throw Error("Invalid source path");
        if (shared.has(f.path) && shared.get(f.path) !== f.sha256)
          throw Error("Incoherent source snapshot");
        shared.set(f.path, f.sha256);
        names.add(f.path);
        const data = Buffer.from(f.base64, "base64");
        size += data.length;
        if (size > limit || data.toString("base64") !== f.base64 || hash(data) !== f.sha256)
          throw Error("Source integrity mismatch");
      }
    }
    const expected = [
      ...new Set(["deployment.json", "targets.json", ...manifest.bundles.map((b) => b.file)]),
    ].sort();
    if (JSON.stringify((await readdir(this.root)).sort()) !== JSON.stringify(expected))
      throw Error("Unexpected deployment files");
    return { hash: id, manifest };
  }
  async activate(receipt: Receipt, qualification: Qualification) {
    const deployment = await this.verify();
    if (
      receipt.format !== "pipeline-infra-receipt/1" ||
      receipt.spec !== deployment.manifest.infrastructure.spec ||
      !receipt.request ||
      !Array.isArray(receipt.resources)
    )
      throw Error("Infrastructure receipt mismatch");
    for (const resource of [
      "pipeline.storage",
      "pipeline.executor",
      "pipeline.control",
      "pipeline.metadata",
    ]) {
      const rows = receipt.resources.filter((r) => r.id === resource);
      if (rows.length !== 1 || !rows[0].identity || !digest(rows[0].configuration))
        throw Error("Incomplete infrastructure receipt");
    }
    if (
      qualification.format !== "pipeline-qualification/1" ||
      qualification.deployment !== deployment.hash ||
      qualification.receipt !== configuration(receipt) ||
      qualification.vm !== true ||
      qualification.backend !== true ||
      qualification.controlBuild !== true
    )
      throw Error("Deployment-bound VM/backend/control qualification required");
    return {
      deployment: deployment.hash,
      receipt: configuration(receipt),
      qualified: true as const,
    };
  }
}
