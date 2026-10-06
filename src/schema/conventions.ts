import type { ComposerConfig } from "../config.js";
import { humanize, plural, singular, snake as sn, synonymsFor } from "../nl/lexicon.js";
import type { RawCatalog, RawColumn, RawConstraint, RawTable } from "./introspect.js";
import { lifecyclePairs, samplePairs } from "./introspect.js";
import type { ColumnModel, ColumnRole, DurationPair, Relationship, SchemaModel, TableModel, Unit } from "./model.js";

/**
 * Apply convention rules (spec §2.2) and composer.yaml overrides (§2.4) to the raw catalog.
 * Rules are ordered; the first match wins; each records (rule, confidence).
 */
export function buildSchemaModel(raw: RawCatalog, cfg: ComposerConfig = {}): SchemaModel {
  const warnings: SchemaModel["warnings"] = [];
  const nameCount = new Map<string, number>();
  for (const t of raw.tables) nameCount.set(t.name, (nameCount.get(t.name) ?? 0) + 1);
  const keyOf = (schema: string, name: string) => ((nameCount.get(name) ?? 0) > 1 ? `${schema}.${name}` : name);
  const rawByKey = new Map<string, RawTable>();
  for (const t of raw.tables) rawByKey.set(keyOf(t.schema, t.name), t);

  const consOf = (t: RawTable, type?: RawConstraint["type"]) =>
    raw.constraints.filter((c) => c.schema === t.schema && c.table === t.name && (!type || c.type === type));

  const tenantNames = new Set(
    cfg.tenancy?.columns ?? (cfg.tenancy?.column ? [cfg.tenancy.column] : ["tenant_id", "org_id", "organization_id", "account_id", "workspace_id"]),
  );
  const tenantCandidates = new Map<string, number>();
  for (const t of raw.tables) for (const c of t.columns) if (tenantNames.has(c.name)) tenantCandidates.set(c.name, (tenantCandidates.get(c.name) ?? 0) + 1);
  const tenantCols = new Set(
    [...tenantCandidates].filter(([n, k]) => cfg.tenancy?.column === n || k >= Math.max(2, raw.tables.length / 2)).map(([n]) => n),
  );

  // ---------------------------------------------------------------- relationships
  const relationships: Relationship[] = [];
  const fkColumns = new Set<string>();
  for (const t of raw.tables) {
    const tk = keyOf(t.schema, t.name);
    const uniques = consOf(t).filter((c) => c.type === "u" || c.type === "p").map((c) => c.columns.join(","));
    for (const fk of consOf(t, "f")) {
      if (!fk.refTable || !fk.refSchema) continue;
      const target = keyOf(fk.refSchema, fk.refTable);
      if (!rawByKey.has(target)) continue;
      fk.columns.forEach((c) => fkColumns.add(`${tk}.${c}`));
      const unique = uniques.includes(fk.columns.join(","));
      relationships.push(makeRel(tk, fk.columns, target, fk.refColumns ?? [], unique ? "1:1" : "N:1", "fk", "R1", 1, t));
    }
  }
  // R2: name-based inference for unconstrained *_id columns.
  const pkOf = (t: RawTable) => consOf(t, "p")[0]?.columns ?? [];
  for (const t of raw.tables) {
    const tk = keyOf(t.schema, t.name);
    for (const c of t.columns) {
      const ref = `${tk}.${c.name}`;
      if (fkColumns.has(ref) || !/_id$/.test(sn(c.name))) continue;
      if (pkOf(t).length === 1 && pkOf(t)[0] === c.name) continue;
      if (tenantCols.has(c.name)) continue;
      const override = cfg.overrides?.[ref]?.references;
      let target: string | undefined;
      let targetCol: string | undefined;
      let conf = 0.7;
      let rule = "R2";
      if (override) {
        const i = override.lastIndexOf(".");
        target = override.slice(0, i);
        targetCol = override.slice(i + 1);
        conf = 1;
        rule = "config";
      } else {
        const base = sn(c.name).replace(/_id$/, "");
        const parts = base.split("_");
        // try longest suffix first: converted_order → order, created_by_employee → employee
        for (let k = 0; k < parts.length && !target; k++) {
          const cand = parts.slice(k).join("_");
          for (const name of [plural(cand), cand, singular(cand)]) {
            const hit = [...rawByKey.entries()].find(([, rt]) => sn(rt.name) === name && rt.schema === t.schema) ?? [...rawByKey.entries()].find(([, rt]) => sn(rt.name) === name);
            if (hit) {
              const pk = pkOf(hit[1]);
              if (pk.length !== 1) continue;
              const pkCol = hit[1].columns.find((x) => x.name === pk[0]);
              if (!pkCol) continue;
              if (!sameIntFamily(pkCol.type, c.type)) {
                warnings.push({ target: ref, message: `name suggests ${hit[0]} but type ${c.type} ≠ ${pkCol.type}`, confidence: 0.3 });
                continue;
              }
              target = hit[0];
              targetCol = pk[0];
              conf = k === 0 ? 0.8 : 0.7;
              break;
            }
          }
        }
      }
      if (!target || !targetCol || !rawByKey.has(target)) continue;
      fkColumns.add(ref);
      relationships.push(makeRel(tk, [c.name], target, [targetCol], "N:1", override ? "config" : "inferred", rule, conf, t));
      if (conf < 0.85) warnings.push({ target: ref, message: `inferred relationship → ${target}.${targetCol} (no FK constraint)`, confidence: conf });
    }
  }
  for (const add of cfg.relationships?.add ?? []) {
    const [ft, fc] = splitLast(add.from);
    const [tt, tc] = splitLast(add.to);
    const t = rawByKey.get(ft);
    if (!t || !rawByKey.has(tt)) continue;
    fkColumns.add(`${ft}.${fc}`);
    const r = makeRel(ft, [fc], tt, [tc], "N:1", "config", "config", 1, t);
    if (add.role) r.role = add.role;
    relationships.push(r);
  }
  // R5: role labels when several relationships share a target.
  const byPair = new Map<string, Relationship[]>();
  for (const r of relationships) {
    const k = `${r.from.table}->${r.to.table}`;
    byPair.set(k, [...(byPair.get(k) ?? []), r]);
  }
  for (const rs of byPair.values()) {
    if (rs.length < 2) continue;
    for (const r of rs) {
      r.role ??= humanize(r.from.columns[0].replace(/_id$/, ""));
      r.inference = { rule: r.inference.rule + "+R5", confidence: r.inference.confidence };
    }
  }

  // ---------------------------------------------------------------- tables & columns
  const tables: Record<string, TableModel> = {};
  for (const t of raw.tables) {
    const tk = keyOf(t.schema, t.name);
    const tOverride = cfg.overrides?.[tk] ?? cfg.overrides?.[`${t.schema}.${t.name}`];
    const pk = pkOf(t);
    const uniqueSets = consOf(t).filter((c) => c.type === "u" || c.type === "p").map((c) => c.columns);
    const checks = consOf(t, "c");
    const timeCols = t.columns.filter((c) => c.typeCategory === "D");
    const eventLikeNonCreated = timeCols.filter(
      (c) => !isAuditName(sn(c.name)) && !isSoftDeleteName(sn(c.name)) && !/^(created|inserted)_(at|on)$/.test(sn(c.name)),
    );

    const columns: Record<string, ColumnModel> = {};
    for (const c of t.columns) {
      const ref = `${tk}.${c.name}`;
      const stat = raw.stats.find((s) => s.schema === t.schema && s.table === t.name && s.column === c.name);
      const kind = kindOf(c);
      const isPk = pk.includes(c.name);
      const isUnique = uniqueSets.some((u) => u.length === 1 && u[0] === c.name);
      const nDistinct = stat ? (stat.nDistinct >= 0 ? stat.nDistinct : Math.round(-stat.nDistinct * Math.max(t.rowEstimate, 1))) : undefined;
      const check = parseCheck(checks, c.name);
      const scanned = raw.distinctValues?.[`${t.schema}.${t.name}.${c.name}`];
      let role: ColumnRole = "other";
      let rule = "default";
      let conf = 0.5;
      let unit: Unit | undefined;
      let values: string[] | undefined;
      let valuesSource: ColumnModel["valuesSource"];
      const n = sn(c.name);

      if (tenantCols.has(c.name)) [role, rule, conf] = ["tenant", "C14", 0.9];
      else if (isPk && pk.length === 1) [role, rule, conf] = ["identifier", "C1", 1];
      else if (fkColumns.has(ref)) [role, rule, conf] = ["foreign_key", "R1/R2", 1];
      else if (kind === "timestamp" || kind === "date") {
        if (isSoftDeleteName(n) && kind === "timestamp") [role, rule, conf] = ["soft_delete", "C2", 0.9];
        else if (isAuditName(n)) [role, rule, conf] = ["timestamp_audit", "C3", 0.9];
        else if (/^(created|inserted)_(at|on)$/.test(n)) {
          if (eventLikeNonCreated.length === 0) [role, rule, conf] = ["timestamp_event", "C3b", 0.85];
          else [role, rule, conf] = ["timestamp_audit", "C3b", 0.8];
        } else [role, rule, conf] = ["timestamp_event", "C4", 0.85];
      } else if (kind === "boolean") {
        if (/^is_(deleted|archived|removed|discarded)$/.test(n)) [role, rule, conf] = ["soft_delete", "C2", 0.9];
        else [role, rule, conf] = ["boolean_flag", "C6", 1];
      } else if (kind === "json") [role, rule, conf] = ["json", "type", 1];
      else if (kind === "enum") {
        [role, rule, conf] = ["dimension_categorical", "C7", 1];
        values = raw.enums[c.typeName];
        valuesSource = "enum";
      } else if (check?.values) {
        [role, rule, conf] = ["dimension_categorical", "C7", 1];
        values = check.values;
        valuesSource = "check";
      } else if (kind === "text") {
        const freeName = /(description|body|notes?|comment|message|content|summary|text|bio)$/.test(n);
        if (freeName || (stat?.avgWidth ?? 0) > 80) [role, rule, conf] = ["free_text", "C8", 0.85];
        else if (nDistinct !== undefined && (nDistinct <= 50 || (t.rowEstimate > 0 && nDistinct <= t.rowEstimate * 0.01)) && stat?.mostCommonVals?.length && !isUnique) {
          [role, rule, conf] = ["dimension_categorical", "C8", 0.85];
          values = (scanned ?? stat.mostCommonVals).slice(0, cfg.introspection?.max_values ?? 100);
          valuesSource = "pg_stats";
        } else {
          [role, rule, conf] = ["dimension_text", "C8", 0.7];
          if (scanned) [values, valuesSource] = [scanned, "sample"];
        }
      } else if (kind === "number") {
        if (isAttributeNumeric(n)) [role, rule, conf] = ["attribute", "C9", 0.85];
        else if (isNonAdditive(n)) [role, rule, conf] = ["measure_nonadditive", "C11", 0.8];
        else if (isSemiAdditive(n)) [role, rule, conf] = ["measure_semiadditive", "C11", 0.75];
        else {
          [role, rule, conf] = ["measure_additive", "C11", hasStrongAdditiveName(n) ? 0.8 : 0.55];
          if (conf < 0.6) warnings.push({ target: ref, message: "numeric column with a neutral name assumed additive", confidence: conf });
        }
        if (check?.range && role === "measure_additive" && check.range.max !== undefined && check.range.max <= 10) {
          [role, rule, conf] = ["measure_nonadditive", "C11+range", 0.75];
        }
        unit = unitOf(n, c.type);
      } else if (kind === "interval") {
        [role, rule, conf] = ["measure_additive", "C10", 0.7];
        unit = { kind: "duration", label: "interval" };
      }

      const commentMarked = !!c.comment && /^when\b|\btime\b|\bdate\b/i.test(c.comment) && (kind === "timestamp" || kind === "date");
      const pii = isPii(n) || (cfg.pii?.columns ?? []).includes(ref);
      const searchable = (role === "dimension_text" || role === "dimension_categorical") && /(name|title|code|number|email|sku|label|city|company)/.test(n);

      columns[c.name] = {
        table: tk,
        name: c.name,
        type: c.type,
        kind,
        nullable: !c.notNull,
        isPrimaryKey: isPk,
        isUnique,
        role,
        inference: { rule, confidence: conf },
        unit,
        description: c.comment ?? `${humanize(t.name)}: ${humanize(c.name)}`,
        humanName: humanColumn(sn(c.name), unit),
        synonyms: [],
        values,
        valuesSource,
        range: check?.range,
        nDistinct,
        nullFrac: stat?.nullFrac,
        avgWidth: stat?.avgWidth,
        pii,
        searchable,
        hidden: role === "tenant",
        commentMarked,
      };
    }

    // Column overrides (composer.yaml)
    for (const [ref, o] of Object.entries(cfg.overrides ?? {})) {
      const [ot, oc] = splitLast(ref);
      if ((ot !== tk && ot !== `${t.schema}.${t.name}`) || !columns[oc]) continue;
      const c = columns[oc];
      if (o.role) c.role = o.role;
      if (o.role) c.inference = { rule: "config", confidence: 1 };
      if (o.unit) c.unit = o.unit === "cents" ? { kind: "money", divisor: 100, label: "USD" } : o.unit === "dollars" ? { kind: "money", label: "USD" } : { kind: o.unit as Unit["kind"], label: String(o.unit) };
      if (o.description) c.description = o.description;
      if (o.values) [c.values, c.valuesSource] = [o.values, "config"];
      if (o.hidden !== undefined) c.hidden = o.hidden;
      if (o.pii !== undefined) c.pii = o.pii;
      if (o.synonyms) c.synonyms.push(...o.synonyms);
      if (o.soft_delete === false && c.role === "soft_delete") c.role = c.kind === "boolean" ? "boolean_flag" : "timestamp_event";
      if (o.soft_delete === true) c.role = "soft_delete";
      if (o.default_time) c.commentMarked = true;
    }

    // C2 soft delete marker
    const sd = Object.values(columns).find((c) => c.role === "soft_delete");
    // C4 default time column
    const events = t.columns.map((c) => columns[c.name]).filter((c) => c.role === "timestamp_event");
    const defaultTime = pickDefaultTime(events);
    if (defaultTime) columns[defaultTime].isDefaultTime = true;

    // R3 junction
    let junction: TableModel["junction"];
    const tableRels = relationships.filter((r) => r.from.table === tk && !r.selfReference);
    const keySet = uniqueSets.find((u) => u.length === 2 && u.every((x) => tableRels.some((r) => r.from.columns[0] === x)));
    if (keySet) {
      const others = t.columns.filter((c) => !keySet.includes(c.name));
      if (others.every((c) => isAuditName(sn(c.name)) || /^(created|inserted)_(at|on)$/.test(sn(c.name)) || sn(c.name) === "id")) {
        junction = { left: keySet[0], right: keySet[1], inference: { rule: "R3", confidence: 0.9 } };
      }
    }

    // C12 snapshot
    let snapshot: TableModel["snapshot"];
    for (const u of uniqueSets) {
      const dateCol = u.find((x) => /^(snapshot_date|snapshot_at|snapshot_on|as_of|as_of_date|date|day|month|period|snapshot_\w+)$/.test(sn(x)) && columns[x] && (columns[x].kind === "date" || columns[x].kind === "timestamp"));
      if (!dateCol || u.length < 2) continue;
      const ents = u.filter((x) => x !== dateCol);
      if (ents.every((x) => columns[x]?.role === "foreign_key")) {
        snapshot = { dateColumn: dateCol, entityColumns: ents, inference: { rule: "C12", confidence: 0.85 } };
        for (const c of Object.values(columns)) {
          if (c.role === "measure_additive") {
            c.role = "measure_semiadditive";
            c.inference = { rule: "C12", confidence: 0.85 };
          }
        }
        columns[dateCol].role = "timestamp_event";
        for (const c of Object.values(columns)) c.isDefaultTime = c.name === dateCol;
        break;
      }
    }

    // C5 duration pairs
    const durations: DurationPair[] = [];
    const eventCols = Object.values(columns).filter((c) => c.role === "timestamp_event" || c.role === "timestamp_audit").map((c) => c.name);
    const bySnake = new Map(eventCols.map((x) => [sn(x), x]));
    for (const [sa, sb] of lifecyclePairs([...bySnake.keys()])) {
      const [a, b] = [bySnake.get(sa)!, bySnake.get(sb)!];
      const ordered = raw.durationOrder?.[`${t.schema}.${t.name}.${a}>${b}`];
      if (ordered !== undefined && ordered < 0.95) continue;
      durations.push({
        start: a,
        end: b,
        label: `time from ${humanColumn(sa)} to ${humanColumn(sb)}`.replace(/ at\b/g, ""),
        inference: { rule: "C5", confidence: ordered === undefined ? 0.6 : 0.9 },
      });
    }
    // pairs outside the lifecycle vocabulary, confirmed by sampled ordering only
    for (const [sa, sb] of samplePairs([...bySnake.keys()])) {
      const [a, b] = [bySnake.get(sa)!, bySnake.get(sb)!];
      const ordered = raw.durationOrder?.[`${t.schema}.${t.name}.${a}>${b}`];
      if (ordered === undefined || ordered < 0.98 || columns[a].role !== "timestamp_event" || columns[b].role !== "timestamp_event") continue;
      durations.push({ start: a, end: b, label: `time from ${humanColumn(sa)} to ${humanColumn(sb)}`.replace(/ at\b/g, ""), inference: { rule: "C5-sampled", confidence: 0.6 } });
    }

    // C13 display column
    const s = singular(sn(t.name));
    const displayOrder = ["name", "full_name", "title", "label", "display_name", `${s}_name`, `${sn(t.name)}_name`, "email", `${s}_number`, "number", "code", "sku"];
    let display: string[] = tOverride?.display ?? [];
    if (!tOverride?.display) {
      const bySn = new Map(Object.keys(columns).map((x) => [sn(x), x]));
      const hit = displayOrder.map((d) => bySn.get(d)).find((d) => d && columns[d].kind === "text") ?? Object.keys(columns).find((x) => /_number$/.test(sn(x)) && columns[x].isUnique && columns[x].kind === "text");
      if (hit && !columns[hit].pii) display = [hit];
    }

    const noun = humanize(s);
    tables[tk] = {
      key: tk,
      schema: t.schema,
      name: t.name,
      kind: t.kind,
      description: tOverride?.description ?? t.comment ?? humanize(t.name),
      humanName: humanize(t.name),
      noun,
      synonyms: uniq([...synonymsFor(noun), ...(tOverride?.synonyms ?? []), ...(cfg.synonyms?.[tk] ?? []), humanize(t.name), noun]),
      primaryKey: pk,
      rowEstimate: t.rowEstimate,
      columns,
      columnOrder: t.columns.map((c) => c.name),
      softDelete: sd ? { column: sd.name, kind: sd.kind === "boolean" ? "boolean" : "timestamp", inference: sd.inference } : undefined,
      defaultTime: Object.values(columns).find((c) => c.isDefaultTime)?.name,
      display,
      junction,
      snapshot,
      durations,
      rls: t.rls,
      hidden: tOverride?.hidden ?? false,
    };
  }

  // Default paths for foreign-key column synonyms ("assigned to employee")
  for (const r of relationships) {
    const c = tables[r.from.table]?.columns[r.from.columns[0]];
    if (c) {
      c.humanName = r.role ? `${r.role} ${tables[r.to.table].noun}` : tables[r.to.table].noun;
      if (!c.description || c.description.includes(":")) c.description = r.label;
    }
  }

  const fingerprint = fingerprintOf(raw);
  return {
    version: 1,
    fingerprint,
    generatedAt: new Date().toISOString(),
    schemas: raw.schemas,
    tables,
    relationships,
    warnings,
    extensions: raw.extensions,
  };

  function makeRel(fromT: string, fromC: string[], toT: string, toC: string[], card: "N:1" | "1:1", source: Relationship["source"], rule: string, conf: number, t: RawTable): Relationship {
    const target = rawByKey.get(toT)!;
    const prefix = rolePrefix(sn(fromC[0]), sn(target.name));
    const fromNoun = humanize(singular(sn(t.name)));
    const toNoun = humanize(singular(sn(target.name)));
    const nullable = t.columns.filter((c) => fromC.includes(c.name)).some((c) => !c.notNull);
    const label = prefix ? `the ${fromNoun}'s ${prefix} ${toNoun}` : `the ${fromNoun}'s ${toNoun}`;
    return {
      id: `${fromT}.${fromC.join("+")}->${toT}`,
      from: { table: fromT, columns: fromC },
      to: { table: toT, columns: toC },
      cardinality: card,
      source,
      inference: { rule, confidence: conf },
      role: prefix,
      label,
      nullable,
      selfReference: fromT === toT,
    };
  }
}

function rolePrefix(column: string, targetTable: string): string | undefined {
  const base = column.replace(/_id$/, "");
  const s = singular(targetTable);
  for (const t of [s, targetTable]) {
    if (base === t) return undefined;
    if (base.endsWith(`_${t}`)) return humanize(base.slice(0, -t.length - 1));
  }
  return base === "id" ? undefined : humanize(base);
}

function sameIntFamily(a: string, b: string) {
  const ints = /^(smallint|integer|bigint|int\d?)$/;
  if (ints.test(a) && ints.test(b)) return true;
  return a === b;
}

function splitLast(ref: string): [string, string] {
  const i = ref.lastIndexOf(".");
  return [ref.slice(0, i), ref.slice(i + 1)];
}

function kindOf(c: RawColumn): ColumnModel["kind"] {
  if (c.isEnum) return "enum";
  switch (c.typeCategory) {
    case "N": return "number";
    case "S": return "text";
    case "B": return "boolean";
    case "D": return /^date$/.test(c.type) ? "date" : "timestamp";
    case "T": return "interval";
    case "A": return "array";
    case "E": return "enum";
  }
  if (/json/.test(c.type)) return "json";
  if (c.typeName === "citext") return "text";
  return "other";
}

const isAuditName = (n: string) => /^(updated|modified|changed)_(at|on)$|_(synced|loaded|imported|refreshed)_at$/.test(n);
const isSoftDeleteName = (n: string) => /^(deleted|archived|discarded|removed)_at$/.test(n);
const isAttributeNumeric = (n: string) =>
  /(_id|^id|code|zip|postal.*|phone|year|_number|^number|_no|version|rank|position|sort_order|^lat.*|^lng|^lon.*|latitude|longitude|_seq|sequence)$/.test(n) || /^(lat|lng|lon)/.test(n) || /(^|_)year(_|$)/.test(n);
const isNonAdditive = (n: string) =>
  /(^|_)(unit|price|rate|ratio|pct|percent|percentage|score|rating|avg|average|margin|age|temperature|temp|lat|lon)(_|$)/.test(n) || /^unit_/.test(n) || /_pct$|_percent$/.test(n);
const isSemiAdditive = (n: string) => /(^|_)(balance|on_hand|stock|inventory|level|headcount)(_|$)/.test(n);
const hasStrongAdditiveName = (n: string) =>
  /(amount|total|subtotal|quantity|qty|count|cents|revenue|cost|fee|tax|shipping|discount|units|views|clicks|sessions|minutes|seconds|hours|_ms|grams|kg|lbs)/.test(n);
const isPii = (n: string) => /^(email|e_mail|phone|phone_number|mobile|ssn|social_security.*|dob|date_of_birth|birth_?date|line1|line2|address_line\d?|street|password.*|ip_address|token|api_key|secret)$/.test(n) || /(^|_)(email|phone|ssn)$/.test(n);

function unitOf(n: string, type: string): Unit | undefined {
  if (/_cents$/.test(n)) return { kind: "money", divisor: 100, label: "USD" };
  if (type === "money" || /(^|_)(price|amount|revenue|cost|fee)(_|$)/.test(n)) return { kind: "money", label: "USD" };
  if (/_(pct|percent|percentage)$/.test(n)) return { kind: "percent", label: "%" };
  if (/_ms$/.test(n)) return { kind: "duration", divisor: 1000, label: "s" };
  if (/_(seconds|secs)$/.test(n)) return { kind: "duration", label: "s" };
  if (/_minutes$/.test(n)) return { kind: "duration", label: "min" };
  if (/_grams$/.test(n)) return { kind: "weight", label: "g" };
  if (/_kg$/.test(n)) return { kind: "weight", label: "kg" };
  if (/_lbs$/.test(n)) return { kind: "weight", label: "lb" };
  return undefined;
}

function humanColumn(name: string, unit?: Unit): string {
  let n = name.replace(/_(cents|pct|percent|ms|seconds|minutes|grams|kg|lbs)$/, "");
  n = n.replace(/_(at|on)$/, (m) => (m === "_at" ? " at" : " on"));
  const h = humanize(n);
  return unit?.kind === "percent" ? `${h} (%)` : h;
}

function pickDefaultTime(events: ColumnModel[]): string | undefined {
  if (!events.length) return undefined;
  const marked = events.filter((c) => c.commentMarked);
  if (marked.length) return marked[0].name;
  const rank = (c: ColumnModel) => {
    let r = c.nullable ? 100 : 0;
    const n = sn(c.name);
    if (/^(placed|occurred|started|opened|ordered|submitted|snapshot)_(at|on|date)$|^snapshot_date$/.test(n)) r += 0;
    else if (/^(created|inserted)_(at|on)$/.test(n)) r += 30;
    else if (/^\w+ed_(at|on)$/.test(n)) r += 10;
    else r += 20;
    return r;
  };
  return events.slice().sort((a, b) => rank(a) - rank(b))[0].name;
}

function parseCheck(checks: RawConstraint[], column: string): { values?: string[]; range?: { min?: number; max?: number } } | undefined {
  for (const c of checks) {
    if (c.columns.length !== 1 || c.columns[0] !== column) continue;
    const d = c.definition;
    const arr = /ANY\s*\(\s*\(?ARRAY\[(.*?)\]/i.exec(d);
    if (arr) {
      const values = [...arr[1].matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
      if (values.length) return { values };
    }
    const inList = /\bIN\s*\(([^)]*)\)/i.exec(d);
    if (inList) {
      const values = [...inList[1].matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]);
      if (values.length) return { values };
    }
    const range: { min?: number; max?: number } = {};
    const ge = />=\s*\(?(-?\d+(?:\.\d+)?)/.exec(d);
    const gt = />\s*\(?(-?\d+(?:\.\d+)?)/.exec(d);
    const le = /<=\s*\(?(-?\d+(?:\.\d+)?)/.exec(d);
    if (ge) range.min = Number(ge[1]);
    else if (gt) range.min = Number(gt[1]);
    if (le) range.max = Number(le[1]);
    const between = /BETWEEN\s+(-?\d+)\s+AND\s+(-?\d+)/i.exec(d);
    if (between) [range.min, range.max] = [Number(between[1]), Number(between[2])];
    if (range.min !== undefined || range.max !== undefined) return { range };
  }
  return undefined;
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/** Stable fingerprint over tables, columns, types and constraints. */
export function fingerprintOf(raw: RawCatalog): string {
  const parts: string[] = [];
  for (const t of raw.tables.slice().sort((a, b) => `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`))) {
    parts.push(`${t.schema}.${t.name}(${t.columns.map((c) => `${c.name}:${c.type}:${c.notNull ? 1 : 0}`).join(",")})`);
  }
  for (const c of raw.constraints.slice().sort((a, b) => `${a.schema}.${a.table}.${a.name}`.localeCompare(`${b.schema}.${b.table}.${b.name}`))) {
    parts.push(`${c.schema}.${c.table}.${c.name}:${c.definition}`);
  }
  return hashString(parts.join("\n"));
}

export function hashString(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}
