// Tests for the IT dashboard (dashboard.js, session.js, summary.js), run by
// the repo's `npm test`, against a real in-memory SQLite database.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { handleRequest, SCHEMA } from "./app.js";
import { createStore } from "./store.js";
import { nodeSql } from "./sql.js";
import { createSession, isValidSession, SESSION_MS } from "./session.js";
import { firewallOf, antivirusOf, updatesOf, compareVersions, parseFilters, applyFilters, csvCell, summarize } from "./summary.js";

const ADMIN = "adm_dashboard-test-token";
const BASE = "https://teams.acme.example";
const NOW = new Date("2026-10-07T12:00:00Z");
const DAY = 86400000;

const report = (over = {}) => ({
  hostname: "PC", user: "sam", appVersion: "1.5.0",
  os: { name: "Windows 11", version: "24H2", pendingUpdates: 0, appUpdates: {} },
  disk: { usedPercent: 40 }, network: { ipv4: "10.0.0.5" },
  firewall: { checked: true, products: [{ name: "Windows Firewall", active: true, detail: null }] },
  antivirus: { checked: true, products: [{ name: "Microsoft Defender", running: true }] },
  ...over,
});

// A store with Acme set up and a few computers, one of them hostile.
async function fleet() {
  const db = new DatabaseSync(":memory:");
  const store = createStore(nodeSql(db));
  await store.migrate();
  await store.setUp({ organization: "Acme <IT>" });
  const add = async (id, r, daysAgo, appVersion = "1.5.0") => {
    await store.enroll({ deviceId: id, name: r.hostname, now: new Date(NOW - 100 * DAY) });
    await store.addReport({ deviceId: id, schema: SCHEMA, appVersion, name: r.hostname, body: JSON.stringify(r), now: new Date(NOW - daysAgo * DAY) });
  };
  await add("device-aaaa-0001", report({ hostname: "ALPHA-PC" }), 0);
  await add("device-bbbb-0002", report({ hostname: "BRAVO-PC", os: { name: "Ubuntu", version: "24.04", pendingUpdates: 3, appUpdates: { snap: 4 } } }), 1);
  await add("device-cccc-0003", report({ hostname: "CHARLIE-PC", firewall: { checked: true, products: [{ name: "UFW", active: false }] }, disk: { usedPercent: 93 } }), 2, "1.4.1");
  await add("device-dddd-0004", report({ hostname: "<script>alert(1)</script>", user: "=HYPERLINK(\"http://evil.example\")",
    os: { name: '"><img src=x onerror=alert(1)>' }, antivirus: { checked: true, products: [] } }), 20);
  return { db, store };
}

const deps = (store, over = {}) => ({ store, adminToken: ADMIN, now: () => NOW, ...over });
const get = (path, cookie) => new Request(`${BASE}${path}`, { headers: cookie ? { Cookie: cookie } : {} });
const form = (path, fields, { cookie, origin = BASE } = {}) => new Request(`${BASE}${path}`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}) },
  body: new URLSearchParams(fields).toString(),
});
async function signIn(store) {
  const res = await handleRequest(form("/login", { token: ADMIN }), deps(store));
  return res.headers.get("Set-Cookie").split(";")[0];
}
const page = async (res) => ({ status: res.status, text: await res.text(), headers: res.headers });

test("signing in", async (t) => {
  await t.test("the dashboard is off without an admin token", async () => {
    const { store } = await fleet();
    assert.equal((await handleRequest(get("/"), deps(store, { adminToken: "" }))).status, 404);
  });

  await t.test("pages redirect to sign-in without a session", async () => {
    const { store } = await fleet();
    for (const path of ["/", "/computers/device-aaaa-0001", "/settings", "/export.csv"]) {
      const res = await handleRequest(get(path), deps(store));
      assert.equal(res.status, 303, path);
      assert.equal(res.headers.get("Location"), "/login");
    }
  });

  await t.test("the right token signs in, with a strict cookie", async () => {
    const { store } = await fleet();
    const res = await handleRequest(form("/login", { token: ADMIN }), deps(store));
    assert.equal(res.status, 303);
    const cookie = res.headers.get("Set-Cookie");
    for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) assert.ok(cookie.includes(flag), flag);
    assert.ok(!cookie.includes(ADMIN), "the cookie holds the admin token");
  });

  await t.test("a wrong token, or a sign-in posted from another site, is refused", async () => {
    const { store } = await fleet();
    assert.equal((await handleRequest(form("/login", { token: "wrong" }), deps(store))).status, 401);
    assert.equal((await handleRequest(form("/login", { token: ADMIN }, { origin: "https://evil.example" }), deps(store))).status, 403);
    assert.equal((await handleRequest(form("/login", { token: ADMIN }, { origin: null }), deps(store))).status, 403);
  });

  await t.test("sign-in is rate-limited per address", async () => {
    const { store } = await fleet();
    const res = await handleRequest(form("/login", { token: ADMIN }), deps(store, { ip: "1.2.3.4", rateLimit: async (k) => k !== "login:1.2.3.4" }));
    assert.equal(res.status, 429);
  });

  await t.test("a tampered, expired or other server's session is refused", async () => {
    const good = await createSession(ADMIN, NOW);
    assert.equal(await isValidSession(good, ADMIN, NOW), true);
    assert.equal(await isValidSession(good, ADMIN, new Date(NOW.getTime() + SESSION_MS + 1)), false);
    assert.equal(await isValidSession(good, "another-admin-token", NOW), false);
    const [exp, sig] = good.split(".");
    assert.equal(await isValidSession(`${Number(exp) + 3600000}.${sig}`, ADMIN, NOW), false);
    for (const bad of ["", "x", `${exp}.`, `${exp}.zz`, null]) assert.equal(await isValidSession(bad, ADMIN, NOW), false);
  });

  await t.test("signing out clears the cookie", async () => {
    const { store } = await fleet();
    const res = await handleRequest(form("/logout", {}, { cookie: await signIn(store) }), deps(store));
    assert.equal(res.status, 303);
    assert.match(res.headers.get("Set-Cookie"), /Max-Age=0/);
  });
});

test("first-time setup from the dashboard", async () => {
  const db = new DatabaseSync(":memory:");
  const store = createStore(nodeSql(db));
  await store.migrate();
  const cookie = await signIn(store);
  assert.match((await page(await handleRequest(get("/", cookie), deps(store)))).text, /Set up Workstation Scanner for Teams/);
  const res = await page(await handleRequest(form("/setup", { organization: "Acme IT" }, { cookie }), deps(store)));
  assert.equal(res.status, 200);
  const key = /<pre class="key">(ek_[A-Za-z0-9_-]+)<\/pre>/.exec(res.text)[1];
  assert.equal(await store.isEnrollmentKey(key), true);
  // The managed.json example, escaped for HTML like everything else.
  assert.match(res.text, /&quot;fleetUrl&quot;: &quot;https:\/\/teams.acme.example\/&quot;/);
});

test("the computers list", async (t) => {
  const { store } = await fleet();
  const cookie = await signIn(store);
  const list = async (q = "") => page(await handleRequest(get(`/${q}`, cookie), deps(store)));

  await t.test("lists every computer, with strict security headers and no scripts", async () => {
    const res = await list();
    assert.equal(res.status, 200);
    for (const name of ["ALPHA-PC", "BRAVO-PC", "CHARLIE-PC"]) assert.ok(res.text.includes(name), name);
    assert.match(res.headers.get("Content-Security-Policy"), /default-src 'none'/);
    assert.ok(!/script-src/.test(res.headers.get("Content-Security-Policy")), "the policy allows scripts");
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    assert.ok(!/<script/i.test(res.text), "the page has a script tag");
  });

  await t.test("escapes every value from a report", async () => {
    const res = await list();
    assert.ok(!res.text.includes("<script>alert(1)</script>"));
    assert.ok(!res.text.includes("<img src=x"));
    assert.ok(res.text.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert.ok(res.text.includes("Acme &lt;IT&gt;"));
  });

  await t.test("filters: pending updates, firewall, antivirus, disk, silent, older app, search", async () => {
    const names = (text) => ["ALPHA-PC", "BRAVO-PC", "CHARLIE-PC", "&lt;script&gt;"].filter((n) => text.includes(`>${n}`));
    // The hostile computer's update count is unknown, and an unknown reading
    // is worth a look, so it shows under "pending updates" too.
    assert.deepEqual(names((await list("?updates=1")).text), ["BRAVO-PC", "&lt;script&gt;"]);
    assert.deepEqual(names((await list("?firewall=1")).text), ["CHARLIE-PC"]);
    assert.deepEqual(names((await list("?antivirus=1")).text), ["&lt;script&gt;"]);
    assert.deepEqual(names((await list("?disk=90")).text), ["CHARLIE-PC"]);
    assert.deepEqual(names((await list("?stale=7")).text), ["&lt;script&gt;"]);
    assert.deepEqual(names((await list("?outdated=1")).text), ["CHARLIE-PC"]);
    assert.deepEqual(names((await list("?q=bravo")).text), ["BRAVO-PC"]);
    assert.match((await list("?q=bravo")).text, /1 of 4/);
  });

  await t.test("snap updates add to the system's count", async () => {
    assert.match((await list("?updates=1")).text, />7</);
  });
});

test("CSV export defuses formulas", async () => {
  const { store } = await fleet();
  const res = await handleRequest(get("/export.csv", await signIn(store)), deps(store));
  assert.match(res.headers.get("Content-Type"), /^text\/csv/);
  assert.match(res.headers.get("Content-Disposition"), /attachment; filename="computers-2026-10-07.csv"/);
  const text = await res.text();
  assert.ok(text.includes(`"'=HYPERLINK(""http://evil.example"")"`), "a formula reached the CSV");
  assert.equal(text.split("\r\n").filter(Boolean).length, 5);
});

test("a computer's page, and removing it", async (t) => {
  const { store } = await fleet();
  const cookie = await signIn(store);

  await t.test("shows the latest readings and history, escaped", async () => {
    const res = await page(await handleRequest(get("/computers/device-dddd-0004", cookie), deps(store)));
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes("<script>alert"));
    assert.match(res.text, /History/);
    assert.equal((await handleRequest(get("/computers/device-zzzz-9999", cookie), deps(store))).status, 404);
  });

  await t.test("removing stops its reports; restoring lets them back", async () => {
    const { deviceToken } = await store.enroll({ deviceId: "device-aaaa-0001", name: "ALPHA-PC", now: NOW });
    const send = () => handleRequest(new Request(`${BASE}/v1/reports`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify({ schema: SCHEMA, appVersion: "1.5.0", report: report() }) }), deps(store));
    assert.equal((await handleRequest(form("/computers/device-aaaa-0001/remove", {}, { cookie }), deps(store))).status, 303);
    assert.equal((await send()).status, 401);
    assert.match((await page(await handleRequest(get("/", cookie), deps(store)))).text, /removed/);
    await handleRequest(form("/computers/device-aaaa-0001/restore", {}, { cookie }), deps(store));
    assert.equal((await send()).status, 202);
  });

  await t.test("a form posted from another site is refused, even with a session", async () => {
    const res = await handleRequest(form("/computers/device-bbbb-0002/remove", {}, { cookie, origin: "https://evil.example" }), deps(store));
    assert.equal(res.status, 403);
    assert.equal((await store.device("device-bbbb-0002")).revoked, 0);
  });

  await t.test("removing needs POST", async () => {
    assert.equal((await handleRequest(get("/computers/device-bbbb-0002/remove", cookie), deps(store))).status, 405);
  });
});

test("settings: a new enrollment key", async () => {
  const { store } = await fleet();
  const cookie = await signIn(store);
  const settings = await page(await handleRequest(get("/settings", cookie), deps(store)));
  assert.match(settings.text, /managed\.json/);
  const res = await page(await handleRequest(form("/settings/rotate-key", {}, { cookie }), deps(store)));
  const key = /<pre class="key">(ek_[A-Za-z0-9_-]+)<\/pre>/.exec(res.text)[1];
  assert.equal(await store.isEnrollmentKey(key), true);
});

test("the stylesheet is served without a session", async () => {
  const { store } = await fleet();
  const res = await handleRequest(get("/assets/dashboard.css"), deps(store));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type"), /^text\/css/);
});

test("summary", async (t) => {
  await t.test("firewall", () => {
    assert.equal(firewallOf(null).status, "unknown");
    assert.equal(firewallOf({ checked: true, products: [] }).status, "none");
    assert.equal(firewallOf({ checked: false, products: [] }).status, "unknown");
    assert.deepEqual(firewallOf({ checked: true, products: [{ name: "UFW", active: true }] }), { status: "active", text: "UFW" });
    assert.equal(firewallOf({ checked: true, products: [{ name: "LuLu", active: null }] }).status, "unknown");
    assert.equal(firewallOf({ checked: true, products: [{ name: "UFW", active: false }] }).status, "inactive");
  });

  await t.test("antivirus: Linux's 'nothing to report' isn't 'none detected'", () => {
    assert.equal(antivirusOf(null).status, "not-reported");
    assert.equal(antivirusOf({ checked: true, products: [] }).status, "none");
    assert.equal(antivirusOf({ checked: false, products: [] }).status, "unknown");
    assert.equal(antivirusOf({ checked: true, products: [{ name: "XProtect", running: null }] }).status, "installed");
  });

  await t.test("updates: unknown when the system's count is", () => {
    assert.deepEqual(updatesOf({ pendingUpdates: null, appUpdates: { snap: 4 } }), { count: null, text: "Unknown" });
    assert.deepEqual(updatesOf({ pendingUpdates: 2, appUpdates: { snap: 4, flatpak: null } }), { count: 6, text: "6" });
    assert.deepEqual(updatesOf({ pendingUpdates: 0 }), { count: 0, text: "None" });
  });

  await t.test("versions compare as numbers", () => {
    assert.equal(compareVersions("1.10.0", "1.9.2"), 1);
    assert.equal(compareVersions("1.4.1", "1.5.0"), -1);
    assert.equal(compareVersions("1.5", "1.5.0"), 0);
  });

  await t.test("a report that isn't JSON is 'not reported', never a crash", () => {
    const s = summarize({ id: "x", name: "N", body: "{broken", last_seen: null }, NOW);
    assert.equal(s.reported, false);
    assert.equal(s.updates.text, "Unknown");
  });

  await t.test("bad filter values are ignored", () => {
    const f = parseFilters("disk=abc&stale=-3&sort=evil&dir=sideways");
    assert.deepEqual([f.disk, f.stale, f.sort, f.dir], [null, null, "name", "asc"]);
    assert.equal(applyFilters([], f).rows.length, 0);
  });

  await t.test("csvCell defuses formulas and quotes", () => {
    for (const lead of ["=", "+", "-", "@", "\t", "\r"]) assert.equal(csvCell(`${lead}x`)[1], "'", JSON.stringify(lead));
    assert.equal(csvCell('a "b"'), '"a ""b"""');
    assert.equal(csvCell(null), '""');
  });
});
