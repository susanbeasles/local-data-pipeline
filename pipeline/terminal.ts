/** Interactive PTY entrypoint. No prompts, credentials or transcript are printed by this launcher. */
import { configure } from "./studio.ts";
import { Sessions, type Provider } from "./sessions.ts";
import { Catalog } from "./catalog.ts";
import { join } from "node:path";
const [file, provider, id] = process.argv.slice(2);
try {
  if (!file || !["codex", "claude"].includes(provider)) throw Error("A configured Codex or Claude provider is required");
  const config = await configure(file);
  const catalog = new Catalog(config.sources, config.state);
  const sessions = new Sessions(join(config.state,"sessions"),config.providers,{
    protectedRoots:[...config.sources.map(s=>s.root),...await catalog.roots(),join(config.state,"datasets"),...(config.protectedRoots || [])],
    readRoots:config.readRoots,
  });
  const plan = await sessions.terminal(provider as Provider["id"],id);
  process.chdir(plan.workspace);
  const env = Object.fromEntries(Object.entries(plan.env).filter((entry): entry is [string,string]=>entry[1] !== undefined));
  process.execve!(plan.executable,[plan.executable,...plan.args],env);
} catch (error) {
  console.error("Terminal could not start:",error instanceof Error ? error.message : "invalid configuration");
  process.exitCode = 1;
}
