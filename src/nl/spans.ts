import { STOPWORDS } from "./lexicon.js";

/** Typed spans with character offsets (spec §4.1). */
export type SpanType = "number" | "quoted" | "proper_noun" | "relative_time" | "explicit_date" | "content_phrase";

export interface Span {
  id: string;
  type: SpanType;
  text: string;
  start: number;
  end: number;
  /** numbers: parsed value; money/percent flags */
  value?: number;
  money?: boolean;
  percent?: boolean;
  /** explicit dates: parsed parts */
  date?: { year?: number; month?: number; quarter?: number; day?: number };
  /** the number is a year-like integer 1900..2100 */
  yearLike?: boolean;
}

const WORD_NUMS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, dozen: 12,
};

export const MONTH_NAMES: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
  august: 8, aug: 8, september: 9, sept: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};

const RELATIVE_TIME = [
  "year[- ]to[- ]date", "month[- ]to[- ]date", "quarter[- ]to[- ]date", "ytd", "mtd", "qtd",
  "(?:the )?(?:last|past|previous|prior|trailing) \\d+ (?:days?|weeks?|months?|quarters?|years?)",
  "(?:the )?(?:last|past|previous|prior|trailing) (?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirty|ninety) (?:days?|weeks?|months?|quarters?|years?)",
  "(?:this|last|previous|prior|current|past) (?:week|month|quarter|year)",
  "today", "yesterday", "(?:so far )?this year", "(?:in )?the same period last year", "right now", "currently",
  "(?:each|every|per) (?:day|week|month|quarter|year)", "(?:daily|weekly|monthly|quarterly|yearly|annually|annual)",
  "month[- ]over[- ]month", "year[- ]over[- ]year", "week[- ]over[- ]week",
];

/** Extract spans. Deterministic, no model calls. */
export function extractSpans(request: string): Span[] {
  const spans: Span[] = [];
  const taken: [number, number][] = [];
  const overlaps = (s: number, e: number) => taken.some(([a, b]) => s < b && e > a);
  const push = (sp: Omit<Span, "id">) => {
    spans.push({ ...sp, id: "" });
    taken.push([sp.start, sp.end]);
  };
  const lower = request.toLowerCase();

  // quoted strings
  for (const m of request.matchAll(/["“']([^"”']{2,})["”']/g)) {
    if (m[0].startsWith("'") && /\w'\w/.test(request.slice(Math.max(0, m.index! - 1), m.index! + 2))) continue;
    push({ type: "quoted", text: m[1], start: m.index! + 1, end: m.index! + 1 + m[1].length });
  }

  // explicit dates: ISO dates, "Q2 2025", "March 2025", "March 5", "in 2025"
  for (const m of request.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    if (overlaps(m.index!, m.index! + m[0].length)) continue;
    push({ type: "explicit_date", text: m[0], start: m.index!, end: m.index! + m[0].length, date: { year: +m[1], month: +m[2], day: +m[3] } });
  }
  for (const m of request.matchAll(/\b[Qq]([1-4])(?:\s*(?:of\s+)?(\d{4}))?\b/g)) {
    if (overlaps(m.index!, m.index! + m[0].length)) continue;
    push({ type: "explicit_date", text: m[0], start: m.index!, end: m.index! + m[0].length, date: { quarter: +m[1], year: m[2] ? +m[2] : undefined } });
  }
  for (const m of request.matchAll(/\b(first|second|third|fourth) quarter(?: of)?(?:\s+(\d{4}))?/gi)) {
    if (overlaps(m.index!, m.index! + m[0].length)) continue;
    const qn = { first: 1, second: 2, third: 3, fourth: 4 }[m[1].toLowerCase() as "first"];
    push({ type: "explicit_date", text: m[0], start: m.index!, end: m.index! + m[0].length, date: { quarter: qn, year: m[2] ? +m[2] : undefined } });
  }
  const monthRe = new RegExp(`\\b(${Object.keys(MONTH_NAMES).join("|")})\\.?(?:\\s+(\\d{1,2})(?:st|nd|rd|th)?)?(?:,?\\s+(\\d{4}))?\\b`, "gi");
  for (const m of request.matchAll(monthRe)) {
    const word = m[1].toLowerCase();
    // "may" and "mar" are ambiguous English words; require a capital or a following number
    if ((word === "may" || word === "mar" || word === "dec" || word === "jun") && !/^[A-Z]/.test(m[1]) && !m[2] && !m[3]) continue;
    if (overlaps(m.index!, m.index! + m[0].length)) continue;
    const day = m[2] ? +m[2] : undefined;
    push({
      type: "explicit_date", text: m[0], start: m.index!, end: m.index! + m[0].length,
      date: { month: MONTH_NAMES[word], day: day && day <= 31 ? day : undefined, year: m[3] ? +m[3] : undefined },
    });
  }

  // relative time phrases
  for (const pat of RELATIVE_TIME) {
    for (const m of lower.matchAll(new RegExp(`\\b${pat}\\b`, "g"))) {
      if (overlaps(m.index!, m.index! + m[0].length)) continue;
      push({ type: "relative_time", text: request.slice(m.index!, m.index! + m[0].length), start: m.index!, end: m.index! + m[0].length });
    }
  }

  // numbers (digits with currency / suffix / percent), then word numbers.
  // Numbers inside relative-time phrases still count ("last 8 weeks" → 8 is a time_amount).
  const numRe = /(\$\s?)?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(k|m|mm|million|thousand|bn|billion)?\b(\s?%| percent)?/gi;
  for (const m of request.matchAll(numRe)) {
    const s = m.index!, e = s + m[0].trimEnd().length;
    if (spans.some((x) => (x.type === "quoted" || x.type === "explicit_date") && s >= x.start && e <= x.end && !(x.type === "explicit_date" && x.date?.day !== undefined && false))) {
      // years inside "March 2025" are part of the date; skip
      continue;
    }
    // part of an identifier like NP-1000123 or SKU-12
    if (/[A-Za-z]-?$/.test(request.slice(Math.max(0, s - 2), s)) && !m[1]) continue;
    let v = Number(m[2].replace(/,/g, ""));
    const suf = (m[3] ?? "").toLowerCase();
    if (suf === "k" || suf === "thousand") v *= 1e3;
    else if (suf === "m" || suf === "mm" || suf === "million") v *= 1e6;
    else if (suf === "bn" || suf === "billion") v *= 1e9;
    const yearLike = !m[1] && !m[3] && !m[4] && Number.isInteger(v) && v >= 1900 && v <= 2100 && m[2].length === 4;
    spans.push({ id: "", type: "number", text: m[0].trim(), start: s, end: e, value: v, money: !!m[1], percent: !!m[4], yearLike });
  }
  for (const m of lower.matchAll(new RegExp(`\\b(a )?(${Object.keys(WORD_NUMS).join("|")})\\b`, "g"))) {
    const s = m.index! + (m[1]?.length ?? 0);
    const e = m.index! + m[0].length;
    if (spans.some((x) => x.type === "number" && s < x.end && e > x.start)) continue;
    if (m[2] === "one" && /\bone (of|another)\b/.test(lower.slice(s))) continue;
    spans.push({ id: "", type: "number", text: request.slice(s, e), start: s, end: e, value: WORD_NUMS[m[2]] });
  }

  // proper nouns: capitalized word sequences not at sentence start (or that are clearly names)
  for (const m of request.matchAll(/\b([A-Z][\w&'.-]*(?:\s+(?:[A-Z][\w&'.-]*|&|of|de|la|and)){0,5}(?:\s+[A-Z][\w&'.-]*)?)/g)) {
    let text = m[1].replace(/\s+(of|de|la|and|&)$/i, "");
    let s = m.index!;
    // drop a leading sentence-initial question word / verb
    const first = text.split(/\s+/)[0];
    if (s === 0 || /[.?!]\s*$/.test(request.slice(0, s))) {
      if (STOPWORDS.has(first.toLowerCase()) || /^(List|Show|Give|Find|Which|What|How|Who|Top|Total|Number|Average|Monthly|Weekly|Daily|Yearly|Same|Customers|Orders|Products|Categories|Revenue|Order|Share|Running|Most|Units|Year|Delete|Profit)$/.test(first)) {
        const rest = text.slice(first.length).trimStart();
        if (!rest || !/^[A-Z]/.test(rest)) continue;
        s += text.length - rest.length;
        text = rest;
      }
    }
    if (MONTH_NAMES[text.toLowerCase()] || /^(Q[1-4]|I|YTD|MTD)$/.test(text)) continue;
    const e = s + text.length;
    if (spans.some((x) => (x.type === "explicit_date" || x.type === "quoted" || x.type === "relative_time") && s < x.end && e > x.start)) continue;
    spans.push({ id: "", type: "proper_noun", text, start: s, end: e });
  }

  // content phrases: maximal runs of non-stopword tokens
  const tokRe = /[A-Za-z][A-Za-z'-]*|\$?\d[\d,.]*%?/g;
  let run: { s: number; e: number; words: string[] } | null = null;
  const flushRun = () => {
    if (run && run.words.length) {
      const text = request.slice(run.s, run.e);
      if (!/^\$?\d/.test(text)) spans.push({ id: "", type: "content_phrase", text, start: run.s, end: run.e });
    }
    run = null;
  };
  for (const m of request.matchAll(tokRe)) {
    const w = m[0].toLowerCase().replace(/'s$/, "");
    const isContent = !STOPWORDS.has(w) && !/^\$?\d/.test(w) && !WORD_NUMS[w];
    if (isContent) {
      if (run && /^[\s-]*$/.test(request.slice(run.e, m.index!))) {
        run.e = m.index! + m[0].length;
        run.words.push(w);
      } else {
        flushRun();
        run = { s: m.index!, e: m.index! + m[0].length, words: [w] };
      }
    } else flushRun();
  }
  flushRun();

  spans.sort((a, b) => a.start - b.start || a.type.localeCompare(b.type));
  const counters: Record<string, number> = {};
  for (const sp of spans) {
    const k = sp.type === "number" ? "num" : sp.type === "content_phrase" ? "phrase" : sp.type === "proper_noun" ? "pn" : sp.type === "quoted" ? "q" : sp.type === "relative_time" ? "rt" : "date";
    sp.id = `${k}${counters[k] = (counters[k] ?? -1) + 1}`;
  }
  return spans;
}

/** Text window around a span, for local cue matching. */
export function window(request: string, span: { start: number; end: number }, before = 30, after = 30): string {
  return request.slice(Math.max(0, span.start - before), Math.min(request.length, span.end + after));
}
