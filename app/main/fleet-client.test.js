// Tests for fleet-client.js, against the real fleet server (server/fleet's
// handleRequest over in-memory SQLite) with only the network replaced.
const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { createFleetClient } = require("./fleet-client");
const { buildEnvelope } = require("./fleet");

const FLEET = "https://fleet.acme.example/";
const NOW = new Date("2026-10-08T12:00:00Z");

async function server() {
  const { handleRequest } = await import("../../server/fleet/src/app.js");
  const { createStore } = await import("../../server/fleet/src/store.js");
  const { nodeSql } = await import("../../server/fleet/src/sql.js");
  const db = new DatabaseSync(":memory:");
  const store = createStore(nodeSql(db));
  await store.migrate();
  const { enrollmentKey } = await store.setUp({ organization: "Acme IT" });
  const calls = [];
  let down = false;
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization || null, redirect: init.redirect });
    if (down) throw new TypeError("fetch failed");
    return handleRequest(new Request(url, init), { store, now: () => NOW });
  };
  return { db, store, enrollmentKey, calls, fetchImpl, setDown: (v) => { down = v; } };
}

// A keychain that "encrypts" visibly, so a test can tell where the token went.
const keychain = (available = true) => ({
  available,
  encrypt: (t) => Buffer.from(`enc:${t}`).toString("base64"),
  decrypt: (b) => {
    const s = Buffer.from(b, "base64").toString();
    if (!s.startsWith("enc:")) throw new Error("not ours");
    return s.slice(4);
  },
});

function client(srv, { state = { value: null }, kc = keychain(), settings = {} } = {}) {
  let n = 0;
  return createFleetClient({
    settings: { status: "on", organization: "Acme IT", fleetUrl: FLEET, enrollmentKey: srv.enrollmentKey, ...settings },
    readState: () => state.value,
    writeState: (s) => { state.value = JSON.parse(JSON.stringify(s)); },
    keychain: kc,
    fetchImpl: srv.fetchImpl,
    randomUUID: () => `6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4${n++}`,
    hostname: () => "PC-01",
    now: () => NOW,
  });
}

const envelope = (trigger = "launch") => buildEnvelope({ hostname: "PC-01", user: "sam" }, { appVersion: "1.5.0", trigger, now: NOW });

test("the first send enrolls, then reports", async () => {
  const srv = await server();
  const state = { value: null };
  const c = client(srv, { state });
  assert.equal(await c.send(envelope()), "sent");
  assert.deepEqual(srv.calls.map((x) => x.url), [`${FLEET}v1/enroll`, `${FLEET}v1/reports`]);
  assert.ok(srv.calls.every((x) => x.redirect === "error"), "redirects are refused");
  assert.equal(srv.db.prepare("SELECT COUNT(*) n FROM reports").get().n, 1);
  assert.equal(srv.db.prepare("SELECT name FROM devices").get().name, "PC-01");
  assert.equal(state.value.token.kind, "keychain");
  assert.equal(state.value.lastSentAt, NOW.toISOString());
  assert.deepEqual(c.status(), { result: "sent", lastSentAt: NOW.toISOString() });
});

test("later sends reuse the token and the device ID", async () => {
  const srv = await server();
  const state = { value: null };
  await client(srv, { state }).send(envelope());
  const id = state.value.deviceId;
  assert.equal(await client(srv, { state }).send(envelope("rescan")), "sent", "a new launch");
  assert.equal(srv.calls.filter((x) => x.url.endsWith("/v1/enroll")).length, 1);
  assert.equal(state.value.deviceId, id);
  assert.equal(srv.db.prepare("SELECT COUNT(*) n FROM devices").get().n, 1);
  assert.equal(srv.db.prepare("SELECT COUNT(*) n FROM reports").get().n, 2);
});

test("without a keychain the token is kept as it is, in the 0600 file", async () => {
  const srv = await server();
  const state = { value: null };
  assert.equal(await client(srv, { state, kc: keychain(false) }).send(envelope()), "sent");
  assert.equal(state.value.token.kind, "file");
  assert.match(state.value.token.value, /^dt_/);
});

test("a token the keychain can't open any more means enrolling again, as the same computer", async () => {
  const srv = await server();
  const state = { value: null };
  await client(srv, { state }).send(envelope());
  state.value.token.value = Buffer.from("garbage").toString("base64");
  assert.equal(await client(srv, { state }).send(envelope()), "sent");
  assert.equal(srv.db.prepare("SELECT COUNT(*) n FROM devices").get().n, 1);
});

test("a token the server doesn't know: enroll again, once", async () => {
  const srv = await server();
  const state = { value: null };
  const c = client(srv, { state, kc: keychain(false) });
  await c.send(envelope());
  state.value.token.value = "dt_not-a-real-token";
  assert.equal(await c.send(envelope()), "sent");
  assert.equal(srv.calls.filter((x) => x.url.endsWith("/v1/enroll")).length, 2);
});

test("a new fleet server address means a new enrollment", async () => {
  const srv = await server();
  const state = { value: null };
  await client(srv, { state }).send(envelope());
  const id = state.value.deviceId;
  state.value.fleetUrl = "https://old.acme.example/";
  await client(srv, { state }).send(envelope());
  assert.equal(srv.calls.filter((x) => x.url.endsWith("/v1/enroll")).length, 2);
  assert.equal(state.value.deviceId, id, "same computer");
  assert.equal(state.value.fleetUrl, FLEET);
});

test("a computer IT removed stops at 'removed', and isn't re-enrolled", async () => {
  const srv = await server();
  const state = { value: null };
  await client(srv, { state }).send(envelope());
  await srv.store.setRevoked(state.value.deviceId, true);
  const c = client(srv, { state });
  assert.equal(await c.send(envelope()), "removed");
  assert.equal(srv.calls.filter((x) => x.url.endsWith("/v1/enroll")).length, 1);
  assert.equal(c.status().result, "removed");
  assert.equal(c.status().lastSentAt, NOW.toISOString(), "the earlier send still shows");
  // Let back in: the same token works again.
  await srv.store.setRevoked(state.value.deviceId, false);
  assert.equal(await client(srv, { state }).send(envelope()), "sent");
});

test("a refused enrollment key, and a server not set up yet", async () => {
  const srv = await server();
  assert.equal(await client(srv, { settings: { enrollmentKey: "ek_wrong" } }).send(envelope()), "key-refused");
  const fresh = await server();
  fresh.db.exec("DELETE FROM settings");
  assert.equal(await client(fresh).send(envelope()), "not-set-up");
});

test("offline: 'failed', nothing queued, and the next send goes fresh", async () => {
  const srv = await server();
  const state = { value: null };
  const c = client(srv, { state });
  srv.setDown(true);
  assert.equal(await c.send(envelope()), "failed");
  assert.deepEqual(c.status(), { result: "failed", lastSentAt: null });
  srv.setDown(false);
  assert.equal(await c.send(envelope("rescan")), "sent");
  assert.equal(srv.db.prepare("SELECT COUNT(*) n FROM reports").get().n, 1, "only the new one");
});

test("sends run one at a time", async () => {
  const srv = await server();
  const c = client(srv);
  const results = await Promise.all([c.send(envelope()), c.send(envelope("rescan"))]);
  assert.deepEqual(results, ["sent", "sent"]);
  assert.equal(srv.calls.filter((x) => x.url.endsWith("/v1/enroll")).length, 1, "the second waited for the first's token");
});

test("a state file that's damaged is replaced", async () => {
  const srv = await server();
  const state = { value: { deviceId: "../../etc", token: "x", fleetUrl: FLEET } };
  assert.equal(await client(srv, { state }).send(envelope()), "sent");
  assert.match(state.value.deviceId, /^[0-9a-f-]{36}$/);
});
