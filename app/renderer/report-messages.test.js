// Unit tests for the report-failure toast text. report-messages.js is a
// browser ES module inside a CommonJS package, so it is loaded from a data: URL.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const load = () =>
  import("data:text/javascript;base64," +
    fs.readFileSync(path.join(__dirname, "report-messages.js")).toString("base64"));

test("shareFailure", async (t) => {
  const { shareFailure } = await load();
  await t.test("a cancelled save is not a failure", () => {
    assert.equal(shareFailure({ ok: false, reason: "cancelled" }), null);
  });
  await t.test("each reason in words, with what to do instead", () => {
    assert.equal(shareFailure({ ok: false, reason: "no-scan" }), "There's no scan to share yet.");
    assert.match(shareFailure({ ok: false, reason: "no-mail-app" }), /Save the report as a file/);
    assert.match(shareFailure({ ok: false, reason: "write-failed", error: "EACCES" }), /another folder/);
    assert.match(shareFailure(undefined), /Try again/);
  });
});

test("explainFailure", async (t) => {
  const { explainFailure } = await load();

  await t.test("names each cause", () => {
    assert.equal(explainFailure({ reason: "no-endpoint" }), "AI explanations aren't set up in this build.");
    assert.equal(explainFailure({ reason: "timeout" }), "The AI took too long to answer. Try again in a moment.");
    assert.equal(explainFailure({ reason: "unreachable" }), "Couldn't reach the AI service. Check the connection and try again.");
    assert.equal(explainFailure({ reason: "http", status: 500, error: "not-configured" }), "The AI service isn't set up yet.");
    assert.equal(explainFailure({ reason: "http", status: 429, error: "rate-limited" }), "The AI service is busy. Try again in a minute.");
    assert.equal(explainFailure({ reason: "http", status: 502, error: "ai-refused" }), "The AI declined to assess this scan.");
    assert.equal(explainFailure({ reason: "http", status: 503, error: "ai-unavailable" }), "AI explanations are unavailable right now.");
    assert.equal(explainFailure({ reason: "http", status: 504, error: "ai-timeout" }), "The AI took too long to answer. Try again in a moment.");
    assert.equal(explainFailure({ reason: "http", status: 429, error: "ai-daily-limit" }), "AI explanations have reached today's limit. Try again tomorrow.");
    assert.equal(explainFailure({ reason: "http", status: 429, error: "ai-monthly-limit" }), "AI explanations have reached this month's limit.");
  });

  await t.test("falls back to a plain message", () => {
    assert.equal(explainFailure({ reason: "http", status: 502, error: "something-new" }), "Couldn't get an explanation. Try again in a moment.");
    assert.equal(explainFailure(undefined), "Couldn't get an explanation. Try again in a moment.");
  });
});
