// Unit tests for the send-report result shape the renderer depends on, with a
// stubbed fetch. No request leaves the machine.
const test = require("node:test");
const assert = require("node:assert/strict");

const { sendReport, classifyReportError } = require("./report");

// A fetch stand-in that records its calls and answers with `respond()`.
function fakeFetch(respond) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return respond();
  };
  fn.calls = calls;
  return fn;
}

const causedBy = (message) => Object.assign(new TypeError("fetch failed"), { cause: new Error(message) });

test("sendReport", async (t) => {
  await t.test("skips when no endpoint is configured", async () => {
    const fetch = fakeFetch(() => new Response(null, { status: 200 }));
    const res = await sendReport("", { host: "x" }, fetch);
    assert.equal(res.ok, true);
    assert.equal(res.skipped, true);
    assert.equal(res.reason, "no-endpoint");
    assert.equal(fetch.calls.length, 0);
  });

  await t.test("refuses a non-https endpoint without sending anything", async () => {
    const fetch = fakeFetch(() => new Response(null, { status: 200 }));
    const res = await sendReport("http://example.test/report", {}, fetch);
    assert.equal(res.ok, false);
    assert.equal(res.reason, "insecure-url");
    assert.equal(fetch.calls.length, 0);
  });

  await t.test("POSTs the facts as JSON and refuses redirects", async () => {
    const fetch = fakeFetch(() => new Response(null, { status: 200 }));
    const res = await sendReport("https://example.test/report", { host: "x" }, fetch);
    assert.deepEqual(res, { ok: true, status: 200 });
    const { init } = fetch.calls[0];
    assert.equal(init.method, "POST");
    assert.equal(init.headers["Content-Type"], "application/json");
    assert.equal(init.body, JSON.stringify({ host: "x" }));
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
  });

  await t.test("reports an error status as reason http", async () => {
    const fetch = fakeFetch(() => new Response(null, { status: 500 }));
    const res = await sendReport("https://example.test/report", {}, fetch);
    assert.deepEqual(res, { ok: false, reason: "http", status: 500 });
  });

  await t.test("keeps the underlying cause in error", async () => {
    const fetch = fakeFetch(() => { throw causedBy("connect ECONNREFUSED 127.0.0.1:443"); });
    const res = await sendReport("https://example.test/report", {}, fetch);
    assert.equal(res.reason, "unreachable");
    assert.match(res.error, /ECONNREFUSED/);
  });
});

test("classifyReportError", async (t) => {
  await t.test("a timeout", () => {
    assert.equal(classifyReportError(new DOMException("timed out", "TimeoutError")), "timeout");
    assert.equal(classifyReportError(new DOMException("aborted", "AbortError")), "timeout");
  });

  await t.test("a refused redirect", () => {
    assert.equal(classifyReportError(causedBy("unexpected redirect")), "redirected");
  });

  await t.test("anything else is unreachable", () => {
    assert.equal(classifyReportError(causedBy("getaddrinfo ENOTFOUND example.test")), "unreachable");
    assert.equal(classifyReportError(new Error("boom")), "unreachable");
    assert.equal(classifyReportError(null), "unreachable");
  });
});
