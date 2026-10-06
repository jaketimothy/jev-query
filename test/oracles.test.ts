import { describe, expect, it, vi } from "vitest";
import { CachingOracle, JevOracle, LogprobOracle, type Questions } from "../src/index.js";

const qs: Questions = {
  shape: { type: "choice", instructions: "What kind of answer?", criteria: { a: "A", b: "B" } },
  flag: { type: "noul", instructions: { question: "Is it?", span: "5" } },
  spec: { type: "score", instructions: "How clear?", criteria: ["low", "mid", "high"] },
};

function jevFetch(calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[], status: number[] = []) {
  return vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, body, headers: init.headers as Record<string, string> });
    const st = status.shift() ?? 200;
    if (st !== 200) return new Response("busy", { status: st });
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(body.questions as Questions)) {
      if (q.type === "noul") answers[id] = { type: "noul", noul: 0.8 };
      else if (q.type === "score") answers[id] = { type: "score", score: 1.8, confidence: 0.7, probabilities: { "0": 0.1, "1": 0.0, "2": 0.9 } };
      else answers[id] = { type: "choice", choice: "b", confidence: 0.9, probabilities: { a: 0.1, b: 0.9 } };
    }
    return new Response(JSON.stringify({ model: "typesafe/jev-1.13", answers, usage: { input_tokens: 100, output_tokens: 5 } }), { status: 200 });
  });
}

describe("JevOracle", () => {
  it("sends {model, state, questions} with bearer auth and normalizes answers", async () => {
    const calls: Parameters<typeof jevFetch>[0] = [];
    const usage = vi.fn();
    const o = new JevOracle({ apiKey: "test-key", url: "https://example.test/decisions", fetch: jevFetch(calls) as never, onUsage: usage });
    const a = await o.ask({ request: "hi" }, qs, { round: "R1" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://example.test/decisions");
    expect(calls[0].headers.authorization).toBe("Bearer test-key");
    expect(calls[0].body).toMatchObject({ model: "typesafe/jev-1.13", state: { request: "hi" } });
    expect(Object.keys(calls[0].body.questions as object)).toEqual(["shape", "flag", "spec"]);
    expect(a.shape).toMatchObject({ type: "choice", choice: "b", confidence: 0.9 });
    expect(a.flag).toEqual({ type: "noul", noul: 0.8 });
    expect(a.spec).toMatchObject({ type: "score", score: 1.8 });
    expect(usage).toHaveBeenCalledWith({ input_tokens: 100, output_tokens: 5 }, "R1");
  });

  it("splits large rounds into parallel batches (questions are independent)", async () => {
    const calls: Parameters<typeof jevFetch>[0] = [];
    const many: Questions = {};
    for (let i = 0; i < 25; i++) many[`q${i}`] = { type: "noul", instructions: `q ${i}` };
    const o = new JevOracle({ apiKey: "k", url: "https://example.test/d", fetch: jevFetch(calls) as never, maxQuestionsPerRequest: 10 });
    const a = await o.ask("state", many);
    expect(calls).toHaveLength(3);
    expect(Object.keys(a)).toHaveLength(25);
  });

  it("retries on 429/5xx", async () => {
    const calls: Parameters<typeof jevFetch>[0] = [];
    const o = new JevOracle({ apiKey: "k", url: "https://example.test/d", fetch: jevFetch(calls, [429, 503]) as never, retries: 3 });
    const a = await o.ask("s", { flag: qs.flag });
    expect(calls).toHaveLength(3);
    expect(a.flag).toEqual({ type: "noul", noul: 0.8 });
  });

  it("requires an API key", () => {
    const env = { ...process.env };
    delete process.env.JEV_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    expect(() => new JevOracle()).toThrow(/API key/);
    process.env = env;
  });
});

describe("CachingOracle", () => {
  it("only asks for questions it has not seen", async () => {
    const calls: Parameters<typeof jevFetch>[0] = [];
    const inner = new JevOracle({ apiKey: "k", url: "https://example.test/d", fetch: jevFetch(calls) as never });
    const o = new CachingOracle(inner);
    await o.ask("s", { shape: qs.shape });
    await o.ask("s", { shape: qs.shape, flag: qs.flag });
    expect(calls).toHaveLength(2);
    expect(Object.keys(calls[1].body.questions as object)).toEqual(["flag"]);
  });
});

describe("LogprobOracle", () => {
  it("reads label log-probabilities and renormalizes", async () => {
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const isNoul = String(body.messages[1].content).includes("Answer Yes or No");
      const top = isNoul
        ? [{ token: "Yes", logprob: Math.log(0.75) }, { token: "No", logprob: Math.log(0.25) }]
        : [{ token: "A", logprob: Math.log(0.2) }, { token: "B", logprob: Math.log(0.6) }, { token: "C", logprob: Math.log(0.2) }];
      return new Response(JSON.stringify({ choices: [{ logprobs: { content: [{ top_logprobs: top }] } }] }));
    });
    const o = new LogprobOracle({ baseUrl: "http://localhost:8000/v1", model: "m", fetch: f as never });
    const a = await o.ask({ request: "x" }, { shape: qs.shape, flag: qs.flag });
    expect(a.flag.type === "noul" && a.flag.noul).toBeCloseTo(0.75);
    expect(a.shape.type === "choice" && a.shape.choice).toBe("b");
    expect(a.shape.type === "choice" && a.shape.probabilities.b).toBeCloseTo(0.75);
  });
});
