/** Local, source-authored documentation pack. This does not claim historical enrichment. */
import { DatabaseSync } from "node:sqlite";
import { readFile, mkdir, opendir, lstat, realpath } from "node:fs/promises";
import { join, resolve, relative, dirname } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import { atomic, hash, publish } from "./store.ts";
import { fileHash } from "./seal.ts";
import { boundaries } from "./run.ts";
import { assertNetworkDenied } from "./sandbox.ts";
const exec = promisify(execFile);
export type Handoff = {
  untracked?: boolean;
  title: string;
  sources: { name: string; path: string }[];
  output: string;
};
type Document = {
  id: string;
  repo: string;
  path: string;
  hash: string;
  text: string;
  base64: string;
};
type Repository = {
  name: string;
  head: string | null;
  branch: string | null;
  modified: number | null;
  error: string | null;
};
const ignored = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  ".next",
  "dist",
  "build",
  "coverage",
  "target",
  "vendor",
  ".terraform",
  ".cache",
]);
const selected = (path: string) =>
  /\.(md|mdx|rst)$/i.test(path) ||
  /(^|\/)(package\.json|Dockerfile|Makefile|pyproject\.toml|Cargo\.toml|(?:docker-)?compose\.ya?ml)$/i.test(
    path,
  ) ||
  /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(path);
const escape = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
async function plan(value: Handoff, base = process.cwd()) {
  if (
    !value ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    !Array.isArray(value.sources) ||
    !value.sources.length ||
    typeof value.output !== "string" ||
    (value.untracked !== undefined && typeof value.untracked !== "boolean")
  )
    throw Error("invalid handoff configuration");
  if (
    value.sources.some(
      (s) =>
        !s ||
        typeof s.name !== "string" ||
        !/^[-a-zA-Z0-9_]+$/.test(s.name) ||
        typeof s.path !== "string",
    ) ||
    new Set(value.sources.map((s) => s.name)).size !== value.sources.length
  )
    throw Error("invalid repository identities");
  const sources = [];
  let output = resolve(base, value.output);
  for (const s of value.sources) {
    const p = await boundaries(resolve(base, s.path), output);
    if (!(await lstat(p.input)).isDirectory()) throw Error("repository directory required");
    output = p.work;
    sources.push({ ...s, path: p.input });
  }
  if (new Set(sources.map((s) => s.path)).size !== sources.length)
    throw Error("duplicate repository roots");
  return { title: value.title, sources, output, untracked: value.untracked ?? false };
}
async function* files(root: string, untracked = false, dir = root): AsyncGenerator<string> {
  if (!untracked) {
    const result = await exec(
      "/usr/bin/git",
      ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", root, "ls-files", "-z"],
      {
        timeout: 15000,
        maxBuffer: 16 * 1024 ** 2,
        env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      },
    );
    for (const name of result.stdout.split("\0").filter(Boolean).filter(selected).sort()) {
      const path = resolve(root, name);
      if (!path.startsWith(root + "/")) throw Error("invalid tracked source path");
      yield path;
    }
    return;
  }
  const entries = [];
  for await (const e of await opendir(dir)) entries.push(e);
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) {
      if (!ignored.has(e.name)) yield* files(root, true, path);
    } else if (selected(relative(root, path)) || (e.isSymbolicLink() && !ignored.has(e.name)))
      yield path;
  }
}
async function repository(name: string, path: string): Promise<Repository> {
  const git = async (args: string[]) =>
    (
      await exec(
        "/usr/bin/git",
        ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", path, ...args],
        {
          timeout: 15000,
          maxBuffer: 2 * 1024 ** 2,
          env: {
            PATH: "/usr/bin:/bin",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
          },
        },
      )
    ).stdout.trim();
  try {
    const head = await git(["rev-parse", "--verify", "HEAD"]);
    let branch: string | null = null;
    try {
      branch = await git(["symbolic-ref", "--short", "HEAD"]);
    } catch {}
    return {
      name,
      head,
      branch,
      modified: null,
      error: null,
    };
  } catch {
    return {
      name,
      head: null,
      branch: null,
      modified: null,
      error:
        "Git revision could not be verified; source documents are still preserved by their own hashes.",
    };
  }
}
function markdown(text: string) {
  let code = false;
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      out.push(code ? "</code></pre>" : "<pre><code>");
      code = !code;
      continue;
    }
    if (code) {
      out.push(escape(line) + "\n");
      continue;
    }
    const title = line.match(/^(#{1,6})\s+(.+)$/);
    if (title) {
      const n = Math.min(6, title[1]!.length + 1);
      out.push(`<h${n}>${escape(title[2]!)}</h${n}>`);
    } else if (/^\s*[-*+]\s/.test(line))
      out.push('<p class="bullet">• ' + escape(line.replace(/^\s*[-*+]\s/, "")) + "</p>");
    else if (line.trim()) out.push("<p>" + escape(line) + "</p>");
  }
  if (code) out.push("</code></pre>");
  return out.join("\n");
}
const finder = `(()=>{const input=document.getElementById("find"),status=document.getElementById("matches");const docs=[...document.querySelectorAll("details[data-doc]")].map(node=>({node,text:node.textContent.toLowerCase()}));let timer;input.addEventListener("input",()=>{clearTimeout(timer);timer=setTimeout(()=>{const q=input.value.toLowerCase().trim();let count=0;for(const d of docs){const show=!q||d.text.includes(q);d.node.hidden=!show;d.node.open=!!q&&show;if(show)count++;}for(const section of document.querySelectorAll("section[data-repo]")){section.hidden=![...section.querySelectorAll("details[data-doc]")].some(n=>!n.hidden);}status.textContent=count+" matching documents";},120);});})();`;
function header(title: string, repos: Repository[], documents: number) {
  const links = repos
    .map((r) => `<a href="#repo-${escape(r.name)}">${escape(r.name)}</a>`)
    .join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${Buffer.from(hash(finder), "hex").toString("base64")}'; base-uri 'none'; form-action 'none'"><title>${escape(title)}</title><style>html{scroll-behavior:smooth}body{margin:0;background:#f5f6f8;color:#202733;font:16px/1.6 system-ui,sans-serif}nav{position:fixed;inset:0 auto 0 0;width:235px;padding:30px 22px;background:#172238;color:#dce5f5;overflow:auto;box-sizing:border-box}nav strong{display:block;margin-bottom:18px}nav a{display:block;color:inherit;text-decoration:none;padding:7px;border-radius:6px}nav a:hover{background:#293b59}main{max-width:1000px;margin-left:235px;padding:48px}h1{font-size:36px;letter-spacing:-1px;line-height:1.2}h2{font-size:26px;margin-top:32px}h3{font-size:20px}article,.card{background:white;border:1px solid #dce2eb;border-radius:12px;padding:24px;margin:20px 0}details{margin:12px 0}summary{cursor:pointer;font-weight:600;padding:12px;background:#eff3fa;border-radius:6px}pre{overflow:auto;background:#101b2c;color:#e4edfc;padding:18px;border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere}code,small{font-family:ui-monospace,monospace}small{display:block;overflow-wrap:anywhere;color:#58677d}p{overflow-wrap:anywhere;white-space:pre-wrap}.bullet{margin:5px 0 5px 16px}.badge{display:inline-block;background:#e5ecfb;color:#284b89;border-radius:20px;padding:3px 10px;font-size:13px}a{color:#245db3}section{scroll-margin-top:28px}table{border-collapse:collapse;width:100%}td,th{text-align:left;border-bottom:1px solid #dce2eb;padding:8px;vertical-align:top;overflow-wrap:anywhere}@media(max-width:800px){nav{position:static;width:auto}main{margin:0;padding:24px}}@media(prefers-color-scheme:dark){body{background:#111820;color:#e0e6ef}article,.card{background:#1b2532;border-color:#36465c}summary{background:#28374b}small{color:#a6b7ce}a{color:#8fbaff}}@media print{nav{display:none}main{margin:0;padding:0}details>*{display:block!important}article{break-inside:avoid}}</style><nav><strong>Engineering handoff</strong><a href="#start">Start here</a>${links}</nav><main><header id="start"><span class="badge">Source-authored documentation · local snapshot</span><h1>${escape(title)}</h1><p>${repos.length} repositories · ${documents} preserved documentation/configuration records</p><p>This pack brings together existing documentation and declared configuration. It is not a completed historical analysis or a certification that deployment commands work. These are working-copy documents, untracked files are excluded unless explicitly enabled; HEAD metadata does not certify that their contents match the commit. Source text is preserved with hashes, SQLite records and JSONL mirrors. No project script was executed. Repository content may describe proposals or old behavior; check its cited revision and working-tree state.</p><p>Use the repository links and local search to find setup, deployment, operations and decisions already documented. Each document cites its repository, relative path and exact byte hash. Search expands matching document sections. All searching happens within this file; no requests are sent. The accompanying manifest records incomplete or unsupported selections.</p><label for="find"><strong>Search documentation</strong></label><input id="find" type="search" placeholder="Search setup, deployment, migrations, incidents…" style="display:block;box-sizing:border-box;width:100%;padding:14px;margin:10px 0;font:inherit;border:1px solid #8a9bb5;border-radius:8px"><p id="matches" role="status">${documents} documents available</p><p><a href="documents.jsonl">Full JSONL records</a> · <a href="documents.sqlite">SQLite lookup database</a> · <a href="report.json">Integrity and scope report</a></p></header>`;
}
export async function handoff(value: Handoff) {
  const config = await plan(value);
  await mkdir(config.output, { mode: 0o700 });
  const db = new DatabaseSync(join(config.output, "documents.sqlite"));
  let unsupported = 0,
    total = 0;
  const dispositions: {
      repo: string;
      path: string;
      state: string;
      reason?: string;
      hash?: string;
    }[] = [],
    repos: Repository[] = [];
  try {
    db.exec(
      "PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;CREATE TABLE documents(id TEXT PRIMARY KEY,repo TEXT NOT NULL,path TEXT NOT NULL,hash TEXT NOT NULL,bytes BLOB NOT NULL,body TEXT NOT NULL,digest TEXT NOT NULL);CREATE INDEX documents_repo ON documents(repo,path);",
    );
    for (const source of config.sources) {
      repos.push(await repository(source.name, source.path));
      for await (const path of files(source.path, config.untracked)) {
        const name = relative(source.path, path),
          info = await lstat(path).catch((e: NodeJS.ErrnoException) => {
            if (e.code === "ENOENT") return null;
            throw e;
          });
        if (!info) {
          unsupported++;
          dispositions.push({
            repo: source.name,
            path: name,
            state: "unsupported",
            reason: "tracked source is missing from working copy",
          });
          continue;
        }
        if (!info.isFile() || (await realpath(path)) !== path) {
          unsupported++;
          dispositions.push({
            repo: source.name,
            path: name,
            state: "unsupported",
            reason: "symlink, aliased ancestor or special file is not followed",
          });
          continue;
        }
        if (info.size > 8 * 1024 ** 2 || total + info.size > 256 * 1024 ** 2) {
          unsupported++;
          dispositions.push({
            repo: source.name,
            path: name,
            state: "unsupported",
            reason: "explicit document byte budget exceeded",
            hash: await fileHash(path),
          });
          continue;
        }
        const before = await fileHash(path),
          bytes = await readFile(path);
        if (hash(bytes) !== before) throw Error("source changed during handoff capture");
        let text: string;
        try {
          text = new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(bytes);
        } catch {
          unsupported++;
          dispositions.push({
            repo: source.name,
            path: name,
            state: "unsupported",
            reason: "invalid UTF-8 document",
            hash: before,
          });
          continue;
        }
        if (bytes.includes(0)) {
          unsupported++;
          dispositions.push({
            repo: source.name,
            path: name,
            state: "unsupported",
            reason: "binary document",
            hash: before,
          });
          continue;
        }
        const record: Document = {
          id: hash(source.name + "\0" + name),
          repo: source.name,
          path: name,
          hash: before,
          text,
          base64: bytes.toString("base64"),
        };
        const body = JSON.stringify(record);
        db.prepare("INSERT INTO documents VALUES(?,?,?,?,?,?,?)").run(
          record.id,
          record.repo,
          record.path,
          record.hash,
          bytes,
          body,
          hash(body + "\n"),
        );
        dispositions.push({ repo: source.name, path: name, state: "captured", hash: before });
        total += bytes.length;
      }
    }
    const documents = Number(db.prepare("SELECT count(*) n FROM documents").get()!.n);
    const jsonl = await publish(
      join(config.output, "documents.jsonl"),
      (function* () {
        for (const row of db.prepare("SELECT body FROM documents ORDER BY repo,path").iterate())
          yield String(row.body) + "\n";
      })(),
    );
    await publish(
      join(config.output, "dispositions.jsonl"),
      dispositions.map((r) => JSON.stringify(r) + "\n"),
    );
    const html = await publish(
      join(config.output, "index.html"),
      (function* () {
        yield header(config.title, repos, documents);
        for (const repo of repos) {
          yield `<section data-repo id="repo-${escape(repo.name)}"><h2>${escape(repo.name)}</h2><div class="card"><small>Revision: ${escape(repo.head ?? "unverified")} · Branch: ${escape(repo.branch ?? "unknown")} · Working-copy documents are individually hashed; full change counts and commit equivalence are not assessed</small>${repo.error ? "<p>" + escape(repo.error) + "</p>" : ""}<h3>Declared scripts</h3>`;
          const packages = db
            .prepare(
              "SELECT body FROM documents WHERE repo=? AND (path='package.json' OR path LIKE '%/package.json') ORDER BY path",
            )
            .all(repo.name);
          let scripts = 0;
          for (const row of packages) {
            const doc = JSON.parse(String(row.body)) as Document;
            let pkg: Record<string, unknown>;
            try {
              pkg = JSON.parse(doc.text);
              if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) continue;
            } catch {
              continue;
            }
            if (pkg.scripts && typeof pkg.scripts === "object" && !Array.isArray(pkg.scripts)) {
              yield "<p>" +
                escape(doc.path) +
                " — configuration only; not executed</p><table><tr><th>Script</th><th>Declared command</th></tr>";
              for (const [name, command] of Object.entries(pkg.scripts)) {
                if (typeof command === "string") {
                  scripts++;
                  yield "<tr><td>" +
                    escape(name) +
                    "</td><td><code>" +
                    escape(command) +
                    "</code></td></tr>";
                }
              }
              yield "</table>";
            }
            for (const kind of [
              "dependencies",
              "devDependencies",
              "peerDependencies",
              "optionalDependencies",
            ]) {
              const deps = pkg[kind];
              if (!deps || typeof deps !== "object" || Array.isArray(deps)) continue;
              yield "<h3>Declared dependencies</h3><small>" +
                escape(doc.path) +
                " · " +
                escape(kind) +
                "</small><table><tr><th>Package</th><th>Declared version</th></tr>";
              for (const [name, version] of Object.entries(deps)) {
                if (typeof version === "string")
                  yield "<tr><td>" + escape(name) + "</td><td>" + escape(version) + "</td></tr>";
              }
              yield "</table>";
            }
          }
          if (!scripts)
            yield "<p>No package scripts were captured. Consult the source-authored documents below.</p>";
          yield "</div>";
          const starts = db
            .prepare(
              "SELECT id,path FROM documents WHERE repo=? ORDER BY CASE WHEN lower(path)='readme.md' THEN 0 ELSE 1 END,path",
            )
            .all(repo.name)
            .filter((r) =>
              /(^|\/)(readme[^/]*|[^/]*(architecture|runbook|deploy|onboard|setup|decision|operations|handoff)[^/]*)\.(md|mdx|rst)$/i.test(
                String(r.path),
              ),
            )
            .slice(0, 12);
          yield '<div class="card"><h3>Starting points</h3>';
          if (starts.length) {
            yield "<ul>";
            for (const row of starts)
              yield '<li><a href="#document-' +
                String(row.id) +
                '">' +
                escape(String(row.path)) +
                "</a></li>";
            yield "</ul>";
          } else
            yield "<p>No README or filename-matched operating guide was captured. Review the configuration records below and record the missing operating knowledge.</p>";
          yield "</div>";
          for (const row of db
            .prepare("SELECT body FROM documents WHERE repo=? ORDER BY path")
            .iterate(repo.name)) {
            const doc = JSON.parse(String(row.body)) as Document;
            yield `<details data-doc id="document-${doc.id}"><summary>${escape(doc.path)}</summary><article><small>Evidence: ${escape(doc.repo + "/" + doc.path)}<br>SHA-256 ${doc.hash}</small>${/\.(md|mdx|rst)$/i.test(doc.path) ? markdown(doc.text) : "<pre><code>" + escape(doc.text) + "</code></pre>"}</article></details>`;
          }
          yield "</section>";
        }
        yield `<footer><p>Coverage: selected existing documentation, package manifests, Docker/compose definitions, Makefiles and CI workflows. General source code, Git history, Slack, Jira and Confluence history are not analyzed by this pack. Their collection and enrichment remain separate.</p></footer><script>${finder}</script></main></html>`;
      })(),
    );
    for (const source of config.sources) {
      const before = new Set(dispositions.filter((d) => d.repo === source.name).map((d) => d.path));
      for await (const path of files(source.path, config.untracked)) {
        if (!before.delete(relative(source.path, path)))
          throw Error("source inventory changed during handoff");
      }
      if (before.size) throw Error("source inventory changed during handoff");
    }
    for (const row of db.prepare("SELECT repo,path,hash FROM documents").iterate()) {
      const source = config.sources.find((s) => s.name === row.repo)!;
      if (
        (await realpath(join(source.path, String(row.path)))) !==
          join(source.path, String(row.path)) ||
        (await fileHash(join(source.path, String(row.path)))) !== row.hash
      )
        throw Error("source changed before handoff certification");
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);PRAGMA journal_mode=DELETE");
    await atomic(join(config.output, "manifest.json"), {
      format: "engineering-handoff/1",
      method: "deterministic source-document aggregation",
      modelCalls: 0,
      title: config.title,
      repositories: repos,
      documents,
      bytes: total,
      unsupported,
      complete: unsupported === 0,
      jsonl,
      html,
      selection: {
        untracked: config.untracked,
        extensions: ["md", "mdx", "rst"],
        configurations: [
          "package.json",
          "Dockerfile",
          "Makefile",
          "pyproject.toml",
          "Cargo.toml",
          "compose YAML",
          "GitHub workflows",
        ],
        excludedDirectories: config.untracked ? [...ignored].sort() : [],
        maxFileBytes: 8 * 1024 ** 2,
        maxTotalBytes: 256 * 1024 ** 2,
      },
      scope:
        "Existing source-authored documentation and declared configuration only; no historical or full-code analysis",
      created: new Date().toISOString(),
    });
    const report = await verifyHandoff(config.output);
    await atomic(join(config.output, "report.json"), report);
    return report;
  } catch (e) {
    await atomic(join(config.output, "report.json"), {
      integrity: false,
      error: e instanceof Error ? e.message : "handoff failed",
    });
    throw e;
  } finally {
    db.close();
  }
}
export async function verifyHandoff(output: string) {
  const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8")) as {
    documents: number;
    bytes: number;
    unsupported: number;
    complete: boolean;
    jsonl: string;
    html: string;
  };
  if (
    !Number.isSafeInteger(manifest.documents) ||
    manifest.documents < 0 ||
    !Number.isSafeInteger(manifest.unsupported) ||
    manifest.unsupported < 0 ||
    manifest.complete !== (manifest.unsupported === 0)
  )
    throw Error("invalid handoff integrity manifest");
  if (
    (await fileHash(join(output, "documents.jsonl"))) !== manifest.jsonl ||
    (await fileHash(join(output, "index.html"))) !== manifest.html
  )
    throw Error("handoff artifact hash mismatch");
  const db = new DatabaseSync(join(output, "documents.sqlite"), { readOnly: true });
  try {
    const seen = new Set<string>();
    for await (const line of createInterface({
      input: createReadStream(join(output, "documents.jsonl")),
      crlfDelay: Infinity,
    })) {
      const r = JSON.parse(line) as Document;
      if (seen.has(r.id)) throw Error("duplicate mirror record");
      seen.add(r.id);
      const row = db.prepare("SELECT body,bytes,digest FROM documents WHERE id=?").get(r.id);
      const bytes = Buffer.from(r.base64, "base64");
      if (
        !row ||
        row.body !== line ||
        row.digest !== hash(line + "\n") ||
        hash(bytes) !== r.hash ||
        !Buffer.from(row.bytes as Uint8Array).equals(bytes) ||
        !Buffer.from(r.text, "utf8").equals(bytes)
      )
        throw Error("handoff record integrity mismatch");
    }
    if (
      seen.size !== manifest.documents ||
      seen.size !== Number(db.prepare("SELECT count(*) n FROM documents").get()!.n)
    )
      throw Error("handoff source coverage mismatch");
    return {
      integrity: true,
      documents: seen.size,
      bytes: manifest.bytes,
      unsupported: manifest.unsupported,
      complete: manifest.complete,
      scope:
        "Preserved selected documentation/configuration; historical enrichment and general source-code analysis are not certified",
      entry: "index.html",
    };
  } finally {
    db.close();
  }
}
if (process.argv[1] === import.meta.filename) {
  try {
    const inside = process.argv[2] === "--inside",
      arg = process.argv[inside ? 3 : 2];
    if (!arg) throw Error("Usage: node pipeline/handoff.ts CONFIG.json | --verify OUTPUT");
    if (process.argv[2] === "--verify")
      console.log(JSON.stringify(await verifyHandoff(resolve(process.argv[3]!))));
    else {
      const config = await plan(
        JSON.parse(await readFile(resolve(arg), "utf8")) as Handoff,
        dirname(resolve(arg)),
      );
      if (inside) {
        await assertNetworkDenied();
        console.log(JSON.stringify(await handoff(config)));
      } else {
        const policy =
          `(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (literal "/dev/null"))(allow file-write* (subpath ${JSON.stringify(config.output)}))` +
          config.sources
            .map((s) => `(deny file-write* (subpath ${JSON.stringify(s.path)}))`)
            .join("");
        const child = spawn(
          "/usr/bin/sandbox-exec",
          ["-p", policy, process.execPath, import.meta.filename, "--inside", resolve(arg)],
          {
            stdio: "inherit",
            env: {
              PATH: "/usr/bin:/bin",
              HOME: config.output,
              TMPDIR: config.output,
              NODE_DISABLE_COMPILE_CACHE: "1",
            },
          },
        );
        process.exitCode = await new Promise<number>((ok, no) => {
          child.once("error", no);
          child.once("exit", (c) => ok(c ?? 1));
        });
      }
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : "handoff failed");
    process.exitCode = 1;
  }
}
