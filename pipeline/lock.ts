import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
export class Lock {
  child: ChildProcessWithoutNullStreams;
  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
  }
  static async acquire(path: string) {
    const child = spawn(
      "/usr/bin/python3",
      [join(import.meta.dirname, "lock.py"), path],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" },
      },
    );
    let diagnostic = "";
    child.stderr.on(
      "data",
      (b) => (diagnostic = (diagnostic + b.toString()).slice(-2000)),
    );
    try {
      await new Promise<void>((ok, no) => {
        child.once("error", no);
        child.once("exit", () =>
          no(Error("lock acquisition failed: " + diagnostic)),
        );
        child.stdout.once("data", (b) => {
          try {
            const r = JSON.parse(b.toString());
            if (r.status === "locked") ok();
            else no(Error("run already active"));
          } catch (e) {
            no(e);
          }
        });
      });
      return new Lock(child);
    } catch (e) {
      child.stdin.end();
      child.kill();
      throw e;
    }
  }
  async close() {
    const done = new Promise<void>((ok) => {
      if (this.child.exitCode !== null) ok();
      else this.child.once("exit", () => ok());
    });
    this.child.stdin.end();
    await done;
  }
}
