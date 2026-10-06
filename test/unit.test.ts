import { describe, expect, it } from "vitest";
import { assignSpans, hungarian, jointDecode } from "../src/plan/decode.js";
import { extractSpans } from "../src/nl/spans.js";
import { periodBounds } from "../src/time/periods.js";
import { singular, stem } from "../src/nl/lexicon.js";
import { parsePgArray } from "../src/schema/introspect.js";
import { averageChoices, choiceFromWeights } from "../src/oracle/types.js";

const ts = { asOf: new Date("2026-10-05T00:00:00Z"), timezone: "UTC", weekStart: "monday" as const };
const iso = (d?: Date) => d?.toISOString().slice(0, 10);

describe("period library (§5.8)", () => {
  it.each([
    ["last_month", "2026-09-01", "2026-10-01"],
    ["last_quarter", "2026-07-01", "2026-10-01"],
    ["this_year", "2026-01-01", "2026-10-05"],
    ["last_year", "2025-01-01", "2026-01-01"],
    ["last_week", "2026-09-28", "2026-10-05"],
    ["this_month", "2026-10-01", "2026-10-05"],
  ] as const)("%s", (key, start, end) => {
    const b = periodBounds({ key }, ts)!;
    expect([iso(b.start), iso(b.end)]).toEqual([start, end]);
  });

  it("trailing weeks use the time_amount", () => {
    const b = periodBounds({ key: "trailing_n_weeks", n: 8 }, ts)!;
    expect(iso(b.start)).toBe("2026-08-10");
  });

  it("named month without a year is the most recent past occurrence", () => {
    expect(iso(periodBounds({ key: "specific_month", start: { month: 9 } }, ts)!.start)).toBe("2026-09-01");
    expect(iso(periodBounds({ key: "specific_month", start: { month: 11 } }, ts)!.start)).toBe("2025-11-01");
  });

  it("quarters and years", () => {
    const q = periodBounds({ key: "specific_quarter", start: { quarter: 2, year: 2026 } }, ts)!;
    expect([iso(q.start), iso(q.end)]).toEqual(["2026-04-01", "2026-07-01"]);
    const y = periodBounds({ key: "specific_year", start: { year: 2025 } }, ts)!;
    expect([iso(y.start), iso(y.end)]).toEqual(["2025-01-01", "2026-01-01"]);
  });

  it("respects a non-UTC timezone (half-open, DST-safe)", () => {
    const b = periodBounds({ key: "last_month" }, { ...ts, timezone: "America/Los_Angeles" })!;
    expect(b.start!.toISOString()).toBe("2026-09-01T07:00:00.000Z");
    expect(b.end!.toISOString()).toBe("2026-10-01T07:00:00.000Z");
  });

  it("sunday week start", () => {
    const b = periodBounds({ key: "last_week" }, { ...ts, weekStart: "sunday" })!;
    expect(iso(b.start)).toBe("2026-09-27");
  });
});

describe("span extraction (§4.1)", () => {
  it("numbers with currency, suffixes and words", () => {
    const s = extractSpans("Top five categories with over $100,000 or 1.5k units, more than 10%");
    const nums = s.filter((x) => x.type === "number").map((x) => [x.value, !!x.money, !!x.percent]);
    expect(nums).toEqual([[5, false, false], [100000, true, false], [1500, false, false], [10, false, true]]);
  });

  it("relative time, explicit dates and quarters", () => {
    const s = extractSpans("Orders in Q2 2026 vs last quarter, and since March 5");
    expect(s.filter((x) => x.type === "explicit_date").map((x) => x.date)).toEqual([{ quarter: 2, year: 2026 }, { month: 3, day: 5, year: undefined }]);
    expect(s.some((x) => x.type === "relative_time" && x.text === "last quarter")).toBe(true);
  });

  it("proper nouns skip sentence-initial verbs", () => {
    const s = extractSpans("Which customers from West Ridge Supply Co placed orders?");
    expect(s.filter((x) => x.type === "proper_noun").map((x) => x.text)).toEqual(["West Ridge Supply Co"]);
  });

  it("year-like numbers are flagged", () => {
    expect(extractSpans("revenue in 2025").find((x) => x.type === "number")?.yearLike).toBe(true);
  });
});

describe("decoding", () => {
  it("hungarian finds the min-cost assignment", () => {
    const a = hungarian([[4, 1, 3], [2, 0, 5], [3, 2, 2]]);
    expect(a).toEqual([1, 0, 2]);
  });

  it("assignSpans never double-assigns single-use roles", () => {
    const out = assignSpans(["a", "b"], { a: { result_count: 0.9, none: 0.05 }, b: { result_count: 0.8, time_amount: 0.15, none: 0.05 } });
    expect(out.a.role).toBe("result_count");
    expect(out.b.role).toBe("time_amount");
  });

  it("masked joint decoding never returns an illegal pair and reports the masked winner", () => {
    const r = jointDecode({ price: 0.9, qty: 0.1 }, { sum: 0.9, avg: 0.1 }, (q, a) => !(q === "price" && a === "sum"));
    expect(r.best).toEqual(["price", "avg"]);
    expect(r.illegalBest?.a).toBe("price");
  });

  it("averaging two orderings of a choice", () => {
    const a = averageChoices(choiceFromWeights({ x: 0.6, y: 0.4 }), choiceFromWeights({ x: 0.4, y: 0.6 }));
    expect(a.probabilities.x).toBeCloseTo(0.5);
  });
});

describe("lexicon & catalog parsing", () => {
  it("inflection", () => {
    expect(singular("categories")).toBe("category");
    expect(singular("addresses")).toBe("address");
    expect(stem("refunded")).toBe(stem("refunds"));
    expect(stem("shipped")).toBe(stem("shipped_at".replace(/_at$/, "")));
  });
  it("pg array literals", () => {
    expect(parsePgArray('{a,"b c",NULL,"d\\"e"}')).toEqual(["a", "b c", 'd"e']);
  });
});
