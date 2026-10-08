// Tests for the admin routes, pruning, and the two ways the fleet server
// runs: the Cloudflare Worker (worker.js, against a D1 stand-in over real
// SQLite) and the Node server (node-server.js, over real HTTP).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { handleRequest, SCHEMA } from "./app.js";
import { createStore } from "./store.js";
import { nodeSql } from "./sql.js";
import { MAX_BODY_BYTES } from "./http.js";
import worker from "./worker.js";
import { createServer, memoryRateLimiter, clientIp } from "./node-server.js";

const ADMIN = "adm_test-admin-token";
const DEVICE = "6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b";
const post = (url, body, headers = {}) =>
  new Request(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const answer = async (res) => ({ status: res.status, body: await res.json() });

async function freshStore() {
  const db = new DatabaseSync(":memory:");
  const store = createStore(nodeSql(db));
  await store.migrate();
  return { db, store };
}

test("admin routes", async (t) => {
  await t.test("are off when no admin token is configured", async () => {
    const { store } = await freshStore();
    const res = await handleRequest(post("https://f.example/v1/admin/setup", { organization: "Acme" }, { Authorization: `Bearer ${ADMIN}` }), { store, adminToken: "" });
    assert.equal(res.status, 404);
  });

  await t.test("refuse a missing or wrong token", async () => {
    const { store } = await freshStore();
    for (const headers of [{}, { Authorization: "Bearer wrong" }, { Authorization: ADMIN }]) {
      const res = await answer(await handleRequest(post("https://f.example/v1/admin/setup", { organization: "Acme" }, headers), { store, adminToken: ADMIN }));
      assert.deepEqual(res, { status: 401, body: { ok: false, error: "not-admin" } });
    }
    assert.equal(await store.organization(), null);
  });

  await t.test("set up once, then rotate the key", async () => {
    const { store } = await freshStore();
    const auth = { Authorization: `Bearer ${ADMIN}` };
    const first = await answer(await handleRequest(post("https://f.example/v1/admin/setup", { organization: "Acme IT" }, auth), { store, adminToken: ADMIN }));
    assert.equal(first.status, 200);
    assert.match(first.body.enrollmentKey, /^ek_/);
    const again = await answer(await handleRequest(post("https://f.example/v1/admin/setup", { organization: "Other" }, auth), { store, adminToken: ADMIN }));
    assert.deepEqual(again, { status: 409, body: { ok: false, error: "already-set-up" } });
    const rotated = await answer(await handleRequest(post("https://f.example/v1/admin/rotate-key", {}, auth), { store, adminToken: ADMIN }));
    assert.equal(rotated.status, 200);
    assert.notEqual(rotated.body.enrollmentKey, first.body.enrollmentKey);
  });

  await t.test("are rate-limited per address", async () => {
    const { store } = await freshStore();
    const res = await handleRequest(post("https://f.example/v1/admin/setup", { organization: "A" }, { Authorization: `Bearer ${ADMIN}` }), { store, adminToken: ADMIN, ip: "1.2.3.4", rateLimit: async (k) => k !== "admin:1.2.3.4" });
    assert.equal(res.status, 429);
  });
});

test("prune keeps recent reports and each computer's latest", async () => {
  const { db, store } = await freshStore();
  await store.setUp({ organization: "Acme" });
  const now = new Date("2026-10-07T00:00:00Z");
  const daysAgo = (d) => new Date(now.getTime() - d * 86400000);
  await store.enroll({ deviceId: "device-aaaa1", name: "A", now: daysAgo(200) });
  await store.enroll({ deviceId: "device-bbbb2", name: "B", now: daysAgo(200) });
  for (const d of [150, 120, 10]) await store.addReport({ deviceId: "device-aaaa1", schema: 1, appVersion: "1", name: "A", body: "{}", now: daysAgo(d) });
  for (const d of [150, 120]) await store.addReport({ deviceId: "device-bbbb2", schema: 1, appVersion: "1", name: "B", body: "{}", now: daysAgo(d) });
  const deleted = await store.prune(now);
  const left = db.prepare("SELECT device_id, received_at FROM reports ORDER BY device_id, received_at").all()
    .map((r) => `${r.device_id} ${Math.round((now - new Date(r.received_at)) / 86400000)}d`);
  // A keeps its 10-day-old report; B, silent for 120 days, keeps only its latest.
  assert.deepEqual(left, ["device-aaaa1 10d", "device-bbbb2 120d"]);
  assert.equal(deleted, 3);
});

// A stand-in for D1's prepare/bind/run/first/all over real SQLite.
function d1Over(db) {
  return {
    prepare: (sql) => ({
      bind: (...params) => ({
        run: async () => db.prepare(sql).run(...params),
        first: async () => db.prepare(sql).get(...params) ?? null,
        all: async () => ({ results: db.prepare(sql).all(...params) }),
      }),
    }),
  };
}

test("the Cloudflare Worker", async (t) => {
  await t.test("serves setup, enrollment and reports over D1", async () => {
    const db = new DatabaseSync(":memory:");
    const env = { DB: d1Over(db), ADMIN_TOKEN: ADMIN };
    const base = "https://teams.acme.example";
    assert.deepEqual((await answer(await worker.fetch(new Request(`${base}/v1/health`), env))).body, { ok: true, setUp: false });
    const { body: setup } = await answer(await worker.fetch(post(`${base}/v1/admin/setup`, { organization: "Acme IT" }, { Authorization: `Bearer ${ADMIN}` }), env));
    const { body: enrolled } = await answer(await worker.fetch(post(`${base}/v1/enroll`, { enrollmentKey: setup.enrollmentKey, deviceId: DEVICE, name: "PC-01" }), env));
    const report = { schema: SCHEMA, appVersion: "1.5.0", sentAt: "2026-10-07T12:00:00Z", trigger: "launch", report: { hostname: "PC-01" } };
    const res = await worker.fetch(post(`${base}/v1/reports`, report, { Authorization: `Bearer ${enrolled.deviceToken}` }), env);
    assert.equal(res.status, 202);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM reports").get().n, 1);
  });

  await t.test("uses the rate limiter binding, keyed by CF-Connecting-IP", async () => {
    const keys = [];
    const env = { DB: d1Over(new DatabaseSync(":memory:")), RATE_LIMITER: { limit: async ({ key }) => { keys.push(key); return { success: false }; } } };
    const res = await worker.fetch(post("https://t.example/v1/enroll", {}, { "CF-Connecting-IP": "203.0.113.9" }), env);
    assert.equal(res.status, 429);
    assert.deepEqual(keys, ["enroll:203.0.113.9"]);
  });

  await t.test("answers JSON, not Cloudflare's error page, if storage fails", async (t) => {
    const logged = t.mock.method(console, "error", () => {});
    const broken = { prepare: () => ({ bind: () => ({ run: async () => { throw new Error("D1 down"); }, first: async () => { throw new Error("D1 down"); }, all: async () => { throw new Error("D1 down"); } }) }) };
    const res = await answer(await worker.fetch(new Request("https://t.example/v1/health"), { DB: broken }));
    assert.deepEqual(res, { status: 500, body: { ok: false, error: "server-error" } });
    assert.equal(logged.mock.callCount(), 1, "logged for wrangler tail");
  });

  await t.test("the daily cron prunes", async () => {
    const db = new DatabaseSync(":memory:");
    await worker.scheduled({}, { DB: d1Over(db) });
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'reports'").get());
  });
});

test("the Node server, over real HTTP", async (t) => {
  const { server, close } = await createServer({ adminToken: ADMIN });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, init) => { const r = await fetch(`${base}${path}`, init); return { status: r.status, body: await r.json() }; };
  const postJson = (body, headers = {}) => ({ method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

  try {
    await t.test("health, setup, enrollment and a report", async () => {
      assert.deepEqual(await call("/v1/health"), { status: 200, body: { ok: true, setUp: false } });
      const setup = await call("/v1/admin/setup", postJson({ organization: "Acme IT" }, { Authorization: `Bearer ${ADMIN}` }));
      assert.equal(setup.status, 200);
      const enrolled = await call("/v1/enroll", postJson({ enrollmentKey: setup.body.enrollmentKey, deviceId: DEVICE, name: "PC-01" }));
      assert.equal(enrolled.status, 200);
      const report = { schema: SCHEMA, appVersion: "1.5.0", sentAt: "2026-10-07T12:00:00Z", trigger: "launch", report: { hostname: "PC-01" } };
      assert.deepEqual(await call("/v1/reports", postJson(report, { Authorization: `Bearer ${enrolled.body.deviceToken}` })), { status: 202, body: { ok: true } });
      assert.equal((await call("/v1/health")).body.organization, "Acme IT");
    });

    await t.test("a body over the cap is refused as it streams in", async () => {
      const big = "x".repeat(MAX_BODY_BYTES + 100);
      const r = await call("/v1/enroll", { method: "POST", headers: { "Content-Type": "application/json" }, body: big });
      assert.equal(r.status, 413);
    });

    await t.test("responses are JSON and never cached", async () => {
      const r = await fetch(`${base}/v1/health`);
      assert.match(r.headers.get("content-type"), /^application\/json/);
      assert.equal(r.headers.get("cache-control"), "no-store");
    });
  } finally {
    await close();
  }
});

test("memoryRateLimiter", async () => {
  let t = 0;
  const allow = memoryRateLimiter({ limit: 2, windowMs: 1000, now: () => t });
  assert.deepEqual([await allow("a"), await allow("a"), await allow("a"), await allow("b")], [true, true, false, true]);
  t = 1000;
  assert.equal(await allow("a"), true, "a new window starts over");
});

test("clientIp trusts X-Forwarded-For only when told to", () => {
  const req = { headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" }, socket: { remoteAddress: "10.0.0.2" } };
  assert.equal(clientIp(req, false), "10.0.0.2");
  assert.equal(clientIp(req, true), "203.0.113.5");
});
