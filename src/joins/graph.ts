import type { Relationship, SchemaModel } from "../schema/model.js";

/** One traversal step. "up" = child→parent (N:1, never multiplies rows); "down" = parent→child (1:N). */
export interface Step {
  rel: Relationship;
  dir: "up" | "down";
  from: string;
  to: string;
}

export interface JoinPath {
  from: string;
  to: string;
  steps: Step[];
  /** number of 1:N steps (fan-out risk) */
  downs: number;
  /** "via the order's customer → the customer's region" */
  label: string;
  /** stable key: relationship ids joined by "|" */
  key: string;
}

export class JoinGraph {
  private adj = new Map<string, Step[]>();

  constructor(readonly model: SchemaModel) {
    for (const r of model.relationships) {
      if (r.selfReference) continue; // R4 hierarchies are recorded, not traversed (v2)
      if (model.tables[r.from.table]?.hidden || model.tables[r.to.table]?.hidden) continue;
      this.add({ rel: r, dir: "up", from: r.from.table, to: r.to.table });
      this.add({ rel: r, dir: "down", from: r.to.table, to: r.from.table });
    }
  }

  private add(s: Step) {
    const xs = this.adj.get(s.from) ?? [];
    xs.push(s);
    this.adj.set(s.from, xs);
  }

  neighbors(t: string): Step[] {
    return this.adj.get(t) ?? [];
  }

  /** All simple paths from → to up to maxLen steps. */
  paths(from: string, to: string, maxLen = 4): JoinPath[] {
    if (from === to) return [mkPath(from, to, [])];
    const out: JoinPath[] = [];
    const walk = (cur: string, steps: Step[], seen: Set<string>) => {
      if (steps.length > maxLen) return;
      if (cur === to) {
        out.push(mkPath(from, to, steps.slice()));
        return;
      }
      for (const s of this.neighbors(cur)) {
        if (seen.has(s.to)) continue;
        // don't pass *through* a junction's far side as an intermediate entity unless it is the target
        seen.add(s.to);
        steps.push(s);
        walk(s.to, steps, seen);
        steps.pop();
        seen.delete(s.to);
      }
    };
    walk(from, [], new Set([from]));
    return out.sort((a, b) => a.downs - b.downs || a.steps.length - b.steps.length);
  }

  /**
   * Best paths from → to: the minimal set by (downs, length). More than one → ambiguous
   * (role-playing FKs, or two routes such as orders→customers→regions vs orders→warehouses→regions).
   */
  bestPaths(from: string, to: string): JoinPath[] {
    const all = this.paths(from, to);
    if (!all.length) return [];
    const best = all[0];
    return all.filter((p) => p.downs === best.downs && p.steps.length === best.steps.length);
  }

  /** Up-only (N:1) reachability: tables whose rows are determined by one `from` row. */
  upReachable(from: string, maxLen = 5): Map<string, JoinPath[]> {
    const out = new Map<string, JoinPath[]>();
    const walk = (cur: string, steps: Step[], seen: Set<string>) => {
      if (steps.length) {
        const p = mkPath(from, cur, steps.slice());
        out.set(cur, [...(out.get(cur) ?? []), p]);
      }
      if (steps.length >= maxLen) return;
      for (const s of this.neighbors(cur)) {
        if (s.dir !== "up" || seen.has(s.to)) continue;
        seen.add(s.to);
        steps.push(s);
        walk(s.to, steps, seen);
        steps.pop();
        seen.delete(s.to);
      }
    };
    walk(from, [], new Set([from]));
    out.set(from, [mkPath(from, from, [])]);
    return out;
  }

  /** Is `to` reachable from `from` by N:1 steps only? */
  isUp(from: string, to: string): boolean {
    return from === to || this.upReachable(from).has(to);
  }

  /**
   * Root (FROM table) for a set of anchors: the first candidate from which every anchor is
   * up-reachable. Candidates: `preferred` first, then the anchors, then any table that
   * points (transitively, up) to all anchors: the most direct bridge (fewest total hops,
   * e.g. order_items for orders × products, never refunds), non-junction first.
   */
  findRoot(anchors: string[], preferred: string[] = []): string | undefined {
    const ok = (r: string) => anchors.every((a) => this.isUp(r, a));
    for (const p of [...preferred, ...anchors]) if (ok(p)) return p;
    const cands = Object.keys(this.model.tables).filter((t) => !this.model.tables[t].hidden && ok(t));
    if (!cands.length) return undefined;
    const hops = (r: string) => {
      const up = this.upReachable(r);
      return anchors.reduce((s, a) => s + Math.min(...(up.get(a) ?? []).map((p) => p.steps.length)), 0);
    };
    const h = new Map(cands.map((c) => [c, hops(c)]));
    cands.sort((a, b) => h.get(a)! - h.get(b)! || (this.model.tables[a].junction ? 1 : 0) - (this.model.tables[b].junction ? 1 : 0) || this.model.tables[b].rowEstimate - this.model.tables[a].rowEstimate);
    return cands[0];
  }
}

function mkPath(from: string, to: string, steps: Step[]): JoinPath {
  return {
    from,
    to,
    steps,
    downs: steps.filter((s) => s.dir === "down").length,
    key: steps.map((s) => s.rel.id).join("|") || "self",
    label: describePath(steps),
  };
}

export function describePath(steps: Step[]): string {
  if (!steps.length) return "directly";
  return steps
    .map((s) => (s.dir === "up" ? s.rel.label : `the ${s.rel.from.table.replace(/_/g, " ")} of the ${s.rel.to.table.replace(/_/g, " ")}`))
    .join(" → ");
}

/** Option text for a path ambiguity: "The region of the order's customer (via customers)." */
export function pathOptionText(p: JoinPath, attribute: string): string {
  const hops = p.steps.slice(0, -1);
  if (!hops.length) return `The ${attribute} of ${p.steps[0]?.rel.label ?? "the record itself"}.`;
  const via = hops.map((s) => (s.dir === "up" ? s.rel.label : `the related ${s.to.replace(/_/g, " ")}`)).join(", then ");
  return `The ${attribute} of ${via}.`;
}
