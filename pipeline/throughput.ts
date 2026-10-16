import { readFile } from "node:fs/promises";
/** Full-source, full-wall-clock acceptance; never substitutes scheduled chunks for completed sources. */
export type Round = {
  role: string;
  input: string;
  expected: number;
  completed: number;
  failed: number;
  pending: number;
  running: number;
  invalid: number;
  unsupported: number;
  integrity: boolean;
  started: number;
  finished?: number;
};
export function throughput(
  spec: { seconds: number; stages: string[] },
  rounds: Round[],
  now = Date.now(),
) {
  if (!Array.isArray(rounds) || rounds.some((r) => !r || typeof r.role !== "string"))
    throw Error("invalid round evidence");
  if (!Array.isArray(spec.stages) || spec.stages.some((s) => typeof s !== "string" || !s.trim()))
    throw Error("invalid stage names");
  if (
    !Number.isFinite(spec.seconds) ||
    spec.seconds <= 0 ||
    !spec.stages.length ||
    new Set(spec.stages).size !== spec.stages.length
  )
    throw Error("invalid round budget");
  const dataset = rounds[0]?.input,
    expected = rounds[0]?.expected;
  const errors: string[] = [];
  for (const r of rounds)
    if (!spec.stages.includes(r.role)) errors.push("unexpected stage " + r.role);
  const stages = spec.stages.map((role) => {
    const matches = rounds.filter((r) => r.role === role);
    if (matches.length !== 1)
      return { role, met: false, errors: ["missing or duplicate stage evidence"] };
    const r = matches[0]!,
      issues: string[] = [];
    if (!/^[a-f0-9]{64}$/.test(r.input) || r.input !== dataset || r.expected !== expected)
      issues.push("dataset mismatch");
    if (
      ![r.expected, r.completed, r.failed, r.pending, r.running, r.invalid, r.unsupported].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      ) ||
      r.expected === 0
    )
      issues.push("invalid source counts");
    if (
      r.completed !== r.expected ||
      r.failed ||
      r.pending ||
      r.running ||
      r.invalid ||
      r.unsupported
    )
      issues.push("incomplete source coverage");
    if (r.integrity !== true) issues.push("integrity unverified");
    const end = r.finished ?? now,
      seconds = (end - r.started) / 1000;
    if (
      !Number.isFinite(r.started) ||
      !Number.isFinite(end) ||
      r.started < 0 ||
      end > now ||
      seconds < 0
    )
      issues.push("invalid timing");
    if (r.finished === undefined) issues.push("round still running");
    if (seconds > spec.seconds) issues.push("wall-clock budget exceeded");
    return {
      role,
      expected: r.expected,
      completed: r.completed,
      seconds,
      budgetSeconds: spec.seconds,
      met: issues.length === 0,
      errors: issues,
    };
  });
  return {
    met: errors.length === 0 && stages.every((s) => s.met),
    input: dataset,
    budgetSeconds: spec.seconds,
    stages,
    errors,
  };
}

if (process.argv[1] === import.meta.filename) {
  try {
    const [evidence, target] = process.argv.slice(2);
    if (!evidence || !target)
      throw Error("Usage: node pipeline/throughput.ts EVIDENCE.json TARGET.json");
    const result = throughput(
      JSON.parse(await readFile(target, "utf8")),
      JSON.parse(await readFile(evidence, "utf8")),
    );
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.met ? 0 : 1;
  } catch (e) {
    console.error(e instanceof Error ? e.message : "Invalid throughput evidence");
    process.exitCode = 2;
  }
}
