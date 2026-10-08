// Tests for managed-settings.js: validating the managed settings, and each
// OS's reader against sample output.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeSettings, parseJsonSettings, parseRegQuery, ownedByRootOnly, checkRootFile, readManagedSettings,
} = require("./managed-settings");

const GOOD = { version: 1, organization: "Acme IT", fleetUrl: "https://fleet.acme.example", enrollmentKey: "ek_abc" };

test("normalizeSettings", async (t) => {
  await t.test("no settings: not managed", () => {
    assert.deepEqual(normalizeSettings(null), { status: "off" });
  });

  await t.test("good settings, with defaults filled in", () => {
    assert.deepEqual(normalizeSettings(GOOD), {
      status: "on", organization: "Acme IT", fleetUrl: "https://fleet.acme.example/", enrollmentKey: "ek_abc",
      speedTest: "open", explain: true, scanEveryHours: 6,
    });
  });

  await t.test("the address is always a folder, without query or fragment", () => {
    assert.equal(normalizeSettings({ ...GOOD, fleetUrl: "https://a.example/fleet?x=1#y" }).fleetUrl, "https://a.example/fleet/");
  });

  await t.test("string values still validate, as device-management tools often produce them", () => {
    assert.equal(normalizeSettings({ ...GOOD, version: "1" }).status, "on");
    assert.equal(normalizeSettings({ ...GOOD, explain: "0" }).explain, false);
    assert.equal(normalizeSettings({ ...GOOD, fleetUrl: " https://a.example/fleet?x=1#y " }).fleetUrl, "https://a.example/fleet/");
    assert.equal(normalizeSettings({ ...GOOD, speedTest: "DAILY" }).speedTest, "daily");
  });

  await t.test("refuses what can't be used, with a reason", () => {
    const reason = (raw) => normalizeSettings(raw).reason;
    assert.equal(reason("text"), "not-an-object");
    assert.equal(reason([GOOD]), "not-an-object");
    assert.equal(reason({ ...GOOD, version: 2 }), "unknown-version");
    assert.equal(reason({ ...GOOD, fleetUrl: "" }), "no-fleet-url");
    assert.equal(reason({ ...GOOD, fleetUrl: "fleet.acme.example" }), "no-fleet-url");
    assert.equal(reason({ ...GOOD, fleetUrl: "http://fleet.acme.example/" }), "not-https");
    assert.equal(reason({ ...GOOD, fleetUrl: "https://user:pw@fleet.acme.example/" }), "credentials-in-url");
    assert.equal(reason({ ...GOOD, enrollmentKey: "  " }), "no-enrollment-key");
    assert.equal(reason({ ...GOOD, enrollmentKey: 5 }), "no-enrollment-key");
  });

  await t.test("the organization falls back to the server's host", () => {
    assert.equal(normalizeSettings({ ...GOOD, organization: "" }).organization, "fleet.acme.example");
    assert.equal(normalizeSettings({ ...GOOD, organization: "x".repeat(300) }).organization.length, 100);
  });

  await t.test("speedTest, explain and scanEveryHours", () => {
    assert.equal(normalizeSettings({ ...GOOD, speedTest: "daily" }).speedTest, "daily");
    assert.equal(normalizeSettings({ ...GOOD, speedTest: "never" }).speedTest, "open");
    // false in JSON and plists; 0 from a REG_DWORD.
    assert.equal(normalizeSettings({ ...GOOD, explain: false }).explain, false);
    assert.equal(normalizeSettings({ ...GOOD, explain: 0 }).explain, false);
    assert.equal(normalizeSettings({ ...GOOD, explain: 1 }).explain, true);
    assert.equal(normalizeSettings({ ...GOOD, scanEveryHours: 12 }).scanEveryHours, 12);
    assert.equal(normalizeSettings({ ...GOOD, scanEveryHours: 0 }).scanEveryHours, 6);
    assert.equal(normalizeSettings({ ...GOOD, scanEveryHours: "x" }).scanEveryHours, 6);
  });

  await t.test("unknown keys are ignored, and never passed on", () => {
    const s = normalizeSettings({ ...GOOD, include: { macAddress: true }, extra: 1 });
    assert.equal(s.status, "on");
    assert.equal("include" in s, false);
    assert.equal("extra" in s, false);
  });
});

test("parseJsonSettings", () => {
  assert.deepEqual(parseJsonSettings('{"a":1}'), { raw: { a: 1 } });
  assert.deepEqual(parseJsonSettings("{oops"), { invalid: "unparseable" });
});

test("parseRegQuery reads reg.exe's output", () => {
  const out = [
    "",
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\WorkstationScanner",
    "    version    REG_DWORD    0x1",
    "    organization    REG_SZ    Acme  IT (London)",
    "    fleetUrl    REG_SZ    https://fleet.acme.example/",
    "    enrollmentKey    REG_SZ    ek_2f9c",
    "    explain    REG_DWORD    0x0",
    "    blob    REG_BINARY    0102",
    "",
  ].join("\r\n");
  const values = parseRegQuery(out);
  assert.deepEqual(values, {
    version: 1, organization: "Acme  IT (London)", fleetUrl: "https://fleet.acme.example/", enrollmentKey: "ek_2f9c", explain: 0,
  });
  const s = normalizeSettings(values);
  assert.equal(s.status, "on");
  assert.equal(s.explain, false);
  assert.deepEqual(parseRegQuery(""), {});
});

test("only root may own and change the settings file", async (t) => {
  const stat = (uid, mode, isFile = true) => ({ uid, mode, isFile: () => isFile });
  await t.test("ownedByRootOnly", () => {
    assert.equal(ownedByRootOnly(stat(0, 0o100644)), true);
    assert.equal(ownedByRootOnly(stat(0, 0o040755)), true);
    assert.equal(ownedByRootOnly(stat(1000, 0o100644)), false, "a user's file");
    assert.equal(ownedByRootOnly(stat(0, 0o100664)), false, "group-writable");
    assert.equal(ownedByRootOnly(stat(0, 0o100646)), false, "world-writable");
    assert.equal(ownedByRootOnly(null), false);
  });

  await t.test("checkRootFile checks the file and its folder", () => {
    const fake = (file, dir) => (p) => {
      const v = p.endsWith(".json") ? file : dir;
      if (v instanceof Error) throw v;
      return v;
    };
    const missing = Object.assign(new Error("no"), { code: "ENOENT" });
    const denied = Object.assign(new Error("no"), { code: "EACCES" });
    const f = "/etc/workstation-scanner/managed.json";
    assert.deepEqual(checkRootFile(f, fake(missing, stat(0, 0o040755))), { raw: null });
    assert.deepEqual(checkRootFile(f, fake(denied, stat(0, 0o040755))), { invalid: "unreadable" });
    assert.deepEqual(checkRootFile(f, fake(stat(0, 0o100644), stat(0, 0o040755))), { ok: true });
    assert.deepEqual(checkRootFile(f, fake(stat(1000, 0o100644), stat(0, 0o040755))), { invalid: "not-root-owned" });
    assert.deepEqual(checkRootFile(f, fake(stat(0, 0o100644), stat(1000, 0o040755))), { invalid: "not-root-owned" }, "a user's folder");
    assert.deepEqual(checkRootFile(f, fake(stat(0, 0o100644), stat(0, 0o040777))), { invalid: "not-root-owned" });
    assert.deepEqual(checkRootFile(f, fake(stat(0, 0o040755, false), stat(0, 0o040755))), { invalid: "not-root-owned" }, "a folder, not a file");
  });
});

test("readManagedSettings never throws, and is off where there's nothing", async () => {
  assert.deepEqual(await readManagedSettings("aix"), { status: "off" });
});
