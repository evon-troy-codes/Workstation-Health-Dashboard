// Unit tests for the pure/parsing helpers in system-facts.js. Detection
// functions that shell out to OS-specific tools (PowerShell, si.*) are left
// untested here — they need a live workstation, not a unit test.
const test = require("node:test");
const assert = require("node:assert/strict");

const os = require("os");

const {
  classifyHeadset,
  detectVpn,
  pickAudio,
  pickPrimaryFs,
  isExternalDisplay,
  formatLinkSpeed,
  ramPressure,
  humanUptime,
  humanAge,
  parseWindowsAv,
} = require("./system-facts");

test("classifyHeadset", async (t) => {
  await t.test("detects bluetooth from AirPods name", () => {
    assert.equal(classifyHeadset([{ name: "AirPods Pro", type: "out" }]), "Bluetooth");
  });

  await t.test("detects USB headset from known brand", () => {
    assert.equal(classifyHeadset([{ name: "Jabra Evolve 65", type: "out" }]), "USB headset");
  });

  await t.test("falls back to built-in when nothing matches", () => {
    assert.equal(classifyHeadset([{ name: "Realtek High Definition Audio", type: "out" }]), "Built-in");
  });

  await t.test("handles empty/missing audio list", () => {
    assert.equal(classifyHeadset([]), "Built-in");
    assert.equal(classifyHeadset(null), "Built-in");
  });
});

test("detectVpn", async (t) => {
  await t.test("detects an active tunnel interface", () => {
    const net = [
      { iface: "eth0", ifaceName: "Ethernet", operstate: "up", ip4: "192.168.1.5" },
      { iface: "utun3", ifaceName: "Tailscale", operstate: "up", ip4: "100.64.0.5" },
    ];
    assert.deepEqual(detectVpn(net), { detected: true, name: "Tailscale" });
  });

  await t.test("ignores an idle tunnel interface with no IPv4", () => {
    const net = [{ iface: "utun0", ifaceName: "utun0", operstate: "up", ip4: null }];
    assert.deepEqual(detectVpn(net), { detected: false, name: null });
  });

  await t.test("returns not-detected when nothing matches", () => {
    const net = [{ iface: "eth0", ifaceName: "Ethernet", operstate: "up", ip4: "192.168.1.5" }];
    assert.deepEqual(detectVpn(net), { detected: false, name: null });
  });
});

test("pickAudio", async (t) => {
  const audio = [
    { name: "Built-in Microphone", type: "in" },
    { name: "Built-in Speakers", type: "out" },
  ];

  await t.test("picks the matching output device", () => {
    assert.equal(pickAudio(audio, "out"), "Built-in Speakers");
  });

  await t.test("picks the matching input device", () => {
    assert.equal(pickAudio(audio, "in"), "Built-in Microphone");
  });

  await t.test("falls back to System default when list is empty", () => {
    assert.equal(pickAudio([], "out"), "System default");
  });
});

test("pickPrimaryFs", async (t) => {
  // The volume the user runs on, even when a larger empty drive is present.
  const root = os.homedir().split(/[\\/]/)[0] || "/";

  await t.test("prefers the volume holding the user profile over the largest", () => {
    const picked = pickPrimaryFs([
      { mount: root, size: 474 * 1e9, available: 296 * 1e9, use: 37.5 },
      { mount: "Z:", size: 931 * 1e9, available: 931 * 1e9, use: 0.01 },
    ]);
    assert.equal(picked.mount, root);
  });

  await t.test("falls back to the largest volume when none matches", () => {
    const picked = pickPrimaryFs([
      { mount: "Y:", size: 100, available: 10, use: 90 },
      { mount: "Z:", size: 500, available: 50, use: 90 },
    ]);
    assert.equal(picked.mount, "Z:");
  });

  await t.test("returns an empty object for no volumes", () => {
    assert.deepEqual(pickPrimaryFs([]), {});
    assert.deepEqual(pickPrimaryFs(null), {});
  });
});

test("isExternalDisplay", async (t) => {
  await t.test("treats a built-in panel as internal even when it is not primary", () => {
    assert.equal(isExternalDisplay({ builtin: true, main: false, connection: "INTERNAL" }), false);
  });

  await t.test("treats an attached monitor as external even when it is primary", () => {
    assert.equal(isExternalDisplay({ builtin: false, main: true, connection: "DP" }), true);
  });

  await t.test("falls back to the connection name when builtin is missing", () => {
    assert.equal(isExternalDisplay({ connection: "INTERNAL" }), false);
    assert.equal(isExternalDisplay({ connection: "HDMI" }), true);
  });
});

test("formatLinkSpeed", async (t) => {
  await t.test("rounds sub-gigabit speeds to whole Mbps", () => {
    assert.equal(formatLinkSpeed(100), "100 Mbps");
  });

  await t.test("rounds gigabit speeds to one decimal", () => {
    assert.equal(formatLinkSpeed(3218.6), "3.2 Gbps");
    assert.equal(formatLinkSpeed(1000), "1 Gbps");
  });

  await t.test("reports unknown for missing or sentinel speeds", () => {
    assert.equal(formatLinkSpeed(null), "Unknown");
    assert.equal(formatLinkSpeed(0), "Unknown");
    assert.equal(formatLinkSpeed(-1), "Unknown");
  });
});

test("ramPressure", () => {
  assert.equal(ramPressure({ total: 100, available: 5 }), "High");
  assert.equal(ramPressure({ total: 100, available: 20 }), "Moderate");
  assert.equal(ramPressure({ total: 100, available: 50 }), "Normal");
});

test("humanUptime", () => {
  assert.equal(humanUptime(3600), "1 hour, 0 min");
  assert.equal(humanUptime(90000), "1 day, 1 hour");
  assert.equal(humanUptime(0), "0 hours, 0 min");
});

test("humanAge", async (t) => {
  await t.test("returns null for missing timestamp", () => {
    assert.equal(humanAge(null), null);
  });

  await t.test("returns null for an unparseable timestamp", () => {
    assert.equal(humanAge("not a date"), null);
  });

  await t.test("formats a recent timestamp in minutes", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    assert.equal(humanAge(fiveMinAgo), "5 min");
  });
});

test("parseWindowsAv", async (t) => {
  await t.test("parses a single product object", () => {
    const stdout = JSON.stringify({ name: "Windows Defender", enabled: true, updated: true, timestamp: null });
    const result = parseWindowsAv(stdout);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "Windows Defender");
    assert.equal(result[0].running, true);
  });

  await t.test("parses an array of products", () => {
    const stdout = JSON.stringify([
      { name: "Defender", enabled: false, updated: true, timestamp: null },
      { name: "Norton", enabled: true, updated: false, timestamp: null },
    ]);
    assert.equal(parseWindowsAv(stdout).length, 2);
  });

  await t.test("returns empty array on invalid JSON", () => {
    assert.deepEqual(parseWindowsAv("not json"), []);
  });

  await t.test("returns empty array on empty input", () => {
    assert.deepEqual(parseWindowsAv(""), []);
  });
});
