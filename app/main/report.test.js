// Unit tests for the send-report result shape the renderer depends on, with a
// stubbed fetch. No request leaves the machine.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  sendReport, buildReport, reportEndpoint, normalizeEmail, classifyReportError, errorDetail,
  buildAiScan, explainEndpoint, requestExplanation,
} = require("./report");

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

test("buildReport", async (t) => {
  await t.test("keeps the MAC address and the Wi-Fi name on the machine", () => {
    const facts = { hostname: "host", network: { interface: "wlan0", ipv4: "192.168.1.9", mac: "aa:bb:cc:dd:ee:ff", ssid: "Home" } };
    const report = buildReport(facts, null, {});
    assert.deepEqual(report.network, { interface: "wlan0", ipv4: "192.168.1.9" });
    assert.equal(facts.network.mac, "aa:bb:cc:dd:ee:ff", "the scan itself is left as it was");
  });

  const scanned = {
    hostname: "host",
    os: { name: "Windows", pendingUpdates: null, lastUpdateCheck: "Checking…", lastUpdateKind: null },
    disk: { totalGB: 500, ssd: null },
    backgroundApps: null,
    bandwidth: { downMbps: null, upMbps: null, ping: null, jitter: null, measuredAt: null },
  };

  await t.test("uses main's own scan, not the renderer's copy of it", () => {
    const r = buildReport(scanned, null, { hostname: "spoofed", os: { name: "Other" } });
    assert.equal(r.hostname, "host");
    assert.equal(r.os.name, "Windows");
  });

  await t.test("merges the deferred results when they have landed", () => {
    const deferred = {
      pendingUpdates: 2, lastUpdateCheck: "3 hours ago", lastUpdateKind: "checked",
      ssd: true, backgroundApps: { browserExtensions: 1, runningApps: ["Zoom"] },
      display: { count: 1, resolution: "1920 × 1080" },
    };
    const r = buildReport(scanned, deferred, {});
    assert.deepEqual(r.display, deferred.display);
    assert.deepEqual(r.os, { name: "Windows", pendingUpdates: 2, lastUpdateCheck: "3 hours ago", lastUpdateKind: "checked" });
    assert.equal(r.disk.ssd, true);
    assert.deepEqual(r.backgroundApps, deferred.backgroundApps);
  });

  await t.test("takes the speed test from the renderer, as numbers and flags only", () => {
    const r = buildReport(scanned, null, {
      bandwidth: { downMbps: 412, upMbps: "lots", ping: 9, jitter: Infinity, measuredAt: 1700000000000, partial: false, failed: "no", extra: "x" },
    });
    assert.deepEqual(r.bandwidth, { downMbps: 412, upMbps: null, ping: 9, jitter: null, measuredAt: 1700000000000, partial: false });
  });

  await t.test("reports no measurement when the renderer sends nothing usable", () => {
    for (const from of [undefined, null, "facts", {}]) {
      assert.deepEqual(buildReport(scanned, null, from).bandwidth,
        { downMbps: null, upMbps: null, ping: null, jitter: null, measuredAt: null });
    }
  });

  await t.test("leaves the scan it was given untouched", () => {
    const before = JSON.stringify(scanned);
    buildReport(scanned, { pendingUpdates: 1, lastUpdateCheck: "x", lastUpdateKind: "checked", ssd: false }, {});
    assert.equal(JSON.stringify(scanned), before);
  });
});

test("reportEndpoint", async (t) => {
  await t.test("prefers WHD_REPORT_URL, then package.json's reportUrl", () => {
    const pkg = { workstationScanner: { reportUrl: "https://built.example/report" } };
    assert.equal(reportEndpoint({ WHD_REPORT_URL: "https://env.example/" }, pkg), "https://env.example/");
    assert.equal(reportEndpoint({}, pkg), "https://built.example/report");
  });

  await t.test("is empty when neither is set, or reportUrl is blank or not a string", () => {
    assert.equal(reportEndpoint({}, {}), "");
    assert.equal(reportEndpoint({}, { workstationScanner: { reportUrl: "  " } }), "");
    assert.equal(reportEndpoint({}, { workstationScanner: { reportUrl: 42 } }), "");
    assert.equal(reportEndpoint(undefined, undefined), "");
  });
});

test("normalizeEmail", async (t) => {
  await t.test("trims a valid address", () => {
    assert.equal(normalizeEmail("  sam@example.com\n"), "sam@example.com");
  });

  await t.test("refuses anything that isn't one plausible address", () => {
    for (const bad of ["", "sam", "sam@example", "sam@@example.com", "sam @example.com",
      "a@b.c,d@e.f", `${"a".repeat(250)}@example.com`, null, undefined, 42, {}]) {
      assert.equal(normalizeEmail(bad), null, String(bad));
    }
  });
});

test("sendReport posts the address and the report together", async () => {
  const fetch = fakeFetch(() => new Response(null, { status: 200 }));
  const payload = { email: "sam@example.com", report: { hostname: "host" } };
  const res = await sendReport("https://mailer.example/", payload, fetch);
  assert.deepEqual(res, { ok: true, status: 200 });
  assert.deepEqual(JSON.parse(fetch.calls[0].init.body), payload);
});

test("classifyReportError reads undici's connect timeout as a timeout", () => {
  const err = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
  });
  assert.equal(classifyReportError(err), "timeout");
  assert.equal(classifyReportError(causedBy("connect ECONNREFUSED 127.0.0.1:9")), "unreachable");
});

// A report as main builds it, with every identifying field the app collects.
const fullReport = {
  hostname: "EVONS-LAPTOP", user: "evon", uptime: "3 days, 2 hours", appVersion: "1.2.0",
  machineType: "Dell Inc. Dell Pro 14 Plus PB14250",
  cpu: { model: "Intel Core Ultra 5 236V", cores: 8, threads: 8, perfCores: 8, effCores: 0, ghz: 4.7, ghzKind: "max" },
  ram: { totalGB: 16, freeGB: 1.2, type: "LPDDR5", pressure: "High" },
  disk: { totalGB: 262, freeGB: 12, usedPercent: 95, ssd: true },
  display: { count: 1, monitors: [{ name: "Evon's monitor", builtin: false, main: true, resolution: "5120 × 1440",
    refreshRate: "120 Hz", connection: "DP-7", size: null }] },
  os: { name: "Debian GNU/Linux", version: "13", build: "", pendingUpdates: 2, lastUpdateCheck: "41 min ago", lastUpdateKind: "checked" },
  network: { interface: "wlp0s20f3", type: "Wireless", linkSpeed: "Unknown", mtu: 1500, mac: "aa:bb:cc:dd:ee:ff",
    ipv4: "192.168.1.138", ipv6Disabled: false, gateway: "192.168.1.1", dns: ["192.168.1.1"], ssid: "Evon's Wi-Fi",
    isWired: false, isVirtual: false },
  bandwidth: { downMbps: 607, upMbps: 37, ping: 46, jitter: 51.7, measuredAt: 1790000000000 },
  vpn: { detected: true, name: "Evon's Corp VPN" },
  antivirus: { products: [{ name: "ClamAV", version: null, running: true, updated: null, definitionsAge: "2 hours" }] },
  backgroundApps: { browserExtensions: 6, runningApps: ["Zoom", "Chrome"] },
  power: { hasBattery: true, onBattery: false, batteryLevel: 80, plugged: true },
  audio: { output: "Evon's AirPods", input: "Evon's AirPods", isWired: false, headsetConnected: true, headsetClass: "Bluetooth" },
};

test("buildAiScan", async (t) => {
  await t.test("leaves out everything that identifies the machine or the person", () => {
    const sent = JSON.stringify(buildAiScan(fullReport));
    for (const secret of ["EVONS-LAPTOP", "evon", "Evon", "aa:bb:cc", "192.168.1", "wlp0s20f3", "DP-7", "1790000000000"]) {
      assert.ok(!sent.includes(secret), `the AI scan carries ${secret}`);
    }
  });

  await t.test("keeps the readings an assessment needs", () => {
    const s = buildAiScan(fullReport);
    assert.equal(s.cpu.model, "Intel Core Ultra 5 236V");
    assert.equal(s.disk.usedPercent, 95);
    assert.equal(s.ram.pressure, "High");
    assert.equal(s.bandwidth.jitter, 51.7);
    assert.deepEqual(s.display.monitors, [{ builtin: false, main: true, resolution: "5120 × 1440", refreshRate: "120 Hz" }]);
    assert.deepEqual(s.vpn, { detected: true });
    assert.deepEqual(s.audio, { headsetClass: "Bluetooth" });
    assert.deepEqual(s.antivirus.products, [{ name: "ClamAV", running: true, definitionsAge: "2 hours" }]);
  });

  await t.test("sends the CPU speed with its kind, and no speed when neither clock is known", () => {
    assert.deepEqual(buildAiScan(fullReport).cpu, { model: "Intel Core Ultra 5 236V", cores: 8, threads: 8, ghz: 4.7, ghzKind: "max" });
    const unknown = buildAiScan({ ...fullReport, cpu: { ...fullReport.cpu, ghz: 0, ghzKind: null } });
    assert.equal(unknown.cpu.ghz, null);
    assert.equal(unknown.cpu.ghzKind, null);
  });

  await t.test("keeps 'none found' apart from 'nothing to report'", () => {
    assert.deepEqual(buildAiScan({ antivirus: { products: [] } }).antivirus, { products: [] });
    assert.equal(buildAiScan({ antivirus: null }).antivirus, null);
  });

  await t.test("copes with a report missing whole sections", () => {
    const s = buildAiScan({ hostname: "x" });
    assert.deepEqual(s.display.monitors, []);
    assert.equal(s.antivirus, null, "no antivirus reading is 'not checked', not 'none found'");
    assert.deepEqual(s.backgroundApps.runningApps, []);
    assert.doesNotThrow(() => buildAiScan(null));
  });
});

test("explainEndpoint", () => {
  assert.equal(explainEndpoint("https://mailer.example.workers.dev/"), "https://mailer.example.workers.dev/explain");
  assert.equal(explainEndpoint("https://mailer.example.workers.dev"), "https://mailer.example.workers.dev/explain");
  assert.equal(explainEndpoint("https://example.com/reports/"), "https://example.com/reports/explain");
  assert.equal(explainEndpoint(""), "");
  assert.equal(explainEndpoint("not a url"), "");
});

test("requestExplanation", async (t) => {
  const answer = { ok: true, summary: "Mostly fine.", findings: [{ severity: "high", title: "Disk", detail: "95%", fix: "Clean up" }], model: "claude-opus-5-5" };

  await t.test("posts { scan } and returns the assessment", async () => {
    const fetch = fakeFetch(() => new Response(JSON.stringify(answer), { status: 200 }));
    const res = await requestExplanation("https://mailer.example/explain", { cpu: {} }, fetch);
    assert.deepEqual(res, { ok: true, summary: "Mostly fine.", findings: answer.findings, model: "claude-opus-5-5" });
    assert.deepEqual(JSON.parse(fetch.calls[0].init.body), { scan: { cpu: {} } });
    assert.equal(fetch.calls[0].init.redirect, "error");
  });

  await t.test("refuses to send over http, and without an endpoint", async () => {
    const fetch = fakeFetch(() => new Response("{}", { status: 200 }));
    assert.equal((await requestExplanation("http://mailer.example/explain", {}, fetch)).reason, "insecure-url");
    assert.deepEqual(await requestExplanation("", {}, fetch), { ok: false, reason: "no-endpoint" });
    assert.equal(fetch.calls.length, 0);
  });

  await t.test("passes the Worker's reason through", async () => {
    const fetch = fakeFetch(() => new Response(JSON.stringify({ ok: false, error: "ai-busy" }), { status: 503 }));
    assert.deepEqual(await requestExplanation("https://mailer.example/explain", {}, fetch),
      { ok: false, reason: "http", status: 503, error: "ai-busy" });
  });

  await t.test("treats a 200 without a summary as a failure", async () => {
    const fetch = fakeFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    assert.equal((await requestExplanation("https://mailer.example/explain", {}, fetch)).ok, false);
  });

  await t.test("reports an unreachable service", async () => {
    const fetch = async () => { throw causedBy("connect ECONNREFUSED 127.0.0.1:9"); };
    assert.equal((await requestExplanation("https://127.0.0.1:9/explain", {}, fetch)).reason, "unreachable");
  });
});

test("sendReport passes the report mailer's reason through", async (t) => {
  await t.test("reads { error } from a JSON refusal", async () => {
    const fetch = fakeFetch(() => new Response(JSON.stringify({ ok: false, error: "send-failed", status: 403 }), { status: 502 }));
    const res = await sendReport("https://mailer.example/", { email: "a@b.co", report: {} }, fetch);
    assert.deepEqual(res, { ok: false, reason: "http", status: 502, error: "send-failed" });
  });

  await t.test("leaves it out when the body isn't JSON or has no error", async () => {
    for (const body of ["<html>Bad gateway</html>", JSON.stringify({ ok: false }), null]) {
      const fetch = fakeFetch(() => new Response(body, { status: 502 }));
      assert.deepEqual(await sendReport("https://mailer.example/", {}, fetch), { ok: false, reason: "http", status: 502 });
    }
  });
});
