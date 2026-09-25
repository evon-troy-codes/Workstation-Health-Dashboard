// Unit tests for the pure/parsing helpers in system-facts.js. Detection
// functions that shell out to OS-specific tools (PowerShell, si.*) are left
// untested here — they need a live workstation, not a unit test.
const test = require("node:test");
const assert = require("node:assert/strict");

const os = require("os");
const fs = require("fs");
const path = require("path");

const {
  collectFacts,
  detectDeferred,
  probeTimings,
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
  toolEnv,
  findTool,
  ageOf,
  parsePactlInfo,
  pactlDescription,
  parseAptUpgrades,
  parseDnfCheckUpdate,
  parseWindowsUpdates,
  parseDefaultAudio,
  detectMacAv,
  isVirtualInterface,
  isLinuxWlan,
  parseResolvectlDns,
  summarizeDisplays,
  summarizeMonitors,
  monitorsFromGraphics,
  parseMutterState,
  detectAudio,
  audioNames,
  parseWpctlInspect,
} = require("./system-facts");

test("classifyHeadset", async (t) => {
  await t.test("detects bluetooth from AirPods name", () => {
    assert.equal(classifyHeadset("Headphones (AirPods Pro)"), "Bluetooth");
  });

  await t.test("detects USB headset from known brand", () => {
    assert.equal(classifyHeadset("Headset (Jabra Evolve 65)"), "USB headset");
  });

  await t.test("reads the bus from a PulseAudio device id", () => {
    // On Linux the id is what carries the bus: the name shown on the card is
    // "Studio Headphones", which says nothing about how it is connected.
    assert.equal(classifyHeadset("bluez_output.AC_12_2F_9B_01_02.1"), "Bluetooth");
    assert.equal(classifyHeadset("alsa_output.usb-Jabra_Evolve_65-00.analog-stereo"), "USB headset");
    assert.equal(classifyHeadset("alsa_output.pci-0000_00_1f.3.analog-stereo"), "Built-in");
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

  await t.test("reads Stereo as Bluetooth only in Windows' \"(… Stereo)\" form", () => {
    assert.equal(classifyHeadset("alsa_output.pci-0000_00_1f.3.analog-stereo"), "Built-in");
    assert.equal(classifyHeadset("Speakers (Realtek Stereo Mix)"), "Built-in");
  });

  await t.test("falls back to built-in when nothing matches", () => {
    assert.equal(classifyHeadset("Speakers (Realtek High Definition Audio)"), "Built-in");
  });

  await t.test("handles a missing device name", () => {
    assert.equal(classifyHeadset(""), "Built-in");
    assert.equal(classifyHeadset(null), "Built-in");
  });
});

test("detectAudio", async (t) => {
  const countingDrivers = () => {
    const fn = async () => { fn.calls++; return [{ name: "Speakers (Realtek)", type: "out" }]; };
    fn.calls = 0;
    return fn;
  };

  await t.test("skips the slow driver listing when the OS names the devices", async () => {
    const drivers = countingDrivers();
    const r = await detectAudio(async () => ({ output: "Headphones", input: null }), drivers);
    assert.deepEqual(r, { defaultAudio: { output: "Headphones", input: null }, drivers: [] });
    assert.equal(drivers.calls, 0);
  });

  await t.test("falls back to the drivers when the OS gives no answer or fails", async () => {
    for (const getDefault of [async () => null, async () => { throw new Error("powershell blocked"); }, () => { throw new Error("sync"); }]) {
      const drivers = countingDrivers();
      const r = await detectAudio(getDefault, drivers);
      assert.equal(r.defaultAudio, null);
      assert.equal(r.drivers.length, 1);
      assert.equal(drivers.calls, 1);
    }
  });

  await t.test("survives a failing driver listing too", async () => {
    const r = await detectAudio(async () => null, async () => { throw new Error("wmi"); });
    assert.deepEqual(r, { defaultAudio: null, drivers: [] });
  });
});

test("audioNames", async (t) => {
  await t.test("says None for a side the OS left empty, rather than guessing a driver", () => {
    // A desktop with speakers and no microphone.
    assert.deepEqual(audioNames({ output: "Speakers (Realtek(R) Audio)", input: null }, []),
      { output: "Speakers (Realtek(R) Audio)", input: "None", classifyBy: "Speakers (Realtek(R) Audio)" });
  });

  await t.test("classifies by the Linux device id, which carries the bus", () => {
    const r = audioNames({ output: "Elgato Wave 3 Analog Stereo", input: "Elgato Wave 3 Mono",
      outputId: "alsa_output.usb-Elgato_Systems_Elgato_Wave_3-00.analog-stereo" }, []);
    assert.equal(r.classifyBy, "alsa_output.usb-Elgato_Systems_Elgato_Wave_3-00.analog-stereo");
    assert.equal(classifyHeadset(r.classifyBy), "USB headset");
  });

  await t.test("uses the driver listing only without an OS answer", () => {
    const drivers = [{ name: "Built-in Microphone", type: "in" }, { name: "Built-in Speakers", type: "out" }];
    assert.deepEqual(audioNames(null, drivers),
      { output: "Built-in Speakers", input: "Built-in Microphone", classifyBy: "Built-in Speakers" });
  });
});

test("parseWpctlInspect", async (t) => {
  // `wpctl inspect @DEFAULT_AUDIO_SINK@` on the Debian 13 laptop, trimmed.
  const sink = [
    "id 57, type PipeWire:Interface:Node",
    "    alsa.card = \"2\"",
    "  * media.class = \"Audio/Sink\"",
    "  * node.description = \"Elgato Wave 3 Analog Stereo\"",
    "  * node.name = \"alsa_output.usb-Elgato_Systems_Elgato_Wave_3_BS10M1A02503-00.analog-stereo\"",
    "  * node.nick = \"Elgato Wave 3\"",
  ].join("\n");

  await t.test("reads the readable name and the id", () => {
    assert.deepEqual(parseWpctlInspect(sink), {
      name: "alsa_output.usb-Elgato_Systems_Elgato_Wave_3_BS10M1A02503-00.analog-stereo",
      description: "Elgato Wave 3 Analog Stereo",
    });
  });

  await t.test("reads properties without the star, and ignores look-alike keys", () => {
    const out = "    node.description = \"Speakers\"\n  * node.description.extra = \"no\"\n    node.name = \"alsa_output.pci-0000_00_1f.3.analog-stereo\"";
    assert.deepEqual(parseWpctlInspect(out), { name: "alsa_output.pci-0000_00_1f.3.analog-stereo", description: "Speakers" });
  });

  await t.test("returns nulls when there is no default device or no output", () => {
    for (const out of [null, "", "Object '@DEFAULT_AUDIO_SOURCE@' not found"]) {
      assert.deepEqual(parseWpctlInspect(out), { name: null, description: null });
    }
  });
});

test("audio edge cases", async (t) => {
  // wpctl prints `%c %s = "%s"` with no escaping, so a quote inside a name
  // arrives bare; the value runs to the last quote on the line.
  await t.test("parseWpctlInspect keeps quotes and apostrophes inside a name", () => {
    const out = '  * node.description = "Bob\'s "Pro" Headset"\n  * node.name = "bluez_output.AC_12_34_56_78_9A.1"\n';
    assert.deepEqual(parseWpctlInspect(out),
      { name: "bluez_output.AC_12_34_56_78_9A.1", description: 'Bob\'s "Pro" Headset' });
  });

  await t.test("parseWpctlInspect trims padding, copes with CRLF and non-ASCII", () => {
    const out = '  * node.description = "  Café Wave 🎧  "\r\n  * node.name = "alsa_output.usb-X-00.analog-stereo"\r\n';
    assert.deepEqual(parseWpctlInspect(out),
      { name: "alsa_output.usb-X-00.analog-stereo", description: "Café Wave 🎧" });
  });

  await t.test("parseWpctlInspect treats an empty or unquoted value as absent", () => {
    assert.deepEqual(parseWpctlInspect('  * node.description = ""\n  * node.name = "x"\n'), { name: "x", description: null });
    assert.deepEqual(parseWpctlInspect("  * node.description = Unquoted\n"), { name: null, description: null });
  });

  await t.test("parseWpctlInspect does not treat the dot in a key as a wildcard", () => {
    assert.deepEqual(parseWpctlInspect('  * nodeXname = "a"\n  * node_description = "b"\n'), { name: null, description: null });
  });

  await t.test("parseWpctlInspect ignores wpctl's usage text after a bad id", () => {
    const usage = "Error: '@DEFAULT_AUDIO_FOO@' is not a valid number\n\nUsage:\n  wpctl [OPTION…] COMMAND [COMMAND_OPTIONS] - WirePlumber Control CLI\n";
    assert.deepEqual(parseWpctlInspect(usage), { name: null, description: null });
  });

  await t.test("audioNames: a microphone and no speakers says None for the output", () => {
    const r = audioNames({ output: null, input: "Elgato Wave 3 Mono", outputId: null }, [{ name: "HDA Intel PCH", type: "out" }]);
    assert.equal(r.output, "None");
    assert.equal(r.input, "Elgato Wave 3 Mono");
    // Nothing to classify: the card says "None", not a guessed "Built-in".
    assert.equal(r.classifyBy, null);
  });

  await t.test("audioNames: no OS answer and no drivers names nothing specific", () => {
    for (const drivers of [[], null, undefined]) {
      assert.deepEqual(audioNames(null, drivers),
        { output: "System default", input: "System default", classifyBy: "System default" });
    }
  });

  await t.test("audioNames: the fallback picks a driver per direction", () => {
    const drivers = [{ name: "Device 0cdc", type: "" }, { name: "USB Mic", type: "Input" }, { name: "HDMI", type: "Speaker" }];
    const r = audioNames(null, drivers);
    assert.equal(r.output, "HDMI");
    assert.equal(r.input, "USB Mic");
  });

  await t.test("detectAudio: a driver listing that is not an array becomes []", async () => {
    for (const bad of [null, undefined, { name: "x" }, "Device 0cdc"]) {
      assert.deepEqual(await detectAudio(async () => null, async () => bad), { defaultAudio: null, drivers: [] });
    }
  });

  await t.test("detectAudio: a sync throw from the driver listing is caught too", async () => {
    const r = await detectAudio(() => { throw new Error("os"); }, () => { throw new Error("wmi"); });
    assert.deepEqual(r, { defaultAudio: null, drivers: [] });
  });

  await t.test("detectAudio: the listing is not started while the OS query is pending", async () => {
    let release;
    let calls = 0;
    const pending = detectAudio(() => new Promise((r) => { release = r; }), async () => { calls++; return []; });
    await new Promise((r) => setImmediate(r));
    assert.equal(calls, 0);
    release(null);
    await pending;
    assert.equal(calls, 1);
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

test("summarizeDisplays", async (t) => {
  await t.test("reads the current mode when the panel resolution is missing (Linux)", () => {
    // What systeminformation returned for this Debian laptop's built-in panel.
    const d = summarizeDisplays({ displays: [{ main: true, builtin: true, connection: "eDP-1",
      resolutionX: null, resolutionY: null, currentResX: 3072, currentResY: 1920,
      sizeX: null, sizeY: null, currentRefreshRate: 59 }] });
    assert.deepEqual(d, { count: 1, resolution: "3072 × 1920", refreshRate: "59 Hz",
      external: false, externalCount: 0, externalSize: null, externalConnection: null,
      monitors: [{ name: "Built-in display", builtin: true, main: true, resolution: "3072 × 1920",
        refreshRate: "59 Hz", connection: "eDP-1", size: null }] });
  });

  await t.test("describes a docked laptop with an external monitor as its main display", () => {
    const d = summarizeDisplays({ displays: [
      { main: false, builtin: true, connection: "INTERNAL", currentResX: 1920, currentResY: 1200 },
      // 60 × 34 cm is a 27" panel.
      { main: true, builtin: false, connection: "DP", currentResX: 2560, currentResY: 1440,
        sizeX: 60, sizeY: 34, currentRefreshRate: 143.98 },
    ] });
    assert.equal(d.count, 2);
    assert.equal(d.resolution, "2560 × 1440");
    assert.equal(d.refreshRate, "144 Hz");
    assert.equal(d.external, true);
    assert.equal(d.externalSize, '27"');
    assert.equal(d.externalConnection, "DP");
  });

  await t.test("lists every monitor with its own resolution and refresh rate, main first", () => {
    const d = summarizeDisplays({ displays: [
      { main: false, builtin: true, connection: "INTERNAL", currentResX: 1920, currentResY: 1200, currentRefreshRate: 60 },
      { main: true, builtin: false, model: "LC49G95T", connection: "DP", currentResX: 5120, currentResY: 1440,
        currentRefreshRate: 119.999 },
      { main: false, builtin: false, connection: "HDMI", currentResX: 2560, currentResY: 1440,
        currentRefreshRate: 143.98, sizeX: 60, sizeY: 34 },
    ] });
    assert.deepEqual(d.monitors.map((m) => [m.name, m.main, m.resolution, m.refreshRate, m.size]), [
      ["LC49G95T", true, "5120 × 1440", "120 Hz", null],
      ["Built-in display", false, "1920 × 1200", "60 Hz", null],
      ["External display (HDMI)", false, "2560 × 1440", "144 Hz", '27"'],
    ]);
  });

  await t.test("counts several external monitors and falls back to a generic connection", () => {
    const d = summarizeDisplays({ displays: [
      { builtin: false, resolutionX: 3840, resolutionY: 2160 },
      { builtin: false, connection: "HDMI", resolutionX: 1920, resolutionY: 1080 },
    ] });
    assert.equal(d.resolution, "3840 × 2160"); // no main flag: the first
    assert.equal(d.externalCount, 2);
    assert.equal(d.externalConnection, "External");
    assert.equal(d.externalSize, null);
  });

  await t.test("reports nothing found, not a guess, without displays", () => {
    for (const g of [{}, { displays: [] }, null, undefined, { displays: [null] }]) {
      assert.deepEqual(summarizeDisplays(g), { count: 0, resolution: "Unknown", refreshRate: null,
        external: false, externalCount: 0, externalSize: null, externalConnection: null, monitors: [] });
    }
  });
});

test("parseMutterState", async (t) => {
  // gdbus's GetCurrentState on the Debian laptop under GNOME Wayland, with a
  // Samsung Odyssey G9 attached (the monitor's serial number replaced).
  // XWayland, which systeminformation reads, reported that screen as
  // 10240 × 2880 at 23.69 Hz and the panel as 3072 × 1920.
  const fixture = require("fs").readFileSync(require("path").join(__dirname, "fixtures", "mutter-state-gnome.txt"), "utf8");

  await t.test("reads each monitor's real current mode, name and role", () => {
    const monitors = parseMutterState(fixture);
    assert.deepEqual(monitors.map((m) => ({ ...m, refreshHz: Math.round(m.refreshHz) })), [
      { name: 'Samsung Electric Company 49"', connection: "DP-7", builtin: false, main: true,
        width: 5120, height: 1440, refreshHz: 120, sizeInches: null },
      { name: "Built-in display", connection: "eDP-1", builtin: true, main: false,
        width: 1920, height: 1200, refreshHz: 60, sizeInches: null },
    ]);
  });

  await t.test("keeps no serial numbers", () => {
    assert.ok(!JSON.stringify(parseMutterState(fixture)).includes("SERIAL0001"));
  });

  await t.test("finds the current mode when it is also the preferred one", () => {
    // The panel's current mode carries {'is-current': <true>, 'is-preferred': <true>}.
    assert.equal(parseMutterState(fixture)[1].height, 1200);
  });

  await t.test("leaves out a monitor that is connected but switched off", () => {
    const off = "(uint32 1, [(('HDMI-1', 'DEL', 'U2720Q', 'X'), [('3840x2160@60.000', 3840, 2160, 60.0, 1.0, [1.0], {})], " +
      "{'is-builtin': <false>, 'display-name': <'Dell 27\"'>})], [], {})";
    assert.deepEqual(parseMutterState(off), []);
  });

  await t.test("unescapes names and copes with a missing display-name", () => {
    const one = "(uint32 1, [(('DP-1', 'ACM', 'X1', 'S'), [('1920x1080@60.000', 1920, 1080, 60.0, 1.0, [1.0], {'is-current': <true>})], " +
      "{'is-builtin': <false>, 'display-name': <'Sam\\'s monitor'>}), " +
      "(('eDP-1', 'BOE', 'P', 'S'), [('1920x1200@60.000', 1920, 1200, 60.0, 1.0, [1.0], {'is-current': <true>})], {})], " +
      "[(0, 0, 1.0, uint32 0, true, [('eDP-1', 'BOE', 'P', 'S')], {})], {})";
    const [a, b] = parseMutterState(one);
    assert.equal(a.name, "Sam's monitor");
    assert.equal(a.main, false);
    assert.deepEqual([b.name, b.builtin, b.main], ["Built-in display", true, true]);
  });

  await t.test("returns nothing for empty or unrelated output", () => {
    for (const out of ["", null, "Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown"]) {
      assert.deepEqual(parseMutterState(out), []);
    }
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
    assert.equal(interfaceType("unknown", false), "Unknown");
  });

  await t.test("falls back to the wired flag when the type is missing", () => {
    assert.equal(interfaceType("", true), "Wired");
    assert.equal(interfaceType(undefined, false), "Wireless");
  });

  await t.test("reads systeminformation's \"virtual\" (lo, bond*) by the wired flag", () => {
    assert.equal(interfaceType("virtual", true), "Wired");
    assert.equal(interfaceType("virtual", false), "Wireless");
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

  await t.test("leaves a bonded link alone, though systeminformation types it virtual", () => {
    assert.equal(isVirtualInterface({ iface: "bond0", ifaceName: "bond0", type: "virtual", speed: 2000 }), false);
    assert.equal(isVirtualInterface({ iface: "br0", ifaceName: "br0", type: "wired" }), false);
  });

  await t.test("leaves physical links alone", () => {
    assert.equal(isVirtualInterface({ iface: "eth0", ifaceName: "Ethernet", type: "wired" }), false);
    assert.equal(isVirtualInterface({ iface: "wlan0", ifaceName: "Wi-Fi", type: "wireless" }), false);
    assert.equal(isVirtualInterface({}), false);
    assert.equal(isVirtualInterface(null), false);
  });
});

test("isLinuxWlan", async (t) => {
  const files = {
    "/sys/class/net/wlp0s20f3/uevent": "DEVTYPE=wlan\nINTERFACE=wlp0s20f3\nIFINDEX=2\n",
    "/sys/class/net/enp3s0/uevent": "INTERFACE=enp3s0\nIFINDEX=3\n",
  };
  const read = (p) => {
    if (!(p in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return files[p];
  };

  await t.test("recognises a Wi-Fi card from its uevent", () => {
    assert.equal(isLinuxWlan("wlp0s20f3", read), true);
  });

  await t.test("leaves a wired card, a missing one and odd names alone", () => {
    assert.equal(isLinuxWlan("enp3s0", read), false);
    assert.equal(isLinuxWlan("gone0", read), false);
    assert.equal(isLinuxWlan("", read), false);
    assert.equal(isLinuxWlan("../../etc", read), false);
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

test("toolEnv", async (t) => {
  await t.test("strips the loader variables a packaged build exports", () => {
    // An AppImage points these at its own bundle; a tool spawned with them can
    // fail to load, which would silently empty every Linux detector in the
    // shipped build only.
    const before = { ...process.env };
    Object.assign(process.env, { LD_LIBRARY_PATH: "/app/usr/lib", LD_PRELOAD: "/x.so", GTK_PATH: "/g" });
    try {
      const env = toolEnv();
      assert.equal("LD_LIBRARY_PATH" in env, false);
      assert.equal("LD_PRELOAD" in env, false);
      assert.equal("GTK_PATH" in env, false);
      assert.equal(process.env.LD_PRELOAD, "/x.so", "must not mutate this process");
    } finally {
      process.env = before;
    }
  });

  await t.test("pins the language and width the output is parsed at", () => {
    const env = toolEnv();
    assert.equal(env.LC_ALL, "C"); // dnf translates "Obsoleting Packages"
    assert.equal(env.LANG, "C");
    assert.equal(env.COLUMNS, "200"); // and wraps long names to the terminal
  });
});

test("findTool", async (t) => {
  await t.test("returns the first path that exists", () => {
    const real = __filename;
    assert.equal(findTool("/nope/a", real, "/nope/b"), real);
    assert.equal(findTool("/nope/a", "/nope/b"), null);
  });
});

test("ageOf", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whd-age-"));
  const stamp = (name, msAgo) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, "");
    const at = new Date(Date.now() - msAgo);
    fs.utimesSync(file, at, at);
    return file;
  };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  await t.test("prefers the more trustworthy source over a newer one", () => {
    // apt's own "I refreshed" stamp outranks a cache file that any install
    // rewrites: taking the newest would call a two-month-old cache fresh.
    const trusted = stamp("update-success-stamp", 60 * 24 * 3600e3);
    const incidental = stamp("pkgcache.bin", 2 * 3600e3);
    assert.match(ageOf([trusted, incidental]), /days ago$/);
  });

  await t.test("takes the newest within one source", () => {
    const old = stamp("repo-a", 9 * 3600e3);
    const fresh = stamp("repo-b", 1 * 3600e3);
    assert.equal(ageOf([[old, fresh]]), "1 hour ago");
  });

  await t.test("says Unknown when nothing is there", () => {
    assert.equal(ageOf([path.join(dir, "missing")]), "Unknown");
    assert.equal(ageOf([]), "Unknown");
  });

  await t.test("ignores a stamp dated in the future, and never says 'just now ago'", () => {
    const skewed = stamp("skewed", -3 * 24 * 3600e3); // three days ahead
    assert.equal(ageOf([skewed]), "Unknown");
    const now = stamp("now", 1000);
    assert.equal(ageOf([now]), "just now");
  });
});

test("humanAge rejects a clock ahead of us", async (t) => {
  await t.test("a future timestamp is no answer, not a fresh one", () => {
    // Otherwise stale antivirus signatures read as "just now" on the card
    // someone opens to find out they are stale.
    assert.equal(humanAge(new Date(Date.now() + 6 * 3600e3).toISOString()), null);
    assert.equal(humanAge(new Date(Date.now() - 1000).toISOString()), "just now");
  });
});

test("parsePactlInfo", async (t) => {
  await t.test("reads the default device ids", () => {
    const info = [
      "Server String: /run/user/1000/pulse/native",
      "Default Sink: alsa_output.pci-0000_00_1f.3.analog-stereo",
      "Default Source: alsa_input.usb-Elgato_Wave_3-00.analog-stereo",
      "Cookie: 1a2b:3c4d",
    ].join("\n");
    assert.deepEqual(parsePactlInfo(info), {
      sink: "alsa_output.pci-0000_00_1f.3.analog-stereo",
      source: "alsa_input.usb-Elgato_Wave_3-00.analog-stereo",
    });
  });

  await t.test("an empty value reads as none, not as the next line", () => {
    // A machine with no sound card, or a sound server just restarted. The
    // line after Default Source is the session cookie, which was being shown
    // on the card as the microphone.
    const info = ["Default Sink: ", "Default Source: ", "Cookie: 1a2b:3c4d"].join("\n");
    assert.deepEqual(parsePactlInfo(info), { sink: null, source: null });
  });

  await t.test("nothing to read", () => {
    assert.deepEqual(parsePactlInfo(""), { sink: null, source: null });
    assert.deepEqual(parsePactlInfo(null), { sink: null, source: null });
  });
});

test("pactlDescription", async (t) => {
  // Trimmed from `pactl list sinks` on PipeWire.
  const sinks = [
    "Sink #46",
    "\tState: RUNNING",
    "\tName: alsa_output.pci-0000_00_1f.3.analog-stereo",
    "\tDescription: Built-in Audio Analog Stereo",
    "\tDriver: PipeWire",
    "",
    "Sink #71",
    "\tState: SUSPENDED",
    "\tName: bluez_output.AC_12_2F_9B_01_02.1",
    "\tDescription: Studio Headphones",
  ].join("\n");

  await t.test("finds the description of the named device", () => {
    assert.equal(
      pactlDescription(sinks, "bluez_output.AC_12_2F_9B_01_02.1"),
      "Studio Headphones",
    );
    assert.equal(
      pactlDescription(sinks, "alsa_output.pci-0000_00_1f.3.analog-stereo"),
      "Built-in Audio Analog Stereo",
    );
  });

  await t.test("trims the description, and falls back when it is blank", () => {
    const padded = ["Sink #1", "\tName: alsa_output.pci", "\tDescription:   Speakers  "].join("\n");
    assert.equal(pactlDescription(padded, "alsa_output.pci"), "Speakers");
    const blank = ["Sink #1", "\tName: alsa_output.pci", "\tDescription: "].join("\n");
    assert.equal(pactlDescription(blank, "alsa_output.pci"), "alsa_output.pci");
  });

  await t.test("falls back to the device id, which still identifies it", () => {
    assert.equal(pactlDescription(sinks, "alsa_output.usb-Some_Mic"), "alsa_output.usb-Some_Mic");
    assert.equal(pactlDescription(null, "alsa_output.usb-Some_Mic"), "alsa_output.usb-Some_Mic");
  });

  await t.test("no device, no answer", () => {
    assert.equal(pactlDescription(sinks, ""), null);
    assert.equal(pactlDescription(sinks, undefined), null);
  });
});

test("parseAptUpgrades", async (t) => {
  await t.test("counts the packages an upgrade would install", () => {
    const out = [
      "NOTE: This is only a simulation!",
      "Reading package lists...",
      "The following packages will be upgraded:",
      "  libssl3 openssh-client tzdata",
      "3 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.",
      "Inst libssl3 [3.0.2-0ubuntu1.15] (3.0.2-0ubuntu1.16 Ubuntu:22.04/jammy-updates [amd64])",
      "Inst openssh-client [1:8.9p1-3] (1:8.9p1-3ubuntu0.6 Ubuntu:22.04/jammy-updates [amd64])",
      "Inst tzdata [2024a-0ubuntu0.22.04] (2024b-0ubuntu0.22.04 Ubuntu:22.04/jammy-updates [all])",
      "Conf libssl3 (3.0.2-0ubuntu1.16 Ubuntu:22.04/jammy-updates [amd64])",
    ].join("\n");
    assert.equal(parseAptUpgrades(out), 3);
  });

  await t.test("counts a kept-back package that dist-upgrade installs", () => {
    // Plain `upgrade` holds these back, which is why the simulation asks for
    // dist-upgrade: a new kernel is exactly what this card should report.
    const out = [
      "The following NEW packages will be installed:",
      "  linux-image-6.8.0-45-generic",
      "Inst linux-image-6.8.0-45-generic (6.8.0-45.45 Ubuntu:24.04/noble-updates [amd64])",
      "Inst linux-headers-6.8.0-45 (6.8.0-45.45 Ubuntu:24.04/noble-updates [all])",
      "Conf linux-image-6.8.0-45-generic (6.8.0-45.45 Ubuntu:24.04/noble-updates [amd64])",
    ].join("\n");
    assert.equal(parseAptUpgrades(out), 2);
  });

  await t.test("counts the install lines only, not prose about them", () => {
    const out = [
      "  Installing linux-image-6.8.0-45-generic as a dependency",
      "   Inst held-back-package (indented, part of a summary block)",
      "Inst real-package (1.0-1 Ubuntu:24.04/noble [amd64])",
    ].join("\n");
    assert.equal(parseAptUpgrades(out), 1);
  });

  await t.test("nothing pending, nothing to read", () => {
    assert.equal(parseAptUpgrades("0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n"), 0);
    assert.equal(parseAptUpgrades(""), 0);
    assert.equal(parseAptUpgrades(null), 0);
  });
});

test("parseDnfCheckUpdate", async (t) => {
  await t.test("counts the update lines", () => {
    const out = [
      "",
      "kernel.x86_64                     6.11.5-300.fc41           updates",
      "vim-minimal.x86_64                2:9.1.866-1.fc41          updates",
      "",
    ].join("\n");
    assert.equal(parseDnfCheckUpdate(out), 2);
  });

  await t.test("counts a package whose name was too wide for the column", () => {
    // dnf wraps to 80 columns when nothing is a terminal, putting the version
    // and repo on an indented line of their own.
    const out = [
      "",
      "kernel.x86_64                     6.11.5-300.fc41           updates",
      "NetworkManager-libreswan-gnome.x86_64",
      "                                  1.2.20-1.fc41             updates",
      "texlive-collection-fontsrecommended.noarch",
      "                                  9:20240311-3.fc41         updates",
    ].join("\n");
    assert.equal(parseDnfCheckUpdate(out), 3);
  });

  await t.test("stops at obsoleted packages, which are not installs", () => {
    const out = [
      "kernel.x86_64                     6.11.5-300.fc41           updates",
      "",
      "Obsoleting Packages",
      "old-thing.noarch                  1.0-1.fc41                updates",
      "    replacing-this.noarch         0.9-1.fc41                @System",
    ].join("\n");
    assert.equal(parseDnfCheckUpdate(out), 1);
  });

  await t.test("ignores the metadata header and an empty answer", () => {
    assert.equal(parseDnfCheckUpdate("Last metadata expiration check: 0:12:01 ago on Mon 22 Sep 2026.\n"), 0);
    assert.equal(parseDnfCheckUpdate(""), 0);
  });

  await t.test("counts package lines only: a listing is name.arch first", () => {
    const out = [
      "Dependencies resolved.",
      "kernel.x86_64   6.11.5-300.fc41   updates",
    ].join("\n");
    assert.equal(parseDnfCheckUpdate(out), 1);
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

  await t.test("never says \"just now ago\", and distrusts a time well in the future", () => {
    // A clock a minute fast is still "just now"; an hour ahead says nothing.
    const at = (ms) => parseWindowsUpdates(JSON.stringify({ lastCheck: new Date(Date.now() + ms).toISOString(), source: "check" }));
    assert.equal(at(60 * 1000).lastUpdateCheck, "just now");
    assert.deepEqual(at(3600 * 1000), { pendingUpdates: null, lastUpdateCheck: "Unknown", lastUpdateKind: null });
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
  assert.equal(facts.display, null);
  assert.equal(facts.bandwidth.measuredAt, null);

  // A fallen-back probe must not surface as the string "undefined".
  assert.ok(!/undefined/.test(facts.cpu.model), "cpu.model leaked undefined");
  assert.ok(!/undefined/.test(facts.machineType), "machineType leaked undefined");
});

test("detectDeferred returns the keys the renderer merges", { timeout: 90000 }, async () => {
  const d = await detectDeferred();
  for (const key of ["pendingUpdates", "lastUpdateCheck", "lastUpdateKind", "ssd", "backgroundApps", "display"]) {
    assert.ok(key in d, `deferred.${key} is missing`);
  }
  assert.ok(Array.isArray(d.backgroundApps.runningApps));
  assert.equal(typeof d.backgroundApps.browserExtensions, "number");
  // The Display card's rows.
  for (const key of ["count", "monitors", "resolution", "refreshRate", "external", "externalCount", "externalSize", "externalConnection"]) {
    assert.ok(key in d.display, `deferred.display.${key} is missing`);
  }
  // One row per monitor on the card.
  assert.ok(Array.isArray(d.display.monitors));
  for (const m of d.display.monitors) {
    for (const key of ["name", "builtin", "main", "resolution", "refreshRate", "connection", "size"]) {
      assert.ok(key in m, `deferred.display.monitors[].${key} is missing`);
    }
  }
});

// The smoke test prints probeTimings() into public CI logs, so it must hold
// check names and milliseconds only: no device, host or user names. Runs after
// the live collectFacts/detectDeferred tests above, which fill it.
test("probeTimings holds only check names and milliseconds, slowest first", { timeout: 90000 }, async () => {
  if (!probeTimings().some(([k]) => k === "audio")) await collectFacts();
  if (!probeTimings().some(([k]) => k.startsWith("deferred:"))) await detectDeferred();
  const timings = probeTimings();
  const expected = ["cpu", "mem", "memLayout", "osInfo", "system", "fsSize", "networkInterfaces",
    "networkGatewayDefault", "battery", "networkInterfaceDefault", "antivirus", "audio", "dns",
    "deferred:updates", "deferred:ssd", "deferred:backgroundApps", "deferred:graphics"];
  assert.deepEqual(timings.map(([k]) => k).sort(), [...expected].sort());
  for (const [k, ms] of timings) {
    assert.match(k, /^(deferred:)?[A-Za-z]+$/);
    assert.ok(Number.isInteger(ms) && ms >= 0, `${k}: ${ms}`);
  }
  for (let i = 1; i < timings.length; i++) assert.ok(timings[i - 1][1] >= timings[i][1], "not sorted slowest first");
  // A copy: a caller sorting or editing it can't change the next reading.
  timings.length = 0;
  assert.ok(probeTimings().length > 0);
});
