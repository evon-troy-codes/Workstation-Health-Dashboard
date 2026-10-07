// Tests for the fleet server's core (app.js, store.js, sql.js), run by the
// repo's `npm test`, against a real in-memory SQLite database (node:sqlite).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { handleRequest, SCHEMA } from "./app.js";
import { createStore } from "./store.js";
import { nodeSql, d1Sql } from "./sql.js";
import { MAX_BODY_BYTES } from "./http.js";

const NOW = new Date("2026-10-07T12:00:00Z");
const DEVICE = "6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b";

async function setup({ setUp = true } = {}) {
  const db = new DatabaseSync(":memory:");
  const store = createStore(nodeSql(db));
  await store.migrate();
  const key = setUp ? (await store.setUp({ organization: "Acme IT" })).enrollmentKey : null;
  return { db, store, key };
}

const post = (path, body, headers = {}) =>
  new Request(`https://fleet.example${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const answer = async (res) => ({ status: res.status, body: await res.json() });
const envelope = (report = { hostname: "PC-01", os: { name: "Windows 11" } }) =>
  ({ schema: SCHEMA, appVersion: "1.5.0", sentAt: NOW.toISOString(), trigger: "launch", report });

async function enrolled() {
  const s = await setup();
  const res = await answer(await handleRequest(post("/v1/enroll", { enrollmentKey: s.key, deviceId: DEVICE, name: "PC-01" }), { store: s.store, now: () => NOW }));
  return { ...s, token: res.body.deviceToken };
}

test("setup", async (t) => {
  await t.test("returns the enrollment key once, and keeps only its hash", async () => {
    const { db, key } = await setup();
    assert.match(key, /^ek_[A-Za-z0-9_-]{43}$/);
    const stored = JSON.stringify(db.prepare("SELECT * FROM settings").all());
    assert.ok(!stored.includes(key), "the key itself is stored");
  });

  await t.test("can't be run twice, and needs a name", async () => {
    const { store } = await setup();
    assert.deepEqual(await store.setUp({ organization: "Other" }), { error: "already-set-up" });
    const fresh = await setup({ setUp: false });
    assert.deepEqual(await fresh.store.setUp({ organization: "  " }), { error: "organization-required" });
  });

  await t.test("rotating the key stops the old one enrolling", async () => {
    const { store, key } = await setup();
    const { enrollmentKey } = await store.rotateEnrollmentKey();
    assert.notEqual(enrollmentKey, key);
    assert.equal(await store.isEnrollmentKey(key), false);
    assert.equal(await store.isEnrollmentKey(enrollmentKey), true);
  });

  await t.test("migrate is safe to run again", async () => {
    const { store } = await setup();
    await store.migrate();
    assert.equal(await store.organization(), "Acme IT");
  });
});

test("GET /v1/health", async (t) => {
  await t.test("names the organization once set up", async () => {
    const { store } = await setup();
    const res = await answer(await handleRequest(new Request("https://fleet.example/v1/health"), { store }));
    assert.deepEqual(res, { status: 200, body: { ok: true, organization: "Acme IT" } });
  });
  await t.test("says so before setup", async () => {
    const { store } = await setup({ setUp: false });
    const res = await answer(await handleRequest(new Request("https://fleet.example/v1/health"), { store }));
    assert.deepEqual(res.body, { ok: true, setUp: false });
  });
});

test("POST /v1/enroll", async (t) => {
  await t.test("the right key gives a device token, stored only as a hash", async () => {
    const { db, store, key } = await setup();
    const res = await answer(await handleRequest(post("/v1/enroll", { enrollmentKey: key, deviceId: DEVICE, name: "PC-01" }), { store, now: () => NOW }));
    assert.equal(res.status, 200);
    assert.match(res.body.deviceToken, /^dt_[A-Za-z0-9_-]{43}$/);
    const row = db.prepare("SELECT * FROM devices").get();
    assert.equal(row.id, DEVICE);
    assert.equal(row.name, "PC-01");
    assert.equal(row.enrolled_at, NOW.toISOString());
    assert.ok(!JSON.stringify(row).includes(res.body.deviceToken), "the token itself is stored");
  });

  await t.test("a wrong or missing key is refused", async () => {
    const { store } = await setup();
    for (const enrollmentKey of ["ek_wrong", "", undefined, 42]) {
      const res = await answer(await handleRequest(post("/v1/enroll", { enrollmentKey, deviceId: DEVICE }), { store }));
      assert.deepEqual(res, { status: 403, body: { ok: false, error: "bad-enrollment-key" } });
    }
  });

  await t.test("before setup, nothing can enroll", async () => {
    const { store } = await setup({ setUp: false });
    const res = await answer(await handleRequest(post("/v1/enroll", { enrollmentKey: "ek_x", deviceId: DEVICE }), { store }));
    assert.deepEqual(res, { status: 503, body: { ok: false, error: "not-set-up" } });
  });

  await t.test("a device ID that isn't a plain ID is refused", async () => {
    const { store, key } = await setup();
    for (const deviceId of ["short", "../../etc", "<script>", "x".repeat(65), 7, null]) {
      const res = await handleRequest(post("/v1/enroll", { enrollmentKey: key, deviceId }), { store });
      assert.equal(res.status, 400, String(deviceId));
    }
  });

  await t.test("re-enrolling (a reinstall) replaces the token; the old one stops working", async () => {
    const { store, key, token } = await enrolled();
    const again = await answer(await handleRequest(post("/v1/enroll", { enrollmentKey: key, deviceId: DEVICE, name: "PC-01" }), { store, now: () => NOW }));
    assert.notEqual(again.body.deviceToken, token);
    assert.equal(await store.deviceForToken(token), null);
    assert.ok(await store.deviceForToken(again.body.deviceToken));
  });

  await t.test("a revoked computer can't come back with the enrollment key", async () => {
    const { db, store, key } = await enrolled();
    db.prepare("UPDATE devices SET revoked = 1").run();
    const res = await answer(await handleRequest(post("/v1/enroll", { enrollmentKey: key, deviceId: DEVICE }), { store }));
    assert.deepEqual(res, { status: 403, body: { ok: false, error: "revoked" } });
  });

  await t.test("rate-limited per address before anything else", async () => {
    const { store, key } = await setup();
    const keys = [];
    const rateLimit = async (k) => { keys.push(k); return false; };
    const res = await answer(await handleRequest(post("/v1/enroll", { enrollmentKey: key, deviceId: DEVICE }), { store, rateLimit, ip: "198.51.100.7" }));
    assert.deepEqual(res, { status: 429, body: { ok: false, error: "rate-limited" } });
    assert.deepEqual(keys, ["enroll:198.51.100.7"]);
  });
});

test("POST /v1/reports", async (t) => {
  await t.test("a report from an enrolled computer is kept, and updates the computer", async () => {
    const { db, store, token } = await enrolled();
    const later = new Date("2026-10-07T13:00:00Z");
    const res = await answer(await handleRequest(post("/v1/reports", envelope({ hostname: "PC-01-renamed", os: { name: "Windows 11" } }), { Authorization: `Bearer ${token}` }), { store, now: () => later }));
    assert.deepEqual(res, { status: 202, body: { ok: true } });
    const report = db.prepare("SELECT * FROM reports").get();
    assert.equal(report.device_id, DEVICE);
    assert.equal(report.schema, 1);
    assert.equal(report.app_version, "1.5.0");
    assert.deepEqual(JSON.parse(report.body), { hostname: "PC-01-renamed", os: { name: "Windows 11" } });
    const device = db.prepare("SELECT * FROM devices").get();
    assert.equal(device.last_seen, later.toISOString());
    assert.equal(device.name, "PC-01-renamed");
    assert.equal(device.app_version, "1.5.0");
  });

  await t.test("no token, a wrong one, or a revoked computer is refused before the body is read", async () => {
    const { db, store, token } = await enrolled();
    for (const headers of [{}, { Authorization: "Bearer dt_nope" }, { Authorization: token }, { Authorization: "Basic abc" }]) {
      const res = await answer(await handleRequest(post("/v1/reports", envelope(), headers), { store }));
      assert.deepEqual(res, { status: 401, body: { ok: false, error: "unknown-device" } }, JSON.stringify(headers));
    }
    db.prepare("UPDATE devices SET revoked = 1").run();
    const res = await answer(await handleRequest(post("/v1/reports", envelope(), { Authorization: `Bearer ${token}` }), { store }));
    assert.deepEqual(res, { status: 401, body: { ok: false, error: "revoked" } });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM reports").get().n, 0);
  });

  await t.test("an envelope of another schema, or with no report object, is refused", async () => {
    const { store, token } = await enrolled();
    const auth = { Authorization: `Bearer ${token}` };
    assert.equal((await handleRequest(post("/v1/reports", { ...envelope(), schema: 2 }, auth), { store })).status, 422);
    for (const report of [null, "text", [1, 2]]) {
      assert.equal((await handleRequest(post("/v1/reports", { ...envelope(), report }, auth), { store })).status, 400);
    }
  });

  await t.test("the stored report is re-serialized JSON, never the raw text", async () => {
    const { db, store, token } = await enrolled();
    const raw = `{"schema":1,"appVersion":"1.5.0","report":{"hostname":"PC","x":1}   ,"extra":"</script>"}`;
    await handleRequest(post("/v1/reports", raw, { Authorization: `Bearer ${token}` }), { store });
    assert.equal(db.prepare("SELECT body FROM reports").get().body, '{"hostname":"PC","x":1}');
  });

  await t.test("long names and versions are capped", async () => {
    const { db, store, token } = await enrolled();
    await handleRequest(post("/v1/reports", { ...envelope({ hostname: "N".repeat(500) }), appVersion: "9".repeat(500) }, { Authorization: `Bearer ${token}` }), { store });
    const d = db.prepare("SELECT name, app_version FROM devices").get();
    assert.equal(d.name.length, 100);
    assert.equal(d.app_version.length, 32);
  });

  await t.test("rate-limited per computer", async () => {
    const { store, token } = await enrolled();
    const keys = [];
    const res = await handleRequest(post("/v1/reports", envelope(), { Authorization: `Bearer ${token}` }), { store, rateLimit: async (k) => { keys.push(k); return false; } });
    assert.equal(res.status, 429);
    assert.deepEqual(keys, [`report:${DEVICE}`]);
  });
});

test("requests", async (t) => {
  await t.test("only JSON is read", async () => {
    const { store, key } = await setup();
    const res = await handleRequest(new Request("https://fleet.example/v1/enroll", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ enrollmentKey: key, deviceId: DEVICE }) }), { store });
    assert.equal(res.status, 415);
  });

  await t.test("bodies over the cap are refused, in bytes, without a Content-Length too", async () => {
    const { store, key } = await setup();
    const big = JSON.stringify({ enrollmentKey: key, deviceId: DEVICE, pad: "€".repeat(Math.ceil(MAX_BODY_BYTES / 3) + 10) });
    assert.equal((await handleRequest(post("/v1/enroll", big), { store })).status, 413);
    const declared = post("/v1/enroll", "{}", { "Content-Length": String(MAX_BODY_BYTES + 1) });
    assert.equal((await handleRequest(declared, { store })).status, 413);
  });

  await t.test("broken JSON, or JSON that isn't an object, is 400", async () => {
    const { store, key } = await setup();
    for (const body of ["{not json", "[1,2]", "null", '"text"']) {
      assert.equal((await handleRequest(post("/v1/enroll", body), { store })).status, 400, body);
    }
    assert.ok(key);
  });

  await t.test("other methods and paths", async () => {
    const { store } = await setup();
    assert.equal((await handleRequest(new Request("https://fleet.example/v1/enroll"), { store })).status, 405);
    assert.equal((await handleRequest(post("/v1/health", {}), { store })).status, 405);
    for (const path of ["/", "/v1", "/v1/enroll/x", "/v2/reports", "/admin"]) {
      assert.equal((await handleRequest(post(path, {}), { store })).status, 404, path);
    }
  });

  await t.test("no response can be cached", async () => {
    const { store } = await setup();
    const res = await handleRequest(new Request("https://fleet.example/v1/health"), { store });
    assert.equal(res.headers.get("Cache-Control"), "no-store");
  });
});

// The D1 adapter, against a stand-in with D1's prepare/bind/run/first/all
// shape, so the Worker's mapping is checked without Cloudflare.
test("d1Sql maps calls onto D1's API", async () => {
  const calls = [];
  const db = {
    prepare: (sql) => ({
      bind: (...params) => ({
        run: async () => { calls.push(["run", sql, params]); },
        first: async () => { calls.push(["first", sql, params]); return undefined; },
        all: async () => { calls.push(["all", sql, params]); return { results: [{ a: 1 }] }; },
      }),
    }),
  };
  const sql = d1Sql(db);
  await sql.run("INSERT x", [1]);
  assert.equal(await sql.first("SELECT y", [2]), null);
  assert.deepEqual(await sql.all("SELECT z", [3]), [{ a: 1 }]);
  assert.deepEqual(calls, [["run", "INSERT x", [1]], ["first", "SELECT y", [2]], ["all", "SELECT z", [3]]]);
});
