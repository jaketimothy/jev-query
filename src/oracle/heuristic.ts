import { contentTokens, singular, snake, stem, STOPWORDS, tokens } from "../nl/lexicon.js";
import { choiceFromWeights, scoreFromWeights } from "./types.js";
import type { Answer, Answers, AskOptions, ChoiceQuestion, NoulQuestion, Oracle, Question, Questions, ScoreQuestion } from "./types.js";

/**
 * Offline, deterministic oracle for development, tests, CI and demos. It answers by
 * lexical matching: quoted cue phrases in option descriptions, attribute names, and
 * a few family-specific rules keyed on question ids. It is NOT calibrated and NOT a
 * substitute for Jev; it exists so the whole pipeline runs without network access.
 */
export class HeuristicOracle implements Oracle {
  readonly name = "heuristic";

  async ask(state: unknown, questions: Questions, _opts?: AskOptions): Promise<Answers> {
    const st = (state ?? {}) as Record<string, unknown>;
    const request = String(st.request ?? (typeof state === "string" ? state : ""));
    const summary = st.plan_summary ? String(st.plan_summary) : undefined;
    const out: Answers = {};
    for (const [id, q] of Object.entries(questions)) out[id] = answer(id.replace(/__rev$/, ""), q, request, summary);
    return out;
  }
}

// ------------------------------------------------------------------ helpers

const lc = (s: string) => s.toLowerCase();
const has = (text: string, re: RegExp) => re.test(lc(text));
const P = (p: number) => ({ type: "noul" as const, noul: Math.max(0.02, Math.min(0.98, p)) });

function cues(desc: string): string[] {
  return [...desc.matchAll(/'([^']+)'/g)].map((m) => lc(m[1]));
}

function cueScore(request: string, desc: string): number {
  const r = lc(request);
  let s = 0;
  for (const c of cues(desc)) {
    const words = c.replace(/[^a-z0-9% ]/g, " ").split(/\s+/).filter(Boolean);
    if (r.includes(c)) s += 2 + c.length / 10;
    else if (words.length > 1 && words.filter((w) => !STOPWORDS.has(w)).every((w) => new RegExp(`\\b${w}`).test(r))) s += 1;
  }
  return s;
}

function overlap(a: string, b: string): number {
  const A = new Set(contentTokens(a).map(stem));
  const B = contentTokens(b).map(stem);
  let n = 0;
  for (const t of B) if (A.has(t)) n++;
  return n;
}

function ins(q: Question): Record<string, unknown> {
  return typeof q.instructions === "string" ? { question: q.instructions } : (q.instructions as Record<string, unknown>);
}

function choiceByCues(request: string, q: ChoiceQuestion, prior: Record<string, number> = {}, base = 0.05): Answer {
  const w: Record<string, number> = {};
  for (const [k, d] of Object.entries(q.criteria)) w[k] = base + (prior[k] ?? 0) + cueScore(request, d);
  return sharpen(w);
}

/** Turn scores into a confident-but-not-certain distribution. */
function sharpen(w: Record<string, number>, temp = 0.5): Answer {
  const keys = Object.keys(w);
  const max = Math.max(...keys.map((k) => w[k]));
  const e: Record<string, number> = {};
  for (const k of keys) e[k] = Math.exp((w[k] - max) / temp);
  return choiceFromWeights(e);
}

function windowAround(request: string, span: string, before = 40, after = 40): string {
  const i = lc(request).indexOf(lc(span));
  if (i < 0) return request;
  return request.slice(Math.max(0, i - before), Math.min(request.length, i + span.length + after));
}

// ------------------------------------------------------------------ answer dispatch

function answer(id: string, q: Question, request: string, summary?: string): Answer {
  const r = lc(request);
  const I = ins(q);

  if (id === "shape") return shape(request, q as ChoiceQuestion);
  if (id === "specificity") return scoreFromWeights([0.05, 0.15, 0.8]);
  if (id.startsWith("flag_")) return flag(id.slice(5), request);
  if (id === "follow_up") return P(/^(same|now|and|what about|how about|also|but|ok|okay)\b|same thing|instead|only\b.*\binstead|\bthat\b/.test(r) ? 0.92 : 0.08);
  if (id === "saved_plan") return savedPlan(request, q as ChoiceQuestion);
  if (id === "subject") return subject(request, q as ChoiceQuestion);
  if (id === "measure_quantity") return measureQuantity(request, q as ChoiceQuestion);
  if (id === "measure_agg") return measureAgg(request, q as ChoiceQuestion);
  if (id.startsWith("also_")) return alsoMeasure(request, String(I.quantity ?? ""));
  if (id.startsWith("show_")) return show(request, I.column as Record<string, string>);
  if (id.startsWith("group_")) return group(request, I.attribute as Record<string, unknown>);
  if (id === "time_grain") return timeGrain(request, q as ChoiceQuestion);
  if (id === "period") return period(request, q as ChoiceQuestion);
  if (id.startsWith("date_role_")) return dateRole(request, String(I.span));
  if (id.startsWith("role_")) return numberRole(request, String(I.span), q as ChoiceQuestion);
  if (id.startsWith("op_")) return op(request, String(I.span));
  if (id.startsWith("filter_")) return filterPolarity(request, I.candidate as Record<string, string>);
  if (id.startsWith("textcol_")) return textCol(request, String(I.span), q as ChoiceQuestion);
  if (id.startsWith("textmode_")) return textMode(request, String(I.span));
  if (id.startsWith("null_")) return nullCheck(request, String(I.column ?? I.attribute));
  if (id.startsWith("bool_")) return boolFlag(request, String(I.attribute));
  if (id === "sort_dir") return choiceByCues(request, q as ChoiceQuestion, { unspecified: 0.6 });
  if (id === "derived") return derived(request, q as ChoiceQuestion);
  if (id === "time_column") return timeColumn(request, q as ChoiceQuestion);
  if (id.startsWith("absent_")) return absent(request, String(I.related));
  if (id.startsWith("present_")) return present(request, String(I.related));
  if (id === "partition_dim") return partition(request, q as ChoiceQuestion);
  if (id.startsWith("path_")) return path(request, q as ChoiceQuestion, String(I.attribute ?? ""));
  if (id === "agreement") return scoreFromWeights([0.02, 0.08, 0.2, 0.7]);
  if (id === "extra_condition") return P(0.1);
  if (id.startsWith("covered_")) return covered(request, String(I.phrase), summary ?? "");
  // generic fallbacks
  if (q.type === "noul") return P(overlap(request, JSON.stringify(q.instructions)) > 1 ? 0.6 : 0.2);
  if (q.type === "score") return scoreFromWeights((q as ScoreQuestion).criteria.map((_, i) => i + 1));
  return choiceByCues(request, q as ChoiceQuestion);
}

// ------------------------------------------------------------------ families

function shape(request: string, q: ChoiceQuestion): Answer {
  const r = lc(request);
  const w: Record<string, number> = { lookup: 0, single_value: 0, breakdown: 0, ranking: 0, trend: 0, distribution: 0, unsupported: 0 };
  if (/\b(delete|remove|update|insert|drop|create|change|set)\b/.test(r) && !/\bcreated?\b.*\b(ticket|order)s?\b|\bdid\b/.test(r)) w.unsupported += 5;
  if (/\bweather|\bjoke|\bwho are you|\bhello\b|\bstock price/.test(r)) w.unsupported += 5;
  if (/histogram|distribution of/.test(r)) w.distribution += 4;
  if (/^(how many|how much|what is the total|what's the total|what was|what is our|total\b|number of\b)/.test(r)) w.single_value += 2;
  if (/\b(how many|how much)\b/.test(r)) w.single_value += 1.5;
  if (/\b(by|per|for each|each|breakdown|broken down)\b/.test(r)) w.breakdown += 1.5;
  if (/\b(monthly|weekly|daily|quarterly|yearly|per (month|week|day|quarter|year)|by (month|week|day|quarter|year)|each month|over time|trend|running total|month-over-month|month over month)\b/.test(r)) w.trend += 4.5;
  if (/\b(top|bottom|most|least|fewest|highest|lowest|best|worst|biggest|smallest)\b/.test(r.replace(/at least/g, "")) && !/most recent/.test(r)) w.ranking += 2.5;
  if (/^(which|list|show|what are|find|give me)\b|\bwhich\b.*\b(have|has|had|are|were|placed|sold)\b|^customers who|^customers whose|^orders (from|with)|most recent order/.test(r)) w.lookup += 2.2;
  if (/\bwho\b|\bwhose\b|^categories with|^products (with|that)|^customers (who|with|whose)/.test(r)) w.lookup += 1.5;
  if (/^which \w+ (spent|sold|had|has|have) the (most|least|fewest)/.test(r) || /^which \w+ (led|had)\b.*\b(most|least|fewest)/.test(r) || /^which [a-z ]+ led to the most/.test(r)) w.ranking += 3;
  if (/\b(how many|number of|count)\b/.test(r) && /\b(by|per|each)\b/.test(r)) w.breakdown += 1.5;
  if (/\bshare of\b|\bsplit by\b/.test(r)) w.breakdown += 2;
  if (/compared with|compared to|\bvs\b|versus/.test(r) && !/\b(by|per|each)\b/.test(r)) w.single_value += 2;
  if (/^(average|avg|mean|median|total|sum)\b/.test(r) && /\b(by|per)\b/.test(r)) w.breakdown += 1;
  if (/\bmost recent\b.*\bfor each\b/.test(r)) w.lookup += 3;
  if (/(in each|within each|for each|per)\b/.test(r) && /\btop \d+/.test(r)) w.ranking += 2;
  if (/\bunits on hand by\b|\bat the start of each\b/.test(r)) w.trend += 2;
  return sharpen(w, 0.6);
}

function flag(k: string, request: string): Answer {
  const r = lc(request);
  const m = (re: RegExp, p = 0.92) => P(re.test(r) ? p : 0.06);
  switch (k) {
    case "is_write": return m(/^(delete|remove|update|insert|drop|create|add|change|set|cancel)\b/);
    case "has_time_period": return m(/\b(last|this|past|previous|since|before|between|in (19|20)\d\d|today|yesterday|ytd|year-to-date|q[1-4]|january|february|march|april|may|june|july|august|september|october|november|december|week|month|quarter|year)\b/);
    case "per_group_top_n": return m(/\b(in|within|for) each\b.*|\btop \d+ \w+ (in|per|within) (each|every)\b/ , /\b(top|most recent|latest|first|best)\b/.test(r) && /\b(each|every|per)\b/.test(r) ? 0.9 : 0.06);
    case "include_empty_groups": return m(/including (\w+ )*(with no|without)|show zero|even (if|those) with no|including empty/);
    case "asks_absence": return m(/\bnever\b|\bno \w+\b(?! more)|\bwithout\b|didn't|did not|haven't|have not|hasn't/);
    case "asks_presence_only": return m(/\bwho (placed|bought|ordered|purchased) (an |any )?(orders?|something)\b(?! more| at least)/, 0.7);
    case "vs_overall_aggregate": return m(/above (the )?average|below (the )?average|more than (the )?average|above the median/);
    case "asks_share": return m(/\bshare\b|% of|percent of|proportion|fraction/);
    case "asks_change": return m(/\bchange\b|growth|increase|decrease|month-over-month|month over month|year over year|vs\.? previous/);
    case "asks_running_total": return m(/running total|cumulative/);
    case "asks_unique": return m(/\bdistinct\b|\bunique\b|\bdifferent\b(?! products)/);
    case "single_best": return m(/^which \w+ (spent|sold|had|has|have|led|bought|placed) the (most|least|fewest|highest|lowest)|\bthe (most|least|fewest) \w+\?*$|\bmost recent \w+ for each\b|\blatest \w+ for each\b|\bthe (top|best|worst|biggest)\b(?! \d)/);
    case "compare_periods": return m(/compared (with|to)|\bvs\.?\b|versus|same period last year/);
  }
  return P(0.1);
}

function savedPlan(request: string, q: ChoiceQuestion): Answer {
  const w: Record<string, number> = {};
  for (const [k, d] of Object.entries(q.criteria)) {
    if (k === "none") continue;
    const reqT = new Set(contentTokens(request).map(stem));
    // "sales" ~ "revenue": business synonyms
    const syn: Record<string, string[]> = { sale: ["revenue"], revenue: ["sale"], region: ["region"] };
    let s = 0;
    for (const t of contentTokens(d).map(stem)) if (reqT.has(t) || (syn[t] ?? []).some((x) => reqT.has(x))) s += 1;
    w[k] = s;
  }
  const best = Math.max(0, ...Object.values(w));
  w.none = best >= 2 ? 0.5 : 4;
  for (const k of Object.keys(w)) if (k !== "none") w[k] = w[k] >= 2 ? w[k] + 1.5 : w[k] * 0.2;
  return sharpen(w, 0.7);
}

function tableTerms(desc: string): string[] {
  // "Orders (also called purchase, sale, transaction): ..." → [orders, purchase, sale, transaction]
  const m = /^([^(:]+)(?:\(also called ([^)]*)\))?/.exec(desc);
  const out = [lc(m?.[1] ?? "").trim()];
  if (m?.[2]) out.push(...m[2].split(",").map((x) => lc(x.trim())));
  return out.filter(Boolean);
}

function mentions(request: string, term: string): number {
  const r = lc(request);
  const words = term.split(/\s+/);
  const reqStems = tokens(r).map(stem);
  const tStems = words.map(stem);
  // full phrase (by stem)
  for (let i = 0; i + tStems.length <= reqStems.length; i++) if (tStems.every((t, j) => reqStems[i + j] === t)) return 1 + 0.2 * (tStems.length - 1) + (i < 3 ? 0.1 : 0);
  return 0;
}

function subject(request: string, q: ChoiceQuestion): Answer {
  const r = lc(request);
  const w: Record<string, number> = {};
  for (const [k, d] of Object.entries(q.criteria)) {
    if (k === "none") continue;
    const terms = tableTerms(d);
    let s = 0;
    for (const t of terms) s = Math.max(s, mentions(request, t) * (t === terms[0] ? 1.2 : 0.9));
    // the counted / listed thing: right after how many / which / list
    const first = terms[0];
    if (new RegExp(`^(how many|which|list( the)?( \\d+)?( most recent)?|show|customers|the)?\\s*(\\w+ )?${stem(first.split(" ").pop()!)}`).test(r)) s += 0.5;
    if (new RegExp(`(how many|number of|list|which|most recent) (\\w+ ){0,2}${stem(first.split(" ").pop()!)}`).test(r)) s += 1;
    w[k] = s;
  }
  // the first entity mentioned is usually the subject ("Customers who placed more than 10 orders")
  let firstKey: string | undefined;
  let firstPos = 1e9;
  for (const [k, d] of Object.entries(q.criteria)) {
    if (k === "none" || !(w[k] > 0)) continue;
    const toks = tokens(r).map(stem);
    for (const t of tableTerms(d)) {
      const idx = toks.indexOf(stem(t.split(" ").pop()!));
      if (idx >= 0 && idx < firstPos) [firstKey, firstPos] = [k, idx];
    }
  }
  if (firstKey) w[firstKey] += 1.2;
  w.none = /^(what is the total|total|how much|average|revenue|what was our revenue)/.test(r) ? 1.2 : 0.2;
  return sharpen(w, 0.5);
}

function measureQuantity(request: string, q: ChoiceQuestion): Answer {
  const r = lc(request).replace(/running total/g, "running");
  const w: Record<string, number> = {};
  const isCountQ =
    /\b(how many|number of|count|order count|\bmost orders\b|fewest orders)\b/.test(r) ||
    /\bmost \w+s\b|\bfewest\b/.test(r) ||
    !/\b(units|value|amount|revenue|price|sales|spent|spend|cost|rating|inventory|on hand|time|average|avg|median|paid|order total|margin|profit)\b|\btotal (?!of)/.test(r);
  for (const [k, d] of Object.entries(q.criteria)) {
    let s = 0;
    if (k === "none") {
      s = /^(list|show|which|customers (who|whose)|most recent|find)\b/.test(r) && !/how many|total|average|sum|units|revenue/.test(r) ? 2 : 0.3;
      w[k] = s;
      continue;
    }
    const [, kind, ref] = /^(saved|col|dur|count):(.+)$/.exec(k) ?? [];
    if (kind === "saved") {
      const name = lc(ref);
      if (r.includes(name) || (name === "revenue" && /\bsales\b/.test(r))) s += 5;
    } else if (kind === "count") {
      const terms = tableTerms(d.replace(/^The number of /, ""));
      let m = 0;
      for (const t of terms) m = Math.max(m, mentions(request, t));
      if (m && isCountQ) {
        s += 2 + m;
        // the thing counted comes right after "how many" / "number of" / "most"
        const head = stem(terms[0].split(" ").pop()!);
        if (new RegExp(`(how many|number of|count of|most|fewest|least) ((?!by |per |of |in )\\w+ ){0,2}${head}`).test(r)) s += 2;
        if (new RegExp(`${head}\\w* count`).test(r)) s += 2;
        // "Orders by …", "Share of orders by …": the noun right at the start / after "of"
        if (new RegExp(`^(share of |running \\w+ of |total of )?(new )?${head}\\w*\\b`).test(r)) s += 2;
        // a noun after by/per/each is a dimension, not the thing counted
        if (new RegExp(`\\b(by|per|each|every|in each) (\\w+ )?${head}`).test(r) && !new RegExp(`(how many|number of|count of) ((?!by |per |of |in )\\w+ ){0,2}${head}`).test(r)) s -= 2.5;
      }
    } else if (kind === "dur") {
      const label = lc(d);
      if (/time to|how long|duration|time (from|between)/.test(r)) {
        const parts = label.match(/time from ([a-z ]+?) to ([a-z ]+?)\./);
        if (parts && r.includes(parts[2].trim())) s += 4;
        else if (parts && overlap(r, parts[2]) > 0) s += 2.5;
      }
    } else if (kind === "col") {
      const col = snake(ref.split(".")[1]);
      const name = col.replace(/_(cents|pct|percent|grams|ms)$/, "").replace(/_/g, " ");
      const table = ref.split(".")[0];
      const tableNoun = singular(table.split("_").pop()!);
      if (r.includes(name)) s += 3;
      else if (name.split(" ").length > 1 && name.split(" ").every((x) => r.includes(stem(x)))) s += 2.5;
      // business phrasing
      if (/order (value|total|amount)|\bspent|\bspend|order total|sales amount/.test(r) && col === "total_cents" && table === "orders") s += 3.5;
      if (/\bunits\b|units sold|quantity|how many items/.test(r) && col === "quantity") s += 3.5;
      if (/\bunits on hand|inventory|in stock|stock level/.test(r) && /on_hand/.test(col)) s += 4;
      if (/product sales|line (total|amount)s?/.test(r) && col === "line_total_cents") s += 3.5;
      if (/amount paid|paid amount|payments? (total|amount)/.test(r) && table === "payments" && col === "amount_cents") s += 3.5;
      if (/\brating\b|\breview score\b|\bstars\b/.test(r) && col === "rating") s += 3.5;
      if (/\b(list )?price\b|\bcost\b/.test(r) && col === "list_price_cents") s += r.includes("list price") ? 3.5 : 2.2;
      if (/\bcost\b/.test(r) && col === "unit_cost_cents") s += 1.4;
      if (/\bcsat|satisfaction\b/.test(r) && col === "csat_score") s += 3.5;
      if (/revenue|sales\b/.test(r) && /total|subtotal|line_total/.test(col)) s += 1.2;
      if (r.includes(tableNoun) && s > 0) s += 0.3;
    }
    if (isCountQ && kind !== "count" && !/(units|total|value|amount|revenue|average|sum|spent|sales|price|rating|inventory|time)/.test(r)) s -= 1;
    w[k] = s;
  }
  // unknown business term (e.g. "revenue" with no saved definition): spread the mass
  const top = Math.max(...Object.values(w));
  return sharpen(w, top >= 3 ? 0.5 : 1.2);
}

function measureAgg(request: string, q: ChoiceQuestion): Answer {
  const r = lc(request);
  const w: Record<string, number> = { sum: 0.5, avg: 0, median: 0, max: 0, min: 0, count_rows: 0, count_distinct: 0 };
  if (/\baverage|\bavg\b|\bmean\b|typical/.test(r)) w.avg += 4;
  if (/\bmedian\b/.test(r)) w.median += 4;
  if (/\b(total|sum|how much|spent|sold|amount|revenue|sales|value|units)\b/.test(r)) w.sum += 2;
  if (/\b(how many|number of|count)\b/.test(r)) w.count_rows += 2.5;
  if (/how many \w+ (placed|bought|ordered|made|had)|unique|distinct/.test(r)) w.count_distinct += 1;
  if (/\b(highest|biggest|largest|maximum|max)\b/.test(r) && !/\btop\b/.test(r)) w.max += 2;
  if (/\b(lowest|smallest|minimum|min)\b/.test(r) && !/\bbottom\b/.test(r)) w.min += 2;
  return sharpen(w, 0.6);
}

function alsoMeasure(request: string, quantity: string): Answer {
  const r = lc(request);
  if (!/\band\b|,/.test(r)) return P(0.05);
  const q = lc(quantity);
  if (/amount paid|paid amount/.test(r) && /^payment amount/.test(q)) return P(0.9);
  if (/\bunits\b/.test(r) && /quantity/.test(q) && /order item/.test(q)) return P(0.85);
  if (/order count|number of orders/.test(r) && /^the number of orders/.test(q)) return P(0.85);
  return P(0.05);
}

function show(request: string, column: Record<string, string>): Answer {
  const r = lc(request);
  const name = column.name.replace(/_(cents|at|on)$/, "").replace(/_/g, " ");
  if (new RegExp(`\\b(show|with|and|including|include|their|its)\\b[^.]*\\b${name}\\b`).test(r)) return P(0.85);
  return P(0.08);
}

function group(request: string, attr: Record<string, unknown>): Answer {
  const r = lc(request);
  if (attr.entity) {
    const noun = lc(String(attr.entity));
    const head = stem(noun.split(" ").pop()!);
    const syns = ((attr.also_called as string[]) ?? []).map(lc).filter((x) => x.length > 2);
    const plural = (x: string) => (/y$/.test(x) ? `${x.slice(0, -1)}(y|ies)` : `${x}s?`);
    const headRe = noun.endsWith("y") ? `${head.slice(0, -1)}(y|ies)` : `${head}\\w*`;
    const nounRe = `(${[plural(noun), headRe, ...syns.map(plural)].join("|")})`;
    if (new RegExp(`\\b(by|per|for each|each|in each|within each|every) (\\w+ ){0,2}${nounRe}\\b`).test(r)) {
      // "by customer region" groups by region, not by customer
      const after = new RegExp(`\\b(by|per|each) (\\w+ )?${nounRe} (\\w+)`).exec(r);
      if (after && /^(region|segment|channel|category|brand|status|priority|type|tier|source|page|method|reason|team|title)s?$/.test(after[4]) && !/^(in|this|last|from|with)$/.test(after[4])) return P(0.1);
      return P(0.9);
    }
    if (new RegExp(`^(top \\d+|which) (\\w+ ){0,2}${nounRe}\\b`).test(r) && /\b(most|least|fewest|top|highest|lowest|spent|sold|led)\b/.test(r)) return P(0.88);
    if (new RegExp(`\\btop \\d+ ${nounRe}\\b`).test(r)) return P(0.88);
    if (new RegExp(`\\b(which|what) ${nounRe}\\b`).test(r) && /\b(most|least|fewest)\b/.test(r)) return P(0.85);
    // "units on hand by warehouse", "orders by fulfillment warehouse region" → region
    return P(0.06);
  }
  const name = lc(String(attr.name)).replace(/_(code|cents)$/, "").replace(/_/g, " ");
  const words = name.split(" ").filter((w) => w.length > 3 && !STOPWORDS.has(w));
  const head = words.length ? words[words.length - 1] : name;
  const tnoun = singular(lc(String(attr.table ?? "")).split("_").pop() ?? "");
  const filler = `((?!this|last|in|the|each|every|per)\\w+ )?`;
  const re = new RegExp(`\\b(by|per|for each|each|split by|broken down by) ${filler}(${name}|${head})s?\\b`);
  const tableMentioned = !!tnoun && new RegExp(`\\b${stem(tnoun)}`).test(r);
  if (re.test(r)) return P(tableMentioned ? 0.92 : 0.75);
  if (new RegExp(`\\b(which|top \\d+) (${name}|${head})s?\\b`).test(r) && /\b(most|least|fewest|top)\b/.test(r)) return P(0.88);
  if (new RegExp(`\\b(of|share of) \\w+ by (${name}|${head})`).test(r)) return P(0.9);
  return P(0.05);
}

function timeGrain(request: string, q: ChoiceQuestion): Answer {
  const r = lc(request);
  const w: Record<string, number> = { none: 1, hour: 0, day: 0, week: 0, month: 0, quarter: 0, year: 0 };
  if (/\b(monthly|per month|by month|each month|every month|month-over-month|month over month)\b/.test(r)) w.month += 4;
  if (/\b(weekly|per week|by week|each week)\b/.test(r)) w.week += 4;
  if (/\b(daily|per day|by day|each day)\b/.test(r)) w.day += 4;
  if (/\b(quarterly|per quarter|by quarter|each quarter)\b/.test(r)) w.quarter += 4;
  if (/\b(yearly|annual|per year|by year|each year)\b/.test(r)) w.year += 4;
  if (/\bhourly|per hour\b/.test(r)) w.hour += 4;
  void q;
  return sharpen(w, 0.6);
}

function period(request: string, q: ChoiceQuestion): Answer {
  const r = lc(request);
  const w: Record<string, number> = {};
  for (const k of Object.keys(q.criteria)) w[k] = 0;
  w.none = 1;
  const set = (k: string, v = 5) => (w[k] = (w[k] ?? 0) + v);
  if (/\blast month\b|\bprevious month\b/.test(r)) set("last_month");
  if (/\bthis month\b|month to date|\bmtd\b/.test(r)) set("this_month");
  if (/\blast quarter\b|previous quarter/.test(r)) set("last_quarter");
  if (/\bthis quarter\b|quarter to date/.test(r)) set("this_quarter");
  if (/\blast year\b|previous year/.test(r) && !/same period last year/.test(r)) set("last_year");
  if (/\bthis year\b|year[- ]to[- ]date|\bytd\b|so far this year/.test(r)) set("this_year");
  if (/\blast week\b/.test(r) && !/last \d+ weeks/.test(r)) set("last_week");
  if (/\bthis week\b/.test(r)) set("this_week");
  if (/\btoday\b/.test(r)) set("today");
  if (/\byesterday\b/.test(r)) set("yesterday");
  if (/(last|past|previous|trailing) (\d+|\w+) days?\b/.test(r)) set("trailing_n_days");
  if (/(last|past|previous|trailing) (\d+|\w+) weeks\b/.test(r)) set("trailing_n_weeks");
  if (/(last|past|previous|trailing) (\d+|\w+) months\b/.test(r)) set("trailing_n_months");
  if (/(last|past|previous|trailing) (\d+|\w+) years\b/.test(r)) set("trailing_n_years");
  if (/\bq[1-4]\b|\b(first|second|third|fourth) quarter\b/.test(r)) set("specific_quarter", 4.5);
  else if (/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(r)) set(/\bsince\b/.test(r) ? "since_date" : /\bbefore\b/.test(r) ? "before_date" : /\bbetween\b|\bfrom\b.*\bto\b/.test(r) ? "between_dates" : "specific_month", 4.5);
  else if (/\b(in|during|for|of) (19|20)\d\d\b|\b(19|20)\d\d\b/.test(r)) set("specific_year", 4.5);
  if (/\bsince\b/.test(r) && !w.since_date) set("since_date", 2);
  return sharpen(w, 0.6);
}

function dateRole(request: string, span: string): Answer {
  const r = lc(request);
  const i = r.indexOf(lc(span));
  const before = r.slice(Math.max(0, i - 12), i);
  if (/\b(to|until|through|thru)\s*$/.test(before)) return sharpen({ start: 0, end: 4, before: 0, not_a_period: 0 });
  if (/\bbefore\s*$/.test(before)) return sharpen({ start: 0, end: 0, before: 4, not_a_period: 0 });
  return sharpen({ start: 4, end: 0, before: 0, not_a_period: 0 });
}

function numberRole(request: string, span: string, q: ChoiceQuestion): Answer {
  const r = lc(request);
  const sp = lc(span);
  const i = r.indexOf(sp);
  const before = r.slice(Math.max(0, i - 30), i);
  const after = r.slice(i + sp.length, i + sp.length + 40);
  const w: Record<string, number> = {};
  for (const k of Object.keys(q.criteria)) w[k] = 0;
  w.none = 0.3;
  if (/\b(top|bottom|first|last)\s*$/.test(before) && !/^\s*(days?|weeks?|months?|years?)/.test(after)) w.result_count = 5;
  if (/^\s*(most recent|latest|newest|oldest|biggest|largest|best)/.test(after) || /\bthe\s*$/.test(before) && /^\s*(most|latest)/.test(after)) w.result_count = 5;
  if (/^\s*(days?|weeks?|months?|quarters?|years?)\b/.test(after)) w.time_amount = 6;
  if (/(store|sku|#|number|no\.?)\s*$/.test(before)) w.part_of_name = 4;
  // thresholds: what follows the number names the target
  const isMoney = /\$/.test(span) || /^\s*(dollars|usd)/.test(after);
  const nextWords = after.replace(/^\s*(in|of|or more|or less|different|distinct)\s*/g, " ").trim();
  const threshold = /\b(more than|over|above|at least|less than|under|below|fewer than|at most|between|exceeding|and|or more|minimum|maximum|up to|cost)\s*$/.test(before) || /^\s*(or more|or less|\+)/.test(after) || /^\s*and \$?\d/.test(after) || /between \$?\d[\d,]* and\s*$/.test(before);
  if (threshold) {
    for (const k of Object.keys(q.criteria)) {
      if (!k.startsWith("threshold:")) continue;
      const [, kind, target] = /^threshold:(col|sum|count|saved):(.+)$/.exec(k)!;
      let s = 0.5;
      if (kind === "count") {
        const table = target.replace(/_/g, " ");
        const head = stem(singular(table.split(" ").pop()!));
        if (new RegExp(`^\\s*(different |distinct )?${head}`).test(nextWords) || new RegExp(`^\\s*(different |distinct )?\\w*\\s?${head}`).test(after)) s += 4;
        if (isMoney) s -= 3;
      } else if (kind === "col" || kind === "sum") {
        const col = target.split(".")[1];
        const tbl = target.split(".")[0];
        const money = /_cents$/.test(col) || /price|amount|total|cost/.test(col);
        if (isMoney && money) s += 2;
        if (!isMoney && money) s -= 1;
        // which money column: by table and words around
        if (isMoney && /\border/.test(r) && tbl === "orders" && col === "total_cents") s += 1.5;
        if (isMoney && /\bproducts?\b/.test(r) && /cost|price/.test(r) && col === "list_price_cents") s += 2;
        if (isMoney && /product sales|in sales|sales\b/.test(after) && col === "line_total_cents") s += 2.5;
        if (/^\s*units\b/.test(after) && col === "quantity") s += 4;
        if (kind === "sum") s -= 0.6; // row-level unless the phrasing is a per-group total
        if (kind === "sum" && /^\s*(units|in (product )?sales|in revenue|worth)/.test(after)) s += 2.6;
        if (kind === "sum" && /\b(sold|sales|in total|total)\b/.test(r) && /\b(products?|categories|customers|brands?)\b/.test(r) && (/^\s*units/.test(after) || /in (product )?sales/.test(after))) s += 1.5;
        if (kind === "col" && /^\s*(units|in (product )?sales)/.test(after)) s -= 1;
        if (kind === "col" && /orders? (over|above|under|below|between|less|more)/.test(r) && tbl === "orders") s += 1;
      } else if (kind === "saved") {
        if (new RegExp(target).test(after)) s += 3;
      }
      w[k] = Math.max(w[k], s);
    }
  }
  if (Object.values(w).every((x) => x <= 0.5)) w.none = 1;
  return sharpen(w, 0.5);
}

function op(request: string, span: string): Answer {
  const r = lc(request);
  const i = r.indexOf(lc(span));
  const before = r.slice(Math.max(0, i - 25), i);
  const after = r.slice(i + span.length, i + span.length + 20);
  const w: Record<string, number> = { gt: 0.3, gte: 0, lt: 0, lte: 0, eq: 0, between_low: 0, between_high: 0 };
  if (/between\s*$/.test(before)) w.between_low += 5;
  if (/between \$?[\d,.]+k?\s*and\s*$/.test(before)) w.between_high += 5;
  if (/(more than|over|above|exceeding|greater than)\s*$/.test(before)) w.gt += 4;
  if (/(at least|minimum of|no less than)\s*$/.test(before) || /^\s*(or more|\+)/.test(after)) w.gte += 4;
  if (/(less than|under|below|fewer than|cheaper than|cost less than)\s*$/.test(before)) w.lt += 4;
  if (/(at most|up to|no more than|maximum of)\s*$/.test(before) || /^\s*or less/.test(after)) w.lte += 4;
  if (/(exactly|equal to)\s*$/.test(before)) w.eq += 4;
  return sharpen(w, 0.5);
}

function filterPolarity(request: string, c: Record<string, string>): Answer {
  const r = lc(request);
  const mt = lc(c.matched_text);
  const i = r.indexOf(mt);
  const before = r.slice(Math.max(0, i - 25), i);
  const after = r.slice(i + mt.length, i + mt.length + 30);
  const attr = lc(c.attribute);
  const tableNoun = attr.split(" ")[0];
  const w = { keep_only: 0.5, exclude: 0, not_a_condition: 0.3 };
  if (/(excluding|except|not|other than|without|exclude|minus|ignoring)\s*(the\s*)?$/.test(before)) w.exclude += 4;
  const nextIsNoun = /^\s*[a-z]+s\b/.test(after) && !/^\s*(is|was|has|this|its)\b/.test(after);
  if (/^\s*(\w+ )?(amount|value|total)\b/.test(after) || /\bamount\s*$/.test(before)) w.not_a_condition += 3;
  if (/^(paid)$/.test(mt) && /amount paid|paid per/.test(r)) w.not_a_condition += 3;
  // the value sits right before a word naming its table ("phone tickets", "open tickets", "mobile devices")
  const tableWords = [tableNoun, stem(tableNoun), ...(tableNoun === "support" ? ["ticket", "tickets"] : []), ...(tableNoun === "web" ? ["session", "sessions", "device", "devices"] : [])];
  const nextWord = (/^\s*([a-z]+)/.exec(after)?.[1] ?? "");
  const nextIsTable = !!nextWord && tableWords.some((t) => t && (nextWord.startsWith(t) || stem(nextWord) === stem(t)));
  if (nextIsTable) w.keep_only += 2.5;
  else if (nextIsNoun) w.keep_only += 2;
  if (/\b(each|every|per|by)\s*$/.test(before) && !nextIsTable && !nextIsNoun) w.not_a_condition += 4;
  if (nextWord && attr.split(" ").slice(1).some((x) => stem(x) === stem(nextWord))) w.keep_only += 2.5;
  if (/(in the|in|from|for|to|at|of)\s*$/.test(before)) w.keep_only += 1.5;
  // the column's own table is not mentioned anywhere → probably coincidental
  const mentioned = tableWords.some((t) => t && new RegExp(`\\b${t}`).test(r)) || attr.split(" ").slice(1).some((x) => x.length > 3 && new RegExp(`\\b${stem(x)}`).test(r));
  if (!mentioned && !nextIsNoun) w.not_a_condition += 1.4;
  if (c.value && /^[A-Z]{2}$/.test(c.value) && /\b(to|in|from)\s*$/.test(before)) w.keep_only += 1;
  if (/\b(were|was|are|is|been)\s*$/.test(before) && /\b(how many)/.test(r)) w.keep_only += 2;
  return sharpen(w, 0.6);
}

function textCol(request: string, span: string, q: ChoiceQuestion): Answer {
  const win = lc(windowAround(request, span, 40, 10));
  const w: Record<string, number> = {};
  for (const [k, d] of Object.entries(q.criteria)) {
    if (k === "none") { w[k] = 0.4; continue; }
    const name = lc(d.replace(/\.$/, ""));
    let s = 0;
    for (const t of name.split(" ")) if (t.length > 2 && win.includes(t)) s += 1;
    if (win.includes(name)) s += 2;
    w[k] = s;
  }
  return sharpen(w, 0.5);
}

function textMode(request: string, span: string): Answer {
  const win = lc(windowAround(request, span, 25, 5));
  if (/contain|including|with \S+ in|has \S+ in|like/.test(win)) return sharpen({ exact: 0, contains: 4, starts_with: 0 });
  if (/start|begin/.test(win)) return sharpen({ exact: 0, contains: 0, starts_with: 4 });
  return sharpen({ exact: 3, contains: 1, starts_with: 0 });
}

function nullCheck(request: string, attribute: string): Answer {
  const r = lc(request);
  const a = lc(attribute);
  const words = a.split(" ").filter((x) => x.length > 2 && !STOPWORDS.has(x));
  if (!words.length) return P(0.04);
  // "unassigned" ↔ "assigned to employee"; "no coupon code" ↔ "coupon code" (the whole name)
  if (new RegExp(`\\bun${words[0]}\\b`).test(r)) return P(0.92);
  if (new RegExp(`\\b(no|without|missing|empty|blank)\\s+${words.map(stem).join("\\w*\\s+")}`).test(r)) return P(0.88);
  return P(0.04);
}

function boolFlag(request: string, attribute: string): Answer {
  const r = lc(request);
  const a = lc(attribute).split(" ").slice(1).join(" ");
  const words = a.split(" ").filter((x) => x.length > 2 && !["is", "has"].includes(x));
  const hit = words.length && words.every((x) => r.includes(stem(x)) || r.includes(x.replace(/_/g, " ")));
  const optIn = /opt in/.test(a) && /opted in|opt(ed)?[- ]in/.test(r);
  if (hit || optIn) {
    if (/\b(not|no|haven't|never|inactive|un)\b/.test(r)) return sharpen({ keep_true: 0, keep_false: 3, not_a_condition: 0.5 });
    return sharpen({ keep_true: 3.5, keep_false: 0, not_a_condition: 0.5 });
  }
  if (/\bactive\b/.test(r) && /active/.test(a)) return sharpen({ keep_true: 3, keep_false: 0, not_a_condition: 0.5 });
  return sharpen({ keep_true: 0, keep_false: 0, not_a_condition: 3 });
}

function derived(request: string, q: ChoiceQuestion): Answer {
  const r = lc(request);
  const w: Record<string, number> = { none: 1.5 };
  for (const k of Object.keys(q.criteria)) if (k !== "none") w[k] = 0;
  if (/\bshare\b|% of total|percent of total|proportion/.test(r)) w.share_of_total = 5;
  if (/running total|cumulative/.test(r)) w.running_total = 5;
  if (/growth|% change|percent change|month-over-month|month over month|year-over-year/.test(r)) w.pct_change_vs_previous = 5;
  else if (/\bchange\b|increase|decrease/.test(r)) w.change_vs_previous = 4;
  if (/rolling average|moving average|\d+-day average/.test(r)) w.moving_average = 5;
  if (/\brank\b/.test(r)) w.rank = 4;
  return sharpen(w, 0.5);
}

function timeColumn(request: string, q: ChoiceQuestion): Answer {
  const r = lc(request);
  const w: Record<string, number> = {};
  for (const [k, d] of Object.entries(q.criteria)) {
    const col = k.split(".").pop()!;
    const verb = col.replace(/_(at|on|date)$/, "").replace(/_/g, " ");
    let s = (/\(the usual time for this record\)/.test(d) ? 1 : 0) + (k === Object.keys(q.criteria)[0] ? 1.2 : 0);
    // the verb of the time column appears in the request ("delivered in August", "placed last month"),
    // but not inside an exclusion ("excluding cancelled orders")
    const vstem = stem(verb.split(" ")[0]);
    const verbHit = tokens(r).find((t) => t === verb || (stem(t) === vstem && /(ed|ing)$/.test(t)));
    if (verb.length > 3 && verbHit && !new RegExp(`(excluding|except|not|without|other than)\\s+(\\w+\\s)?${verbHit}`).test(r)) s += 4.5;
    if (/\b(ordered|bought|purchased|sold|orders?)\b/.test(r) && col === "placed_at") s += 1.6;
    if (/\b(order|ordered|buy|bought|purchase|purchased) (anything|something|nothing|an?|any)\b|\bplaced (an? )?orders?\b/.test(r) && col === "placed_at") s += 2;
    if (/\bsigned up|new customers|signups?\b|joined/.test(r) && col === "created_at" && /customer/.test(k)) s += 3;
    if (/\bsessions?\b|visits?/.test(r) && col === "started_at") s += 1;
    if (/\btickets?\b/.test(r) && col === "opened_at") s += 0.8;
    w[k] = s;
  }
  return sharpen(w, 0.6);
}

function absent(request: string, related: string): Answer {
  const r = lc(request);
  const head = stem(singular(lc(related).split(" ").pop()!));
  if (/\b(never|no|without|didn't|did not|haven't|hasn't|have not)\b/.test(r)) {
    if (new RegExp(`(never|no|without|didn't|did not|haven't|hasn't|have not)\\b[^.]*\\b(${head}|${verbFor(head)})`).test(r)) return P(0.9);
    if (head === "review" && /reviewed/.test(r)) return P(0.9);
    if (head === "order" && /\border(ed)?\b|\bbought\b|purchas/.test(r)) return P(0.9);
  }
  return P(0.05);
}

function verbFor(head: string) {
  return { order: "order", review: "review", payment: "pa(y|id)", refund: "refund", session: "visit" }[head] ?? head;
}

function present(request: string, related: string): Answer {
  const r = lc(request);
  const head = stem(singular(lc(related).split(" ").pop()!));
  if (new RegExp(`\\bwho (placed|made|bought|have|had)\\b[^.]*\\b${head}`).test(r)) return P(0.8);
  return P(0.1);
}

function partition(request: string, q: ChoiceQuestion): Answer {
  const r = lc(request);
  const w: Record<string, number> = {};
  for (const [k, d] of Object.entries(q.criteria)) {
    const noun = lc(d.replace(/^Within each /, "").replace(/\.$/, ""));
    const head = noun.split(" ").pop()!;
    w[k] = new RegExp(`\\b(each|every|per|within each|in each) (\\w+ )?${stem(head)}`).test(r) ? 4 : 0;
  }
  return sharpen(w, 0.5);
}

function path(request: string, q: ChoiceQuestion, attribute: string): Answer {
  const r = lc(request);
  const w: Record<string, number> = {};
  for (const [k, d] of Object.entries(q.criteria)) {
    if (k === "unclear") { w[k] = 1; continue; }
    let s = 0;
    const [, kind, val] = /^(via|role):(.+)$/.exec(k) ?? [];
    const word = lc(val ?? "").replace(/_/g, " ");
    if (kind === "role") {
      // "shipped to" ~ shipping, "assigned to" ~ assigned to, "create" ~ created by, "billed" ~ billing
      const st = stem(word.split(" ")[0]);
      if (tokens(r).some((t) => stem(t) === st || (st.length >= 4 && t.startsWith(st.slice(0, 4))))) s += 4;
    } else if (kind === "via") {
      const head = stem(singular(word.split(" ").pop()!));
      // "customer region", "fulfillment warehouse region", "customers in the West region"
      const attrHead = lc(attribute).split(" ")[0];
      if (new RegExp(`\\b${head}\\w*\\s+(\\w+\\s+)?${stem(attrHead)}`).test(r)) s += 4;
      else if (new RegExp(`\\b${head}\\w*\\b`).test(r)) s += 2.2;
      if (/fulfil/.test(r) && head === "warehouse") s += 2;
    }
    void d;
    w[k] = s;
  }
  return sharpen(w, 0.7);
}

const GENERIC = new Set(
  ("led lead sold sell sale sales get got did do does placed place spent spend had have has came come went make made " +
    "right now currently anything something each every per all total amount value number count new " +
    "show list give tell find which what how many much most least top bottom year month week quarter day today " +
    "record records thing things one ones data result results report fewest least lowest highest biggest smallest best worst " +
    "including include anything list ever").split(" "),
);

function covered(request: string, phrase: string, summary: string): Answer {
  const s = lc(summary);
  const sT = new Set(tokens(s).map(stem));
  const words = contentTokens(phrase).filter((t) => !GENERIC.has(t));
  if (!words.length) return P(0.95);
  const unknown = words.filter((t) => !sT.has(stem(t)) && !s.includes(t.slice(0, 5)));
  if (!unknown.length) return P(0.95);
  // business synonyms the narrative may express differently
  const SYN: Record<string, string[]> = {
    spent: ["total"], spend: ["total"], value: ["total"], sales: ["revenue", "line total", "quantity"], sold: ["quantity"], units: ["quantity", "unit"],
    revenue: ["revenue"], agent: ["employee"], support: ["ticket"], website: ["session"], growth: ["change"], inventory: ["on hand"],
    cost: ["price"], opted: ["opt in"], marketing: ["opt in"], unassigned: ["assigned"], recent: ["recent"], start: ["snapshot"],
    fulfillment: ["fulfilled"], enterprise: ["enterprise"], ultralight: ["ultralight"], landing: ["landing"], pages: ["page"],
    response: ["first response"], devices: ["device"], mobile: ["mobile"], phone: ["phone"], different: ["number of"],
    signup: ["created"], product: ["item", "product"], products: ["item", "product"], categories: ["category"], sessions: ["session"], signups: ["created"], customers: ["customer"], subcategories: ["subcategor"], camping: ["camping"],
    family: [], right: [], year: [], date: [],
  };
  const stillUnknown = unknown.filter((t) => !(SYN[t] ?? []).some((x) => s.includes(x)) && !(t in SYN && SYN[t].length === 0));
  if (!stillUnknown.length) return P(0.85);
  return P(0.12);
}
