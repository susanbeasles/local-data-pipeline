/** Semantic acceptance for the controlled Alpha/Beta benchmark, never production input. */
export type Entity = { id: string; name: string; namespace: string; claims: { predicate: string; object: string }[] };
export type Group = { memberIds: string[] };
export type Edge = { from: string; to: string; relation: string };
export function acceptance(entities: Entity[], groups: Group[], edges: Edge[]): string[] {
  const errors: string[] = [];
  const names = new Map(entities.map(e => [e.id, e.name]));
  if (!entities.some(e => e.name === "Alpha") || !entities.some(e => e.name === "Beta")) errors.push("missing fixture entities");
  if (entities.some(e => !["Alpha", "Beta"].includes(e.name) || e.namespace !== "fixture")) errors.push("invented entity or namespace");
  if (entities.flatMap(e => e.claims).some(c => c.object === "fact")) errors.push("schema placeholder copied into claim");
  if (!entities.some(e => e.name === "Alpha" && e.claims.some(c => /stor/i.test(c.predicate + " " + c.object) && /local/i.test(c.predicate + " " + c.object)))) errors.push("missing local storage fact");
  if (!entities.some(e => e.name === "Beta" && e.claims.some(c => /read/i.test(c.predicate + " " + c.object) && /Alpha/.test(names.get(c.object) ?? c.object)))) errors.push("missing reader fact");
  for (const name of ["Alpha", "Beta"]) if (!entities.some(e => e.name === name && e.claims.some(c => /network/i.test(c.predicate + " " + c.object) && /disabled|denied|no access/i.test(c.predicate + " " + c.object)))) errors.push("missing network denial for " + name);
  if (groups.some(g => new Set(g.memberIds.map(id => names.get(id))).size > 1)) errors.push("different components grouped as aliases");
  if (!edges.some(e => names.get(e.from) === "Beta" && names.get(e.to) === "Alpha" && e.relation === "depends-on")) errors.push("missing reader dependency");
  if (edges.some(e => names.get(e.from) !== "Beta" || names.get(e.to) !== "Alpha" || e.relation !== "depends-on")) errors.push("unsupported relationship or direction");
  if (edges.some(e => e.relation === "related-history")) errors.push("invented history");
  return errors;
}
