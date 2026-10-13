import type { Payload } from "./roles.ts";
/** Reversible inference identifiers; persisted provenance always uses original IDs. */
export class Refs {
  private forward = new Map<string, string>();
  private reverse = new Map<string, string>();
  constructor(payload?: Payload) {
    const pair = payload?.context?.candidates;
    const labels =
      pair?.members.map((member) =>
        typeof member.name === "string"
          ? [...member.name].slice(0, 48).join("")
          : "",
      ) ?? [];
    for (const [kind, items] of [
      ["m", pair?.members],
      ["r", pair?.evidence],
    ] as const)
      items?.forEach((item, index) => {
        const name =
          kind === "m" && "name" in item && typeof item.name === "string"
            ? [...item.name].slice(0, 48).join("")
            : "";
        const local = name
          ? labels.filter((label) => label === name).length === 1
            ? name
            : name + "#" + index
          : kind + index;
        this.forward.set(item.id, local);
        this.reverse.set(local, item.id);
      });
  }
  encode(payload: Payload): Payload {
    const value = structuredClone(payload),
      pair = value.context?.candidates;
    if (!pair) return value;
    for (const member of pair.members) {
      member.id = this.forward.get(member.id)!;
      if (Array.isArray(member.claims))
        member.claims = member.claims.map((claim: Record<string, unknown>) => ({
          ...claim,
          subject: this.forward.get(String(claim.subject)) ?? claim.subject,
          object: this.forward.get(String(claim.object)) ?? claim.object,
          ...(claim.target
            ? { target: this.forward.get(String(claim.target)) ?? claim.target }
            : {}),
        }));
    }
    for (const proof of pair.evidence) {
      proof.id = this.forward.get(proof.id)!;
      proof.member = this.forward.get(proof.member)!;
    }
    const previous = value.prior?.reconcile;
    if (previous)
      value.prior!.reconcile = this.translate(previous, this.forward);
    return value;
  }
  restore(value: unknown): unknown {
    return this.translate(value, this.reverse);
  }
  private translate(
    value: unknown,
    mapping: Map<string, string>,
    key = "",
  ): unknown {
    if (Array.isArray(value))
      return value.map((item) => this.translate(item, mapping, key));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([name, item]) => [
          name,
          this.translate(item, mapping, name),
        ]),
      );
    if (
      typeof value === "string" &&
      ["from", "to", "actor", "target", "memberIds", "evidenceIds"].includes(
        key,
      )
    )
      return mapping.get(value) ?? value;
    return value;
  }
}
