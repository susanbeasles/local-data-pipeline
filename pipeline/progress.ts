import { join } from "node:path";
import { atomic } from "./store.ts";
export function phase(
  work: string,
  name: string,
  state = "running",
  generation?: string,
  error?: string,
) {
  return atomic(join(work, "state", "phase.json"), {
    phase: name,
    state,
    generation,
    error,
    pid: process.pid,
    at: new Date().toISOString(),
  });
}
