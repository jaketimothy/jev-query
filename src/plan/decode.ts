import type { ChoiceAnswer } from "../oracle/types.js";

/**
 * Hungarian algorithm (min-cost assignment) on an n×m cost matrix, n ≤ m.
 * Returns assignment[row] = column.
 */
export function hungarian(cost: number[][]): number[] {
  const n = cost.length;
  if (!n) return [];
  const m = cost[0].length;
  const INF = 1e18;
  const u = new Array(n + 1).fill(0), v = new Array(m + 1).fill(0), p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(INF);
    const used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF, j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const assign = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) assign[p[j] - 1] = j - 1;
  return assign;
}

/**
 * Assignment over slots (spec §1): spans × roles with probabilities; each role can be used
 * at most once except roles listed in `reusable`; every span also has a private "none" slack.
 */
export function assignSpans(
  spans: string[],
  probs: Record<string, Record<string, number>>,
  reusable: (role: string) => boolean = () => false,
): Record<string, { role: string; p: number }> {
  const roles = [...new Set(spans.flatMap((s) => Object.keys(probs[s] ?? {})))].filter((r) => r !== "none");
  // expand reusable roles into one column per span
  const cols: string[] = [];
  for (const r of roles) {
    if (reusable(r)) for (let i = 0; i < spans.length; i++) cols.push(r);
    else cols.push(r);
  }
  const slackStart = cols.length;
  for (let i = 0; i < spans.length; i++) cols.push(`none#${i}`);
  const cost = spans.map((s, i) =>
    cols.map((c, j) => {
      if (j >= slackStart) return j - slackStart === i ? -Math.log(Math.max(1e-6, probs[s]?.none ?? 0.05)) : 1e9;
      return -Math.log(Math.max(1e-9, probs[s]?.[c] ?? 0));
    }),
  );
  const a = hungarian(cost);
  const out: Record<string, { role: string; p: number }> = {};
  spans.forEach((s, i) => {
    const c = cols[a[i]];
    const role = !c || c.startsWith("none#") ? "none" : c;
    out[s] = { role, p: role === "none" ? probs[s]?.none ?? 0 : probs[s]?.[role] ?? 0 };
  });
  return out;
}

/** Masked joint decoding: P(a, b) ∝ P(a)·P(b)·legal(a, b). */
export function jointDecode<A extends string, B extends string>(
  pa: Record<A, number>,
  pb: Record<B, number>,
  legal: (a: A, b: B) => boolean,
  bIgnored: (a: A) => B | undefined = () => undefined,
): { best: [A, B]; p: number; dist: { a: A; b: B; p: number }[]; illegalBest?: { a: A; b: B; p: number } } {
  const dist: { a: A; b: B; p: number }[] = [];
  let illegalBest: { a: A; b: B; p: number } | undefined;
  for (const a of Object.keys(pa) as A[]) {
    const fixed = bIgnored(a);
    if (fixed) {
      dist.push({ a, b: fixed, p: pa[a] });
      continue;
    }
    for (const b of Object.keys(pb) as B[]) {
      const p = pa[a] * pb[b];
      if (legal(a, b)) dist.push({ a, b, p });
      else if (!illegalBest || p > illegalBest.p) illegalBest = { a, b, p };
    }
  }
  const total = dist.reduce((s, x) => s + x.p, 0) || 1;
  for (const x of dist) x.p /= total;
  dist.sort((x, y) => y.p - x.p);
  return { best: [dist[0].a, dist[0].b], p: dist[0].p, dist, illegalBest: illegalBest ? { ...illegalBest, p: illegalBest.p / total } : undefined };
}

export function top(a: ChoiceAnswer | undefined, n = 3): { key: string; p: number }[] {
  if (!a) return [];
  return Object.entries(a.probabilities)
    .map(([key, p]) => ({ key, p }))
    .sort((x, y) => y.p - x.p)
    .slice(0, n);
}
