import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { readFile, realpath, stat, access } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { status } from "./status.ts";
import { gates, decide, type Decision } from "./review.ts";
import { hash } from "./store.ts";
export async function consoleServer(work: string, port = 0) {
  work = await realpath(work);
  const token = randomBytes(32).toString("hex"),
    nonce = randomBytes(16).toString("hex");
  let origin = "";
  const dbPath = (kind: string) => {
    if (!["core", "graph"].includes(kind)) throw Error("invalid database");
    return join(work, "state", kind === "core" ? "pipeline.sqlite" : "graph.sqlite");
  };
  function rows(kind: string, table: string, offset: number, role: string) {
    if (!["jobs", "sources", "attempts"].includes(table)) throw Error("invalid table");
    const db = new DatabaseSync(dbPath(kind), { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout=1000");
      if (role && !/^[a-z][a-z0-9-]{0,47}$/.test(role)) throw Error("invalid stage filter");
      if (role && table !== "jobs") throw Error("stage filter applies to jobs");
      return db
        .prepare(
          `SELECT * FROM ${table} ${role ? "WHERE role=?" : ""} ORDER BY rowid LIMIT 50 OFFSET ?`,
        )
        .all(...(role ? [role, offset] : [offset]));
    } finally {
      db.close();
    }
  }
  async function receipt(kind: string, id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw Error("invalid job");
    const db = new DatabaseSync(dbPath(kind), { readOnly: true });
    let row;
    try {
      row = db.prepare("SELECT output,outputHash FROM jobs WHERE id=?").get(id);
    } finally {
      db.close();
    }
    if (!row?.output || !row.outputHash) throw Error("no completed receipt");
    const path = await realpath(String(row.output));
    if (!path.startsWith(work + sep)) throw Error("receipt outside work");
    if ((await stat(path)).size > 8 * 1024 * 1024)
      throw Error("receipt exceeds browser preview limit; use local artifact");
    const bytes = await readFile(path);
    if (bytes.length > 8 * 1024 * 1024) throw Error("receipt exceeds browser preview limit");
    if (hash(bytes) !== row.outputHash) throw Error("receipt integrity mismatch");
    return JSON.parse(bytes.toString("utf8"));
  }
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const json = (code: number, value: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.headers.host !== origin.slice(7)) {
        json(403, { error: "invalid Host" });
        return;
      }
      const url = new URL(req.url ?? "/", origin);
      if (req.method === "GET" && url.pathname === "/") {
        res.setHeader(
          "Content-Security-Policy",
          `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'`,
        );
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page(nonce));
        return;
      }
      if (
        req.headers.authorization !== `Bearer ${token}` ||
        (req.headers.origin && req.headers.origin !== origin)
      ) {
        json(403, { error: "console token/origin required" });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/status") {
        json(200, { status: await status(work), gates: await gates(work) });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/rows") {
        const offset = Number(url.searchParams.get("offset") ?? 0);
        if (!Number.isSafeInteger(offset) || offset < 0) throw Error("invalid offset");
        json(
          200,
          rows(
            url.searchParams.get("db") ?? "core",
            url.searchParams.get("table") ?? "jobs",
            offset,
            url.searchParams.get("role") ?? "",
          ),
        );
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/receipt") {
        json(
          200,
          await receipt(url.searchParams.get("db") ?? "core", url.searchParams.get("id") ?? ""),
        );
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/decision") {
        if (req.headers["content-type"] !== "application/json") throw Error("JSON required");
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 4096) throw Error("request too large");
        }
        const value = JSON.parse(body);
        await access(join(work, "state/review.sqlite"));
        decide(work, value.id, value.decision as Decision);
        json(200, { accepted: true });
        return;
      }
      json(404, { error: "not found" });
    } catch (e) {
      json(400, { error: e instanceof Error ? e.message : String(e) });
    }
  });
  await new Promise<void>((ok, no) => {
    server.once("error", no);
    server.listen(port, "127.0.0.1", ok);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("console address unavailable");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    server,
    url: origin + "/#" + token,
    token,
    origin,
    close: () => new Promise<void>((ok, no) => server.close((e) => (e ? no(e) : ok()))),
  };
}
function page(nonce: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Local pipeline review</title><style nonce="${nonce}">body{font:15px system-ui;margin:32px;background:#101827;color:#e5edf6}button,select{padding:8px;margin:4px;background:#233449;color:inherit;border:1px solid #54708b;border-radius:5px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#172638;padding:16px}table{border-collapse:collapse;width:100%}td,th{padding:10px;border-bottom:1px solid #34435b;text-align:left}h2{margin-top:30px}.error{color:#ffb5b5}</style></head><body><h1>Local pipeline review</h1><p>Read-only processing databases. Review actions write only the separate decision ledger. This console does not launch inference.</p><p id="error" class="error"></p><h2>Progress</h2><pre id="status"></pre><h2>Stage review</h2><div id="gates"></div><h2>Database browser</h2><label>Stage <input id="role" placeholder="all stages"></label><select id="db"><option value="core">Core</option><option value="graph">Graph</option></select><select id="table"><option>jobs</option><option>sources</option><option>attempts</option></select><button id="load">Load</button><button id="prev">Previous 50</button><button id="next">Next 50</button><p id="offset"></p><div id="rows"></div><h2>Receipt: source text and model output</h2><pre id="receipt">Select a completed job to review its attributable output.</pre><script nonce="${nonce}">
const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);let offset=0;const el=id=>document.getElementById(id);async function api(path,body){const r=await fetch(path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const value=await r.json();if(!r.ok)throw Error(value.error);return value;}async function safe(f){try{await f();el('error').textContent='';}catch(e){el('error').textContent=e.message;}}async function refresh(){const data=await api('/api/status');el('status').textContent=JSON.stringify(data.status,null,2);el('gates').replaceChildren();if(!data.gates.length){const note=document.createElement('p');note.textContent='No review gates are waiting. This running pipeline may have automatic stage progression.';el('gates').append(note);}for(const g of data.gates){const box=document.createElement('div');const label=document.createElement('p');label.textContent=g.role+' — '+g.state+(g.complete?'':' (incomplete stage)');box.append(label);if(g.state==='waiting')for(const decision of ['approve','retry','reject']){const b=document.createElement('button');b.textContent=decision;b.disabled=decision==='approve'&&!g.complete;b.onclick=()=>safe(async()=>{if(decision!=='approve'&&!confirm(decision==='retry'?'Rerun this stage and invalidate dependent results?':'Stop progression at this stage?'))return;await api('/api/decision',{id:g.id,decision});await refresh();});box.append(b);}el('gates').append(box);}}async function load(){const db=el('db').value,table=el('table').value;const rows=await api('/api/rows?db='+db+'&table='+table+'&offset='+offset+'&role='+encodeURIComponent(el('role').value));el('offset').textContent='Rows '+offset+'–'+(offset+rows.length);el('rows').replaceChildren();for(const row of rows){const box=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');summary.textContent=[row.id??row.job,row.role??row.path,row.state??''].join(' · ');pre.textContent=JSON.stringify(row,null,2);box.append(summary,pre);if(table==='jobs'&&row.output){const b=document.createElement('button');b.textContent='Review receipt';b.onclick=()=>safe(async()=>el('receipt').textContent=JSON.stringify(await api('/api/receipt?db='+db+'&id='+encodeURIComponent(row.id)),null,2));box.append(b);}el('rows').append(box);}}el('load').onclick=()=>safe(load);el('prev').onclick=()=>{offset=Math.max(0,offset-50);safe(load);};el('next').onclick=()=>{offset+=50;safe(load);};for(const id of ['db','table'])el(id).onchange=()=>{offset=0;safe(load);};safe(async()=>{await refresh();await load();});setInterval(()=>safe(refresh),2000);
</script></body></html>`;
}
if (process.argv[1] === import.meta.filename) {
  const work = process.argv[2],
    port = Number(process.argv[3] ?? 8765);
  if (!work || !Number.isSafeInteger(port) || port < 0 || port > 65535)
    throw Error("Usage: node pipeline/console.ts /absolute/work [port]");
  const app = await consoleServer(resolve(work), port);
  console.log("Local review console: " + app.url);
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => app.close().then(() => process.exit(0)));
}
