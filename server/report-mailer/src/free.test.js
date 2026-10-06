// Tests for the free Workers AI fallback (explainScanFree, and the routing
// in index.js once Claude's budget is spent), run by the repo's `npm test`.
// Workers AI (env.AI) and the Anthropic API are stubbed: nothing is sent.
import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "./index.js";
import { explainScanFree, workersAiContent, parseAnswerText } from "./explain.js";
import { budgetBinding } from "./budget.test.js";

const MODEL = "@cf/google/gemma-4-26b-a4b-it";
const goodAnswer = { summary: "Mostly fine.", findings: [{ severity: "low", title: "Disk", detail: "60% used", fix: "Nothing yet" }] };

// Workers AI, stubbed: records each call, answers with `reply()` or throws `fail`.
function workersAi({ reply = () => ({ response: goodAnswer }), fail } = {}) {
  const calls = [];
  return { calls, run: async (model, input) => { calls.push({ model, input }); if (fail) throw fail; return reply(); } };
}

// A fetch that fails the test if anything tries to reach Claude.
const noClaude = async (url) => { throw new Error(`unexpected request to ${url}`); };

const req = (ip = "198.51.100.7") => new Request("https://mailer.example.workers.dev/explain", {
  method: "POST",
  headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
  body: JSON.stringify({ scan: { os: { name: "Windows 11" } } }),
});
const answerOf = async (res) => ({ status: res.status, body: await res.json() });

// Claude's day already spent, the free model configured.
const env = (over = {}) => ({ ANTHROPIC_API_KEY: "sk-test", AI_DAILY_LIMIT: "0", AI_BUDGET: budgetBinding(), AI: workersAi(), FREE_AI_MODEL: MODEL, ...over });

test("once Claude's budget is spent", async (t) => {
  await t.test("the free model answers, and Claude is never called", async () => {
    const e = env();
    const res = await answerOf(await handleRequest(req(), e, noClaude));
    assert.deepEqual(res, { status: 200, body: { ok: true, ...goodAnswer, model: MODEL } });
    assert.equal(e.AI.calls.length, 1);
    assert.equal(e.AI.calls[0].model, MODEL);
    assert.equal(e.AI.calls[0].input.response_format.type, "json_schema");
  });

  await t.test("without a free model configured, it's still Claude's limit", async () => {
    for (const over of [{ FREE_AI_MODEL: "" }, { AI: undefined }]) {
      const res = await answerOf(await handleRequest(req(), env(over), noClaude));
      assert.deepEqual(res, { status: 429, body: { ok: false, error: "ai-daily-limit" } });
    }
    const monthly = await answerOf(await handleRequest(req(), env({ AI_DAILY_LIMIT: "10", AI_MONTHLY_LIMIT: "0", FREE_AI_MODEL: "" }), noClaude));
    assert.equal(monthly.body.error, "ai-monthly-limit");
  });

  await t.test("the free pool has its own per-caller and daily caps", async () => {
    const e = env({ FREE_AI_DAILY_PER_IP_LIMIT: "2", FREE_AI_DAILY_LIMIT: "3" });
    const statuses = [];
    for (const ip of ["198.51.100.1", "198.51.100.1", "198.51.100.1", "198.51.100.2", "198.51.100.3"]) {
      statuses.push((await handleRequest(req(ip), e, noClaude)).status);
    }
    assert.deepEqual(statuses, [200, 200, 429, 200, 429]);
    assert.equal(e.AI.calls.length, 3);
  });

  await t.test("Cloudflare's free allocation used up reads as today's limit, and is given back", async () => {
    const e = env({ AI: workersAi({ fail: new Error("4006: you have used up your daily free allocation of 10,000 neurons") }) });
    const res = await answerOf(await handleRequest(req(), e, noClaude));
    assert.deepEqual(res, { status: 429, body: { ok: false, error: "ai-daily-limit" } });
    assert.equal(e.AI_BUDGET.store.get("usage:free").dayCount, 0);
  });

  await t.test("a model that can't be reached is unreachable, and is given back", async () => {
    const e = env({ AI: workersAi({ fail: new Error("InferenceUpstreamError") }) });
    assert.deepEqual(await answerOf(await handleRequest(req(), e, noClaude)), { status: 502, body: { ok: false, error: "ai-unreachable" } });
    assert.equal(e.AI_BUDGET.store.get("usage:free").dayCount, 0);
  });

  await t.test("an answer that isn't the schema is a bad answer, and counts", async () => {
    for (const reply of [() => ({ response: "Sorry, I can't help." }), () => ({ response: { summary: "" } }), () => null]) {
      const e = env({ AI: workersAi({ reply }) });
      const res = await answerOf(await handleRequest(req(), e, noClaude));
      assert.deepEqual(res, { status: 502, body: { ok: false, error: "ai-bad-answer" } });
      assert.equal(e.AI_BUDGET.store.get("usage:free").dayCount, 1);
    }
  });

  await t.test("the free model's answer is capped and re-shaped like Claude's", async () => {
    const evil = { summary: "x".repeat(5000), findings: Array.from({ length: 9 }, () => ({ severity: "high", title: "T", detail: "D", fix: "F", extra: 1 })) };
    const res = await answerOf(await handleRequest(req(), env({ AI: workersAi({ reply: () => ({ response: evil }) }) }), noClaude));
    assert.equal(res.body.summary.length, 600);
    assert.equal(res.body.findings.length, 5);
    assert.deepEqual(Object.keys(res.body.findings[0]).sort(), ["detail", "fix", "severity", "title"]);
  });

  await t.test("a free pool counter that can't answer is busy, not free for all", async () => {
    const AI_BUDGET = budgetBinding();
    const broken = { ...AI_BUDGET, get: () => ({ fetch: async (url, init) => (JSON.parse(init.body).pool === "free" ? new Response("", { status: 500 }) : AI_BUDGET.get().fetch(url, init)) }) };
    const res = await answerOf(await handleRequest(req(), env({ AI_BUDGET: broken }), noClaude));
    assert.deepEqual(res, { status: 503, body: { ok: false, error: "ai-busy" } });
  });
});

test("explainScanFree", async (t) => {
  await t.test("sends only the sanitized scan, never extra fields", async () => {
    const AI = workersAi();
    await explainScanFree({ hostname: "EVONS-LAPTOP", os: { name: "Windows 11" } }, { AI, FREE_AI_MODEL: MODEL });
    assert.ok(!JSON.stringify(AI.calls[0].input).includes("EVONS-LAPTOP"));
  });
});

test("reading Workers AI's answer", async (t) => {
  await t.test("both response shapes", () => {
    assert.deepEqual(workersAiContent({ response: goodAnswer }), goodAnswer);
    assert.equal(workersAiContent({ choices: [{ message: { content: "{}" } }] }), "{}");
    assert.equal(workersAiContent(null), null);
    assert.equal(workersAiContent({}), null);
  });

  await t.test("JSON text, with or without a code fence; anything else is null", () => {
    assert.deepEqual(parseAnswerText('{"summary":"a"}'), { summary: "a" });
    assert.deepEqual(parseAnswerText('```json\n{"summary":"a"}\n```'), { summary: "a" });
    assert.deepEqual(parseAnswerText({ summary: "a" }), { summary: "a" });
    assert.equal(parseAnswerText("not json"), null);
    assert.equal(parseAnswerText(undefined), null);
  });
});
