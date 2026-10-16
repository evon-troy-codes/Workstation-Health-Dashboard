const test = require("node:test");
const assert = require("node:assert/strict");
const { createScanSequence } = require("./scan-sequence");

test("only the newest scan sequence may update results", () => {
  const scans = createScanSequence();
  const first = scans.begin();
  const second = scans.begin();

  assert.equal(scans.isCurrent(first), false);
  assert.equal(scans.isCurrent(second), true);
  assert.equal(scans.isCurrent(scans.begin()), true);
  assert.equal(scans.isCurrent(second), false);
});
