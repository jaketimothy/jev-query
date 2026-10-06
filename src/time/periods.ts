/**
 * Closed relative-period library (spec §4.4, §5.8). Jev picks a key; code computes
 * half-open [start, end) bounds in the org timezone. All math is here, never in the model.
 */

export const PERIOD_KEYS = [
  "none", "today", "yesterday", "this_week", "last_week", "this_month", "last_month", "this_quarter", "last_quarter",
  "this_year", "last_year", "trailing_n_days", "trailing_n_weeks", "trailing_n_months", "trailing_n_years",
  "specific_month", "specific_quarter", "specific_year", "specific_day", "since_date", "before_date", "between_dates",
] as const;
export type PeriodKey = (typeof PERIOD_KEYS)[number];

export const PERIOD_CRITERIA: Record<PeriodKey, string> = {
  none: "No time restriction: all time, or the current state ('right now', 'currently', 'how much do we have').",
  today: "Today.",
  yesterday: "Yesterday.",
  this_week: "The current week so far ('this week').",
  last_week: "The previous complete calendar week ('last week').",
  this_month: "The current month so far ('this month', 'month to date', 'MTD').",
  last_month: "The previous complete calendar month ('last month').",
  this_quarter: "The current quarter so far ('this quarter', 'QTD').",
  last_quarter: "The previous complete calendar quarter ('last quarter').",
  this_year: "The current year so far ('this year', 'YTD', 'year to date').",
  last_year: "The previous complete calendar year ('last year').",
  trailing_n_days: "A rolling number of days ending now ('last 30 days', 'past 7 days').",
  trailing_n_weeks: "A rolling number of weeks ending now ('last 8 weeks', 'past 6 weeks').",
  trailing_n_months: "A rolling number of months ending now ('last 3 months', 'past 12 months').",
  trailing_n_years: "A rolling number of years ending now ('last 2 years').",
  specific_month: "A named month ('in March', 'September', 'March 2025').",
  specific_quarter: "A named quarter ('Q2 2025', 'second quarter').",
  specific_year: "A named year ('in 2024', 'during 2025').",
  specific_day: "A single named date ('on March 5', '2025-03-05').",
  since_date: "From a specific date until now ('since January 15').",
  before_date: "Before a specific date ('before March 2025').",
  between_dates: "Between two specific dates ('from March 1 to April 15').",
};

export interface DateParts {
  year?: number;
  month?: number; // 1-12
  quarter?: number; // 1-4
  day?: number;
}

export interface PeriodSpec {
  key: PeriodKey;
  n?: number;
  start?: DateParts;
  end?: DateParts;
}

export interface Bounds {
  /** inclusive, UTC instant */
  start?: Date;
  /** exclusive, UTC instant */
  end?: Date;
  /** human label: "Jul 1 – Sep 30, 2026" */
  label: string;
}

export interface TimeSettings {
  asOf: Date;
  timezone: string;
  weekStart: "monday" | "sunday";
}

/** Wall-clock parts of `d` in `tz`. */
export function wallParts(d: Date, tz: string) {
  if (tz === "UTC") return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), dow: d.getUTCDay() };
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", weekday: "short",
  });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(d)) p[x.type] = x.value;
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second, dow };
}

/** UTC instant of wall-clock midnight y-m-d in tz (handles DST by iterating the offset). */
export function zonedMidnight(y: number, m: number, d: number, tz: string): Date {
  // Normalize overflow (month 13, day 0, ...) via UTC date arithmetic first.
  const base = new Date(Date.UTC(y, m - 1, d));
  if (tz === "UTC") return base;
  let guess = base.getTime();
  for (let i = 0; i < 3; i++) {
    const w = wallParts(new Date(guess), tz);
    const wallAsUtc = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
    const diff = wallAsUtc - base.getTime();
    if (diff === 0) break;
    guess -= diff;
  }
  return new Date(guess);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmt(d: Date, tz: string, withYear = true) {
  const w = wallParts(d, tz);
  return `${MONTHS[w.m - 1]} ${w.d}${withYear ? `, ${w.y}` : ""}`;
}

export function boundsLabel(start: Date | undefined, end: Date | undefined, tz: string): string {
  if (!start && !end) return "all time";
  if (start && !end) return `since ${fmt(start, tz)}`;
  if (!start && end) return `before ${fmt(end, tz)}`;
  const last = new Date(end!.getTime() - 1);
  const sameYear = wallParts(start!, tz).y === wallParts(last, tz).y;
  if (start!.getTime() === zonedMidnight(wallParts(last, tz).y, wallParts(last, tz).m, wallParts(last, tz).d, tz).getTime()) return fmt(start!, tz);
  return `${fmt(start!, tz, !sameYear)} – ${fmt(last, tz)}`;
}

/**
 * Compute [start, end) for a period. Returns undefined when the parts needed are missing.
 * "this_*" periods end at as_of (so far); "last_*" are complete calendar periods.
 */
export function periodBounds(spec: PeriodSpec, ts: TimeSettings): Bounds | undefined {
  const { asOf, timezone: tz } = ts;
  const now = wallParts(asOf, tz);
  const mid = (y: number, m: number, d: number) => zonedMidnight(y, m, d, tz);
  const today = mid(now.y, now.m, now.d);
  const weekOffset = ts.weekStart === "monday" ? (now.dow + 6) % 7 : now.dow;
  const thisWeek = mid(now.y, now.m, now.d - weekOffset);
  const q0 = Math.floor((now.m - 1) / 3) * 3 + 1;
  let start: Date | undefined;
  let end: Date | undefined;
  const n = spec.n ?? 1;
  switch (spec.key) {
    case "none":
      return { label: "all time" };
    case "today": [start, end] = [today, mid(now.y, now.m, now.d + 1)]; break;
    case "yesterday": [start, end] = [mid(now.y, now.m, now.d - 1), today]; break;
    case "this_week": [start, end] = [thisWeek, asOf]; break;
    case "last_week": [start, end] = [mid(now.y, now.m, now.d - weekOffset - 7), thisWeek]; break;
    case "this_month": [start, end] = [mid(now.y, now.m, 1), asOf]; break;
    case "last_month": [start, end] = [mid(now.y, now.m - 1, 1), mid(now.y, now.m, 1)]; break;
    case "this_quarter": [start, end] = [mid(now.y, q0, 1), asOf]; break;
    case "last_quarter": [start, end] = [mid(now.y, q0 - 3, 1), mid(now.y, q0, 1)]; break;
    case "this_year": [start, end] = [mid(now.y, 1, 1), asOf]; break;
    case "last_year": [start, end] = [mid(now.y - 1, 1, 1), mid(now.y, 1, 1)]; break;
    case "trailing_n_days": [start, end] = [new Date(asOf.getTime() - n * 86400_000), asOf]; break;
    case "trailing_n_weeks": [start, end] = [new Date(asOf.getTime() - n * 7 * 86400_000), asOf]; break;
    case "trailing_n_months": [start, end] = [mid(now.y, now.m - n, now.d), asOf]; break;
    case "trailing_n_years": [start, end] = [mid(now.y - n, now.m, now.d), asOf]; break;
    case "specific_year": {
      const y = spec.start?.year;
      if (!y) return undefined;
      [start, end] = [mid(y, 1, 1), mid(y + 1, 1, 1)];
      break;
    }
    case "specific_quarter": {
      const qn = spec.start?.quarter;
      if (!qn) return undefined;
      const y = spec.start?.year ?? inferYear(now, qn * 3);
      [start, end] = [mid(y, (qn - 1) * 3 + 1, 1), mid(y, qn * 3 + 1, 1)];
      break;
    }
    case "specific_month": {
      const m = spec.start?.month;
      if (!m) return undefined;
      const y = spec.start?.year ?? inferYear(now, m);
      [start, end] = [mid(y, m, 1), mid(y, m + 1, 1)];
      break;
    }
    case "specific_day": {
      const p = spec.start;
      if (!p?.month || !p.day) return undefined;
      const y = p.year ?? inferYear(now, p.month, p.day);
      [start, end] = [mid(y, p.month, p.day), mid(y, p.month, p.day + 1)];
      break;
    }
    case "since_date": {
      const s = partsStart(spec.start, now, tz);
      if (!s) return undefined;
      [start, end] = [s, asOf];
      break;
    }
    case "before_date": {
      const s = partsStart(spec.start ?? spec.end, now, tz);
      if (!s) return undefined;
      end = s;
      break;
    }
    case "between_dates": {
      const s = partsStart(spec.start, now, tz);
      const e = partsEnd(spec.end, now, tz);
      if (!s || !e) return undefined;
      [start, end] = [s, e];
      break;
    }
  }
  return { start, end, label: boundsLabel(start, end, tz) };
}

/** Most recent past (or current-and-complete) occurrence of month m (spec §5.8: "code infers the most recent past occurrence"). */
function inferYear(now: { y: number; m: number; d: number }, m: number, d = 1): number {
  if (m < now.m || (m === now.m && d < now.d && d !== 1)) return now.y;
  return now.y - 1;
}

function partsStart(p: DateParts | undefined, now: { y: number; m: number; d: number }, tz: string): Date | undefined {
  if (!p) return undefined;
  if (p.month) {
    const y = p.year ?? inferYear(now, p.month, p.day ?? 1);
    return zonedMidnight(y, p.month, p.day ?? 1, tz);
  }
  if (p.quarter) return zonedMidnight(p.year ?? now.y, (p.quarter - 1) * 3 + 1, 1, tz);
  if (p.year) return zonedMidnight(p.year, 1, 1, tz);
  return undefined;
}

/** Exclusive end for an end date: the day after a named day, the month after a named month. */
function partsEnd(p: DateParts | undefined, now: { y: number; m: number; d: number }, tz: string): Date | undefined {
  if (!p) return undefined;
  if (p.month) {
    const y = p.year ?? inferYear(now, p.month, p.day ?? 1);
    return p.day ? zonedMidnight(y, p.month, p.day + 1, tz) : zonedMidnight(y, p.month + 1, 1, tz);
  }
  if (p.quarter) return zonedMidnight(p.year ?? now.y, p.quarter * 3 + 1, 1, tz);
  if (p.year) return zonedMidnight(p.year + 1, 1, 1, tz);
  return undefined;
}

/** Period of the same length one year earlier (for "compared with the same period last year"). */
export function shiftYears(b: Bounds, years: number, tz: string): Bounds {
  const sh = (d?: Date) => {
    if (!d) return undefined;
    const w = wallParts(d, tz);
    const midnight = zonedMidnight(w.y + years, w.m, w.d, tz);
    return new Date(midnight.getTime() + (w.h * 3600 + w.mi * 60 + w.s) * 1000);
  };
  const start = sh(b.start), end = sh(b.end);
  return { start, end, label: boundsLabel(start, end, tz) };
}

export function previousPeriod(b: Bounds, tz: string): Bounds | undefined {
  if (!b.start || !b.end) return undefined;
  const len = b.end.getTime() - b.start.getTime();
  const start = new Date(b.start.getTime() - len);
  return { start, end: b.start, label: boundsLabel(start, b.start, tz) };
}
