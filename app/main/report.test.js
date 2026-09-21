// Unit tests for the send-report result shape the renderer depends on, with a
// stubbed fetch. No request leaves the machine.
const test = require("node:test");
const assert = require("node:assert/strict");

const { sendReport, classifyReportError, errorDetail } = require("./report");

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
    // No `error` on a result that succeeded.
    assert.deepEqual(res, { ok: true, skipped: true, reason: "no-endpoint" });
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

test("errorDetail", async (t) => {
  await t.test("keeps the cause rather than fetch's generic message", () => {
    assert.equal(errorDetail(causedBy("connect ECONNREFUSED 127.0.0.1:443")), "Error: connect ECONNREFUSED 127.0.0.1:443");
  });

  await t.test("unpacks the per-address errors when every address refused", () => {
    // What undici throws when a host resolves to IPv6 and IPv4 and both
    // refuse: an AggregateError whose own message is empty.
    const refused = new AggregateError([
      new Error("connect ECONNREFUSED ::1:443"),
      new Error("connect ECONNREFUSED 127.0.0.1:443"),
    ]);
    const err = Object.assign(new TypeError("fetch failed"), { cause: refused });
    assert.equal(String(refused), "AggregateError"); // the detail that was being lost
    assert.equal(
      errorDetail(err),
      "Error: connect ECONNREFUSED ::1:443; Error: connect ECONNREFUSED 127.0.0.1:443",
    );
  });

  await t.test("falls back to the error itself when there is no cause", () => {
    assert.equal(errorDetail(new Error("boom")), "Error: boom");
  });
});
