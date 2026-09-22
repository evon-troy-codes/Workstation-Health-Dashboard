// Unit tests for the pure/parsing helpers in system-facts.js. Detection
// functions that shell out to OS-specific tools (PowerShell, si.*) are left
// untested here — they need a live workstation, not a unit test.
const test = require("node:test");
const assert = require("node:assert/strict");

const os = require("os");

const {
  collectFacts,
  detectDeferred,
  classifyHeadset,
  cleanAudioName,
  detectVpn,
  pickAudio,
  pickPrimaryFs,
  isExternalDisplay,
  interfaceType,
  formatLinkSpeed,
  ramPressure,
  humanUptime,
  humanAge,
  parseWindowsAv,
  parseWindowsUpdates,
  parseDefaultAudio,
  detectMacAv,
  isVirtualInterface,
  parseResolvectlDns,
} = require("./system-facts");

test("classifyHeadset", async (t) => {
  await t.test("detects bluetooth from AirPods name", () => {
    assert.equal(classifyHeadset("Headphones (AirPods Pro)"), "Bluetooth");
  });

  await t.test("detects USB headset from known brand", () => {
    assert.equal(classifyHeadset("Headset (Jabra Evolve 65)"), "USB headset");
  });

  // Windows names a Bluetooth headset's endpoints after its profiles.
  await t.test("detects bluetooth from Windows' hands-free and stereo endpoints", () => {
    assert.equal(classifyHeadset("Headset (WH-1000XM4 Hands-Free AG Audio)"), "Bluetooth");
    assert.equal(classifyHeadset("Headphones (WH-1000XM4 Stereo)"), "Bluetooth");
  });

  await t.test("keeps an explicitly USB device as USB, even when it says stereo", () => {
    assert.equal(classifyHeadset("Speakers (USB Stereo Audio)"), "USB headset");
    assert.equal(classifyHeadset("Headset Earphone (Logitech USB Headset H390)"), "USB headset");
  });

  await t.test("falls back to built-in when nothing matches", () => {
    assert.equal(classifyHeadset("Speakers (Realtek High Definition Audio)"), "Built-in");
  });

  await t.test("handles a missing device name", () => {
    assert.equal(classifyHeadset(""), "Built-in");
    assert.equal(classifyHeadset(null), "Built-in");
  });
});

test("cleanAudioName", async (t) => {
  // Windows disambiguates repeated device names with a "2- " prefix.
  await t.test("strips the duplicate-device numbering prefix", () => {
    assert.equal(cleanAudioName("Mic In (2- Elgato Wave:3)"), "Mic In (Elgato Wave:3)");
    assert.equal(cleanAudioName("Headphones (10- Some Device)"), "Headphones (Some Device)");
  });

  await t.test("leaves an unprefixed name untouched", () => {
    assert.equal(cleanAudioName("Speakers (CS42L43 AMP Speaker)"), "Speakers (CS42L43 AMP Speaker)");
  });

  await t.test("returns null for missing or non-string input", () => {
    assert.equal(cleanAudioName(null), null);
    assert.equal(cleanAudioName(""), null);
    assert.equal(cleanAudioName(42), null);
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

  await t.test("on macOS, picks the data volume over the sealed system volume", () => {
    // si.fsSize on APFS: / is the read-only system snapshot, and the home
    // folder's /Users path never starts with the data volume's mount.
    const picked = pickPrimaryFs([
      { mount: "/", size: 494 * 1e9, available: 20 * 1e9, use: 11.2 },
      { mount: "/System/Volumes/Data", size: 494 * 1e9, available: 20 * 1e9, use: 95.9 },
    ], "/Users/sam", "darwin");
    assert.equal(picked.mount, "/System/Volumes/Data");
  });

  await t.test("off macOS, a /System/Volumes/Data mount gets no special treatment", () => {
    const picked = pickPrimaryFs([
      { mount: "/", size: 100, available: 50, use: 50 },
      { mount: "/System/Volumes/Data", size: 500, available: 50, use: 90 },
    ], "/home/sam", "linux");
    assert.equal(picked.mount, "/");
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

test("interfaceType", async (t) => {
  await t.test("capitalises what systeminformation reports", () => {
    assert.equal(interfaceType("wireless", false), "Wireless");
    assert.equal(interfaceType("wired", true), "Wired");
    assert.equal(interfaceType("virtual", false), "Virtual");
  });

  await t.test("falls back to the wired flag when the type is missing", () => {
    assert.equal(interfaceType("", true), "Wired");
    assert.equal(interfaceType(undefined, false), "Wireless");
  });

  await t.test("reports a tunnel as virtual, whatever the OS calls it", () => {
    assert.equal(interfaceType("wired", false, true), "Virtual");
    assert.equal(interfaceType(undefined, false, true), "Virtual");
  });
});

test("isVirtualInterface", async (t) => {
  await t.test("recognises a tunnel by type or by name", () => {
    assert.equal(isVirtualInterface({ iface: "wg0", type: "virtual", speed: -1 }), true);
    // Windows reports a WireGuard adapter as wired.
    assert.equal(isVirtualInterface({ iface: "{GUID}", ifaceName: "WireGuard Tunnel", type: "wired" }), true);
    assert.equal(isVirtualInterface({ iface: "utun4", ifaceName: "utun4", type: "" }), true);
  });

  await t.test("leaves physical links alone", () => {
    assert.equal(isVirtualInterface({ iface: "eth0", ifaceName: "Ethernet", type: "wired" }), false);
    assert.equal(isVirtualInterface({ iface: "wlan0", ifaceName: "Wi-Fi", type: "wireless" }), false);
    assert.equal(isVirtualInterface({}), false);
    assert.equal(isVirtualInterface(null), false);
  });
});

test("parseResolvectlDns", async (t) => {
  await t.test("collects each link's servers once, in order", () => {
    const stdout = [
      "Global:",
      "Link 2 (enp3s0): 192.168.1.1 2603:8000::1",
      "Link 3 (wlan0): 192.168.1.1",
      "Link 4 (docker0):",
    ].join("\n");
    assert.deepEqual(parseResolvectlDns(stdout), ["192.168.1.1", "2603:8000::1"]);
  });

  await t.test("drops DNS-over-TLS names, scope ids and link-local servers", () => {
    const stdout = "Global: 1.1.1.1#cloudflare-dns.com\nLink 2 (eth0): fe80::1%eth0 10.0.0.1";
    assert.deepEqual(parseResolvectlDns(stdout), ["1.1.1.1", "10.0.0.1"]);
  });

  await t.test("returns nothing for empty output", () => {
    assert.deepEqual(parseResolvectlDns(""), []);
    assert.deepEqual(parseResolvectlDns(undefined), []);
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

test("parseWindowsUpdates", async (t) => {
  const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

  await t.test("reports a Windows Update check as a check", () => {
    const r = parseWindowsUpdates(JSON.stringify({ pending: 2, lastCheck: hoursAgo(3), source: "check" }));
    assert.deepEqual(r, { pendingUpdates: 2, lastUpdateCheck: "3 hours ago", lastUpdateKind: "checked" });
  });

  await t.test("reports the hotfix fallback as an install, not a check", () => {
    const r = parseWindowsUpdates(JSON.stringify({ pending: 0, lastCheck: hoursAgo(48), source: "install" }));
    assert.equal(r.lastUpdateCheck, "2 days ago");
    assert.equal(r.lastUpdateKind, "installed");
    assert.equal(r.pendingUpdates, 0);
  });

  await t.test("reads a UTC timestamp as UTC, whatever the local timezone", () => {
    // The script now emits round-trip UTC ("...Z"); an offset-less string was
    // read as local time and landed hours in the future west of UTC.
    const utc = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    assert.ok(utc.endsWith("Z"));
    assert.equal(parseWindowsUpdates(JSON.stringify({ lastCheck: utc, source: "check" })).lastUpdateCheck, "2 hours ago");
  });

  await t.test("never says \"just now ago\" for a time in the future", () => {
    const future = new Date(Date.now() + 3600 * 1000).toISOString();
    assert.equal(parseWindowsUpdates(JSON.stringify({ lastCheck: future, source: "check" })).lastUpdateCheck, "just now");
  });

  await t.test("reports unknown when nothing could be read", () => {
    const unknown = { pendingUpdates: null, lastUpdateCheck: "Unknown", lastUpdateKind: null };
    assert.deepEqual(parseWindowsUpdates(JSON.stringify({ pending: null, lastCheck: null, source: null })), unknown);
    assert.deepEqual(parseWindowsUpdates("not json"), unknown);
    assert.deepEqual(parseWindowsUpdates(""), unknown);
  });
});

test("parseDefaultAudio", async (t) => {
  await t.test("returns both endpoint names, cleaned", () => {
    const stdout = JSON.stringify({ output: "Headphones (2- Jabra Evolve 65)", input: "Microphone (Jabra Evolve 65)" });
    assert.deepEqual(parseDefaultAudio(stdout), {
      output: "Headphones (Jabra Evolve 65)",
      input: "Microphone (Jabra Evolve 65)",
    });
  });

  await t.test("keeps one side when the other has no default device", () => {
    assert.deepEqual(parseDefaultAudio(JSON.stringify({ output: "Speakers (Realtek(R) Audio)", input: null })), {
      output: "Speakers (Realtek(R) Audio)",
      input: null,
    });
  });

  await t.test("returns null when neither is known or the output is not JSON", () => {
    assert.equal(parseDefaultAudio(JSON.stringify({ output: null, input: null })), null);
    assert.equal(parseDefaultAudio("Add-Type : error"), null);
    assert.equal(parseDefaultAudio(""), null);
  });
});

test("detectMacAv", async (t) => {
  await t.test("reports an installed product without claiming it is running or current", () => {
    const products = detectMacAv((p) => p === "/Applications/Malwarebytes.app");
    assert.deepEqual(products, [
      { name: "Malwarebytes", version: null, running: null, updated: null, definitionsAge: null },
    ]);
  });

  await t.test("finds Microsoft Defender", () => {
    const products = detectMacAv((p) => p === "/Applications/Microsoft Defender.app");
    assert.deepEqual(products.map((p) => p.name), ["Microsoft Defender"]);
  });

  await t.test("returns nothing when no known bundle exists", () => {
    assert.deepEqual(detectMacAv(() => false), []);
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

// ---------------------------------------------------------------------------
// Contract between the collector and the renderer.
//
// The renderer indexes straight into the facts object (facts.cpu.model,
// facts.network.dns.join(...), and so on). A rename on this side shows up
// there as "undefined" on a card rather than as an error, so assert the shape
// the UI relies on. This one does touch the live machine.
// ---------------------------------------------------------------------------
test("collectFacts returns the shape the renderer reads", { timeout: 90000 }, async () => {
  const facts = await collectFacts();

  // Scalars the header, sidebar and Overview screen read.
  for (const key of ["hostname", "user", "uptime", "appVersion", "machineType"]) {
    assert.equal(typeof facts[key], "string", `${key} should be a string`);
  }

  // Nested groups, with the leaf keys each screen indexes into.
  const groups = {
    cpu: ["model", "cores", "threads", "perfCores", "effCores", "ghz", "family", "arch", "series"],
    ram: ["totalGB", "freeGB", "type", "pressure"],
    disk: ["totalGB", "freeGB", "usedPercent", "ssd"],
    display: ["resolution", "external"],
    os: ["name", "version", "build", "lastUpdateCheck", "lastUpdateKind", "pendingUpdates"],
    network: ["interface", "type", "linkSpeed", "mtu", "mac", "ipv4",
              "ipv6Disabled", "gateway", "dns", "ssid", "isWired", "isVirtual"],
    bandwidth: ["downMbps", "upMbps", "ping", "jitter", "measuredAt"],
    vpn: ["detected", "name"],
    power: ["hasBattery", "onBattery", "batteryLevel", "plugged"],
    audio: ["output", "input", "isWired", "headsetConnected", "headsetClass"],
  };
  for (const [group, keys] of Object.entries(groups)) {
    assert.equal(typeof facts[group], "object", `${group} should be an object`);
    assert.notEqual(facts[group], null, `${group} should not be null`);
    for (const key of keys) {
      assert.ok(key in facts[group], `facts.${group}.${key} is missing`);
    }
  }

  // Types the renderer calls methods on.
  assert.ok(Array.isArray(facts.network.dns), "network.dns must be an array");
  assert.ok(Array.isArray(facts.antivirus.products), "antivirus.products must be an array");

  // Filled in by detectDeferred after first paint; null means "still checking".
  assert.equal(facts.backgroundApps, null);
  assert.equal(facts.disk.ssd, null);
  assert.equal(facts.bandwidth.measuredAt, null);

  // A fallen-back probe must not surface as the string "undefined".
  assert.ok(!/undefined/.test(facts.cpu.model), "cpu.model leaked undefined");
  assert.ok(!/undefined/.test(facts.machineType), "machineType leaked undefined");
});

test("detectDeferred returns the keys the renderer merges", { timeout: 90000 }, async () => {
  const d = await detectDeferred();
  for (const key of ["pendingUpdates", "lastUpdateCheck", "lastUpdateKind", "ssd", "backgroundApps"]) {
    assert.ok(key in d, `deferred.${key} is missing`);
  }
  assert.ok(Array.isArray(d.backgroundApps.runningApps));
  assert.equal(typeof d.backgroundApps.browserExtensions, "number");
});
