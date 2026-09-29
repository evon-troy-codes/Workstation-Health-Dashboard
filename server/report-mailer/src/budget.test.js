// Unit tests for the AI's monthly and daily caps (budget.js), run by the repo's
// `npm test`. Durable Object storage is an in-memory Map; the date is a fake
// clock.
import test from "node:test";
import assert from "node:assert/strict";
import { AiBudget, take, limitSetting, limitsFrom, spendAiBudget, DEFAULT_MONTHLY_LIMIT, DEFAULT_DAILY_LIMIT } from "./budget.js";

// A Durable Object namespace holding one AiBudget over in-memory storage, as
// env.AI_BUDGET sees it.
function budgetBinding() {
  const store = new Map();
  const storage = { get: async (k) => store.get(k), put: async (k, v) => { store.set(k, v); } };
  const obj = new AiBudget({ storage });
  const names = [];
  return {
    store,
    names,
    idFromName: (name) => { names.push(name); return name; },
    get: () => ({ fetch: (url, init) => obj.fetch(new Request(url, init)) }),
  };
}

// Takes `n` calls in a row; the allowed flags.
function takeMany(n, day, limits, usage) {
  const allowed = [];
  for (let i = 0; i < n; i++) {
    const r = take(usage, day, limits);
    allowed.push(r.allowed);
    usage = r.usage;
  }
  return { allowed, usage };
}

test("take", async (t) => {
  await t.test("counts up to the daily limit, then refuses with 'day'", () => {
    const { allowed, usage } = takeMany(4, "2026-09-29", { month: 100, day: 3 });
    assert.deepEqual(allowed, [true, true, true, false]);
    assert.deepEqual(usage, { day: "2026-09-29", dayCount: 3, month: "2026-09", monthCount: 3 });
    assert.equal(take(usage, "2026-09-29", { month: 100, day: 3 }).spent, "day");
  });

  await t.test("the monthly limit holds across days, and wins over the daily one", () => {
    const limits = { month: 5, day: 3 };
    let { usage } = takeMany(3, "2026-09-28", limits);
    const next = takeMany(3, "2026-09-29", limits, usage);
    assert.deepEqual(next.allowed, [true, true, false]);
    assert.equal(take(next.usage, "2026-09-29", limits).spent, "month");
  });

  await t.test("a new day resets the daily count, a new month both", () => {
    const usage = { day: "2026-09-30", dayCount: 10, month: "2026-09", monthCount: 100 };
    assert.deepEqual(take(usage, "2026-10-01", { month: 100, day: 10 }),
      { allowed: true, usage: { day: "2026-10-01", dayCount: 1, month: "2026-10", monthCount: 1 } });
    const midMonth = { day: "2026-09-28", dayCount: 10, month: "2026-09", monthCount: 40 };
    assert.deepEqual(take(midMonth, "2026-09-29", { month: 100, day: 10 }).usage,
      { day: "2026-09-29", dayCount: 1, month: "2026-09", monthCount: 41 });
  });

  await t.test("a limit of 0 refuses everything", () => {
    assert.equal(take(undefined, "2026-09-29", { month: 0, day: 10 }).allowed, false);
    assert.equal(take(undefined, "2026-09-29", { month: 100, day: 0 }).allowed, false);
  });
});

test("limitSetting and limitsFrom", () => {
  for (const raw of [undefined, "", "lots", "-5", "2.5"]) assert.equal(limitSetting(raw, 7), 7);
  assert.equal(limitSetting("50", 7), 50);
  assert.equal(limitSetting("0", 7), 0);
  assert.deepEqual(limitsFrom({}), { month: DEFAULT_MONTHLY_LIMIT, day: DEFAULT_DAILY_LIMIT });
  assert.deepEqual(limitsFrom({ AI_MONTHLY_LIMIT: "30", AI_DAILY_LIMIT: "2" }), { month: 30, day: 2 });
});

test("spendAiBudget", async (t) => {
  await t.test("uses one global counter and says which limit is spent", async () => {
    const AI_BUDGET = budgetBinding();
    const env = { AI_BUDGET, AI_MONTHLY_LIMIT: "100", AI_DAILY_LIMIT: "2" };
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await spendAiBudget(env));
    assert.deepEqual(results, [null, null, "day"]);
    assert.deepEqual([...new Set(AI_BUDGET.names)], ["global"]);
    assert.equal(await spendAiBudget({ ...env, AI_MONTHLY_LIMIT: "2", AI_DAILY_LIMIT: "5" }), "month");
  });

  await t.test("allows calls again the next UTC day, and the next month", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-30T23:59:00Z") });
    const env = { AI_BUDGET: budgetBinding(), AI_MONTHLY_LIMIT: "2", AI_DAILY_LIMIT: "1" };
    assert.equal(await spendAiBudget(env), null);
    assert.equal(await spendAiBudget(env), "day");
    t.mock.timers.tick(2 * 60 * 1000); // 00:01 on 1 October
    assert.equal(await spendAiBudget(env), null);
    assert.deepEqual(env.AI_BUDGET.store.get("usage"),
      { day: "2026-10-01", dayCount: 1, month: "2026-10", monthCount: 1 });
  });

  await t.test("caps nothing without the binding", async () => {
    assert.equal(await spendAiBudget({ AI_MONTHLY_LIMIT: "0" }), null);
  });

  await t.test("throws when the counter answers with an error", async () => {
    const AI_BUDGET = { idFromName: (n) => n, get: () => ({ fetch: async () => new Response("", { status: 500 }) }) };
    await assert.rejects(spendAiBudget({ AI_BUDGET }));
  });
});

export { budgetBinding };
