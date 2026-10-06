/** Small built-in lexicon (spec §2.2): inflection, a few business synonyms, and value aliases. */

const IRREGULAR: Record<string, string> = {
  people: "person", children: "child", men: "man", women: "woman", data: "datum", indices: "index",
  addresses: "address", statuses: "status", categories: "category", companies: "company", analyses: "analysis",
};

export function singular(w: string): string {
  const lw = w.toLowerCase();
  if (IRREGULAR[lw]) return IRREGULAR[lw];
  if (/(ss|us|is)$/.test(lw)) return lw;
  if (/ies$/.test(lw) && lw.length > 4) return lw.slice(0, -3) + "y";
  if (/(xes|ches|shes|sses|zes)$/.test(lw)) return lw.slice(0, -2);
  if (/s$/.test(lw) && lw.length > 3) return lw.slice(0, -1);
  return lw;
}

export function plural(w: string): string {
  const lw = w.toLowerCase();
  for (const [p, s] of Object.entries(IRREGULAR)) if (s === lw) return p;
  if (/[^aeiou]y$/.test(lw)) return lw.slice(0, -1) + "ies";
  if (/(s|x|ch|sh|z)$/.test(lw)) return lw + "es";
  return lw + "s";
}

/** Crude stemmer for matching ("refunded" ~ "refunds" ~ "refund", "shipped" ~ "shipping"). */
export function stem(w: string): string {
  let s = w.toLowerCase();
  if (s.length <= 3) return s;
  s = singular(s);
  s = s.replace(/(ing|ed|er|ly|ment|ation)$/, "");
  if (/(.)\1$/.test(s) && !/(ll|ss)$/.test(s)) s = s.slice(0, -1);
  return s.length >= 3 ? s : w.toLowerCase();
}

export function humanize(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const SYNONYM_GROUPS: string[][] = [
  ["customer", "client", "buyer", "account", "shopper", "member"],
  ["order", "purchase", "sale", "transaction"],
  ["product", "item", "sku", "article", "good"],
  ["employee", "staff", "agent", "rep", "worker", "team member"],
  ["support ticket", "ticket", "case", "request", "issue"],
  ["web session", "session", "visit", "website session"],
  ["warehouse", "distribution center", "dc", "fulfillment center"],
  ["region", "territory", "area"],
  ["category", "product category", "department"],
  ["review", "rating", "feedback"],
  ["payment", "charge"],
  ["refund", "return", "reimbursement"],
  ["inventory snapshot", "inventory", "stock", "on hand"],
  ["address", "location"],
  ["tag", "label"],
  ["user", "member", "person"],
  ["invoice", "bill"],
  ["subscription", "plan"],
];

export function synonymsFor(phrase: string): string[] {
  const p = phrase.toLowerCase();
  const sp = p.split(" ").map(singular).join(" ");
  const out = new Set<string>();
  for (const g of SYNONYM_GROUPS) {
    if (g.includes(sp) || g.includes(p)) for (const s of g) if (s !== sp) out.add(s);
  }
  return [...out];
}

export const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia",
  WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia",
};

export const COUNTRIES: Record<string, string> = {
  US: "United States", CA: "Canada", GB: "United Kingdom", DE: "Germany", FR: "France", MX: "Mexico", JP: "Japan",
  AU: "Australia", IN: "India", BR: "Brazil", CN: "China", ES: "Spain", IT: "Italy", NL: "Netherlands",
};

/**
 * Aliases a known value may be referred to by in requests (e.g. state code "UT" ↔ "Utah").
 * Keyed by column-name hint.
 */
export function valueAliases(column: string, value: string): string[] {
  const c = column.toLowerCase();
  const out: string[] = [];
  if (/state/.test(c) && US_STATES[value.toUpperCase()]) out.push(US_STATES[value.toUpperCase()]);
  if (/country/.test(c) && COUNTRIES[value.toUpperCase()]) out.push(COUNTRIES[value.toUpperCase()]);
  if (value.includes("_")) out.push(value.replace(/_/g, " "));
  if (value.includes("-")) out.push(value.replace(/-/g, " "));
  return out;
}

export const STOPWORDS = new Set(
  (
    "a an the of for to in on at by with from and or but is are was were be been being do does did have has had " +
    "how many much what which who whom whose when where why show me list give get find tell our we us my i you " +
    "their them they it its this that these those there here all any each every per than then as into about " +
    "over under between more less most least top bottom number count total amount average sum please can could " +
    "would should will shall may might must also just only not no never ever same thing like vs versus compared " +
    "did does so up out off s"
  ).split(" "),
);

export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? []).map((t) => t.replace(/'s$/, ""));
}

export function contentTokens(text: string): string[] {
  return tokens(text).filter((t) => !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

/** Normalize an identifier for convention matching: customerId / CustomerID / customer-id → customer_id. */
export function snake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}
