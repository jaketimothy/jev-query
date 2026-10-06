import type { Answer, Answers, AskOptions, Oracle, Questions } from "./types.js";

export interface JevOracleOptions {
  /**
   * Full URL of the System One decisions endpoint. Defaults to `JEV_URL`, else the
   * OpenRouter endpoint. TypeSafe's native API and Cloudflare Workers AI accept the
   * same `{model, state, questions}` body.
   */
  url?: string;
  /** Bearer token. Defaults to `JEV_API_KEY`, `TYPESAFE_API_KEY`, then `OPENROUTER_API_KEY`. */
  apiKey?: string;
  /** Defaults to `JEV_MODEL` or `typesafe/jev-1.13`. */
  model?: string;
  /**
   * Questions in one request are evaluated independently, so large rounds are split
   * into parallel requests of at most this many questions.
   */
  maxQuestionsPerRequest?: number;
  /** Max concurrent HTTP requests per ask(). */
  concurrency?: number;
  retries?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  /** Called after each HTTP call with token usage, for cost tracking. */
  onUsage?: (usage: { input_tokens?: number; output_tokens?: number; cost?: number }, round?: string) => void;
}

const DEFAULT_URL = "https://openrouter.ai/api/v1/systemone";

/** Oracle backed by TypeSafe Jev (spec §1). */
export class JevOracle implements Oracle {
  readonly name: string;
  private readonly url: string;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly opts: JevOracleOptions;

  constructor(opts: JevOracleOptions = {}) {
    const env = typeof process !== "undefined" ? process.env : {};
    this.opts = opts;
    this.url = opts.url ?? env.JEV_URL ?? DEFAULT_URL;
    this.apiKey = opts.apiKey ?? env.JEV_API_KEY ?? env.TYPESAFE_API_KEY ?? env.OPENROUTER_API_KEY;
    this.model = opts.model ?? env.JEV_MODEL ?? "typesafe/jev-1.13";
    this.name = `jev:${this.model}`;
    if (!this.apiKey) {
      throw new Error("JevOracle: no API key. Set JEV_API_KEY, TYPESAFE_API_KEY or OPENROUTER_API_KEY, or pass { apiKey }.");
    }
  }

  async ask(state: unknown, questions: Questions, opts: AskOptions = {}): Promise<Answers> {
    const ids = Object.keys(questions);
    if (ids.length === 0) return {};
    const size = this.opts.maxQuestionsPerRequest ?? 120;
    const batches: string[][] = [];
    for (let i = 0; i < ids.length; i += size) batches.push(ids.slice(i, i + size));
    const out: Answers = {};
    const limit = this.opts.concurrency ?? 6;
    let next = 0;
    const worker = async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        const qs: Questions = {};
        for (const id of batch) qs[id] = questions[id];
        Object.assign(out, await this.call(state, qs, opts));
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, batches.length) }, worker));
    return out;
  }

  private async call(state: unknown, questions: Questions, opts: AskOptions): Promise<Answers> {
    const f = this.opts.fetch ?? fetch;
    const body = JSON.stringify({ model: this.model, state, questions });
    const retries = this.opts.retries ?? 3;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 60_000);
      opts.signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
      try {
        const res = await f(this.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
            ...this.opts.headers,
          },
          body,
          signal: ctrl.signal,
        });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`Jev HTTP ${res.status}: ${await res.text()}`);
          await sleep(500 * 2 ** attempt);
          continue;
        }
        if (!res.ok) throw new Error(`Jev HTTP ${res.status}: ${await res.text()}`);
        const json = (await res.json()) as { answers?: Record<string, unknown>; usage?: never; result?: { answers?: Record<string, unknown> } };
        const answers = json.answers ?? json.result?.answers;
        if (!answers) throw new Error(`Jev: response has no answers: ${JSON.stringify(json).slice(0, 300)}`);
        if (json.usage) this.opts.onUsage?.(json.usage, opts.round);
        const out: Answers = {};
        for (const [id, raw] of Object.entries(answers)) out[id] = normalizeAnswer(raw as Record<string, unknown>, questions[id]?.type);
        return out;
      } catch (e) {
        lastErr = e;
        if (opts.signal?.aborted) throw e;
        if (attempt < retries) await sleep(500 * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }
}

function normalizeAnswer(raw: Record<string, unknown>, type?: string): Answer {
  const t = (raw.type as string) ?? type;
  if (t === "noul") {
    const p = typeof raw.noul === "number" ? raw.noul : typeof raw.probability === "number" ? raw.probability : Number(raw.noul);
    return { type: "noul", noul: p };
  }
  const probabilities: Record<string, number> = {};
  for (const [k, v] of Object.entries((raw.probabilities as Record<string, number>) ?? {})) probabilities[k] = Number(v);
  if (t === "score") {
    return { type: "score", score: Number(raw.score), probabilities, confidence: Number(raw.confidence ?? 0) };
  }
  return { type: "choice", choice: String(raw.choice), probabilities, confidence: Number(raw.confidence ?? probabilities[String(raw.choice)] ?? 0) };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
