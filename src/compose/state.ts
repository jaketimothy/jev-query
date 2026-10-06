import type { SchemaModel } from "../schema/model.js";
import type { ValueLink } from "../nl/link.js";

/**
 * Shared state for a round: the request plus a pruned slice of the schema model
 * (spec §1 "large irrelevant state hurts"). Candidate-specific metadata goes in each
 * question's structured `instructions`, not here.
 */
export function schemaSlice(model: SchemaModel, tables: string[], links: ValueLink[] = []) {
  return tables
    .map((k) => model.tables[k])
    .filter((t) => t && !t.hidden && !t.junction)
    .map((t) => ({
      table: t.key,
      description: t.description,
      columns: t.columnOrder
        .map((c) => t.columns[c])
        .filter((c) => !c.hidden && c.role !== "identifier" && c.role !== "timestamp_audit" && c.role !== "json")
        .map((c) => {
          const linked = links.filter((l) => l.column === `${t.key}.${c.name}`).map((l) => l.value);
          const vals = c.values && c.values.length <= 12 ? c.values : linked.length ? linked : undefined;
          return { name: c.name, about: c.description.length > 90 ? c.description.slice(0, 87) + "..." : c.description, ...(vals ? { values: vals } : {}) };
        }),
    }));
}
