// report-mailer — the Cloudflare Worker behind Workstation Scanner's "Explain
// my results". (The name and URL date from when it also emailed reports; they
// stay, so installed apps keep finding it.)
//
// POST /explain with JSON { scan } → an AI assessment of the scan from Claude
// (explain.js), within a per-IP rate limit and a global monthly and daily
// budget (budget.js). The Anthropic key is a Worker secret, never in the app:
// the app is public and its installers can be unpacked.
//
// It no longer emails reports. The app shares them from the person's own
// email, a saved file or the clipboard (app/main/share.js), because a public
// service that mails any address anyone types is a spam relay in waiting.
// POST / answers 410 Gone, so an old build says why rather than failing
// mysteriously.
//
// Configuration (wrangler.toml / `wrangler secret put`):
//   ANTHROPIC_API_KEY  secret, required for /explain
//   AI_MODEL, AI_EFFORT, AI_MONTHLY_LIMIT, AI_DAILY_LIMIT  vars
//   RATE_LIMITER       Workers rate-limiting binding
//   AI_BUDGET          Durable Object binding (budget.js)

import { explainScan } from "./explain.js";
import { spendAiBudget, refundAiBudget } from "./budget.js";
import { MAX_BODY_BYTES } from "./limits.js";


const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// Workers rate limiting: one call per key. Without the binding (local tests,
// or a deploy that forgot it) nothing is limited rather than everything
// refused, and the deploy guide says to configure it.
// A limiter that fails throws, and the caller answers ai-busy.
async function underLimit(env, key) {
  if (!env.RATE_LIMITER) return true;
  const { success } = await env.RATE_LIMITER.limit({ key });
  return success;
}

// The body as text, or null once it passes `max` bytes: counted as it
// arrives, so a body with no Content-Length (or a false one) isn't read whole
// first, and in bytes, not characters.
async function readCapped(request, max) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

async function handleRequest(request, env, fetchImpl = fetch) {
  if (request.method !== "POST") return json(405, { ok: false, error: "method-not-allowed" });

  const path = new URL(request.url).pathname;
  // The old email route. Answered before the body is read: nothing about it
  // is processed any more.
  if (path === "/") return json(410, { ok: false, error: "email-removed" });
  if (path !== "/explain") return json(404, { ok: false, error: "not-found" });

  // JSON only. The app always says so, and a web page can't send
  // application/json to another site without a CORS preflight, which this
  // Worker refuses (405). So no page can make its visitors' browsers spend
  // the budget with a plain text/plain POST.
  if (!/^application\/json\s*(;|$)/i.test(request.headers.get("Content-Type") || "")) {
    return json(415, { ok: false, error: "unsupported-media-type" });
  }

  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_BODY_BYTES) return json(413, { ok: false, error: "too-large" });
  const raw = await readCapped(request, MAX_BODY_BYTES);
  if (raw === null) return json(413, { ok: false, error: "too-large" });

  let body;
  try {
    body = JSON.parse(raw);
  } catch (_) {
    return json(400, { ok: false, error: "bad-request" });
  }

  // POST /explain: an AI assessment of a scan (explain.js).
  const scan = body && body.scan;
  if (!scan || typeof scan !== "object" || Array.isArray(scan)) return json(400, { ok: false, error: "invalid-scan" });
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  let allowed;
  try {
    allowed = await underLimit(env, `ai:${ip}`);
  } catch (_) {
    return json(503, { ok: false, error: "ai-busy" });
  }
  if (!allowed) return json(429, { ok: false, error: "rate-limited" });
  // Then the whole Worker's monthly and daily caps and this caller's share of
  // the day (budget.js), which bound the spend however many addresses call.
  // If the counter can't answer, refuse.
  let spent;
  try {
    spent = await spendAiBudget(env, ip);
  } catch (_) {
    return json(503, { ok: false, error: "ai-busy" });
  }
  if (spent) return json(429, { ok: false, error: `ai-${spent === "day" ? "daily" : "monthly"}-limit` });
  // The SDK gets the Worker's own fetch only in tests: handed the global
  // fetch, it would call it detached, which the Workers runtime rejects.
  let out;
  try {
    out = await explainScan(scan, env, fetchImpl === fetch ? undefined : fetchImpl);
  } catch (_) {
    // Something explain.js didn't expect. Refunded, since whether it was
    // billed is unknown, and answered as JSON rather than Cloudflare's error
    // page, so the app can say what happened.
    await refundAiBudget(env, ip);
    return json(502, { ok: false, error: "ai-failed" });
  }
  // A call that never reached Claude costs nothing, so it shouldn't use up
  // the budget: an outage would otherwise spend the day on retries.
  if (out.billed === false) await refundAiBudget(env, ip);
  return json(out.status, out.body);
}

export default {
  fetch: (request, env) => handleRequest(request, env),
};

// The Durable Object class behind the AI_BUDGET binding, exported from the
// main module as Workers requires.
export { AiBudget } from "./budget.js";

export { handleRequest };
