import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawnSync } from "node:child_process";
import { Sessions, assist, type Session } from "../sessions.ts";

async function fixture(
  t: test.TestContext,
  options:
    | ConstructorParameters<typeof Sessions>[2]
    | ((root: string) => ConstructorParameters<typeof Sessions>[2]) = {},
) {
  const root = await mkdtemp(join(tmpdir(), "sessions-"));
  const priorHome = process.env.CODEX_HOME;
  const home = join(root, "user-codex");
  await mkdir(join(home, "sessions"), { recursive: true });
  await mkdir(join(home, "rules"));
  await writeFile(join(home, "config.toml"), 'approval_policy="on-request"\n');
  await writeFile(
    join(home, "rules", "guard.rules"),
    'prefix_rule(pattern=["rm"], decision="forbidden")\n',
  );
  await writeFile(join(home, "sessions", "old.jsonl"), "GLOBAL ROLLOUT SECRET");
  await writeFile(join(root, "secret.txt"), "PROTECTED SOURCE SECRET");
  process.env.CODEX_HOME = home;
  const executable = join(root, "codex");
  await writeFile(
    executable,
    `#!${process.execPath}
import {readFileSync,writeFileSync} from 'node:fs';
if(process.argv.includes('--help')) {console.log('exec --json --sandbox --skip-git-repo-check resume fork');process.exit(0)}
if(process.argv.includes('mcp')) {console.log(JSON.stringify([{name:'external',enabled:!process.argv.some(a=>a.includes('mcp_servers.')&&a.endsWith('.enabled=false')),transport:{token:'DO NOT LEAK'}}]));process.exit(0)}
let prompt='';for await(const bytes of process.stdin)prompt+=bytes;
writeFileSync('invocation.json',JSON.stringify({args:process.argv.slice(2),prompt,cwd:process.cwd(),home:process.env.CODEX_HOME}));
if(prompt.includes('READ_ESCAPE')){for(const [label,path] of [['source',${JSON.stringify(join(root, "secret.txt"))}],['history',${JSON.stringify(join(home, "sessions", "old.jsonl"))}]]){try{const value=readFileSync(path,'utf8');console.log(JSON.stringify({type:'read_escape',label,value}))}catch{console.log(JSON.stringify({type:'read_escape',label,blocked:true}))}}}
if(prompt.includes('ESCAPE')){try{writeFileSync(${JSON.stringify(join(root, "source.txt"))},'CHANGED');console.log(JSON.stringify({type:'escape',allowed:true}))}catch{console.log(JSON.stringify({type:'escape',allowed:false}))}}
if(prompt.includes('MALFORMED')){console.log('null');console.log('plain output');console.log('[]')}
const resume=process.argv.includes('resume'),fork=process.argv.includes('fork');
console.log(JSON.stringify({type:'thread.started',thread_id:resume?'fixture-thread':fork?'fixture-branch':'fixture-thread'}));
if(prompt.includes('HOSTILE')){process.on('SIGTERM',()=>{});if(prompt.includes('FLOOD'))console.log('x'.repeat(200000));setInterval(()=>{},1000)}
else if(prompt.includes('FLOOD')){console.log('x'.repeat(200000))}
else if(prompt.includes('HANG')){setInterval(()=>{},1000)}else{
await new Promise(r=>setTimeout(r,80));
console.error('fixture stderr');
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:prompt.includes('Summarize')?'Scoped summary.':'Fixture answer.'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:5}}));
}
`,
    { mode: 0o700 },
  );
  const sessions = new Sessions(
    join(root, "state"),
    [{ id: "codex", executable }],
    typeof options === "function" ? options(root) : options,
  );
  t.after(async () => {
    for (const session of await sessions.list()) await sessions.stop(session.id);
    await rm(root, { recursive: true, force: true });
    if (priorHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = priorHome;
  });
  return { root, executable, sessions, home };
}

async function finish(sessions: Sessions, id: string): Promise<Session> {
  for (let n = 0; n < 120; n++) {
    const { session } = await sessions.snapshot(id);
    if (!["starting", "running"].includes(session.status)) return session;
    await delay(25);
  }
  throw Error("fixture session timed out");
}

test("field assistance sends bounded operational metadata and exactly three scoped suggestions", () => {
  const packet = assist({
    project: "Studio",
    purpose: "Local ETL",
    dataset: "demo",
    run: "run-7",
    field: "files",
    value: 12,
    definition: "Registered source files",
    observedAt: "2026-10-14T12:00:00Z",
    provenance: { source: "SQLite", location: "sources/count" },
    controls: ["Refresh"],
    raw: "PRIVATE RECORD",
    history: "PRIVATE HISTORY",
  } as Parameters<typeof assist>[0]);
  assert.equal(packet.suggestions.length, 3);
  assert.match(packet.prompt, /files/);
  assert.match(packet.prompt, /run-7/);
  assert.match(packet.prompt, /why/i);
  assert.match(packet.prompt, /fix/i);
  assert.doesNotMatch(packet.prompt, /PRIVATE/);
  assert.ok(Buffer.byteLength(packet.prompt) < 12_288);
  assert.throws(
    () => assist({ project: "x", field: "y", value: { text: "raw" }, definition: "z" }),
    /scalar|metadata/,
  );
});

test("providers report missing binaries without installation or model calls", async (t) => {
  const { root, executable } = await fixture(t);
  const sessions = new Sessions(join(root, "status"), [
    { id: "codex", executable },
    { id: "claude", executable: join(root, "absent") },
  ]);
  const available = await sessions.available();
  assert.equal(available.find((p) => p.id === "codex")?.available, true);
  assert.equal(available.find((p) => p.id === "claude")?.available, false);
  await assert.rejects(
    sessions.start({ provider: "claude", kind: "help", prompt: "Hello" }),
    /unavailable/,
  );
});

test("detached sessions durably stream events, retain provider IDs, and resume with stdin", async (t) => {
  const { sessions, root, executable } = await fixture(t);
  const session = await sessions.start({
    provider: "codex",
    kind: "help",
    prompt: "Explain count",
  });
  const done = await finish(sessions, session.id);
  assert.equal(done.status, "idle");
  assert.equal(done.providerSession, "fixture-thread");
  const view = await sessions.snapshot(session.id);
  assert.ok(view.events.some((e) => e.type === "provider"));
  assert.ok(view.messages.some((m) => m.role === "assistant" && m.text === "Fixture answer."));
  const empty = await sessions.snapshot(session.id, view.offset);
  assert.equal(empty.events.length, 0);
  const reopened = new Sessions(join(root, "state"), [{ id: "codex", executable }]);
  await reopened.send(session.id, "Why?");
  assert.equal((await finish(reopened, session.id)).turn, 2);
  const args = JSON.parse(await readFile(join(done.workspace, "invocation.json"), "utf8"));
  assert.ok(args.args.includes("resume"));
  assert.ok(args.args.includes("fixture-thread"));
  assert.ok(args.args.includes("read-only"));
  assert.ok(args.args.includes("-"));
  assert.doesNotMatch(JSON.stringify(args.args), /Why\?/);
  assert.match(args.prompt, /Why\?/);
});

test("collection workspaces are separate and use confined provider writes", async (t) => {
  const { sessions } = await fixture(t);
  const a = await sessions.start({
    provider: "codex",
    kind: "collection",
    prompt: "Collect synthetic examples",
  });
  const b = await sessions.start({
    provider: "codex",
    kind: "help",
    prompt: "Explain synthetic count",
  });
  await Promise.all([finish(sessions, a.id), finish(sessions, b.id)]);
  assert.notEqual(a.workspace, b.workspace);
  const invocation = JSON.parse(await readFile(join(a.workspace, "invocation.json"), "utf8"));
  assert.ok(invocation.args.includes("workspace-write"));
  assert.ok(invocation.args.includes("sandbox_workspace_write.writable_roots=[]"));
  assert.ok(
    !invocation.args.some((arg: string) => arg.includes("dangerously") || arg.includes("ignore-")),
  );
});

test("busy turns reject overlap and hanging workers stop with visible final state", async (t) => {
  const { sessions } = await fixture(t);
  const session = await sessions.start({ provider: "codex", kind: "collection", prompt: "HANG" });
  await assert.rejects(sessions.send(session.id, "overlap"), /busy|running/);
  await delay(120);
  const running = (await sessions.snapshot(session.id)).session;
  assert.ok(running.pid);
  await sessions.stop(session.id);
  assert.equal((await sessions.snapshot(session.id)).session.status, "stopped");
});

test("reset, provider branch, transcript rewind and generated compaction preserve parent", async (t) => {
  const { sessions } = await fixture(t);
  const parent = await sessions.start({
    provider: "codex",
    kind: "help",
    prompt: "Explain count",
    context: { field: "count" },
  });
  await finish(sessions, parent.id);
  const reset = await sessions.reset(parent.id);
  await finish(sessions, reset.id);
  assert.notEqual(reset.workspace, parent.workspace);
  assert.equal(reset.parent, parent.id);
  const branch = await sessions.branch(parent.id, "Another approach");
  await finish(sessions, branch.id);
  const invocation = JSON.parse(await readFile(join(branch.workspace, "invocation.json"), "utf8"));
  assert.ok(invocation.args.includes("fork"));
  const rewind = await sessions.rewind(parent.id, 1);
  await finish(sessions, rewind.id);
  const compact = await sessions.compact(parent.id);
  const summary = await finish(sessions, compact.id);
  assert.equal(summary.summary, "Scoped summary.");
  assert.equal(summary.providerSession, undefined);
  await sessions.send(compact.id, "Continue");
  await finish(sessions, compact.id);
  const continued = JSON.parse(await readFile(join(compact.workspace, "invocation.json"), "utf8"));
  assert.ok(!continued.args.includes("resume"));
  assert.match(continued.prompt, /Scoped summary/);
  assert.doesNotMatch(continued.prompt, /Explain count/);
  assert.equal((await sessions.snapshot(parent.id)).messages.length, 2);
});

test("session IDs, prompts and event offsets are bounded before provider execution", async (t) => {
  const { sessions } = await fixture(t);
  await assert.rejects(sessions.snapshot("../escape"), /session|id/);
  await assert.rejects(
    sessions.start({ provider: "codex", kind: "help", prompt: "x".repeat(30_000) }),
    /limit|budget/,
  );
  const session = await sessions.start({ provider: "codex", kind: "help", prompt: "small" });
  await finish(sessions, session.id);
  await assert.rejects(sessions.snapshot(session.id, -1), /offset/);
  await assert.rejects(sessions.rewind(session.id, 999), /turn/);
});

test("metadata directory symlinks cannot redirect session storage", async (t) => {
  const { root, executable } = await fixture(t);
  const external = join(root, "external");
  await mkdir(external);
  await symlink(external, join(root, "alias"));
  const sessions = new Sessions(join(root, "alias"), [{ id: "codex", executable }]);
  await assert.rejects(
    sessions.start({ provider: "codex", kind: "help", prompt: "small" }),
    /symlink|symbolic/,
  );
});

test("worker interruption terminates its owned orphan and permits durable resume", async (t) => {
  const { sessions, root } = await fixture(t);
  const session = await sessions.start({ provider: "codex", kind: "collection", prompt: "HANG" });
  let active = session;
  for (let n = 0; n < 80; n++) {
    active = (await sessions.snapshot(session.id)).session;
    if (active.process && active.providerSession) break;
    await delay(25);
  }
  assert.ok(active.pid && active.process && active.providerSession);
  process.kill(active.pid!, "SIGKILL");
  await delay(1600);
  const interrupted = (await sessions.snapshot(session.id)).session;
  assert.equal(interrupted.status, "interrupted");
  assert.throws(() => process.kill(active.process!, 0), /ESRCH/);
  await sessions.send(session.id, "Continue after interruption");
  assert.equal((await finish(sessions, session.id)).status, "idle");
  assert.equal(
    (await readFile(join(root, "state", session.id, "events.jsonl"), "utf8")).includes(
      "interrupted",
    ),
    true,
  );
});

test("oversized provider lines fail visibly and stop output growth", async (t) => {
  const { sessions, root } = await fixture(t);
  const session = await sessions.start({ provider: "codex", kind: "help", prompt: "FLOOD" });
  const done = await finish(sessions, session.id);
  assert.equal(done.status, "failed");
  assert.match(done.error!, /limit/);
  assert.ok((await readFile(join(root, "state", session.id, "events.jsonl"))).length < 200_000);
});

test("stop refuses to signal an unrelated reused worker PID", async (t) => {
  const { sessions, root } = await fixture(t);
  const session = await sessions.start({ provider: "codex", kind: "help", prompt: "small" });
  await finish(sessions, session.id);
  const path = join(root, "state", session.id, "session.json");
  const state = JSON.parse(await readFile(path, "utf8"));
  state.session.pid = process.pid;
  state.session.status = "running";
  state.token = "unrelated";
  await writeFile(path, JSON.stringify(state));
  await sessions.stop(session.id);
  assert.equal((await sessions.snapshot(session.id)).session.status, "stopped");
});

test(
  "macOS outer boundary prevents a provider from writing a synthetic source",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const { sessions, root } = await fixture(t);
    await writeFile(join(root, "source.txt"), "ORIGINAL");
    const session = await sessions.start({
      provider: "codex",
      kind: "collection",
      prompt: "ESCAPE",
    });
    assert.equal((await finish(sessions, session.id)).status, "idle");
    assert.equal(await readFile(join(root, "source.txt"), "utf8"), "ORIGINAL");
    assert.ok(
      (await sessions.snapshot(session.id)).events.some(
        (e) =>
          e.type === "provider" &&
          (e.data as { type?: string; allowed?: boolean }).type === "escape" &&
          (e.data as { allowed: boolean }).allowed === false,
      ),
    );
  },
);

test("a full durable event log rejects new turns before launching a provider", async (t) => {
  const { sessions, root } = await fixture(t);
  const session = await sessions.start({ provider: "codex", kind: "help", prompt: "small" });
  await finish(sessions, session.id);
  await truncate(join(root, "state", session.id, "events.jsonl"), 8 * 1024 * 1024);
  await assert.rejects(sessions.send(session.id, "more"), /limit/);
});

test("compaction of a long transcript uses a visible bounded excerpt and fresh continuation", async (t) => {
  const { sessions } = await fixture(t);
  const parent = await sessions.start({ provider: "codex", kind: "help", prompt: "ORIGINAL GOAL" });
  await finish(sessions, parent.id);
  for (let n = 0; n < 5; n++) {
    await sessions.send(parent.id, `${"x".repeat(3000)} LAST TURN ${n}`);
    await finish(sessions, parent.id);
  }
  const compact = await sessions.compact(parent.id);
  assert.equal((await finish(sessions, compact.id)).status, "idle");
  const invocation = JSON.parse(await readFile(join(compact.workspace, "invocation.json"), "utf8"));
  assert.match(invocation.prompt, /ORIGINAL GOAL/);
  assert.match(invocation.prompt, /LAST TURN 4/);
  assert.match(invocation.prompt, /omitted/);
  assert.ok(Buffer.byteLength(invocation.prompt) <= 12_288);
});

test("controller exit releases its durable control lock for the next turn", async (t) => {
  const { sessions, root } = await fixture(t);
  const session = await sessions.start({ provider: "codex", kind: "help", prompt: "small" });
  await finish(sessions, session.id);
  const lock = join(root, "state", session.id, "control.sqlite");
  const exited = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    "import {DatabaseSync} from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); process.exit(0)",
    lock,
  ]);
  assert.equal(exited.status, 0);
  await sessions.send(session.id, "resume after controller interruption");
  assert.equal((await finish(sessions, session.id)).status, "idle");
});

test("malformed provider output remains visible without crashing the owned worker", async (t) => {
  const { sessions } = await fixture(t);
  const session = await sessions.start({ provider: "codex", kind: "help", prompt: "MALFORMED" });
  assert.equal((await finish(sessions, session.id)).status, "idle");
  const view = await sessions.snapshot(session.id);
  assert.ok(
    view.events.some((e) => e.type === "stderr" && (e.data as { malformed?: boolean }).malformed),
  );
  assert.ok(view.messages.some((m) => m.role === "assistant"));
});

test("metadata help denies source and global rollout reads while preserving copied guards", async (t) => {
  const { sessions, root, home } = await fixture(t);
  const session = await sessions.start({ provider: "codex", kind: "help", prompt: "READ_ESCAPE" });
  assert.equal((await finish(sessions, session.id)).status, "idle");
  const view = await sessions.snapshot(session.id);
  const reads = view.events
    .filter((e) => e.type === "provider" && (e.data as { type?: string }).type === "read_escape")
    .map((e) => e.data as { blocked?: boolean });
  assert.equal(reads.length, 2);
  assert.ok(reads.every((r) => r.blocked));
  assert.doesNotMatch(
    JSON.stringify(view),
    /PROTECTED SOURCE SECRET|GLOBAL ROLLOUT SECRET|DO NOT LEAK/,
  );
  const invocation = JSON.parse(await readFile(join(session.workspace, "invocation.json"), "utf8"));
  assert.notEqual(invocation.home, home);
  assert.equal(
    await readFile(join(invocation.home, "config.toml"), "utf8"),
    'approval_policy="on-request"\n',
  );
  assert.match(await readFile(join(invocation.home, "rules", "guard.rules"), "utf8"), /forbidden/);
  assert.ok(invocation.args.includes('mcp_servers."external".enabled=false'));
  await assert.rejects(readFile(join(invocation.home, "sessions", "old.jsonl")), /ENOENT/);
  assert.equal(await readFile(join(root, "secret.txt"), "utf8"), "PROTECTED SOURCE SECRET");
});

test("provider output limits escalate against a subprocess ignoring SIGTERM", async (t) => {
  const { sessions } = await fixture(t, { maxMillis: 2000, killMillis: 100 });
  const session = await sessions.start({
    provider: "codex",
    kind: "help",
    prompt: "HOSTILE FLOOD",
  });
  const done = await finish(sessions, session.id);
  assert.equal(done.status, "failed");
  assert.match(done.error!, /limit/);
});

test("turn deadline terminates an owned hostile process group", async (t) => {
  const { sessions } = await fixture(t, { maxMillis: 250, killMillis: 100 });
  const session = await sessions.start({
    provider: "codex",
    kind: "collection",
    prompt: "HOSTILE",
  });
  const done = await finish(sessions, session.id);
  assert.equal(done.status, "failed");
  assert.match(done.error!, /deadline|timeout/);
});

test("help protection overrides collection read approvals and protected sources reject state storage", async (t) => {
  const { sessions, root, executable } = await fixture(t, (root) => ({
    protectedRoots: [join(root, "secret.txt")],
    readRoots: [join(root, "secret.txt")],
  }));
  const help = await sessions.start({ provider: "codex", kind: "help", prompt: "READ_ESCAPE" });
  assert.equal((await finish(sessions, help.id)).status, "idle");
  assert.ok(
    (await sessions.snapshot(help.id)).events.some(
      (e) =>
        e.type === "provider" &&
        (e.data as { label?: string; blocked?: boolean }).label === "source" &&
        (e.data as { blocked?: boolean }).blocked,
    ),
  );
  const collection = await sessions.start({
    provider: "codex",
    kind: "collection",
    prompt: "READ_ESCAPE",
  });
  assert.equal((await finish(sessions, collection.id)).status, "idle");
  assert.ok(
    (await sessions.snapshot(collection.id)).events.some(
      (e) =>
        e.type === "provider" &&
        (e.data as { label?: string; value?: string }).label === "source" &&
        (e.data as { value?: string }).value === "PROTECTED SOURCE SECRET",
    ),
  );
  const unsafe = new Sessions(join(root, "protected", "state"), [{ id: "codex", executable }], {
    protectedRoots: [join(root, "protected")],
  });
  await assert.rejects(
    unsafe.start({ provider: "codex", kind: "help", prompt: "small" }),
    /overlap/,
  );
});

test("unverifiable external MCP restrictions fail before any prompt reaches the provider", async (t) => {
  const { sessions, executable } = await fixture(t);
  const script = await readFile(executable, "utf8");
  await writeFile(
    executable,
    script.replace(
      "enabled:!process.argv.some(a=>a.includes('mcp_servers.')&&a.endsWith('.enabled=false'))",
      "enabled:true",
    ),
  );
  const session = await sessions.start({ provider: "codex", kind: "help", prompt: "small" });
  const done = await finish(sessions, session.id);
  assert.equal(done.status, "failed");
  assert.match(done.error!, /MCP/);
  await assert.rejects(readFile(join(session.workspace, "invocation.json")), /ENOENT/);
  assert.doesNotMatch(JSON.stringify(await sessions.snapshot(session.id)), /DO NOT LEAK/);
});
