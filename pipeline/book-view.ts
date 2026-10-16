/** Portable book rendering. Generated prose and all source text are HTML escaped. */
import { join } from "node:path";
import { atomic, hash } from "./store.ts";
import { fileHash } from "./seal.ts";
import type { Packet, Draft } from "./book-data.ts";
export const escape = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const search = `(()=>{const q=document.getElementById('find'),rows=[...document.querySelectorAll('[data-page]')],n=document.getElementById('matches');if(!q)return;q.addEventListener('input',()=>{let found=0;const words=q.value.toLowerCase().trim().split(/\\s+/).filter(Boolean);for(const row of rows){row.hidden=!words.every(w=>row.textContent.toLowerCase().includes(w));if(!row.hidden)found++;}n.textContent=found+' matching chapters';});})();`;
function shell(title: string, nav: string, body: string) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${Buffer.from(hash(search), "hex").toString("base64")}'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'"><title>${escape(title)}</title><style>:root{color-scheme:light dark;font:17px/1.65 system-ui;background:#11191e;color:#e0e9eb}*{box-sizing:border-box}body{margin:0}a{color:#79d4c5}nav{position:fixed;inset:0 auto 0 0;width:260px;padding:36px 24px;overflow:auto;background:#18242b}nav a{display:block;padding:8px 0}main{max-width:1150px;margin-left:260px;padding:64px 64px 100px}h1{font-size:2.5rem;line-height:1.15}h2{margin-top:2.4rem}h3{margin-top:1.6rem}p{max-width:78ch}.label,small{font-size:.8rem;color:#b2c2c9}.notice{padding:18px 22px;border-left:3px solid #d9aa60;background:#263039;margin:24px 0}.card{border:1px solid #34454e;border-radius:12px;padding:20px;margin:20px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 ui-monospace,monospace;background:#0c1216;padding:20px}input{width:100%;padding:15px;font:inherit;background:#1c2b33;color:inherit;border:1px solid #45616c;border-radius:9px}blockquote{border-left:2px solid #618c91;padding-left:18px;margin-left:0;color:#b7cdd2}li{margin:8px 0}details{margin:18px 0}summary{cursor:pointer}code{overflow-wrap:anywhere}[hidden]{display:none!important}@media(max-width:800px){nav{position:static;width:auto}main{margin:0;padding:32px 24px}}</style><nav><strong>Engineering handbook</strong><a href="index.html">Search &amp; contents</a>${nav}</nav><main>${body}</main><script>${search}</script></html>`;
}
export type Chapter = { packet: Packet; draft?: Draft; state: string };
export async function renderBook(
  site: string,
  title: string,
  chapters: Chapter[],
  coverage: unknown,
) {
  const nav = chapters
    .map((c) => `<a href="${c.packet.topic.id}.html">${escape(c.packet.topic.title)}</a>`)
    .join("");
  const artifacts: Record<string, string> = {};
  const put = async (name: string, text: string) => {
    await atomic(join(site, name), text, true);
    artifacts[name] = await fileHash(join(site, name));
  };
  const searchCards: string[] = [];
  for (const c of chapters) {
    const { packet, draft } = c,
      t = packet.topic;
    const intro = `<p class="label">${escape(title)} · ${escape(c.state)}</p><h1>${escape(t.title)}</h1><p>${t.keywords.map(escape).join(" · ")}</p><div class="notice"><strong>${draft ? "Model draft — factual interpretation needs review." : "Evidence gap — chapter not drafted."}</strong><br>Quotation checks verify cited text exists. They do not establish that the interpretation is correct or deployed.</div><h2>Questions this chapter must answer</h2><ul>${t.questions.map((q) => "<li>" + escape(q) + "</li>").join("")}</ul>`;
    let prose = "",
      plain = "";
    for (const section of draft?.sections ?? []) {
      prose += "<h2>" + escape(section.heading) + "</h2>";
      for (const p of section.paragraphs) {
        plain += " " + p.text;
        prose +=
          "<p>" +
          escape(p.text) +
          '</p><p class="label">' +
          escape(p.status) +
          " · " +
          p.citations
            .map((r, i) => `<a href="#source-${r.id}">[${i + 1}] ${escape(r.id)}</a>`)
            .join(" · ") +
          "</p>";
        for (const r of p.citations) prose += "<blockquote>" + escape(r.quote) + "</blockquote>";
      }
    }
    const gaps = draft?.unknowns ?? [
      packet.evidence.length
        ? "Authoring is pending."
        : "No matching evidence was found in the registered source snapshot.",
    ];
    prose +=
      "<h2>Unresolved questions</h2><ul>" +
      gaps.map((g) => "<li>" + escape(g) + "</li>").join("") +
      "</ul>";
    prose += `<h2>Evidence and scope</h2><p>${packet.scope.selected} excerpts selected from ${packet.scope.matched} matching records; ${packet.scope.omitted} matching records are outside this chapter context. Retrieval uses keywords, not exhaustive dependency analysis. No search match is not proof of absence.</p>`;
    for (const e of packet.evidence)
      prose += `<details id="source-${e.id}"><summary>${escape(e.origin.name + " / " + e.origin.path)} · ${escape(e.id)}</summary><small>Record ${escape(e.origin.record)} · original hash ${e.origin.hash}<br>Excerpt hash ${e.hash} · offsets ${e.start}–${e.end}${e.origin.pointer ? " · JSON pointer " + escape(e.origin.pointer) : ""}</small><pre>${escape(e.text)}</pre></details>`;
    if (t.related.length)
      prose +=
        "<h2>Related chapters</h2><ul>" +
        t.related
          .map(
            (id) =>
              '<li><a href="' +
              id +
              '.html">' +
              escape(chapters.find((x) => x.packet.topic.id === id)!.packet.topic.title) +
              "</a></li>",
          )
          .join("") +
        "</ul>";
    await put(t.id + ".html", shell(t.title, nav, intro + prose));
    searchCards.push(
      `<article class="card" data-page><h2><a href="${t.id}.html">${escape(t.title)}</a></h2><p class="label">${escape(c.state)} · ${t.keywords.map(escape).join(" · ")}</p><p>${t.questions.map(escape).join(" ")}</p><details><summary>Searchable chapter text</summary><p>${escape(plain)}</p><p>${packet.evidence.map((e) => escape(e.text)).join(" ")}</p></details></article>`,
    );
  }
  await put(
    "index.html",
    shell(
      title,
      nav,
      `<p class="label">Local, source-linked engineering knowledge</p><h1>${escape(title)}</h1><div class="notice">This edition contains model drafts and explicit gaps. It is not a verified description of all deployed systems. The source snapshot and retrieval scope are recorded below. Keep this company data local.</div><label for="find">Search questions, keywords, explanations and captured evidence</label><input id="find" type="search" placeholder="consent, usertags, Ansible, CloudWatch, Iterable…"><p id="matches" class="label">${chapters.length} chapters</p>${searchCards.join("")}<h2>Collection snapshot</h2><p>Collection job counts are recorded, not certified as all-time provider coverage. Pending or failed source collection remains a gap.</p><pre>${escape(JSON.stringify(coverage, null, 2))}</pre>`,
    ),
  );
  return artifacts;
}
