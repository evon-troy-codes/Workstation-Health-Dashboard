// Unit tests for the report-failure toast text. report-messages.js is a
// browser ES module inside a CommonJS package, so it is loaded from a data: URL.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const load = () =>
  import("data:text/javascript;base64," +
    fs.readFileSync(path.join(__dirname, "report-messages.js")).toString("base64"));

test("reportFailure", async (t) => {
  const { reportFailure } = await load();

  await t.test("names the cause for each reason code", () => {
    assert.equal(reportFailure({ reason: "insecure-url" }), "Report failed: endpoint must use https");
    assert.equal(reportFailure({ reason: "timeout" }), "Report failed: timed out");
    assert.equal(reportFailure({ reason: "unreachable" }), "Report failed: couldn't reach the server");
    assert.equal(reportFailure({ reason: "redirected" }), "Report failed: endpoint redirected, not sent");
    assert.equal(reportFailure({ reason: "http", status: 503 }), "Report failed (HTTP 503)");
    assert.equal(reportFailure({ reason: "no-scan" }), "Report failed: no scan to send yet");
  });

  await t.test("falls back to a plain message", () => {
    assert.equal(reportFailure({ reason: "something-new" }), "Report failed");
    assert.equal(reportFailure(undefined), "Report failed");
  });
});
