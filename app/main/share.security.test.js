// Security tests for Share report (share.js), fed through buildReport as main
// does: hostile values in the scan must come out escaped in the saved page,
// can't add headers or recipients to the email link, and the MAC address and
// Wi-Fi name never appear in anything shared. Nothing here sends anything.
const test = require("node:test");
const assert = require("node:assert/strict");
const { reportText, shortText, mailtoLink, reportHtml, reportFileName, MAX_MAILTO } = require("./share");
const { buildReport } = require("./report");

const at = new Date("2026-10-02T17:13:00Z");
const MAC = "aa:bb:cc:dd:ee:ff";
const SSID = "Evons-Secret-WiFi";

// Every value the report shows, set to `v`. Numbers stay numbers where the
// report formats them as numbers, and get `v` too where val() would show a
// string.
function factsWith(v) {
  return {
    hostname: v, user: v, machineType: v, uptime: v, appVersion: v,
    os: { name: v, version: v, pendingUpdates: v, lastUpdateCheck: v, lastUpdateKind: "checked" },
    cpu: { model: v, cores: v, threads: v },
    ram: { totalGB: 16, freeGB: 6, pressure: v },
    disk: { totalGB: 475, freeGB: 300, usedPercent: 37 },
    display: { monitors: [{ name: v, main: true, resolution: v, refreshRate: v, size: v }, { name: v, resolution: v }] },
    network: { type: v, interface: v, linkSpeed: v, ipv4: v, gateway: v, dns: [v, v], mac: MAC, ssid: SSID, isWired: false, isVirtual: false },
    vpn: { detected: true, name: v },
    antivirus: { checked: true, products: [{ name: v, running: true, definitionsAge: v }, { name: v, running: null }] },
    power: { hasBattery: true, batteryLevel: 80, plugged: true },
    audio: { output: v, input: v, headsetClass: v },
    backgroundApps: { runningApps: [v, v] },
  };
}

const deferredWith = (v) => ({ pendingUpdates: v, lastUpdateCheck: v, lastUpdateKind: "installed", ssd: true, backgroundApps: { runningApps: [v] }, display: null });

// What main shares: buildReport over its own scan, with only the speed test
// from the renderer.
const shared = (v, fromRenderer = { bandwidth: { downMbps: 100, upMbps: 10, ping: 5, jitter: 1 } }) =>
  buildReport(factsWith(v), deferredWith(v), fromRenderer);

const HOSTILE = [
  "<script>alert(1)</script>",
  '"><img src=x onerror=alert(1)>',
  "</title><script>alert(document.domain)</script>",
  "'><svg/onload=alert(1)>",
  "</td></tr></table><iframe src=javascript:alert(1)>",
  "<!--",
  "]]><![CDATA[<x>",
  "&lt;script&gt;", // already-escaped text must be escaped again, not decoded
  "<meta http-equiv=refresh content=0;url=https://evil.example>",
];

test("reportHtml escapes hostile scan values", async (t) => {
  // The page's own markup, from a report of harmless values.
  const tags = (html) => (html.match(/</g) || []).length;
  const baseline = tags(reportHtml(shared("X"), at));

  for (const h of HOSTILE) {
    await t.test(JSON.stringify(h), () => {
      const html = reportHtml(shared(h), at);
      // Not one extra "<": every one in a value was escaped.
      assert.equal(tags(html), baseline, "a value added markup to the page");
      assert.equal((html.match(/<\/title>/g) || []).length, 1);
      assert.equal((html.match(/<script/gi) || []).length, 0);
      assert.ok(!/<img|<svg|<iframe|<meta http-equiv=refresh/i.test(html));
      // And the value is shown, escaped, rather than dropped.
      const escaped = h.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
      assert.ok(html.includes(escaped), "value missing from the page");
    });
  }

  await t.test("keeps its own CSP: no scripts, nothing from outside", () => {
    const html = reportHtml(shared(HOSTILE[0]), at);
    assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">/);
    // The CSP must come before the first value, or a value could precede it.
    assert.ok(html.indexOf("Content-Security-Policy") < html.indexOf("&lt;script"));
  });

  await t.test("quotes in values can't break out of an attribute", () => {
    const html = reportHtml(shared('" style="background:url(https://evil.example/x)" x="'), at);
    assert.ok(!html.includes('style="background:url'));
    assert.ok(!html.includes("https://evil.example/x)\""));
  });
});

test("mailtoLink can't add headers or recipients", async (t) => {
  const INJECT = [
    "x\r\nBcc: victim@example.com",
    "x%0d%0aBcc:%20victim@example.com",
    "x&cc=victim@example.com",
    "x?bcc=victim@example.com",
    "x&to=victim@example.com&subject=Pwned",
    "victim@example.com,other@example.com",
    "x#&bcc=victim@example.com",
    "x\u2028Bcc: victim@example.com",
    "x\nTo: victim@example.com\n\nbody",
  ];

  for (const h of INJECT) {
    await t.test(JSON.stringify(h), () => {
      const { url } = mailtoLink(shared(h), at);
      assert.ok(url.startsWith("mailto:?subject="), "a recipient was filled in");
      const u = new URL(url);
      assert.equal(u.protocol, "mailto:");
      assert.equal(u.pathname, "", "a recipient was filled in");
      assert.equal(u.hash, "");
      assert.deepEqual([...u.searchParams.keys()], ["subject", "body"], "an extra header was added");
      // Nothing raw that a mail app could read as a separator.
      assert.ok(!/[\r\n\s#]/.test(url), "raw separator in the link");
      assert.equal((url.match(/[?]/g) || []).length, 1);
      assert.equal((url.match(/&/g) || []).length, 1);
      // The subject is one line, whatever the hostname held.
      assert.ok(!/[\r\n\u2028\u2029]/.test(u.searchParams.get("subject")));
    });
  }

  await t.test("a body line can't start a header block", () => {
    const { url } = mailtoLink(shared("x\r\n\r\nBcc: victim@example.com"), at);
    const body = new URL(url).searchParams.get("body");
    assert.ok(!/^Bcc:/mi.test(body));
  });
});

test("very long values", async (t) => {
  await t.test("each value in the page and text is capped at 200 characters", () => {
    const long = "A".repeat(100_000);
    const html = reportHtml(shared(long), at);
    const text = reportText(shared(long), at);
    assert.ok(!html.includes("A".repeat(201)));
    assert.ok(!text.includes("A".repeat(201)));
    assert.ok(html.length < 100_000, `page is ${html.length} characters`);
  });

  await t.test("the file name stays short and safe", () => {
    for (const h of ["A".repeat(10_000), "../../etc/passwd", "..\\..\\Windows\\win.ini", "CON", "a/b\\c:d*e?f\"g<h>i|j", "\u0000", "."]) {
      const name = reportFileName(shared(h), at);
      assert.match(name, /^workstation-report-[A-Za-z0-9._-]+-2026-10-02\.html$/);
      assert.ok(name.length < 120);
      // ".." can remain, but with no separator it is only part of one name.
      assert.ok(!name.includes("/") && !name.includes("\\"), name);
    }
  });

  await t.test("a long report falls back to the summary", () => {
    assert.equal(mailtoLink(shared("A".repeat(10_000)), at).shortened, true);
  });

  // BUG: the summary isn't capped either. Its eight values of up to 200
  // characters each, percent-encoded (non-ASCII characters grow to 6-9
  // characters each), pass MAX_MAILTO, which some Windows mail apps cut off.
  await t.test("the email link stays within MAX_MAILTO even when the summary is long", () => {
    for (const v of ["A".repeat(250), "é".repeat(250), "日本".repeat(125), "Intel(R) Core(TM) i9-14900K @ 3.20GHz — ".repeat(10)]) {
      const { url } = mailtoLink(shared(v), at);
      assert.ok(url.length <= MAX_MAILTO, `${JSON.stringify(v.slice(0, 12))}…: link is ${url.length} characters, over ${MAX_MAILTO}`);
    }
  });
});

test("the MAC address and Wi-Fi name never appear in anything shared", async (t) => {
  const outputs = (report) => {
    const { url } = mailtoLink(report, at);
    return {
      text: reportText(report, at),
      short: shortText(report, at),
      html: reportHtml(report, at),
      mailto: decodeURIComponent(url),
      mailtoRaw: url,
      fileName: reportFileName(report, at),
    };
  };
  const forms = (mac) => [mac, mac.toUpperCase(), mac.replace(/:/g, "-"), mac.replace(/:/g, "-").toUpperCase(), mac.replace(/:/g, "")];

  await t.test("not from facts.network.mac / ssid", () => {
    const report = shared("ok");
    for (const [name, out] of Object.entries(outputs(report))) {
      for (const f of forms(MAC)) assert.ok(!out.includes(f), `${name} has the MAC (${f})`);
      assert.ok(!out.includes(SSID), `${name} has the SSID`);
    }
  });

  await t.test("not when the renderer sends them back", () => {
    const report = buildReport(factsWith("ok"), null, {
      network: { mac: MAC, ssid: SSID }, ssid: SSID, mac: MAC, hostname: SSID,
      bandwidth: { downMbps: SSID, upMbps: MAC, ping: 1, jitter: 1, partial: SSID },
    });
    assert.equal(report.hostname, "ok", "the renderer's hostname was taken");
    for (const [name, out] of Object.entries(outputs(report))) {
      assert.ok(!out.includes(MAC) && !out.includes(SSID), name);
    }
  });

  await t.test("not when the Wi-Fi name is the network type or a VPN name is the SSID's twin", () => {
    // The report shows network.type and vpn.name; neither is the SSID in the
    // collector, but if one ever were the same string the report must still
    // not carry the ssid field itself.
    const report = shared("ok");
    assert.equal(report.network.ssid, undefined);
    assert.equal(report.network.mac, undefined);
  });

  // BUG (privacy): on Linux, systemd names USB network adapters after their
  // MAC address ("enx" + MAC for USB Ethernet dongles, "wlx" + MAC for USB
  // Wi-Fi). buildReport drops network.mac but keeps network.interface, so the
  // MAC goes out in every shared report as "Interface: enxaabbccddeeff".
  await t.test("not inside a Linux interface name such as enx<mac> / wlx<mac>", () => {
    for (const iface of ["enxaabbccddeeff", "wlxaabbccddeeff"]) {
      const facts = factsWith("ok");
      facts.network.interface = iface;
      const report = buildReport(facts, null, {});
      for (const [name, out] of Object.entries(outputs(report))) {
        assert.ok(!out.toLowerCase().includes("aabbccddeeff"), `${name} carries the MAC via the interface name ${iface}`);
      }
    }
  });
});
