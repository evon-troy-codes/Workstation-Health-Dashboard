// Tests for the public demo (demo.js, and DEMO in app.js and dashboard.js).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { handleRequest } from "./app.js";
import { createStore } from "./store.js";
import { nodeSql } from "./sql.js";
import { demoComputers, seedDemo, ensureDemo, COMPUTERS, LATEST_APP } from "./demo.js";
import { summarize, applyFilters, parseFilters } from "./summary.js";

const NOW = new Date("2026-10-07T12:00:00Z");
const DAY = 86400000;

async function demoStore() {
  const db = new DatabaseSync(":memory:");
  const sql = nodeSql(db);
  const store = createStore(sql);
  await store.migrate();
  await seedDemo(sql, NOW);
  return { db, sql, store };
}
const deps = (store) => ({ store, demo: true, now: () => NOW });

test("the made-up computers", async (t) => {
  await t.test("are the same every time", () => {
    assert.deepEqual(JSON.stringify(demoComputers()), JSON.stringify(demoComputers()));
    assert.equal(demoComputers().length, COMPUTERS);
  });

  await t.test("use documentation addresses only, and unique names", () => {
    const all = demoComputers();
    assert.equal(new Set(all.map((c) => c.name)).size, all.length);
    for (const c of all) for (const { report } of c.reports) {
      assert.match(report.network.ipv4, /^198\.51\.100\.\d+$/, c.name);
      assert.match(report.hostname, /^EX-/);
    }
  });

  await t.test("give every filter something to show", async () => {
    const { store } = await demoStore();
    const rows = (await store.listDevices()).map((r) => summarize(r, NOW));
    for (const q of ["updates=1", "firewall=1", "antivirus=1", "disk=85", "stale=3", "outdated=1"]) {
      assert.ok(applyFilters(rows, parseFilters(q)).rows.length > 0, q);
    }
    assert.ok(applyFilters(rows, parseFilters("")).rows.length === COMPUTERS);
    assert.equal(applyFilters(rows, parseFilters("")).latestVersion, LATEST_APP);
  });

  await t.test("report recently, apart from the two that went quiet", async () => {
    const { store } = await demoStore();
    const silent = (await store.listDevices()).map((r) => summarize(r, NOW)).filter((r) => r.daysSinceSeen >= 1);
    assert.equal(silent.length, 2);
  });
});

test("ensureDemo refreshes once a day", async () => {
  const { db, sql, store } = await demoStore();
  assert.equal(await ensureDemo(sql, new Date(NOW.getTime() + 3600000)), false);
  assert.equal(await ensureDemo(sql, new Date(NOW.getTime() + DAY + 1)), true);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM devices").get().n, COMPUTERS);
});

test("seeding", async (t) => {
  // D1 limits the queries one request may make, and the first request after
  // a deploy seeds: about 1,200 one-row queries failed there.
  await t.test("takes one batch of a few statements", async () => {
    const db = new DatabaseSync(":memory:");
    const sql = nodeSql(db);
    await createStore(sql).migrate();
    const calls = [];
    const counting = { ...sql, run: async (...a) => { calls.push("run"); return sql.run(...a); }, batch: async (s) => { calls.push(s.length); return sql.batch(s); } };
    await seedDemo(counting, NOW);
    assert.equal(calls.length, 1);
    assert.ok(calls[0] <= 20, `${calls[0]} statements`);
  });

  await t.test("replaces the data, with foreign keys enforced, as on D1", async () => {
    const { db, sql, store } = await demoStore();
    await seedDemo(sql, new Date(NOW.getTime() + DAY));
    assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM reports").get().n, demoComputers().reduce((a, c) => a + c.reports.length, 0));
    const [first] = await store.listDevices();
    const history = await store.history(first.id);
    assert.equal(first.report_at, history[0].received_at, "the latest report is the newest");
    assert.ok(history[0].received_at > history[1].received_at);
    assert.equal(first.last_seen, history[0].received_at);
  });

  await t.test("leaves no enrollment key or device token that works", async () => {
    const { store } = await demoStore();
    assert.equal(await store.isEnrollmentKey("demo"), false);
    assert.equal(await store.deviceForToken("demo"), null);
  });
});

test("a failed batch changes nothing", async () => {
  const { db, sql } = await demoStore();
  await assert.rejects(sql.batch([["DELETE FROM reports"], ["INSERT INTO nowhere VALUES (1)"]]));
  assert.ok(db.prepare("SELECT COUNT(*) n FROM reports").get().n > 0);
});

test("the demo is read-only", async (t) => {
  const { store } = await demoStore();
  const post = (path, body, type = "application/json") => new Request(`https://demo.example${path}`, { method: "POST", headers: { "Content-Type": type, Origin: "https://demo.example" }, body });

  await t.test("nothing enrolls, reports or changes setup", async () => {
    for (const path of ["/v1/enroll", "/v1/reports", "/v1/admin/setup", "/v1/admin/rotate-key"]) {
      const res = await handleRequest(post(path, "{}"), deps(store));
      assert.equal(res.status, 403, path);
      assert.deepEqual(await res.json(), { ok: false, error: "demo" });
    }
    assert.equal((await handleRequest(new Request("https://demo.example/v1/health"), deps(store))).status, 200);
  });

  await t.test("the dashboard needs no sign-in, says it's a demo, and has no Remove or Settings", async () => {
    const res = await handleRequest(new Request("https://demo.example/"), deps(store));
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /demo with made-up computers/);
    assert.ok(!text.includes("/settings"), "Settings link in the demo");
    assert.ok(!text.includes("Sign out"));
    const id = /href="\/computers\/([^"]+)"/.exec(text)[1];
    const device = await (await handleRequest(new Request(`https://demo.example/computers/${id}`), deps(store))).text();
    assert.match(device, /History/);
    assert.ok(!device.includes("Remove this computer"));
  });

  await t.test("every form post is refused, and other pages go to the list", async () => {
    for (const path of ["/login", "/setup", "/settings/rotate-key", "/computers/demo-0001-x/remove", "/logout"]) {
      assert.equal((await handleRequest(post(path, "", "application/x-www-form-urlencoded"), deps(store))).status, 403, path);
    }
    for (const path of ["/login", "/settings", "/nope"]) {
      const res = await handleRequest(new Request(`https://demo.example${path}`), deps(store));
      assert.equal(res.status, 303, path);
    }
  });

  await t.test("the CSV export works", async () => {
    const res = await handleRequest(new Request("https://demo.example/export.csv?firewall=1"), deps(store));
    assert.match(res.headers.get("Content-Disposition"), /demo-computers-2026-10-07\.csv/);
    assert.ok((await res.text()).split("\r\n").length > 2);
  });
});
