import type { SchemaModel } from "./model.js";

/**
 * `composer doctor` (spec §2.3): list low-confidence inferences a developer should
 * confirm in composer.yaml, with the override that would pin each one.
 */
export function doctor(model: SchemaModel, threshold = 0.7): string {
  const lines: string[] = [];
  lines.push(`Schema fingerprint ${model.fingerprint} — ${Object.keys(model.tables).length} tables, ${model.relationships.length} relationships\n`);
  const low: { target: string; why: string; conf: number; fix: string }[] = [];
  for (const t of Object.values(model.tables)) {
    for (const c of Object.values(t.columns)) {
      if (c.inference.confidence < threshold && c.role !== "other") {
        low.push({ target: `${t.key}.${c.name}`, why: `${c.role} by ${c.inference.rule}`, conf: c.inference.confidence, fix: `overrides:\n    ${t.key}.${c.name}: { role: ${c.role} }` });
      }
    }
    if (!t.display.length && !t.junction && !t.snapshot && Object.values(t.columns).some((c) => c.kind === "text")) {
      const names = Object.values(t.columns).filter((c) => /name/.test(c.name)).map((c) => c.name);
      if (names.length) low.push({ target: t.key, why: "no display column (results show the id)", conf: 0.5, fix: `overrides:\n    ${t.key}: { display: [${names.join(", ")}] }` });
    }
  }
  for (const r of model.relationships) {
    if (r.inference.confidence < threshold) low.push({ target: r.id, why: `relationship inferred by ${r.inference.rule} (no FK constraint)`, conf: r.inference.confidence, fix: `overrides:\n    ${r.from.table}.${r.from.columns[0]}: { references: ${r.to.table}.${r.to.columns[0]} }` });
  }
  // ambiguous routes worth a default path
  const pairs = new Map<string, number>();
  for (const r of model.relationships) if (!r.selfReference) pairs.set(`${r.from.table}->${r.to.table}`, (pairs.get(`${r.from.table}->${r.to.table}`) ?? 0) + 1);
  for (const [k, n] of pairs) if (n > 1) low.push({ target: k, why: `${n} role-playing relationships; users will be asked which one`, conf: 0.6, fix: `relationships:\n  default_paths:\n    ${k}: <role>` });

  if (!low.length) lines.push("Nothing to confirm. All inferences are above the threshold.");
  for (const l of low.sort((a, b) => a.conf - b.conf)) {
    lines.push(`• ${l.target}  (${l.conf.toFixed(2)})  ${l.why}\n    ${l.fix.replace(/\n/g, "\n    ")}`);
  }
  for (const w of model.warnings) lines.push(`! ${w.target}: ${w.message}`);
  return lines.join("\n");
}
