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
