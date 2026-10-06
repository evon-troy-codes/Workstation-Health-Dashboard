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
// AI_DAILY_PER_IP_LIMIT caps each caller's share of the day, so one person
// with a script can't use up everyone's day. A caller is an IPv4 address or
// an IPv6 /64 (one home or phone gets a whole /64), stored only as a hash
// salted afresh each day, so yesterday's entries can't be traced back.
//
// The counter is a Durable Object: one instance, named "global", that every
// request reaches, and whose storage calls don't interleave, so two requests
// can't both take the last one. It speaks fetch rather than RPC so this file
// doesn't import cloudflare:workers, which the Node tests can't load.

// About 3–4 cents a call on Claude Opus 5.5 at medium effort, so 100 a month
// stays under a $5 monthly budget with room to spare.
const DEFAULT_MONTHLY_LIMIT = 100;
const DEFAULT_DAILY_LIMIT = 10;
const DEFAULT_DAILY_PER_IP_LIMIT = 3;

// The free pool: answers from a Workers AI model once Claude's day or month
// is spent (FREE_AI_MODEL). It costs nothing, but Cloudflare's free daily
// allocation is shared, so it has its own day and per-caller caps; no month.
const DEFAULT_FREE_DAILY_LIMIT = 250;
const DEFAULT_FREE_DAILY_PER_IP_LIMIT = 10;
const NO_LIMIT = Number.MAX_SAFE_INTEGER;

// Where each pool's usage is stored. "usage" is Claude's, as before.
const POOL_KEYS = { claude: "usage", free: "usage:free" };
const poolKey = (pool) => POOL_KEYS[pool] || POOL_KEYS.claude;

// The UTC day and month a call counts towards: "2026-09-29" and "2026-09".
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// The stored usage ({ day, dayCount, month, monthCount, ips } or undefined),
// the current day, the limits ({ month, day, perIp }) and the caller's hashed
// key (or none) → may this call go ahead, why not ("month" or "day"), and the
// usage to store. A new day or month starts from zero. A caller over their
// share is told the day is spent: for them, it is.
function take(usage, day, limits, who) {
  const month = day.slice(0, 7);
  const u = usage || {};
  const monthCount = u.month === month ? u.monthCount : 0;
  const dayCount = u.day === day ? u.dayCount : 0;
  // At most AI_DAILY_LIMIT entries: only calls that go ahead add one.
  const ips = u.day === day && u.ips ? { ...u.ips } : {};
  const now = { day, dayCount, month, monthCount, ips };
  if (monthCount >= limits.month) return { allowed: false, spent: "month", usage: now };
  if (dayCount >= limits.day) return { allowed: false, spent: "day", usage: now };
  if (who && limits.perIp != null && (ips[who] || 0) >= limits.perIp) return { allowed: false, spent: "day", usage: now };
  if (who) ips[who] = (ips[who] || 0) + 1;
  return { allowed: true, usage: { day, dayCount: dayCount + 1, month, monthCount: monthCount + 1, ips } };
}

// Gives one call back, for a call that never reached Claude. Only to the
// day and month it was taken from (and the caller it was taken for), and
// never below zero.
function refund(usage, day, who) {
  const u = usage || {};
  const month = day.slice(0, 7);
  const ips = u.ips ? { ...u.ips } : undefined;
  if (ips && who && u.day === day && ips[who]) ips[who] -= 1;
  return {
    day: u.day, dayCount: u.day === day ? Math.max(0, (u.dayCount || 0) - 1) : u.dayCount,
    month: u.month, monthCount: u.month === month ? Math.max(0, (u.monthCount || 0) - 1) : u.monthCount,
    ...(ips ? { ips } : {}),
  };
}

// The part of an address that stands for one caller: an IPv4 address whole,
// an IPv6 address's /64 (its first four groups).
function callerOf(ip) {
  if (typeof ip !== "string" || !ip) return null;
  if (!ip.includes(":")) return ip;
  const [head, tail] = ip.toLowerCase().split("::");
  const front = head ? head.split(":") : [];
  const back = tail === undefined ? [] : tail ? tail.split(":") : [];
  const groups = tail === undefined ? front : [...front, ...Array(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

// A caller's key in storage: a hash of the caller under the day's salt.
async function callerKey(salt, ip) {
  const caller = callerOf(ip);
  if (!caller) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}|${caller}`));
  return [...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

class AiBudget {
  constructor(ctx) {
    this.storage = ctx.storage;
  }

  // POST /take { limits: { month, day, perIp }, ip?, pool? } → { allowed, spent?, usage }.
  // POST /refund { ip?, pool? } → { usage }.
  // pool is "claude" (the default) or "free". The address is hashed here and
  // never stored.
  async fetch(request) {
    const { limits, ip, pool } = await request.json().catch(() => ({}));
    const key = poolKey(pool);
    const day = utcDay(Date.now());
    const stored = await this.storage.get(key);
    const salt = stored && stored.day === day && stored.salt ? stored.salt : crypto.randomUUID();
    const who = await callerKey(salt, ip);
    if (new URL(request.url).pathname === "/refund") {
      if (!stored) return Response.json({ usage: null });
      const back = { ...refund(stored, day, who), ...(stored.salt ? { salt: stored.salt } : {}) };
      await this.storage.put(key, back);
      return Response.json({ usage: back });
    }
    const { allowed, spent, usage } = take(stored, day, limits, who);
    if (allowed) await this.storage.put(key, { ...usage, salt });
    return Response.json({ allowed, spent, usage });
  }
}

// A limit setting as a whole number, or `fallback` when it is unset or not a
// number. "0" is a real setting: it turns /explain off.
function limitSetting(raw, fallback) {
  const n = raw == null || raw === "" ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

const limitsFrom = (env, pool = "claude") => (pool === "free"
  ? {
    month: NO_LIMIT,
    day: limitSetting(env.FREE_AI_DAILY_LIMIT, DEFAULT_FREE_DAILY_LIMIT),
    perIp: limitSetting(env.FREE_AI_DAILY_PER_IP_LIMIT, DEFAULT_FREE_DAILY_PER_IP_LIMIT),
  }
  : {
    month: limitSetting(env.AI_MONTHLY_LIMIT, DEFAULT_MONTHLY_LIMIT),
    day: limitSetting(env.AI_DAILY_LIMIT, DEFAULT_DAILY_LIMIT),
    perIp: limitSetting(env.AI_DAILY_PER_IP_LIMIT, DEFAULT_DAILY_PER_IP_LIMIT),
  });

// Takes one call from the budget, for the caller at `ip`. Resolves null if it may go ahead, or which
// limit is spent ("month" or "day"). Without the binding (local tests) nothing
// is capped, as with the rate limiter. A counter that can't answer throws, and
// the caller refuses the call.
async function spendAiBudget(env, ip, pool = "claude") {
  if (!env.AI_BUDGET) return null;
  const stub = env.AI_BUDGET.get(env.AI_BUDGET.idFromName("global"));
  const res = await stub.fetch("https://ai-budget/take", {
    method: "POST",
    body: JSON.stringify({ limits: limitsFrom(env, pool), ip, pool }),
  });
  if (!res.ok) throw new Error(`AI budget answered ${res.status}`);
  const { allowed, spent } = await res.json();
  if (allowed === true) return null;
  return spent === "day" ? "day" : "month";
}

// Gives back the call spendAiBudget took, when it never reached Claude, so
// an outage or a misconfiguration doesn't use up the day. Best effort: a
// counter that can't answer keeps the call counted.
async function refundAiBudget(env, ip, pool = "claude") {
  if (!env.AI_BUDGET) return;
  try {
    const stub = env.AI_BUDGET.get(env.AI_BUDGET.idFromName("global"));
    await stub.fetch("https://ai-budget/refund", { method: "POST", body: JSON.stringify({ ip, pool }) });
  } catch (_) {
    /* stays counted */
  }
}

export { AiBudget, take, refund, refundAiBudget, utcDay, limitSetting, limitsFrom, spendAiBudget, callerOf, callerKey, DEFAULT_MONTHLY_LIMIT, DEFAULT_DAILY_LIMIT, DEFAULT_DAILY_PER_IP_LIMIT,
  DEFAULT_FREE_DAILY_LIMIT, DEFAULT_FREE_DAILY_PER_IP_LIMIT };
