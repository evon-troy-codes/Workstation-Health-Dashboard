// Unit tests for the installed-build self-test result (selftest.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const { selfTestResult, RENDERED_CHECK } = require("./selftest");

const facts = { os: { name: "Omarchy" }, cpu: { model: "Intel Core Ultra 5 236V" }, ram: { totalGB: 15 }, disk: { totalGB: 475 },
  network: { interface: "wlan0", mac: "aa:bb:cc:dd:ee:ff", ipv4: "192.168.1.9" }, hostname: "devops", user: "evon" };
const deferred = { lastUpdateCheck: "1 hour ago", display: { count: 2 } };

test("selfTestResult", async (t) => {
  await t.test("every reading that came back is true", () => {
    const r = selfTestResult({ facts, deferred, rendered: true, version: "1.3.1", packaged: true });
    assert.deepEqual(r, { version: "1.3.1", packaged: true, checks: {
      rendered: true, osName: true, cpuModel: true, ramTotal: true, diskTotal: true,
      networkInterface: true, lastUpdateCheck: true, display: true } });
  });

  await t.test("rendered is only true when the page said so", () => {
    for (const rendered of [false, undefined, "true", 1]) {
      assert.equal(selfTestResult({ facts, deferred, rendered }).checks.rendered, false);
    }
  });

  await t.test("never writes a value from the machine, only true/false", () => {
    const text = JSON.stringify(selfTestResult({ facts, deferred, rendered: true, version: "1.3.1", packaged: true }));
    for (const value of ["Omarchy", "Intel", "wlan0", "aa:bb", "192.168", "devops", "evon", "1 hour"]) {
      assert.ok(!text.includes(value), `the result carries ${value}`);
    }
  });

  await t.test("Unknown and missing readings are false", () => {
    const r = selfTestResult({ facts: { os: { name: "Unknown" } }, deferred: { lastUpdateCheck: "Unknown" }, rendered: true });
    assert.equal(r.checks.osName, false);
    assert.equal(r.checks.lastUpdateCheck, false);
    assert.equal(r.checks.ramTotal, false);
    assert.equal(r.checks.display, false);
  });
});

test("RENDERED_CHECK is a script the page can run", () => {
  assert.doesNotThrow(() => new Function(`return ${RENDERED_CHECK}`));
  assert.match(RENDERED_CHECK, /helper-shell/);
  assert.match(RENDERED_CHECK, /data-render-error/);
});
