/**
 * The composer depends on one function (spec §9):
 *
 *   ask(state, questions) -> answers
 *
 * Questions are typed decisions over code-enumerated options. Any backend that can
 * return calibrated distributions for Choice / Score / Noul questions can drive the
 * composer: Jev, a self-hosted logprob model, a cache, or the offline heuristic oracle.
 */

/** `instructions` may be a plain string or a structured object whose fields are referenced by backtick path. */
export type Instructions = string | Record<string, unknown>;

export interface ChoiceQuestion {
  type: "choice";
  instructions: Instructions;
  /** option key -> description. 2–255 options. */
  criteria: Record<string, string>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: Instructions;
  /** ordered levels, lowest first. 2–10 levels. */
  criteria: string[];
}

export interface NoulQuestion {
  type: "noul";
  instructions: Instructions;
  criteria?: { true: string; false: string };
}

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;
export type Questions = Record<string, Question>;

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  /** expected level index (0-based) */
  score: number;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface NoulAnswer {
  type: "noul";
  /** probability of yes */
  noul: number;
}

export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;
export type Answers = Record<string, Answer>;

export interface AskOptions {
  /** Round label, for logging and caching ("R0", "R1", ...). */
  round?: string;
  signal?: AbortSignal;
}

export interface Oracle {
  /** Human-readable backend name, recorded in provenance. */
  readonly name: string;
  ask(state: unknown, questions: Questions, opts?: AskOptions): Promise<Answers>;
}

/** Confidence of a Noul, per spec §8.3: |p − 0.5| · 2. */
export function noulConfidence(p: number): number {
  return Math.abs(p - 0.5) * 2;
}

/** Build a ChoiceAnswer from (possibly unnormalized) weights. */
export function choiceFromWeights(weights: Record<string, number>): ChoiceAnswer {
  const keys = Object.keys(weights);
  let total = 0;
  for (const k of keys) total += Math.max(0, weights[k]);
  const probabilities: Record<string, number> = {};
  for (const k of keys) probabilities[k] = total > 0 ? Math.max(0, weights[k]) / total : 1 / keys.length;
  const sorted = keys.slice().sort((a, b) => probabilities[b] - probabilities[a]);
  return { type: "choice", choice: sorted[0], probabilities, confidence: probabilities[sorted[0]] };
}

export function scoreFromWeights(weights: number[]): ScoreAnswer {
  const total = weights.reduce((a, b) => a + Math.max(0, b), 0) || 1;
  const probabilities: Record<string, number> = {};
  let score = 0;
  let best = 0;
  weights.forEach((w, i) => {
    const p = Math.max(0, w) / total;
    probabilities[String(i)] = p;
    score += i * p;
    if (p > (probabilities[String(best)] ?? 0)) best = i;
  });
  return { type: "score", score, probabilities, confidence: probabilities[String(best)] };
}

/** Top-2 margin of a choice answer. */
export function choiceMargin(a: ChoiceAnswer): number {
  const ps = Object.values(a.probabilities).sort((x, y) => y - x);
  return (ps[0] ?? 0) - (ps[1] ?? 0);
}

/** Average two choice distributions (used for option-order debiasing, §8.3). */
export function averageChoices(a: ChoiceAnswer, b: ChoiceAnswer): ChoiceAnswer {
  const w: Record<string, number> = {};
  for (const k of new Set([...Object.keys(a.probabilities), ...Object.keys(b.probabilities)])) {
    w[k] = ((a.probabilities[k] ?? 0) + (b.probabilities[k] ?? 0)) / 2;
  }
  return choiceFromWeights(w);
}
