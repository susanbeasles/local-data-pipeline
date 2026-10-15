/** Connector transport boundary: provider responses enter local storage, never model context. */
import { readFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Intake, type Task } from "./intake.ts";
import { atomic } from "./store.ts";

export async function receive(root: string, id: string, response: unknown) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw Error("invalid request identifier");
  const reader = new DatabaseSync(join(root, "state/intake.sqlite"), { readOnly: true });
  let task: Task;
  try {
    const row = reader.prepare("SELECT task FROM jobs WHERE id=?").get(id);
    if (!row) throw Error("unknown request");
    task = JSON.parse(String(row.task));
  } finally {
    reader.close();
  }
  const inbox = await Intake.open(root);
  try {
    const { expand } = await import("./atlassian.ts");
    let children: Task[];
    try {
      children = expand(task, response);
    } catch {
      await inbox.fail(
        task,
        response,
        "provider response could not establish complete pagination or data; inspect the local receipt",
      );
      return { stored: true, planned: false, ...inbox.status() };
    }
    await inbox.accept(task, response, children);
    return { stored: true, planned: true, ...inbox.status() };
  } finally {
    inbox.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, path, value] = process.argv.slice(2);
  if (!command || !path)
    throw Error(
      "Usage: node pipeline/receive.ts init /config | next /work [limit] | accept /work /response-envelope.json | status /work",
    );
  const config = command === "init" ? JSON.parse(await readFile(resolve(path), "utf8")) : undefined;
  const root = resolve(config?.work ?? path);
  if (!process.argv.includes("--sandboxed")) {
    if (process.platform !== "darwin")
      throw Error("only verified macOS intake sandbox is supported");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const policy = `(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (subpath ${JSON.stringify(root)}))`;
    const child = spawn(
      "/usr/bin/sandbox-exec",
      ["-p", policy, process.execPath, process.argv[1], ...process.argv.slice(2), "--sandboxed"],
      {
        stdio: "inherit",
        env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root, PYTHONDONTWRITEBYTECODE: "1" },
      },
    );
    process.exit(
      await new Promise<number>((ok, no) => {
        child.once("error", no);
        child.once("exit", (code) => ok(code ?? 1));
      }),
    );
  }
  const { assertNetworkDenied } = await import("./sandbox.ts");
  await assertNetworkDenied();
  if (command === "accept") {
    if (!value) throw Error("response envelope required");
    const envelope = JSON.parse(await readFile(resolve(value), "utf8"));
    const status = await receive(root, envelope.id, envelope.response);
    await atomic(join(root, "progress.json"), { ...status, updatedAt: new Date().toISOString() });
    console.log(JSON.stringify(status));
  } else {
    const inbox = await Intake.open(root);
    try {
      await inbox.recover();
      if (command === "init") {
        const { seed } = await import("./atlassian.ts");
        inbox.seed(seed(config));
        await atomic(join(root, "scope.json"), config);
        console.log(JSON.stringify(inbox.status()));
      } else if (command === "next")
        console.log(JSON.stringify(inbox.pending(value ? Number(value) : 4)));
      else if (command === "status") console.log(JSON.stringify(inbox.status()));
      else throw Error("unknown intake command");
    } finally {
      inbox.close();
    }
  }
}
