// Security tests for what leaves the machine for "Explain my results"
// (report.js buildAiScan, requestExplanation): only allow-listed readings,
// nothing identifying, however the facts are shaped. fetch is stubbed.
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildReport, buildAiScan, requestExplanation, explainEndpoint, reportEndpoint } = require("./report");

// Identifying values, each unique so a leak names itself.
const ID = {
  hostname: "ID-HOSTNAME-EVONS-LAPTOP", user: "ID-USER-evon", mac: "aa:bb:cc:dd:ee:ff", ssid: "ID-SSID-Home",
  ipv4: "192.168.77.138", ipv6: "fe80::dead:beef", gateway: "192.168.77.1", dns: "10.77.0.53",
  serial: "ID-SERIAL-5CG1234", path: "/home/evon/ID-PATH", winPath: "C:\\Users\\evon\\ID-WINPATH",
  monitor: "ID-MONITOR-Evons-Dell", audioOut: "ID-AUDIO-Evons-AirPods", audioIn: "ID-MIC-Evons-AirPods",
  iface: "ID-IFACE-enxaabbccddeeff", vpnName: "ID-VPN-corp-evon", uuid: "ID-UUID-4c4c4544",
};

// Facts as the collector makes them, plus the identifying fields it has, plus
// fields it doesn't have (yet) that a later change might add.
function leakyFacts() {
  return {
    hostname: ID.hostname, user: ID.user, uptime: "3 days", appVersion: "1.3.1",
    machineType: "Dell Inc. XPS 13", serial: ID.serial, uuid: ID.uuid, homeDir: ID.path,
    cpu: { model: "Intel Core i7", cores: 4, threads: 8, ghz: 4.7, ghzKind: "max", serial: ID.serial, family: "Intel", arch: "x64", series: "x" },
    ram: { totalGB: 16, freeGB: 4, pressure: "Normal", type: "LPDDR5", serial: ID.serial },
    disk: { totalGB: 512, freeGB: 100, usedPercent: 80, ssd: null, serial: ID.serial, mount: ID.path, label: ID.winPath },
    display: { count: 1, monitors: [{ name: ID.monitor, builtin: true, main: true, resolution: "1920 × 1080", refreshRate: "60 Hz", size: '13"', serial: ID.serial, connection: "eDP-1", vendor: ID.monitor }] },
    os: { name: "Arch Linux", version: "rolling", pendingUpdates: null, lastUpdateCheck: "Checking…", lastUpdateKind: null, hostname: ID.hostname, kernel: "6.1", serial: ID.serial, logofile: ID.path },
    network: { interface: ID.iface, type: "Wireless", linkSpeed: "866 Mbps", mtu: 1500, mac: ID.mac, ipv4: ID.ipv4, ipv6: ID.ipv6, ipv6Disabled: false,
      gateway: ID.gateway, dns: [ID.dns], ssid: ID.ssid, isWired: false, isVirtual: false, bssid: ID.mac, publicIp: ID.ipv4 },
    bandwidth: { downMbps: null, upMbps: null, ping: null, jitter: null, measuredAt: null },
    vpn: { detected: true, name: ID.vpnName, server: ID.ipv4 },
    antivirus: { checked: true, products: [{ name: "ClamAV", running: true, definitionsAge: "1 day", path: ID.winPath, guid: ID.uuid, instanceGuid: ID.uuid }] },
    backgroundApps: null,
    power: { hasBattery: true, onBattery: false, batteryLevel: 80, plugged: true, serial: ID.serial, model: ID.serial },
    audio: { output: ID.audioOut, input: ID.audioIn, isWired: false, headsetConnected: true, headsetClass: "Bluetooth", deviceId: ID.uuid },
  };
}

const leakyDeferred = () => ({
  pendingUpdates: 3, lastUpdateCheck: "2 days ago", lastUpdateKind: "checked", ssd: true,
  backgroundApps: { runningApps: ["Zoom", "Chrome"], browserExtensions: 4, processes: [{ name: "zoom", path: ID.path, user: ID.user }], profileDir: ID.path },
  display: null,
});

// The allow-list, as report.js documents it.
const ALLOWED = {
  machineType: 1, uptime: 1,
  os: { name: 1, version: 1, pendingUpdates: 1, lastUpdateCheck: 1, lastUpdateKind: 1 },
  cpu: { model: 1, cores: 1, threads: 1, ghz: 1, ghzKind: 1 },
  ram: { totalGB: 1, freeGB: 1, pressure: 1, type: 1 },
  disk: { totalGB: 1, freeGB: 1, usedPercent: 1, ssd: 1 },
  display: { monitors: [{ builtin: 1, main: 1, resolution: 1, refreshRate: 1 }] },
  network: { type: 1, isWired: 1, isVirtual: 1, linkSpeed: 1 },
  vpn: { detected: 1 },
  bandwidth: { downMbps: 1, upMbps: 1, ping: 1, jitter: 1, partial: 1, failed: 1 },
  antivirus: { products: [{ name: 1, running: 1, definitionsAge: 1 }] },
  power: { hasBattery: 1, batteryLevel: 1, onBattery: 1 },
  audio: { headsetClass: 1 },
  backgroundApps: { runningApps: [1], browserExtensions: 1 },
};

// Every key path in `v` that the allow-list doesn't name.
function outsideAllowList(v, allow, p = "") {
  if (v === null || typeof v !== "object") return [];
  if (Array.isArray(v)) return v.flatMap((x, i) => outsideAllowList(x, Array.isArray(allow) ? allow[0] : undefined, `${p}[${i}]`));
  if (!allow || typeof allow !== "object") return [`${p} (an object where a value belongs)`];
  return Object.entries(v).flatMap(([k, x]) => (k in allow ? outsideAllowList(x, allow[k], `${p}.${k}`) : [`${p}.${k}`]));
}

const fromRenderer = { bandwidth: { downMbps: 500, upMbps: 50, ping: 10, jitter: 2, partial: false, failed: false } };

test("buildAiScan sends only the allow-list", async (t) => {
  await t.test("no key outside the allow-list, with every identifying and unexpected field present", () => {
    const scan = buildAiScan(buildReport(leakyFacts(), leakyDeferred(), fromRenderer));
    assert.deepEqual(outsideAllowList(scan, ALLOWED), []);
  });

  await t.test("no identifying value anywhere in what is sent", () => {
    for (const deferred of [leakyDeferred(), null]) {
      const sent = JSON.stringify({ scan: buildAiScan(buildReport(leakyFacts(), deferred, fromRenderer)) });
      for (const [name, v] of Object.entries(ID)) {
        assert.ok(!sent.includes(v), `${name} leaked`);
      }
      for (const v of ["evon", "aabbccddeeff", "AA:BB:CC", "192.168.", "Users\\\\", "/home/"]) {
        assert.ok(!sent.includes(v), `${v} leaked`);
      }
    }
  });

  await t.test("the renderer can't add anything but speed-test numbers", () => {
    const evil = {
      hostname: ID.hostname, network: { mac: ID.mac, ssid: ID.ssid }, extra: ID.serial,
      bandwidth: { downMbps: ID.ipv4, upMbps: { ip: ID.ipv4 }, ping: [ID.ipv4], jitter: NaN, partial: ID.ssid, failed: "true", server: ID.ipv4, measuredAt: ID.uuid },
    };
    const sent = JSON.stringify(buildAiScan(buildReport(leakyFacts(), null, evil)));
    for (const v of Object.values(ID)) assert.ok(!sent.includes(v), v);
    const scan = buildAiScan(buildReport(leakyFacts(), null, evil));
    assert.deepEqual(scan.bandwidth, { downMbps: null, upMbps: null, ping: null, jitter: null, partial: undefined, failed: undefined });
  });

  await t.test("a missing or empty scan still has the same shape, with no undefined objects", () => {
    for (const r of [undefined, null, {}, { cpu: null, os: "x", display: { monitors: "x" }, antivirus: { products: null }, backgroundApps: { runningApps: "x" } }]) {
      const scan = buildAiScan(r);
      assert.deepEqual(outsideAllowList(scan, ALLOWED), []);
      assert.ok(Array.isArray(scan.display.monitors));
      assert.ok(Array.isArray(scan.backgroundApps.runningApps));
    }
  });

  // BUG (defence in depth): the allow-list picks keys but doesn't check what
  // they hold. A value that is an object or array (here os.name, a running app
  // and an antivirus name) goes out whole, with whatever is nested in it. The
  // Worker's sanitizeScan drops non-strings, so today it stops at the Worker,
  // but it has already left the machine.
  await t.test("each value sent is a string, number, boolean or null, never a nested object", () => {
    const facts = leakyFacts();
    facts.os.name = { pretty: "Arch Linux", hostname: ID.hostname };
    facts.antivirus.products[0].name = { display: "ClamAV", path: ID.winPath };
    const deferred = leakyDeferred();
    deferred.backgroundApps.runningApps = ["Zoom", { name: "Chrome", path: ID.path, user: ID.user }];
    const sent = JSON.stringify(buildAiScan(buildReport(facts, deferred, fromRenderer)));
    for (const v of [ID.hostname, ID.winPath, ID.path, ID.user]) assert.ok(!sent.includes(JSON.stringify(v).slice(1, -1)), `${v} leaked inside a nested value`);
  });
});

test("requestExplanation", async (t) => {
  const stub = (status, body) => {
    const calls = [];
    const fn = async (url, init) => {
      calls.push({ url, init });
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    };
    fn.calls = calls;
    return fn;
  };

  await t.test("posts { scan } only, as JSON, with no redirects and a time limit", async () => {
    const fetchImpl = stub(200, { ok: true, summary: "Fine", findings: [] });
    const scan = buildAiScan(buildReport(leakyFacts(), leakyDeferred(), fromRenderer));
    await requestExplanation("https://worker.example/explain", scan, fetchImpl);
    const { init } = fetchImpl.calls[0];
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    assert.deepEqual(Object.keys(JSON.parse(init.body)), ["scan"]);
    assert.deepEqual(Object.keys(init.headers), ["Content-Type"], "no cookies, auth or identifying headers");
    for (const v of Object.values(ID)) assert.ok(!init.body.includes(v), v);
  });

  await t.test("refuses anything but https, before any request", async () => {
    const fetchImpl = stub(200, {});
    for (const url of ["http://worker.example/explain", "file:///etc/passwd", "javascript:alert(1)", "ftp://x/explain", " https://x", "HTTP://x", "//x/explain"]) {
      const out = await requestExplanation(url, {}, fetchImpl);
      assert.equal(out.ok, false, url);
    }
    assert.equal(fetchImpl.calls.length, 0);
  });

  await t.test("explainEndpoint stays on the configured host", () => {
    assert.equal(explainEndpoint("https://w.example/"), "https://w.example/explain");
    assert.equal(explainEndpoint("https://w.example/base"), "https://w.example/base/explain");
    assert.equal(new URL(explainEndpoint("https://w.example/?x=//evil.example")).host, "w.example");
    assert.equal(explainEndpoint("not a url"), "");
    assert.equal(explainEndpoint("https://127.0.0.1:9/"), "https://127.0.0.1:9/explain");
  });

  await t.test("a hostile or broken answer is an error, not passed on as a summary", async () => {
    for (const [status, body] of [[200, "<html>captive portal</html>"], [200, { ok: true, summary: 42 }], [200, { ok: false, summary: "x" }], [500, { ok: true, summary: "x" }], [302, ""]]) {
      const out = await requestExplanation("https://w.example/explain", {}, stub(status, body));
      assert.equal(out.ok, false, JSON.stringify(body));
    }
  });

  await t.test("a stalled server is a timeout; a refused connection is unreachable", async () => {
    const abort = async () => { throw Object.assign(new Error("aborted"), { name: "TimeoutError" }); };
    assert.equal((await requestExplanation("https://w.example/explain", {}, abort)).reason, "timeout");
    const refused = async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" }) }); };
    const out = await requestExplanation("https://127.0.0.1:9/explain", {}, refused);
    assert.deepEqual([out.ok, out.reason], [false, "unreachable"]);
  });

  await t.test("WHD_REPORT_URL wins over package.json; an empty one falls back", () => {
    const pkg = { workstationScanner: { reportUrl: "https://built-in.example/" } };
    assert.equal(reportEndpoint({ WHD_REPORT_URL: "https://127.0.0.1:9/" }, pkg), "https://127.0.0.1:9/");
    assert.equal(reportEndpoint({ WHD_REPORT_URL: "" }, pkg), "https://built-in.example/");
    assert.equal(reportEndpoint({}, { workstationScanner: { reportUrl: 42 } }), "");
  });
});
