import { choiceFromWeights, scoreFromWeights } from "./types.js";
import type { Answers, AskOptions, ChoiceQuestion, Instructions, NoulQuestion, Oracle, Question, Questions, ScoreQuestion } from "./types.js";

export interface LogprobOracleOptions {
  /** Base URL of an OpenAI-compatible server (vLLM, SGLang, llama.cpp server, ...), e.g. http://localhost:8000/v1 */
  baseUrl: string;
  model: string;
  apiKey?: string;
  concurrency?: number;
  fetch?: typeof fetch;
  /** Per-family temperature for calibration (spec §9): p ∝ exp(logp / T). */
  temperature?: (questionId: string) => number;
}

const LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".split("");

/**
 * Self-hosted equivalent of Jev (spec §9): one completion token per question, read
 * next-token log-probabilities over option labels and renormalize. The shared state
 * is placed first so prefix caching makes a round one prefill plus N short suffixes.
 */
export class LogprobOracle implements Oracle {
  readonly name: string;
  constructor(private readonly opts: LogprobOracleOptions) {
    this.name = `logprob:${opts.model}`;
  }

  async ask(state: unknown, questions: Questions, _opts?: AskOptions): Promise<Answers> {
    const ids = Object.keys(questions);
    const out: Answers = {};
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const id = ids[next++];
        out[id] = await this.one(id, state, questions[id]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.opts.concurrency ?? 16, ids.length) }, worker));
    return out;
  }

  private async one(id: string, state: unknown, q: Question): Promise<Answers[string]> {
    const T = this.opts.temperature?.(id) ?? 1;
    if (q.type === "noul") {
      const lp = await this.labelLogprobs(prompt(state, q, ["Yes", "No"]), ["Yes", "No"]);
      const y = Math.exp(lp.Yes / T), n = Math.exp(lp.No / T);
      return { type: "noul" as const, noul: y / (y + n || 1) };
    }
    if (q.type === "score") {
      const labels = q.criteria.map((_, i) => String(i));
      const lp = await this.labelLogprobs(prompt(state, q, labels), labels);
      return scoreFromWeights(labels.map((l) => Math.exp(lp[l] / T)));
    }
    const keys = Object.keys(q.criteria);
    if (keys.length > LABELS.length) {
      // Hierarchical: pick a winner within each group, then among winners.
      const groups: string[][] = [];
      for (let i = 0; i < keys.length; i += LABELS.length) groups.push(keys.slice(i, i + LABELS.length));
      const winners: Record<string, string> = {};
      for (const g of groups) {
        const sub: ChoiceQuestion = { ...q, criteria: Object.fromEntries(g.map((k) => [k, q.criteria[k]])) };
        const a = await this.one(id, state, sub);
        if (a.type === "choice") winners[a.choice] = q.criteria[a.choice];
      }
      return this.one(id, state, { ...q, criteria: winners });
    }
    const labels = keys.map((_, i) => LABELS[i]);
    const lp = await this.labelLogprobs(prompt(state, q, labels), labels);
    const w: Record<string, number> = {};
    keys.forEach((k, i) => (w[k] = Math.exp(lp[labels[i]] / T)));
    return choiceFromWeights(w);
  }

  private async labelLogprobs(messages: { role: string; content: string }[], labels: string[]): Promise<Record<string, number>> {
    const f = this.opts.fetch ?? fetch;
    const res = await f(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.opts.model, messages, max_tokens: 1, temperature: 0, logprobs: true, top_logprobs: 20 }),
    });
    if (!res.ok) throw new Error(`LogprobOracle HTTP ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { choices: { logprobs?: { content?: { top_logprobs?: { token: string; logprob: number }[] }[] } }[] };
    const top = json.choices[0]?.logprobs?.content?.[0]?.top_logprobs ?? [];
    const out: Record<string, number> = {};
    for (const l of labels) out[l] = -50;
    for (const t of top) {
      const tok = t.token.trim();
      if (tok in out) out[tok] = Math.max(out[tok], t.logprob);
    }
    return out;
  }
}

function renderInstructions(ins: Instructions): string {
  return typeof ins === "string" ? ins : JSON.stringify(ins, null, 1);
}

function prompt(state: unknown, q: Question, labels: string[]) {
  const system =
    "You answer typed decision questions about the given state. Answer with exactly one label and nothing else.";
  const stateText = typeof state === "string" ? state : JSON.stringify(state, null, 1);
  let body = `Question: ${renderInstructions(q.instructions)}\n`;
  if (q.type === "choice") {
    Object.entries((q as ChoiceQuestion).criteria).forEach(([, desc], i) => (body += `${labels[i]}. ${desc}\n`));
  } else if (q.type === "score") {
    (q as ScoreQuestion).criteria.forEach((desc, i) => (body += `${labels[i]}. ${desc}\n`));
  } else {
    const c = (q as NoulQuestion).criteria;
    if (c) body += `Yes means: ${c.true}\nNo means: ${c.false}\n`;
    body += "Answer Yes or No.\n";
  }
  return [
    { role: "system", content: system },
    { role: "user", content: `State:\n${stateText}\n\n${body}Answer:` },
  ];
}
