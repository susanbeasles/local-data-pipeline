const key = Symbol("inference-proof");
export function annotate(value: unknown, evidence: unknown): unknown {
  if (value && typeof value === "object" && evidence)
    Object.defineProperty(value, key, { value: evidence });
  return value;
}
export function proof(value: unknown): unknown {
  return value && typeof value === "object"
    ? (value as Record<symbol, unknown>)[key]
    : undefined;
}
