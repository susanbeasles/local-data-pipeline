import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { prepare, pause, resume, snapshot, logs, sample } from "../panel.ts";

test("native control reads bounded logs and pauses only its registered process tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-control-")),
    control = join(root, "control"),
    input = join(root, "input"),
    work = join(root, "work"),
    entry = join(root, "fixture-controller.ts");
  await mkdir(control);
  await mkdir(input);
  await mkdir(work);
  await writeFile(
    entry,
    `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; setTimeout(()=>{const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(${JSON.stringify(join(root, "late.pid"))},String(c.pid));},1200);setInterval(()=>{},1000);`,
  );
  const child = spawn(process.execPath, [entry], { stdio: "ignore", detached: true });
  const run = "12345678-1234-1234-1234-123456789012",
    config = join(control, "config.json");
  await writeFile(config, JSON.stringify({ input, work }));
  await writeFile(
    join(control, "production.json"),
    JSON.stringify({ controllerPid: child.pid, run, configs: { fixture: config } }),
  );
  await writeFile(
    join(control, "progress.json"),
    JSON.stringify({ pile: "fixture", phase: "running" }),
  );
  await writeFile(join(control, `fixture-${run}.log`), "x".repeat(100000));
  const panel = { control, entry, project: root };
  try {
    assert.equal((await snapshot(panel)).alive, true);
    assert.ok((await logs(panel)).text.length <= 65536);
    await assert.rejects(pause({ ...panel, entry: join(root, "wrong.ts") }), /register/);
    // Registration binds birth identity and a dedicated process group.
    await mkdir(join(root, "config"));
    await cp(join(import.meta.dirname, ".."), join(root, "pipeline"), { recursive: true });
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeFile(join(root, "package-lock.json"), "{}");
    const source = join(root, "source");
    await mkdir(source);
    await cp(join(root, "pipeline"), join(source, "pipeline"), { recursive: true });
    await mkdir(join(source, "config"));
    await writeFile(join(source, "package.json"), '{"type":"module"}');
    await writeFile(join(source, "package-lock.json"), "{}");
    await prepare({ ...panel, project: source });
    const ownerPath = join(control, "panel-owner.json"),
      owner = JSON.parse(await readFile(ownerPath, "utf8"));
    await writeFile(ownerPath, JSON.stringify({ ...owner, birth: "wrong birth" }));
    await assert.rejects(pause(panel), /identity changed/);
    await writeFile(ownerPath, JSON.stringify(owner));
    for (let i = 0; i < 60; i++) {
      try {
        await readFile(join(root, "late.pid"));
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    const late = Number(await readFile(join(root, "late.pid"), "utf8"));
    const runningLate = () =>
      execFileSync("/bin/ps", ["-axo", "pid=,stat="], { encoding: "utf8" })
        .split("\n")
        .some((line) => {
          const [pid, state] = line.trim().split(/\s+/);
          return Number(pid) === late && !state.startsWith("Z");
        });
    assert.equal(runningLate(), true, "late worker must be running before pause");
    assert.equal((await pause(panel)).paused, true);
    // Container PID 1 may retain exited children as zombies; they cannot execute.
    assert.equal(runningLate(), false, "late worker must stop after pause");
    await writeFile(join(control, "panel-intent.json"), JSON.stringify({ state: "pausing" }));
    await pause(panel);
    assert.equal(
      JSON.parse(await readFile(join(control, "panel-intent.json"), "utf8")).state,
      "paused",
    );
  } finally {
    child.kill();
    const { execFileSync } = await import("node:child_process");
    execFileSync("/bin/chmod", ["-R", "u+w", root]);
    await rm(root, { recursive: true, force: true });
  }
});

test("native resume executes sealed code and frozen configs despite editable project changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-resume-")),
    control = join(root, "control"),
    project = join(root, "project"),
    input = join(root, "input"),
    work = join(root, "work");
  await mkdir(control);
  await mkdir(project);
  await mkdir(input);
  await mkdir(work);
  await cp(join(import.meta.dirname, ".."), join(project, "pipeline"), { recursive: true });
  await mkdir(join(project, "config"));
  await writeFile(join(project, "package.json"), '{"type":"module"}');
  await writeFile(join(project, "package-lock.json"), "{}");
  await writeFile(
    join(project, "pipeline/cli.ts"),
    `import {readFile,writeFile} from 'node:fs/promises'; const cfg=JSON.parse(await readFile(process.argv[3],'utf8')); await writeFile(cfg.work+'/observed.json',JSON.stringify({value:cfg.value,code:'original'}));`,
  );
  const cfg = join(control, "config.json");
  await writeFile(cfg, JSON.stringify({ input, work, value: "frozen" }));
  await writeFile(
    join(control, "production.json"),
    JSON.stringify({
      controllerPid: 99999999,
      run: "12345678-1234-1234-1234-123456789012",
      configs: { fixture: cfg },
    }),
  );
  await writeFile(
    join(control, "progress.json"),
    JSON.stringify({ pile: "fixture", phase: "paused" }),
  );
  const settings = await prepare({ control, entry: join(project, "legacy.ts"), project });
  await writeFile(cfg, JSON.stringify({ input, work, value: "edited" }));
  await writeFile(
    join(project, "pipeline/cli.ts"),
    'throw Error("edited code must never execute")',
  );
  try {
    assert.equal((await resume(settings)).resuming, true);
    for (let i = 0; i < 100; i++) {
      try {
        const value = JSON.parse(await readFile(join(work, "observed.json"), "utf8"));
        assert.deepEqual(value, { value: "frozen", code: "original" });
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.fail("sealed controller did not complete synthetic work");
  } finally {
    await pause(settings).catch(() => {});
    const { execFileSync } = await import("node:child_process");
    execFileSync("/bin/chmod", ["-R", "u+w", root]);
    await rm(root, { recursive: true, force: true });
  }
});

test("native sample reader verifies provenance and never follows receipts outside work", async () => {
  const { Store, hash } = await import("../store.ts");
  const root = await mkdtemp(join(tmpdir(), "panel-sample-")),
    control = join(root, "control"),
    work = join(root, "work");
  await mkdir(control);
  await mkdir(join(work, "state"), { recursive: true });
  const config = join(control, "config.json"),
    receipt = join(work, "receipt.json"),
    bytes = JSON.stringify({ result: "synthetic output" });
  await writeFile(config, JSON.stringify({ input: join(root, "input"), work }));
  await writeFile(
    join(control, "production.json"),
    JSON.stringify({ run: "fixture", configs: { fixture: config } }),
  );
  await writeFile(join(control, "progress.json"), JSON.stringify({ pile: "fixture" }));
  await writeFile(receipt, bytes);
  const db = new Store(join(work, "state/pipeline.sqlite"));
  db.db
    .prepare(
      "INSERT INTO jobs(id,source,chunk,role,config,state,output,outputHash) VALUES('fixture','source',0,'summarize','config','completed',?,?)",
    )
    .run(receipt, hash(bytes));
  db.close();
  const panel = { control, entry: "unused", project: root };
  try {
    assert.equal((await sample(panel, "summarize")).available, true);
    assert.equal((await sample(panel, "summarize", 1)).available, false);
    await writeFile(receipt, "corrupted");
    await assert.rejects(sample(panel, "summarize"), /integrity/);
    await assert.rejects(sample(panel, "../anything"), /invalid/);
    const outside = join(root, "outside.json");
    await writeFile(outside, bytes);
    const changed = new Store(join(work, "state/pipeline.sqlite"));
    changed.db.prepare("UPDATE jobs SET output=?,outputHash=? WHERE id='fixture'").run(outside,hash(bytes));
    changed.close();
    await assert.rejects(sample(panel,"summarize"),/outside work/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("graph samples use only the active generation and fail closed without one", async () => {
  const { Store, hash } = await import("../store.ts");
  const root = await mkdtemp(join(tmpdir(), "panel-generations-")),
    control = join(root, "control"),
    work = join(root, "work"),
    active = hash("active"),
    archived = hash("archived");
  await mkdir(control);
  await mkdir(join(work, "state"), { recursive: true });
  const config = join(control, "config.json"),
    phase = join(work, "state/phase.json"),
    panel = { control, entry: "unused", project: root };
  await writeFile(config, JSON.stringify({ work }));
  await writeFile(
    join(control, "production.json"),
    JSON.stringify({ configs: { fixture: config } }),
  );
  await writeFile(
    join(control, "progress.json"),
    JSON.stringify({ pile: "fixture" }),
  );
  const db = new Store(join(work, "state/graph.sqlite"));
  try {
    for (const generation of [archived, active]) {
      for (const role of ["reconcile", "connect"]) {
        for (let index = 0; index < 2; index++) {
          const id = `${generation}-${role}-${index}`,
            receipt = join(work, `${id}.json`),
            bytes = JSON.stringify({ generation, role, index });
          await writeFile(receipt, bytes);
          db.db
            .prepare(
              "INSERT INTO jobs(id,source,chunk,role,config,state,output,outputHash) VALUES(?,'source',0,?,?,'completed',?,?)",
            )
            .run(id, role, generation, receipt, hash(bytes));
        }
      }
    }
    for (const role of ["reconcile", "connect"]) {
      await writeFile(phase, JSON.stringify({ generation: active }));
      for (let index = 0; index < 2; index++) {
        const result = await sample(panel, role, index);
        assert.equal(result.available, true);
        assert.deepEqual(result.receipt, { generation: active, role, index });
      }
      assert.equal((await sample(panel, role, 2)).available, false);
      await writeFile(phase, JSON.stringify({ generation: hash("no jobs") }));
      assert.equal((await sample(panel, role)).available, false);
      for (const invalid of [
        undefined,
        null,
        {},
        { generation: null },
        { generation: "" },
        { generation: 42 },
        { generation: {} },
        { generation: "invalid" },
        "malformed",
      ]) {
        await rm(phase, { force: true });
        if (invalid !== undefined)
          await writeFile(
            phase,
            invalid === "malformed" ? "{" : JSON.stringify(invalid),
          );
        assert.equal((await sample(panel, role)).available, false);
      }
    }
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
