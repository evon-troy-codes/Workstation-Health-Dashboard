// Unit tests for fleet.js, run by the repo's `npm test`.
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCliArgs, buildEnvelope, SCHEMA } = require("./fleet");

test("parseCliArgs", async (t) => {
  await t.test("no flag is the normal app", () => {
    assert.deepEqual(parseCliArgs(["/opt/app/workstation-scanner"]), { reportJson: false });
    assert.deepEqual(parseCliArgs(["app", "--no-sandbox", "--enable-features=X"]), { reportJson: false });
    assert.deepEqual(parseCliArgs(undefined), { reportJson: false });
  });

  await t.test("--report-json prints to stdout", () => {
    assert.deepEqual(parseCliArgs(["app", "--report-json"]), { reportJson: true, out: null });
  });

  await t.test("--report-json=<path> writes a file, spaces and all", () => {
    assert.deepEqual(parseCliArgs(["app", "--report-json=C:\\IT\\scan.json"]), { reportJson: true, out: "C:\\IT\\scan.json" });
    assert.deepEqual(parseCliArgs(["app", "--report-json=/tmp/My Scans/a.json"]), { reportJson: true, out: "/tmp/My Scans/a.json" });
  });

  await t.test("an empty path or a repeated flag is an error, not a guess", () => {
    assert.ok(parseCliArgs(["app", "--report-json="]).error);
    assert.ok(parseCliArgs(["app", "--report-json", "--report-json=/tmp/a.json"]).error);
  });

  await t.test("a look-alike flag isn't taken", () => {
    assert.deepEqual(parseCliArgs(["app", "--report-jsonx", "--report"]), { reportJson: false });
  });
});

test("buildEnvelope", () => {
  const report = { hostname: "PC-1", os: { name: "Windows 11" } };
  const env = buildEnvelope(report, { appVersion: "1.5.0", trigger: "cli", now: new Date("2026-10-07T14:03:00Z") });
  assert.deepEqual(env, { schema: SCHEMA, appVersion: "1.5.0", sentAt: "2026-10-07T14:03:00.000Z", trigger: "cli", report });
  assert.equal(SCHEMA, 1);
  assert.equal(buildEnvelope(report, { trigger: "cli" }).appVersion, null);
});
