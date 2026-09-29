// budget.js — a global cap on AI explanations, per month and per day.
//
// POST /explain has no login (the app is public and can't hold a secret), and
// every call spends Anthropic credit. The per-IP rate limit alone doesn't
// bound that: many addresses multiply it, and Cloudflare's rate limiting
// counts per server. So every call also takes one from a single counter for
// the whole Worker: AI_MONTHLY_LIMIT a calendar month, which bounds the spend,
// and AI_DAILY_LIMIT a day, so one burst of abuse can't use up the month on
// its first day. Both are UTC. Once either runs out, /explain answers 429
// ("ai-monthly-limit" or "ai-daily-limit") without calling Claude.
//
// The counter is a Durable Object: one instance, named "global", that every
// request reaches, and whose storage calls don't interleave, so two requests
// can't both take the last one. It speaks fetch rather than RPC so this file
// doesn't import cloudflare:workers, which the Node tests can't load.

// About 3–4 cents a call on Claude Opus 5.5 at medium effort, so 100 a month
// stays under a $5 monthly budget with room to spare.
const DEFAULT_MONTHLY_LIMIT = 100;
const DEFAULT_DAILY_LIMIT = 10;

// The UTC day and month a call counts towards: "2026-09-29" and "2026-09".
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// The stored usage ({ day, dayCount, month, monthCount } or undefined), the
// current day and the limits ({ month, day }) → may this call go ahead, why
// not ("month" or "day"), and the usage to store. A new day or month starts
// from zero.
function take(usage, day, limits) {
  const month = day.slice(0, 7);
  const u = usage || {};
  const monthCount = u.month === month ? u.monthCount : 0;
  const dayCount = u.day === day ? u.dayCount : 0;
  const now = { day, dayCount, month, monthCount };
  if (monthCount >= limits.month) return { allowed: false, spent: "month", usage: now };
  if (dayCount >= limits.day) return { allowed: false, spent: "day", usage: now };
  return { allowed: true, usage: { day, dayCount: dayCount + 1, month, monthCount: monthCount + 1 } };
}

class AiBudget {
  constructor(ctx) {
    this.storage = ctx.storage;
  }

  // POST { limits: { month, day } } → { allowed, spent?, usage }.
  async fetch(request) {
    const { limits } = await request.json();
    const { allowed, spent, usage } = take(await this.storage.get("usage"), utcDay(Date.now()), limits);
    if (allowed) await this.storage.put("usage", usage);
    return Response.json({ allowed, spent, usage });
  }
}

// A limit setting as a whole number, or `fallback` when it is unset or not a
// number. "0" is a real setting: it turns /explain off.
function limitSetting(raw, fallback) {
  const n = raw == null || raw === "" ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

const limitsFrom = (env) => ({
  month: limitSetting(env.AI_MONTHLY_LIMIT, DEFAULT_MONTHLY_LIMIT),
  day: limitSetting(env.AI_DAILY_LIMIT, DEFAULT_DAILY_LIMIT),
});

// Takes one call from the budget. Resolves null if it may go ahead, or which
// limit is spent ("month" or "day"). Without the binding (local tests) nothing
// is capped, as with the rate limiter. A counter that can't answer throws, and
// the caller refuses the call.
async function spendAiBudget(env) {
  if (!env.AI_BUDGET) return null;
  const stub = env.AI_BUDGET.get(env.AI_BUDGET.idFromName("global"));
  const res = await stub.fetch("https://ai-budget/take", {
    method: "POST",
    body: JSON.stringify({ limits: limitsFrom(env) }),
  });
  if (!res.ok) throw new Error(`AI budget answered ${res.status}`);
  const { allowed, spent } = await res.json();
  if (allowed === true) return null;
  return spent === "day" ? "day" : "month";
}

export { AiBudget, take, utcDay, limitSetting, limitsFrom, spendAiBudget, DEFAULT_MONTHLY_LIMIT, DEFAULT_DAILY_LIMIT };
