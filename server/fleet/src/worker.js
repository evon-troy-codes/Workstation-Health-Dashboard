// worker.js — Workstation Scanner for Teams on Cloudflare: the Worker's entry.
//
// Bindings (wrangler.toml): DB (D1), RATE_LIMITER (Workers rate limiting,
// optional). Secret: ADMIN_TOKEN (`npx wrangler secret put ADMIN_TOKEN`), for
// the admin routes; without it they're off. A daily cron trigger prunes old
// reports. With DEMO = "1" (wrangler.demo.toml) it's the public demo instead:
// made-up computers, refreshed daily, read-only, no sign-in (demo.js).

import { handleRequest } from "./app.js";
import { createStore } from "./store.js";
import { d1Sql } from "./sql.js";
import { ensureDemo, seedDemo } from "./demo.js";

// The tables are created on the first request each Worker instance serves,
// once per database binding; every statement is safe to repeat.
const migrated = new WeakMap();
async function storeFor(env) {
  const store = createStore(d1Sql(env.DB));
  if (!migrated.has(env.DB)) {
    migrated.set(env.DB, store.migrate().catch((err) => { migrated.delete(env.DB); throw err; }));
  }
  await migrated.get(env.DB);
  return store;
}

// Workers rate limiting: one call per key. Without the binding nothing is
// limited, as in server/report-mailer.
const rateLimiter = (env) => async (key) => {
  if (!env.RATE_LIMITER) return true;
  const { success } = await env.RATE_LIMITER.limit({ key });
  return success;
};

const isDemo = (env) => env.DEMO === "1";

export default {
  async fetch(request, env) {
    try {
      const store = await storeFor(env);
      if (isDemo(env)) await ensureDemo(d1Sql(env.DB), new Date());
      return await handleRequest(request, {
        store,
        demo: isDemo(env),
        rateLimit: rateLimiter(env),
        ip: request.headers.get("CF-Connecting-IP") || "unknown",
        adminToken: env.ADMIN_TOKEN || "",
      });
    } catch (err) {
      // Logged for `wrangler tail`; JSON rather than Cloudflare's error page,
      // so the app can say what happened.
      console.error(err);
      return new Response(JSON.stringify({ ok: false, error: "server-error" }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
  },

  async scheduled(_event, env) {
    const store = await storeFor(env);
    if (isDemo(env)) await seedDemo(d1Sql(env.DB), new Date());
    else await store.prune(new Date());
  },
};

export { storeFor, rateLimiter };
