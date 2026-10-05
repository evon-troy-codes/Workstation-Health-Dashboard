// Unit tests for the AI's monthly and daily caps (budget.js), run by the repo's
// `npm test`. Durable Object storage is an in-memory Map; the date is a fake
// clock.
import test from "node:test";
import assert from "node:assert/strict";
import { AiBudget, take, refund, refundAiBudget, limitSetting, limitsFrom, spendAiBudget, callerOf, DEFAULT_MONTHLY_LIMIT, DEFAULT_DAILY_LIMIT, DEFAULT_DAILY_PER_IP_LIMIT } from "./budget.js";

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
    assert.deepEqual(usage, { day: "2026-09-29", dayCount: 3, month: "2026-09", monthCount: 3, ips: {} });
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
      { allowed: true, usage: { day: "2026-10-01", dayCount: 1, month: "2026-10", monthCount: 1, ips: {} } });
    const midMonth = { day: "2026-09-28", dayCount: 10, month: "2026-09", monthCount: 40 };
    assert.deepEqual(take(midMonth, "2026-09-29", { month: 100, day: 10 }).usage,
      { day: "2026-09-29", dayCount: 1, month: "2026-09", monthCount: 41, ips: {} });
  });

  await t.test("each caller gets only their share of the day, and the share resets with it", () => {
    const limits = { month: 100, day: 10, perIp: 2 };
    let usage;
    const allowed = [];
    for (const who of ["a", "a", "a", "b"]) {
      const r = take(usage, "2026-09-29", limits, who);
      allowed.push(r.spent || r.allowed);
      if (r.allowed) usage = r.usage;
    }
    assert.deepEqual(allowed, [true, true, "day", true]);
    assert.deepEqual(usage.ips, { a: 2, b: 1 });
    assert.equal(usage.dayCount, 3);
    assert.equal(take(usage, "2026-09-30", limits, "a").allowed, true);
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
  assert.deepEqual(limitsFrom({}), { month: DEFAULT_MONTHLY_LIMIT, day: DEFAULT_DAILY_LIMIT, perIp: DEFAULT_DAILY_PER_IP_LIMIT });
  assert.deepEqual(limitsFrom({ AI_MONTHLY_LIMIT: "30", AI_DAILY_LIMIT: "2", AI_DAILY_PER_IP_LIMIT: "1" }), { month: 30, day: 2, perIp: 1 });
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
    const { salt, ...usage } = env.AI_BUDGET.store.get("usage");
    assert.deepEqual(usage, { day: "2026-10-01", dayCount: 1, month: "2026-10", monthCount: 1, ips: {} });
  });

  await t.test("limits each caller's share of the day, storing a salted hash, never the address", async () => {
    const AI_BUDGET = budgetBinding();
    const env = { AI_BUDGET, AI_DAILY_LIMIT: "10", AI_DAILY_PER_IP_LIMIT: "2" };
    const results = [];
    for (const ip of ["198.51.100.7", "198.51.100.7", "198.51.100.7", "203.0.113.9"]) results.push(await spendAiBudget(env, ip));
    assert.deepEqual(results, [null, null, "day", null]);
    // Two addresses in one IPv6 /64 are one caller.
    assert.equal(await spendAiBudget(env, "2001:db8:1:2::a"), null);
    assert.equal(await spendAiBudget(env, "2001:db8:1:2:ffff::1"), null);
    assert.equal(await spendAiBudget(env, "2001:db8:1:2:0:0:0:3"), "day");
    const stored = JSON.stringify(AI_BUDGET.store.get("usage"));
    for (const raw of ["198.51.100", "203.0.113", "2001:db8"]) assert.ok(!stored.includes(raw), `${raw} stored`);
    assert.equal(Object.keys(AI_BUDGET.store.get("usage").ips).length, 3);
  });

  await t.test("a refund gives the caller their share back", async () => {
    const env = { AI_BUDGET: budgetBinding(), AI_DAILY_PER_IP_LIMIT: "1" };
    assert.equal(await spendAiBudget(env, "198.51.100.7"), null);
    assert.equal(await spendAiBudget(env, "198.51.100.7"), "day");
    await refundAiBudget(env, "198.51.100.7");
    assert.equal(await spendAiBudget(env, "198.51.100.7"), null);
  });

  await t.test("caps nothing without the binding", async () => {
    assert.equal(await spendAiBudget({ AI_MONTHLY_LIMIT: "0" }), null);
  });

  await t.test("throws when the counter answers with an error", async () => {
    const AI_BUDGET = { idFromName: (n) => n, get: () => ({ fetch: async () => new Response("", { status: 500 }) }) };
    await assert.rejects(spendAiBudget({ AI_BUDGET }));
  });
});

test("callerOf", () => {
  assert.equal(callerOf("198.51.100.7"), "198.51.100.7");
  assert.equal(callerOf("2001:db8:1:2::a"), "2001:db8:1:2::/64");
  assert.equal(callerOf("2001:0DB8:0001:0002:0:0:0:3"), "2001:db8:1:2::/64");
  assert.equal(callerOf("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(callerOf("::1"), "0:0:0:0::/64");
  for (const none of [undefined, null, "", 7]) assert.equal(callerOf(none), null);
});

test("refund", async (t) => {
  await t.test("gives one call back to today and this month", () => {
    const usage = { day: "2026-09-29", dayCount: 3, month: "2026-09", monthCount: 40 };
    assert.deepEqual(refund(usage, "2026-09-29"), { day: "2026-09-29", dayCount: 2, month: "2026-09", monthCount: 39 });
  });

  await t.test("leaves an earlier day's count alone, and never goes below zero", () => {
    const usage = { day: "2026-09-28", dayCount: 5, month: "2026-09", monthCount: 0 };
    assert.deepEqual(refund(usage, "2026-09-29"), { day: "2026-09-28", dayCount: 5, month: "2026-09", monthCount: 0 });
  });

  await t.test("refundAiBudget undoes a spend through the counter", async () => {
    const env = { AI_BUDGET: budgetBinding(), AI_DAILY_LIMIT: "1" };
    assert.equal(await spendAiBudget(env), null);
    assert.equal(await spendAiBudget(env), "day");
    await refundAiBudget(env);
    assert.equal(await spendAiBudget(env), null);
    await refundAiBudget({}); // no binding: nothing to do
  });

  await t.test("a counter that can't answer keeps the call counted, without throwing", async () => {
    const AI_BUDGET = { idFromName: (n) => n, get: () => ({ fetch: async () => { throw new Error("down"); } }) };
    await refundAiBudget({ AI_BUDGET });
  });
});

export { budgetBinding };
