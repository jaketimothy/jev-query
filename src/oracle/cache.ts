import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Answers, AskOptions, Oracle, Questions } from "./types.js";

/**
 * Caches answers per (state, question) on disk so eval runs and tests are
 * reproducible and cheap to repeat. Questions are cached individually, so a round
 * that adds one question only pays for that question.
 */
export class CachingOracle implements Oracle {
  readonly name: string;
  private mem = new Map<string, Answers[string]>();
  constructor(private readonly inner: Oracle, private readonly dir?: string, private readonly mode: "readwrite" | "readonly" = "readwrite") {
    this.name = inner.name;
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  async ask(state: unknown, questions: Questions, opts?: AskOptions): Promise<Answers> {
    const stateKey = hash(JSON.stringify(state));
    const out: Answers = {};
    const missing: Questions = {};
    const keys: Record<string, string> = {};
    for (const [id, q] of Object.entries(questions)) {
      const key = hash(`${this.inner.name}|${stateKey}|${JSON.stringify(q)}`);
      keys[id] = key;
      const hit = this.mem.get(key) ?? this.readDisk(key);
      if (hit) out[id] = hit;
      else missing[id] = q;
    }
    if (Object.keys(missing).length) {
      if (this.mode === "readonly") throw new Error(`CachingOracle(readonly): ${Object.keys(missing).length} uncached questions, e.g. ${Object.keys(missing)[0]}`);
      const fresh = await this.inner.ask(state, missing, opts);
      for (const [id, a] of Object.entries(fresh)) {
        out[id] = a;
        this.mem.set(keys[id], a);
        if (this.dir) writeFileSync(join(this.dir, `${keys[id]}.json`), JSON.stringify(a));
      }
    }
    return out;
  }

  private readDisk(key: string) {
    if (!this.dir) return undefined;
    const p = join(this.dir, `${key}.json`);
    if (!existsSync(p)) return undefined;
    const a = JSON.parse(readFileSync(p, "utf8"));
    this.mem.set(key, a);
    return a;
  }
}

/** Wraps an oracle and records every round (state, questions, answers) for debugging. */
export class RecordingOracle implements Oracle {
  readonly name: string;
  readonly log: { round?: string; state: unknown; questions: Questions; answers: Answers; ms: number }[] = [];
  constructor(private readonly inner: Oracle) {
    this.name = inner.name;
  }
  async ask(state: unknown, questions: Questions, opts?: AskOptions): Promise<Answers> {
    const t0 = Date.now();
    const answers = await this.inner.ask(state, questions, opts);
    this.log.push({ round: opts?.round, state, questions, answers, ms: Date.now() - t0 });
    return answers;
  }
}

function hash(s: string) {
  return createHash("sha256").update(s).digest("hex").slice(0, 32);
}
