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
  const reports = [];
  let down = false;
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization || null, redirect: init.redirect });
    if (down) throw new TypeError("fetch failed");
    if (url.endsWith("/v1/reports")) reports.push(JSON.parse(init.body));
    return handleRequest(new Request(url, init), { store, now: () => NOW });
  };
  return { db, store, enrollmentKey, calls, reports, fetchImpl, setDown: (v) => { down = v; } };
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

function client(srv, { state = { value: null }, kc = keychain(), settings = {}, now = () => NOW, fetchImpl = srv.fetchImpl } = {}) {
  let n = 0;
  return createFleetClient({
    settings: { status: "on", organization: "Acme IT", fleetUrl: FLEET, enrollmentKey: srv.enrollmentKey, ...settings },
    readState: () => state.value,
    writeState: (s) => { state.value = JSON.parse(JSON.stringify(s)); },
    keychain: kc,
    fetchImpl,
    randomUUID: () => `6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4${n++}`,
    hostname: () => "PC-01",
    now,
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
  assert.equal(state.value.pendingReport, null);
  assert.deepEqual(c.status(), { result: "sent", lastSentAt: NOW.toISOString(), pending: false });
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

test("offline: keeps the latest report and retries it on the next send", async () => {
  const srv = await server();
  const state = { value: null };
  const c = client(srv, { state });
  srv.setDown(true);
  assert.equal(await c.send(envelope()), "failed");
  assert.deepEqual(c.status(), { result: "failed", lastSentAt: null, pending: true });
  assert.equal(state.value.pendingReport.envelope.trigger, "launch");
  assert.equal(await c.send(envelope("rescan")), "failed");
  assert.equal(state.value.pendingReport.envelope.trigger, "rescan", "a newer scan replaces the old one");
  srv.setDown(false);
  assert.equal(await client(srv, { state }).send(envelope("rescan")), "sent");
  assert.equal(srv.db.prepare("SELECT COUNT(*) n FROM reports").get().n, 1);
  assert.equal(srv.reports[0].trigger, "rescan");
  assert.equal(state.value.pendingReport, null);
  assert.equal(client(srv, { state }).status().pending, false);
});

test("discards a pending report after 24 hours", async () => {
  const srv = await server();
  const state = { value: null };
  let now = NOW;
  const c = client(srv, { state, now: () => now });
  srv.setDown(true);
  assert.equal(await c.send(envelope()), "failed");
  now = new Date(NOW.getTime() + 24 * 60 * 60 * 1000 + 1);
  assert.deepEqual(c.status(), { result: "expired", lastSentAt: null, pending: false });
  assert.equal(state.value.pendingReport, null);
});

test("sends run one at a time", async () => {
  const srv = await server();
  const c = client(srv);
  const results = await Promise.all([c.send(envelope()), c.send(envelope("rescan"))]);
  assert.deepEqual(results, ["sent", "sent"]);
  assert.equal(srv.calls.filter((x) => x.url.endsWith("/v1/enroll")).length, 1, "the second waited for the first's token");
  assert.equal(srv.db.prepare("SELECT COUNT(*) n FROM reports").get().n, 1, "only the latest queued report is sent");
  assert.equal(srv.reports[0].trigger, "rescan");
});

test("a newer report queued during a send is not cleared by the earlier success", async () => {
  const srv = await server();
  const state = { value: null };
  let releaseReport;
  let reportStarted;
  const started = new Promise((resolve) => { reportStarted = resolve; });
  const gate = new Promise((resolve) => { releaseReport = resolve; });
  let delayed = false;
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/v1/reports") && !delayed) {
      delayed = true;
      reportStarted();
      await gate;
    }
    return srv.fetchImpl(url, init);
  };
  const c = client(srv, { state, fetchImpl });
  const first = c.send(envelope());
  await started;
  const second = c.send(envelope("rescan"));
  assert.equal(state.value.pendingReport.envelope.trigger, "rescan");
  releaseReport();
  assert.deepEqual(await Promise.all([first, second]), ["sent", "sent"]);
  assert.deepEqual(srv.reports.map((report) => report.trigger), ["launch", "rescan"]);
  assert.equal(state.value.pendingReport, null);
});

test("a report is not sent when it cannot be saved for retry", async () => {
  const srv = await server();
  const state = { value: null };
  const c = createFleetClient({
    settings: { status: "on", organization: "Acme IT", fleetUrl: FLEET, enrollmentKey: srv.enrollmentKey },
    readState: () => state.value,
    writeState: () => { throw new Error("disk full"); },
    keychain: keychain(),
    fetchImpl: srv.fetchImpl,
    randomUUID: () => "6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4",
    hostname: () => "PC-01",
    now: () => NOW,
  });
  assert.equal(await c.send(envelope()), "failed");
  assert.deepEqual(srv.calls, [], "do not send a report that cannot be retried");
  assert.deepEqual(c.status(), { result: "failed", lastSentAt: null, pending: false });
});

test("a state file that's damaged is replaced", async () => {
  const srv = await server();
  const state = { value: { deviceId: "../../etc", token: "x", fleetUrl: FLEET } };
  assert.equal(await client(srv, { state }).send(envelope()), "sent");
  assert.match(state.value.deviceId, /^[0-9a-f-]{36}$/);
});
