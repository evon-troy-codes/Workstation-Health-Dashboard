// Unit tests for Share report (share.js): the text, the email link, the
// saved page and its file name. Nothing here sends anything.
const test = require("node:test");
const assert = require("node:assert/strict");
const { reportSections, reportText, shortText, mailtoLink, reportHtml, reportFileName, MAX_MAILTO } = require("./share");

const at = new Date("2026-10-02T17:13:00Z");
const report = {
  hostname: "DESKTOP-01", user: "sam", machineType: "Dell Inc. Dell Pro 14", uptime: "3 days, 2 hours", appVersion: "1.3.1",
  os: { name: "Windows 11 Pro", version: "10.0.26100", pendingUpdates: 2, lastUpdateCheck: "1 day ago", lastUpdateKind: "checked" },
  cpu: { model: "Intel Core Ultra 5 236V", cores: 8, threads: 8 },
  ram: { totalGB: 16, freeGB: 6, pressure: "Normal" },
  disk: { totalGB: 475, freeGB: 300, usedPercent: 37 },
  display: { count: 1, monitors: [{ name: "Built-in display", main: true, resolution: "1920 × 1200", refreshRate: "60 Hz", size: '14"' }] },
  network: { type: "Wireless", interface: "Wi-Fi", linkSpeed: "866 Mbps", ipv4: "192.168.1.9", gateway: "192.168.1.1", dns: ["192.168.1.1"] },
  vpn: { detected: false },
  bandwidth: { downMbps: 844, upMbps: 37, ping: 57, jitter: 3 },
  antivirus: { checked: true, products: [{ name: "Windows Defender", running: true, definitionsAge: "2 hours" }] },
  power: { hasBattery: true, batteryLevel: 80, plugged: true },
  audio: { output: "Headphones", input: "Microphone", headsetClass: "Bluetooth" },
  backgroundApps: { runningApps: ["Zoom", "Chrome"] },
};

test("reportText", async (t) => {
  await t.test("lays out every section as plain text", () => {
    const text = reportText(report, at);
    assert.match(text, /^Workstation Scanner report for DESKTOP-01, 2026-10-02 17:13 UTC\./);
    for (const line of ["  Operating system: Windows 11 Pro 10.0.26100", "  Download: 844 Mbps", "  Windows Defender: Active · definitions 2 hours",
      "  Background apps: Zoom, Chrome", "  Built-in display: 1920 × 1200 · 60 Hz · 14\""]) {
      assert.ok(text.includes(line), `missing: ${line}`);
    }
  });

  await t.test("never shows the MAC address or Wi-Fi name, even if the report had them", () => {
    const text = reportText({ ...report, network: { ...report.network, mac: "aa:bb:cc:dd:ee:ff", ssid: "HomeWiFi" } }, at);
    assert.ok(!text.includes("aa:bb:cc") && !text.includes("HomeWiFi"));
  });

  await t.test("antivirus: none to report, unknown, none found", () => {
    // Security stays for the firewall, with no antivirus row.
    const security = reportSections({ ...report, antivirus: null }).find(([name]) => name === "Security");
    assert.ok(!security[1].some(([k]) => k === "Antivirus"));
    assert.match(reportText({ ...report, antivirus: { checked: false, products: [] } }, at), /Antivirus: Unknown \(the check failed\)/);
    assert.match(reportText({ ...report, antivirus: { checked: true, products: [] } }, at), /Antivirus: None detected/);
  });

  await t.test("firewall: each product's state, none found, unknown", () => {
    const fw = (firewall) => reportText({ ...report, firewall }, at);
    assert.match(fw({ checked: true, products: [{ name: "UFW", active: true, detail: null }] }), /UFW: Active/);
    assert.match(fw({ checked: true, products: [{ name: "Windows Firewall", active: true, detail: "Off for: Public" }] }), /Windows Firewall: Active · Off for: Public/);
    assert.match(fw({ checked: true, products: [{ name: "LuLu", active: null, detail: null }] }), /LuLu: Installed/);
    assert.match(fw({ checked: true, products: [{ name: "firewalld", active: false, detail: null }] }), /firewalld: Inactive/);
    assert.match(fw({ checked: true, products: [] }), /Firewall: No firewall service found/);
    assert.match(fw({ checked: false, products: [] }), /Firewall: Unknown \(the check failed\)/);
    // No reading at all is unknown, never "none found".
    assert.match(fw(undefined), /Firewall: Unknown$/m);
  });

  await t.test("snap and Flatpak rows only for installed stores, Unknown when unchecked", () => {
    const text = reportText({ ...report, os: { ...report.os, appUpdates: { snap: 4, flatpak: null } } }, at);
    assert.match(text, /Snap updates: 4/);
    assert.match(text, /Flatpak updates: Unknown/);
    assert.ok(!/Snap updates|Flatpak updates/.test(reportText({ ...report, os: { ...report.os, appUpdates: {} } }, at)));
  });

  await t.test("missing readings read as a dash, not undefined", () => {
    const text = reportText({ hostname: "x" }, at);
    assert.ok(!/undefined|NaN|null/.test(text), text);
  });
});

test("mailtoLink", async (t) => {
  await t.test("opens an email with no recipient, the subject and the report filled in", () => {
    const { url, shortened } = mailtoLink(report, at);
    assert.ok(url.startsWith("mailto:?subject="), "no recipient: the person picks who it goes to");
    assert.equal(shortened, false);
    const params = new URL(url).searchParams;
    assert.equal(params.get("subject"), "Workstation report: DESKTOP-01");
    assert.equal(params.get("body"), reportText(report, at));
    assert.ok(url.length <= MAX_MAILTO);
  });

  await t.test("a report too long for a link sends the summary, which says how to attach the rest", () => {
    const long = { ...report, backgroundApps: { runningApps: Array.from({ length: 20 }, (_, i) => `Application number ${i} with a long name`) } };
    const { url, shortened } = mailtoLink(long, at);
    assert.equal(shortened, true);
    assert.ok(url.length <= MAX_MAILTO, `${url.length} characters`);
    assert.equal(new URL(url).searchParams.get("body"), shortText(long, at));
    assert.match(shortText(long, at), /Save as a file/);
  });
});

test("reportHtml", async (t) => {
  await t.test("escapes every value and loads nothing from outside", () => {
    const html = reportHtml({ ...report, hostname: '<script>alert(1)</script>', user: '"><img src=x onerror=alert(1)>' }, at);
    assert.ok(!html.includes("<script>alert") && !html.includes("<img"), "values must be escaped");
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
    assert.ok(!/<(script|link|img|iframe|object|embed)\b/i.test(html), "no scripts, images, frames or linked files");
    assert.ok(!/https?:\/\//.test(html), "nothing loaded from the web");
  });

  await t.test("has the readings", () => {
    const html = reportHtml(report, at);
    assert.match(html, /<title>Workstation report: DESKTOP-01<\/title>/);
    assert.match(html, /844 Mbps/);
  });
});

test("reportFileName", () => {
  assert.equal(reportFileName(report, at), "workstation-report-DESKTOP-01-2026-10-02.html");
  // No path separators survive, so a name can't point outside the chosen folder.
  assert.equal(reportFileName({ hostname: "../../etc/passwd" }, at), "workstation-report-..-..-etc-passwd-2026-10-02.html");
  assert.doesNotMatch(reportFileName({ hostname: 'a/b\\c:d*e?"f<g>h|i' }, at), /[/\\:*?"<>|]/);
  assert.equal(reportFileName({}, at), "workstation-report-computer-2026-10-02.html");
});
