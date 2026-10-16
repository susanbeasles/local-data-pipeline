export type Output = { source: string; result: unknown };
/** Exact fixture oracle keyed by source; permutations and duplicates fail. */
export function check(
  expected: Map<string, string>,
  outputs: Output[],
): boolean {
  const remaining = new Map(expected);
  for (const output of outputs) {
    const text = remaining.get(output.source);
    if (text === undefined) return false;
    const actual = output.result as any;
    if (
      !actual ||
      actual.summary !== text ||
      JSON.stringify(actual.facts) !==
        JSON.stringify([{ claim: text, anchorIds: [0] }]) ||
      JSON.stringify(actual.unknowns) !== "[]" ||
      Object.keys(actual).sort().join(",") !== "facts,summary,unknowns"
    )
      return false;
    remaining.delete(output.source);
  }
  return remaining.size === 0;
}

/** Clarify engine phase counters separately from aggregate pipeline wall-clock rates. */
export function describe(report: any) {
  const metrics = report.metrics ?? [];
  const tokens = metrics.reduce(
    (n: number, r: any) => n + (r.engine?.promptTokens ?? 0),
    0,
  );
  const seconds = metrics.reduce(
    (n: number, r: any) => n + (r.engine?.promptSeconds ?? 0),
    0,
  );
  report.enginePromptPhaseTokensPerSecond =
    seconds > 0 ? tokens / seconds : null;
  delete report.enginePrefillTokensPerSecond;
  report.enginePromptPhaseScope =
    "pooled worker engine prompt-phase seconds; MLX includes admission and associated generation, not pure kernel time or concurrent wall time";
  report.forwardsScope =
    "prefill: multi-token model calls; token: single-token model calls including final prompt token and autoregressive decode";
  for (const metric of metrics) {
    metric.forwards = Object.fromEntries(
      Object.entries(metric.forwards ?? {}).map(([key, value]) => [
        key.replace(/^decode:/, "token:"),
        value,
      ]),
    );
  }
  return report;
}
