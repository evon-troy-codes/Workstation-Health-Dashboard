// system-facts.js — runs in the Electron MAIN process (Node context).
// Collects real workstation facts and shapes them to match exactly what the
// renderer's helper-app.jsx expects (the FACTS object).
//
// Requires: npm i systeminformation
// Node built-ins os/dns are used for the bits `systeminformation` doesn't cover.

const os = require("os");
const dns = require("dns");
const fs = require("fs");
const path = require("path");
const si = require("systeminformation");
const { execFile } = require("child_process");

// App version for display. Resolved from the project's package.json.
let APP_VERSION = "1.2.0";
try {
  APP_VERSION = require("../../package.json").version || APP_VERSION;
} catch (_) {
  /* keep default */
}

const GB = 1024 * 1024 * 1024;
const round1 = (n) => Math.round(n * 10) / 10;

// Run a probe that must never take the whole scan down with it. A machine with
// no battery, a VM with no display adapter or a locked-down security policy
// should cost one blank card, not the entire dashboard.
//
// A named probe records how long it took in `timings` (ms), which the smoke
// test prints, so CI shows which checks are slow on each OS. Windows can't be
// profiled from the Linux machine any other way.
const timings = {};
function probe(promise, fallback, name) {
  const start = Date.now();
  const done = () => { if (name) timings[name] = Date.now() - start; };
  return Promise.resolve(promise).then(
    (v) => { done(); return v == null ? fallback : v; },
    () => { done(); return fallback; },
  );
}

// The last duration of each named probe, slowest first, e.g. [["audio", 480]].
function probeTimings() {
  return Object.entries(timings).sort((a, b) => b[1] - a[1]);
}

// Run a command for its output. Resolves null when the tool is missing, fails
// or runs long: every caller treats that as "this machine can't tell me", not
// as an error. `okExitCodes` covers tools that report findings through their
// exit status (dnf answers 100 when updates are pending).
function runCmd(cmd, args, { timeout = 10000, okExitCodes = [] } = {}) {
  return new Promise((resolve) => {
    // 4 MB: the default 1 MB is enough for a normal listing but not for a
    // machine hundreds of updates behind, where truncation would read as
    // "this machine can't tell me" instead of a large number.
    const opts = { timeout, windowsHide: true, env: toolEnv(), maxBuffer: 4 * 1024 * 1024 };
    execFile(cmd, args, opts, (err, stdout) => {
      if (err && !okExitCodes.includes(err.code)) return resolve(null);
      resolve(stdout || "");
    });
  });
}

// The environment these tools run in. Two problems to head off:
//
// Packaged Linux builds (AppImage) export LD_LIBRARY_PATH and friends pointing
// into the bundle, and a child process inheriting them can fail to load
// against the wrong libraries — which would make every detector here return
// nothing, but only in the shipped build.
//
// Every output below is parsed, and these tools translate their labels and
// wrap their columns to the terminal width, so both are pinned.
function toolEnv() {
  const env = { ...process.env, LC_ALL: "C", LANG: "C", COLUMNS: "200" };
  delete env.LD_LIBRARY_PATH;
  delete env.LD_PRELOAD;
  delete env.GTK_PATH;
  return env;
}

// The first of these paths that exists, for a tool that must be run by full
// path rather than by name: a writable PATH entry ahead of /usr/bin should not
// decide what the app runs.
function findTool(...candidates) {
  return candidates.find(exists) || null;
}

// When a file was last written, or null if it isn't there. Several Linux
// package managers record their last update check as a stamp file's mtime.
function fileMtime(file) {
  try {
    return fs.statSync(file).mtime;
  } catch (_) {
    return null;
  }
}

const exists = (p) => {
  try {
    return fs.existsSync(p);
  } catch (_) {
    return false;
  }
};

async function collectFacts() {
  // Everything fast runs in one parallel batch. Deliberately excluded and
  // resolved lazily instead (see detectDeferred): si.diskLayout() (SSD flag,
  // ~7s Windows storage provider), the OS update check, si.processes(),
  // which is among the slowest calls on Windows, and si.graphics(), whose WMI
  // queries held up the first paint on Windows.
  const [cpu, mem, memLayout, osInfo, system, fsSize, net, gateway,
         battery, defIfaceName,
         antivirus, audio, dnsServers] = await Promise.all([
    probe(si.cpu(), {}, "cpu"), probe(si.mem(), {}, "mem"), probe(si.memLayout(), [], "memLayout"),
    probe(si.osInfo(), {}, "osInfo"), probe(si.system(), {}, "system"), probe(si.fsSize(), [], "fsSize"),
    probe(si.networkInterfaces(), [], "networkInterfaces"),
    probe(si.networkGatewayDefault(), "", "networkGatewayDefault"),
    probe(si.battery(), {}, "battery"),
    probe(si.networkInterfaceDefault(), "", "networkInterfaceDefault"),
    probe(detectAntivirus(), { products: [] }, "antivirus"),
    probe(detectAudio(), { defaultAudio: null, drivers: [] }, "audio"),
    probe(detectDnsServers(), [], "dns"),
  ]);

  // --- default network interface ---
  const iface = (Array.isArray(net) ? net : [net]).find((n) => n.iface === defIfaceName) || {};
  // A full-tunnel VPN owns the default route, and is neither wired nor Wi-Fi.
  const isVirtual = isVirtualInterface(iface);
  // systeminformation can call a Linux Wi-Fi card "wired" (it relies on tools
  // like iw that are often missing); the kernel knows better.
  const ifType = process.platform === "linux" && isLinuxWlan(iface.iface) ? "wireless" : iface.type;
  const isWired = !isVirtual && (
    /ethernet|wired|thunderbolt|usb/i.test(ifType || "") ||
    (!/wifi|wireless|wi-fi/i.test(ifType || "") && (iface.speed || 0) >= 100));

  // --- disk (system volume); ssd flag filled in lazily (null = checking) ---
  const primaryFs = pickPrimaryFs(fsSize);

  // --- memory type ---
  const memType = (memLayout && memLayout[0] && memLayout[0].type) || "";

  const { output: outputName, input: inputName, classifyBy } = audioNames(audio.defaultAudio, audio.drivers);
  // No output device is "None", not a guessed "Built-in".
  const headsetClass = classifyBy ? classifyHeadset(classifyBy) : "None";

  const facts = {
    hostname: os.hostname(),
    user: os.userInfo().username,
    uptime: humanUptime(os.uptime()),
    appVersion: APP_VERSION,

    cpu: {
      model: [cpu.manufacturer, cpu.brand].filter(Boolean).join(" ") || "Unknown",
      // systeminformation's `cores` counts logical processors (threads).
      cores: cpu.physicalCores || cpu.cores || 0,
      threads: cpu.cores || 0,
      perfCores: cpu.performanceCores || cpu.physicalCores || cpu.cores || 0,
      effCores: cpu.efficiencyCores || 0,
      ghz: round1(cpu.speedMax || cpu.speed || 0),
      family: cpu.manufacturer || "Unknown",
      arch: os.arch(),
      series: cpu.brand || "Unknown",
    },
    machineType: `${system.manufacturer || ""} ${system.model || os.platform()}`.trim(),
    ram: {
      totalGB: Math.round((mem.total || 0) / GB),
      freeGB: round1((mem.available || 0) / GB),
      type: memType,
      pressure: ramPressure(mem),
    },
    disk: {
      totalGB: Math.round(primaryFs.size / GB) || 0,
      freeGB: Math.round(primaryFs.available / GB) || 0,
      usedPercent: Math.round(primaryFs.use || 0),
      ssd: null, // resolved lazily (slow Windows storage provider)
    },
    display: null, // resolved lazily (si.graphics is slow on Windows)
    os: {
      name: osInfo.distro || os.type(),
      version: osInfo.release || os.release(),
      build: osInfo.build || "",
      lastUpdateCheck: "Checking…", // filled in by the lazy get-updates call
      // "checked" or "installed": which event lastUpdateCheck dates. null
      // until the update check resolves, or when nothing could be read.
      lastUpdateKind: null,
      pendingUpdates: null, // number once the lazy update check resolves
    },
    network: {
      interface: iface.iface || defIfaceName || "Unknown",
      type: interfaceType(ifType, isWired, isVirtual),
      linkSpeed: formatLinkSpeed(iface.speed),
      mtu: iface.mtu || null,
      mac: iface.mac || "",
      ipv4: iface.ip4 || "",
      ipv6Disabled: !iface.ip6,
      gateway: gateway || "",
      dns: dnsServers.length ? dnsServers : (osInfo.servers || []),
      ssid: isWired || isVirtual ? null : (iface.ssid || null),
      isWired,
      isVirtual,
    },
    // Bandwidth is a measurement, not a static fact — filled in once the
    // renderer's speed test completes.
    bandwidth: {
      downMbps: null, upMbps: null, ping: null, jitter: null,
      measuredAt: null, // millisecond timestamp once the renderer measures
    },
    vpn: detectVpn(net),
    antivirus,
    backgroundApps: null, // filled in by detectDeferred (si.processes is slow)
    power: {
      hasBattery: !!battery.hasBattery,
      onBattery: battery.hasBattery ? !battery.acConnected : false,
      batteryLevel: battery.hasBattery ? battery.percent : null, // null: no battery
      plugged: battery.hasBattery ? battery.acConnected : true,
    },
    audio: {
      output: outputName,
      input: inputName,
      // Derived from the same device classifyHeadset looked at, so the card
      // can't report "Bluetooth" and "Wired" at the same time.
      isWired: headsetClass === "USB headset",
      // Whether the selected output is a headset, from the same classification.
      // Counting installed sound drivers made this true on every machine.
      headsetConnected: headsetClass !== "Built-in",
      headsetClass,
    },
  };

  return facts;
}

// The default playback/recording endpoints, via the Windows MMDevice API.
// systeminformation only lists sound *drivers* (Win32_SoundDevice), so it
// reports e.g. "Intel® Smart Sound Technology for USB Audio" rather than the
// headset the user actually selected. Resolves null when unavailable, so
// callers fall back to the driver list.
const PS_DEFAULT_AUDIO = [
  "$ErrorActionPreference='SilentlyContinue';",
  "Add-Type -TypeDefinition @'",
  "using System;",
  "using System.Runtime.InteropServices;",
  "public static class WhdAudio {",
  '  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] internal class DevEnum { }',
  '  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
  "  internal interface IEnum { int F1(); int GetDefault(int flow, int role, out IDev dev); }",
  '  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
  "  internal interface IDev { int F1(); int OpenPropertyStore(int access, out IStore store); }",
  '  [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
  "  internal interface IStore { int GetCount(out int c); int GetAt(int i, out PK k); int GetValue(ref PK k, out PV v); }",
  "  [StructLayout(LayoutKind.Sequential)] internal struct PK { public Guid fmtid; public int pid; }",
  "  [StructLayout(LayoutKind.Explicit)] internal struct PV { [FieldOffset(0)] public short vt; [FieldOffset(8)] public IntPtr p; }",
  "  public static string Name(int flow) {",
  "    IDev d = null; var e = (IEnum)(new DevEnum());",
  "    if (e.GetDefault(flow, 0, out d) != 0 || d == null) return null;",
  "    IStore s; if (d.OpenPropertyStore(0, out s) != 0) return null;",
  '    var k = new PK(); k.fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"); k.pid = 14;',
  "    PV v; if (s.GetValue(ref k, out v) != 0 || v.p == IntPtr.Zero) return null;",
  "    return Marshal.PtrToStringUni(v.p);",
  "  }",
  "}",
  "'@;",
  "[pscustomobject]@{output=[WhdAudio]::Name(0);input=[WhdAudio]::Name(1)} | ConvertTo-Json -Compress",
].join("\n");

// The selected output and input devices. The OS's own answer comes first
// (detectDefaultAudio); the driver listing, si.audio(), is fetched only when
// that answer is missing altogether. si.audio() was the slowest call in the
// first scan (about 480 ms on Linux, a WMI query on Windows) and its result
// went unused whenever the OS answered, which is almost always.
async function detectAudio(getDefault = detectDefaultAudio, getDrivers = () => si.audio()) {
  const defaultAudio = await Promise.resolve().then(getDefault).catch(() => null);
  if (defaultAudio) return { defaultAudio, drivers: [] };
  const drivers = await Promise.resolve().then(getDrivers).catch(() => []);
  return { defaultAudio: null, drivers: Array.isArray(drivers) ? drivers : [] };
}

// The names the Audio card shows, and what to classify the headset by.
// When the OS named the default devices, a side it left empty has no device
// ("None"), not whichever driver the listing happens to name first. Only
// without that answer (macOS, or a failed query) do the drivers stand in.
function audioNames(defaultAudio, drivers) {
  if (defaultAudio) {
    const output = defaultAudio.output || "None";
    return {
      output,
      input: defaultAudio.input || "None",
      // On Linux the bus lives in the device id, not in the name shown on
      // the card: "Studio Headphones" says nothing, "bluez_output.AC_12…"
      // says Bluetooth.
      classifyBy: defaultAudio.outputId || defaultAudio.output || null,
    };
  }
  const output = pickAudio(drivers, "out");
  return { output, input: pickAudio(drivers, "in"), classifyBy: output };
}

// The devices sound is actually playing through, as opposed to whichever the
// hardware listing happens to name first. Windows asks the audio policy COM
// API; Linux asks PulseAudio/PipeWire. macOS falls back to the listing.
function detectDefaultAudio() {
  if (process.platform === "linux") return linuxDefaultAudio();
  if (process.platform !== "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", PS_DEFAULT_AUDIO],
      { timeout: 15000, windowsHide: true },
      (err, stdout) => resolve(err ? null : parseDefaultAudio(stdout)),
    );
  });
}

// PulseAudio and PipeWire both answer `pactl`, which names the default devices
// but only as internal ids ("alsa_output.pci-0000_00_1f.3.analog-stereo"). The
// human name lives in the matching entry of the device listing.
//
// `pactl` comes from pulseaudio-utils, which PipeWire desktops don't always
// install (Debian 13 doesn't). Those have WirePlumber's `wpctl` instead, so it
// is asked when `pactl` is missing. Without either, the Audio card fell back
// to the driver listing and named a sound chip ("Device 0cdc") where the
// default output was a USB interface.
async function linuxDefaultAudio() {
  const pactl = findTool("/usr/bin/pactl", "/bin/pactl", "/usr/local/bin/pactl");
  if (!pactl) return wpctlDefaultAudio();
  const info = await runCmd(pactl, ["info"], { timeout: 3000 });
  // An installed pactl can still fail: pulseaudio-utils on a PipeWire system
  // without pipewire-pulse has no server to talk to. WirePlumber may.
  if (!info) return wpctlDefaultAudio();
  const { sink, source } = parsePactlInfo(info);
  const [sinks, sources] = await Promise.all([
    sink ? runCmd(pactl, ["list", "sinks"], { timeout: 3000 }) : null,
    source ? runCmd(pactl, ["list", "sources"], { timeout: 3000 }) : null,
  ]);
  const output = pactlDescription(sinks, sink);
  const input = pactlDescription(sources, source);
  // The ids carry the bus ("bluez_output…", "alsa_output.usb-…"), which the
  // readable description drops, so keep them for classifying the headset.
  return output || input ? { output, input, outputId: sink || null } : null;
}

// WirePlumber's view of the default sink and source: `wpctl inspect` on each
// prints the node's properties, including its readable description and its
// id (node.name, which carries the bus, as pactl's ids do).
async function wpctlDefaultAudio() {
  const wpctl = findTool("/usr/bin/wpctl", "/bin/wpctl", "/usr/local/bin/wpctl");
  if (!wpctl) return null;
  const [sink, source] = (await Promise.all([
    runCmd(wpctl, ["inspect", "@DEFAULT_AUDIO_SINK@"], { timeout: 3000 }),
    runCmd(wpctl, ["inspect", "@DEFAULT_AUDIO_SOURCE@"], { timeout: 3000 }),
  ])).map(parseWpctlInspect);
  const output = sink.description || sink.name;
  const input = source.description || source.name;
  return output || input ? { output, input, outputId: sink.name } : null;
}

// `wpctl inspect` output → { name, description }, each null when absent.
// Property lines look like `  * node.description = "Elgato Wave 3 Analog
// Stereo"`, the star marking properties set on the node itself.
function parseWpctlInspect(stdout) {
  const prop = (key) => {
    const m = new RegExp(`^\\s*\\*?\\s*${key.replace(".", "\\.")}\\s*=\\s*"(.*)"\\s*$`, "m").exec(stdout || "");
    return (m && m[1].trim()) || null;
  };
  return { name: prop("node.name"), description: prop("node.description") };
}

// The default devices named by `pactl info`. Matching spaces and tabs only,
// not \s: an empty "Default Sink:" would otherwise swallow the newline and
// capture the next line — which is the session cookie, published as the
// device name.
function parsePactlInfo(info) {
  const one = (label) => (new RegExp(`^${label}:[ \\t]*(\\S.*)$`, "m").exec(info || "") || [])[1] || null;
  return { sink: one("Default Sink"), source: one("Default Source") };
}

// The Description of the device named `name` in `pactl list sinks|sources`
// output. Falls back to the id itself, which is ugly but still identifies the
// device, and to null when there is nothing to go on.
function pactlDescription(listing, name) {
  const id = (name || "").trim();
  if (!id) return null;
  if (!listing) return id;
  // Entries start at "Sink #0" / "Source #3"; fields are indented under them.
  for (const block of listing.split(/\n(?=\w+ #\d+)/)) {
    const blockName = (/^\s*Name:\s*(.+)$/m.exec(block) || [])[1];
    if ((blockName || "").trim() !== id) continue;
    const desc = (/^\s*Description:\s*(.+)$/m.exec(block) || [])[1];
    return (desc || "").trim() || id;
  }
  return id;
}

// PS_DEFAULT_AUDIO's JSON → { output, input }, or null when neither is known.
function parseDefaultAudio(stdout) {
  let o;
  try {
    o = JSON.parse((stdout || "").trim());
  } catch (_) {
    return null;
  }
  const output = cleanAudioName(o && o.output);
  const input = cleanAudioName(o && o.input);
  return output || input ? { output, input } : null;
}

// Windows disambiguates repeated device names with a "2- " prefix:
// "Mic In (2- Elgato Wave:3)" → "Mic In (Elgato Wave:3)".
function cleanAudioName(name) {
  if (!name || typeof name !== "string") return null;
  return name.replace(/\(\s*\d+-\s*/g, "(").trim() || null;
}

// Antivirus detection. systeminformation has no AV API, so this queries the
// platform directly: Windows Security Center (where McAfee/Norton/etc register)
// on Windows, and known app bundles on macOS. Returns the FACTS.antivirus shape:
//   { products: [{ name, version, running, updated, definitionsAge }] }
// running/updated are null when the platform gives no way to know.
function detectAntivirus() {
  const plat = process.platform;

  if (plat === "win32") {
    // Decode productState (a hex bitfield): middle byte = real-time protection
    // on (0x10/0x11), last byte = signatures up to date (0x00).
    const ps =
      "$ErrorActionPreference='SilentlyContinue';" +
      "$av = Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct;" +
      "$out = foreach ($p in $av) {" +
      "  $hex = ([Convert]::ToString($p.productState,16)).PadLeft(6,'0');" +
      "  [pscustomobject]@{ name=$p.displayName; enabled=($hex.Substring(2,2) -in '10','11'); updated=($hex.Substring(4,2) -eq '00'); timestamp=$p.timestamp }" +
      "};" +
      "$out | ConvertTo-Json -Compress";
    return new Promise((resolve) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
        { timeout: 15000, windowsHide: true },
        (err, stdout) => {
          let products = err ? [] : parseWindowsAv((stdout || "").trim());
          // Prefer third-party AV: drop the built-in Defender when another
          // product is present, so a single real AV reads as "one AV".
          const thirdParty = products.filter(
            (p) => !/windows defender|microsoft defender/i.test(p.name),
          );
          if (thirdParty.length) products = thirdParty;
          resolve({ products });
        },
      );
    });
  }

  if (plat === "darwin") return Promise.resolve({ products: detectMacAv() });

  if (plat === "linux") return linuxAntivirus();

  return Promise.resolve({ products: [] });
}

// Linux has no equivalent of Security Center, so this looks for the products
// themselves: a file each one installs, and whether its daemon is running.
// Reported running only when its process is actually up, rather than assuming
// an installed product is protecting anything.
// `daemons` lists the resident process names, since a product's package, its
// service and its process are often three different names. Kernel process
// names are cut to 15 characters, so these are compared on that prefix.
const LINUX_AV = [
  // freshclam is deliberately absent: it updates signatures, it does not scan,
  // and counting it as running is how "fresh definitions, dead scanner" hides.
  { name: "ClamAV", marker: "/usr/bin/clamscan", daemons: ["clamd", "clamav-daemon"] },
  { name: "CrowdStrike Falcon", marker: "/opt/CrowdStrike/falconctl", daemons: ["falcond", "falcon-sensor"] },
  { name: "SentinelOne", marker: "/opt/sentinelone/bin/sentinelctl", daemons: ["sentineld", "s1-agent", "sentinelone"] },
  { name: "Sophos Protection", marker: "/opt/sophos-spl/bin/wdctl", daemons: ["sophos_watchdog", "sophosd", "SophosMcsAgent"] },
  { name: "ESET Server Security", marker: "/opt/eset/efs/sbin/setgui", daemons: ["oaeventd", "eset_daemon"] },
  // wdavdaemon only: "mdatp" is also the command a user can run by hand.
  { name: "Microsoft Defender", marker: "/opt/microsoft/mdatp/sbin/wdavdaemon", daemons: ["wdavdaemon"] },
];

async function linuxAntivirus() {
  const installed = LINUX_AV.filter((p) => exists(p.marker));
  if (!installed.length) return { products: [] };
  const running = runningProcessNames(
    new Set(installed.flatMap((p) => p.daemons.map((d) => d.slice(0, 15)))),
  );
  const products = installed.map((p) => ({
    name: p.name,
    version: null,
    // null, not false, when the process list could not be read: "unknown" and
    // "not running" mean different things on a card about protection.
    running: running && p.daemons.some((d) => running.has(d.slice(0, 15))),
    updated: null,
    definitionsAge: p.name === "ClamAV" ? clamavDefinitionsAge() : null,
  }));
  return { products };
}

// The names of every running process, read from /proc rather than by spawning
// pgrep: procps is not on every image, and a missing tool would otherwise read
// as "nothing is running".
function runningProcessNames(wanted) {
  try {
    const found = new Set();
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const name = fs.readFileSync(`/proc/${entry}/comm`, "utf8").trim();
        if (!wanted || wanted.has(name)) found.add(name);
        // Nothing else to learn: stop reading a busy machine's process table.
        if (wanted && found.size === wanted.size) break;
      } catch (_) {
        /* the process ended, or it is not ours to read */
      }
    }
    return found;
  } catch (_) {
    return null;
  }
}

// ClamAV's signature database, whichever format freshclam left behind.
function clamavDefinitionsAge() {
  const stamps = ["/var/lib/clamav/daily.cld", "/var/lib/clamav/daily.cvd"]
    .map(fileMtime)
    .filter(Boolean);
  if (!stamps.length) return null;
  const newest = new Date(Math.max(...stamps.map((d) => d.getTime())));
  return humanAge(newest.toISOString());
}

// macOS has no Security Center, so this finds known AV app bundles. A bundle
// on disk says the product is installed, not that it is running or current,
// so both stay null rather than reporting a check that never happened.
function detectMacAv(has = exists) {
  const apps = [
    "/Applications/Microsoft Defender.app",
    "/Applications/McAfee Endpoint Security for Mac.app",
    "/Applications/McAfee LiveSafe.app",
    "/Applications/Malwarebytes.app",
    "/Applications/Norton 360.app",
    "/Applications/Bitdefender Antivirus for Mac.app",
    "/Applications/ESET Endpoint Antivirus.app",
    "/Applications/Kaspersky Internet Security.app",
    "/Applications/Sophos Home.app",
    "/Applications/Webroot SecureAnywhere.app",
    "/Applications/CrowdStrike Falcon.app",
    "/Applications/SentinelOne.app",
  ];
  return apps
    .filter((p) => has(p))
    .map((p) => ({
      name: path.basename(p, ".app"),
      version: null,
      running: null,
      updated: null,
      definitionsAge: null,
    }));
}

function parseWindowsAv(stdout) {
  if (!stdout) return [];
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (_) {
    return [];
  }
  if (!parsed) return [];
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  return arr
    .filter((p) => p && p.name)
    .map((p) => ({
      name: p.name,
      version: null, // Security Center doesn't expose the product version
      running: !!p.enabled,
      updated: !!p.updated,
      definitionsAge: humanAge(p.timestamp),
    }));
}

// Humanize a last-update timestamp (RFC1123 from Security Center) → "3 hours".
function humanAge(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  if (isNaN(d.getTime())) return null;
  const sec = (Date.now() - d.getTime()) / 1000;
  // A timestamp in the future is a clock the app cannot reason from — a VM
  // whose RTC is ahead, a restored snapshot, a mislabelled timezone. Saying
  // "just now" would make signatures or a package cache of unknown age look
  // freshly updated on the card someone checks to find out otherwise.
  if (sec < -300) return null;
  if (sec < 60) return "just now";
  if (sec < 3600) return Math.max(1, Math.round(sec / 60)) + " min";
  if (sec < 86400) return plural(Math.round(sec / 3600), "hour");
  return plural(Math.round(sec / 86400), "day");
}

// "1 day" rather than "1 days" — this string is rendered straight onto a card.
function plural(n, unit) {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

// Slow detections, fetched lazily after first paint: OS update status, the SSD
// flag (both hit slow Windows providers) and the running-process scan. Returned
// together so the renderer merges them in a single re-render. Each is wrapped
// so one slow provider cannot strand the others.
async function detectDeferred() {
  const [updates, ssd, backgroundApps, graphics] = await Promise.all([
    probe(detectUpdates(), UNKNOWN_UPDATES, "deferred:updates"),
    probe(detectSsd(), null, "deferred:ssd"),
    probe(detectBackgroundApps(), { browserExtensions: 0, runningApps: [] }, "deferred:backgroundApps"),
    probe(detectDisplays(), [], "deferred:graphics"),
  ]);
  return { ...updates, ssd, backgroundApps, display: summarizeMonitors(graphics) };
}

// The monitors, one entry each: { name, connection, builtin, main, width,
// height, refreshHz, sizeInches }.
//
// On GNOME with Wayland the X11 view systeminformation reads (through
// XWayland) is scaled: a 5120 × 1440 120 Hz monitor read 10240 × 2880 at
// 23.69 Hz, and a 1920 × 1200 panel 3072 × 1920. GNOME's own display service,
// Mutter, has the real modes, so it is asked first there. Everywhere else, and
// whenever Mutter can't answer, systeminformation's list is used.
async function detectDisplays() {
  const fromMutter = await mutterMonitors().catch(() => null);
  if (fromMutter && fromMutter.length) return fromMutter;
  return monitorsFromGraphics(await si.graphics().catch(() => ({})));
}

// Mutter's DisplayConfig over D-Bus, on a GNOME session. Resolves null
// anywhere else (no gdbus, no Mutter, not Linux).
async function mutterMonitors() {
  if (process.platform !== "linux") return null;
  const gdbus = findTool("/usr/bin/gdbus", "/bin/gdbus");
  if (!gdbus) return null;
  const out = await runCmd(gdbus, [
    "call", "--session",
    "--dest", "org.gnome.Mutter.DisplayConfig",
    "--object-path", "/org/gnome/Mutter/DisplayConfig",
    "--method", "org.gnome.Mutter.DisplayConfig.GetCurrentState",
  ], { timeout: 3000 });
  return out ? parseMutterState(out) : null;
}

// `GetCurrentState`, as gdbus prints it, → monitors. The text is a GVariant:
//   (serial, [((connector, vendor, product, serial), [modes], {props}), …],
//    [(x, y, scale, transform, primary, [(connector, …)], {props}), …], {…})
// Each mode is ('5120x1440@119.999', 5120, 1440, 119.999…, scale, [scales],
// {'is-current': <true>, …}). A monitor that is connected but switched off
// has no current mode and is left out, as it shows nothing. Its serial number
// is never kept.
function parseMutterState(stdout) {
  const text = String(stdout || "");
  const header = /\(\('((?:[^'\\]|\\.)*)', '((?:[^'\\]|\\.)*)', '((?:[^'\\]|\\.)*)', '(?:[^'\\]|\\.)*'\), \[/g;
  const starts = [];
  for (let m; (m = header.exec(text));) starts.push({ at: m.index, connector: m[1], vendor: m[2], product: m[3] });
  // Which connector the primary logical monitor shows.
  const primary = (/\(-?\d+, -?\d+, [\d.]+, (?:uint32 )?\d+, true, \[\('((?:[^'\\]|\\.)*)'/.exec(text) || [])[1];
  const unescape = (v) => v.replace(/\\(.)/g, "$1");
  const monitors = [];
  starts.forEach((mon, i) => {
    const seg = text.slice(mon.at, i + 1 < starts.length ? starts[i + 1].at : text.length);
    let current = null;
    const mode = /\('\d+x\d+@[\d.]+', (\d+), (\d+), ([\d.]+), [\d.]+, \[[^\]]*\], \{([^}]*)\}\)/g;
    for (let m; (m = mode.exec(seg));) {
      if (/'is-current': <true>/.test(m[4])) {
        current = { width: Number(m[1]), height: Number(m[2]), refreshHz: Number(m[3]) };
        break;
      }
    }
    if (!current) return;
    const builtinMatch = /'is-builtin': <(true|false)>/.exec(seg);
    const nameMatch = /'display-name': <'((?:[^'\\]|\\.)*)'>/.exec(seg);
    const builtin = builtinMatch ? builtinMatch[1] === "true" : /^(eDP|LVDS|DSI)/i.test(mon.connector);
    monitors.push({
      name: nameMatch ? unescape(nameMatch[1]) : builtin ? "Built-in display" : unescape(mon.connector),
      connection: unescape(mon.connector),
      builtin,
      main: unescape(mon.connector) === (primary && unescape(primary)),
      ...current,
      sizeInches: null,
    });
  });
  return monitors;
}

// systeminformation's si.graphics() → monitors. Each display's resolution is
// the mode it runs in now (currentResX/Y), falling back to the panel's own:
// on Linux systeminformation often fills only the former. sizeX/sizeY come
// back in centimetres, not millimetres.
function monitorsFromGraphics(graphics) {
  const displays = ((graphics && graphics.displays) || []).filter((d) => d && typeof d === "object");
  return displays.map((d, i) => {
    const builtin = !isExternalDisplay(d);
    const named = [d.model, d.deviceName].find((v) => typeof v === "string" && v.trim() && !/^\\\\\.\\/.test(v));
    return {
      name: named ? named.trim() : builtin ? "Built-in display" : d.connection ? `External display (${d.connection})` : `Display ${i + 1}`,
      connection: d.connection || null,
      builtin,
      main: Boolean(d.main),
      width: d.currentResX || d.resolutionX || null,
      height: d.currentResY || d.resolutionY || null,
      refreshHz: d.currentRefreshRate > 0 ? d.currentRefreshRate : null,
      sizeInches: d.sizeX > 0 && d.sizeY > 0 ? Math.round(Math.hypot(d.sizeX, d.sizeY) / 2.54) : null,
    };
  });
}

// Monitors → the Display card's facts. `monitors` lists every display with its
// own resolution and refresh rate, the main one first. The single-display
// fields (resolution, refreshRate, external…) describe the main display and
// the first external one, as they did before, for older report readers.
function summarizeMonitors(list) {
  const monitors = (Array.isArray(list) ? list : []).filter((m) => m && typeof m === "object");
  const main = monitors.find((m) => m.main) || monitors[0];
  const ordered = main ? [main, ...monitors.filter((m) => m !== main)] : [];
  const resolution = (m) => (m && m.width && m.height ? `${m.width} × ${m.height}` : "Unknown");
  const refresh = (m) => (m && m.refreshHz > 0 ? `${Math.round(m.refreshHz)} Hz` : null);
  const externals = ordered.filter((m) => !m.builtin);
  const ext = externals[0];
  return {
    count: monitors.length,
    monitors: ordered.map((m) => ({
      name: m.name,
      builtin: Boolean(m.builtin),
      main: m === main,
      resolution: resolution(m),
      refreshRate: refresh(m),
      connection: m.connection || null,
      size: m.sizeInches ? `${m.sizeInches}"` : null,
    })),
    resolution: resolution(main),
    refreshRate: refresh(main),
    external: externals.length > 0,
    externalCount: externals.length,
    externalSize: ext && ext.sizeInches ? `${ext.sizeInches}"` : null,
    externalConnection: ext ? (ext.connection || "External") : null,
  };
}

// si.graphics() straight to the card's facts, for callers (and tests) that
// start from systeminformation's output.
function summarizeDisplays(graphics) {
  return summarizeMonitors(monitorsFromGraphics(graphics));
}

// Is the primary disk an SSD? si.diskLayout() is the reliable source but slow.
function detectSsd() {
  return si
    .diskLayout()
    .then((layout) => (layout || []).some((d) => /ssd|nvme/i.test(d.type || "")))
    .catch(() => null);
}

const UNKNOWN_UPDATES = { pendingUpdates: null, lastUpdateCheck: "Unknown", lastUpdateKind: null };

// OS update status. Windows: an offline WU search (fast — uses the last synced
// metadata, no network round-trip) for the pending count, plus the agent's last
// successful detect time from the registry. Other platforms return unknown.
//
// The Detect key is gone on Windows 10 1903 and later, so the fallback is the
// newest hotfix's install date — a different event, reported as such. Both
// leave PowerShell as round-trip UTC ("o"): LastSuccessTime is stored in UTC
// with no marker, and an offset-less string would be read back as local time.
function detectUpdates() {
  if (process.platform === "linux") return linuxUpdates();
  if (process.platform !== "win32") return Promise.resolve(UNKNOWN_UPDATES);
  const ps =
    "$ErrorActionPreference='SilentlyContinue';" +
    "$r=[ordered]@{pending=$null;lastCheck=$null;source=$null};" +
    "try{ $s=(New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher(); $s.Online=$false; $r.pending=($s.Search('IsInstalled=0 and IsHidden=0').Updates).Count }catch{};" +
    "$lc=(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\Results\\Detect').LastSuccessTime;" +
    "if($lc){ $r.lastCheck=[DateTime]::SpecifyKind([DateTime]$lc,'Utc').ToString('o'); $r.source='check' }" +
    "else{ $hf=(Get-HotFix | Where-Object InstalledOn | Sort-Object InstalledOn -Descending | Select-Object -First 1).InstalledOn;" +
    "  if($hf){ $r.lastCheck=$hf.ToUniversalTime().ToString('o'); $r.source='install' } };" +
    "[pscustomobject]$r | ConvertTo-Json -Compress";
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
      { timeout: 25000, windowsHide: true },
      (err, stdout) => resolve(err ? UNKNOWN_UPDATES : parseWindowsUpdates(stdout)),
    );
  });
}

// Pending updates on the two families this app targets: Debian/Ubuntu (apt)
// and Fedora/RHEL (dnf). Both are asked to work from their existing metadata
// rather than refresh it, so this costs no network round-trip and no lock.
async function linuxUpdates() {
  const apt = findTool("/usr/bin/apt-get", "/bin/apt-get");
  if (apt) {
    // dist-upgrade, not upgrade: plain upgrade never installs a new package,
    // so anything pulling in a new dependency is "kept back" and goes
    // uncounted — most visibly kernel updates, which are the ones worth
    // nagging about. Simulated, so it needs no root and takes no lock.
    // 25 s, not the default 10: a cold cache makes apt rebuild pkgcache.bin
    // first, and this runs after first paint where the wait costs nothing.
    const out = await runCmd(apt, ["-s", "-o", "Debug::NoLocking=true", "dist-upgrade"], { timeout: 25000 });
    return withKind({
      pendingUpdates: out == null ? null : parseAptUpgrades(out),
      lastUpdateCheck: ageOf([
        "/var/lib/apt/periodic/update-success-stamp", // written only by a successful update
        "/var/lib/apt/lists", // touched by every apt-get update, and left alone by clean
        "/var/cache/apt/pkgcache.bin", // last resort: any install rewrites it too
      ]),
    });
  }
  const dnf = findTool("/usr/bin/dnf", "/bin/dnf");
  if (dnf) {
    // dnf exits 100 when updates are pending, 0 when none are.
    const out = await runCmd(dnf, ["-q", "--cacheonly", "check-update"], { okExitCodes: [100] });
    return withKind({
      pendingUpdates: out == null ? null : parseDnfCheckUpdate(out),
      lastUpdateCheck: ageOf([
        "/var/cache/dnf/last_makecache", // dnf4 only
        repoMetadataFiles(), // dnf5, and dnf4 without the stamp: newest repo wins
      ]),
    });
  }
  return UNKNOWN_UPDATES;
}

// Every apt and dnf source above dates a metadata refresh, which is a check
// for updates rather than an install of one.
function withKind(updates) {
  return { ...updates, lastUpdateKind: updates.lastUpdateCheck === "Unknown" ? null : "checked" };
}

// Each repository's downloaded metadata, whose mtime is when it was last
// refreshed. The cache directory's own mtime is not that: it changes when a
// repo is added or removed, so on dnf5 (which writes no last_makecache) it
// would report image build time as the last check.
function repoMetadataFiles() {
  const files = [];
  for (const root of ["/var/cache/libdnf5", "/var/cache/dnf"]) {
    let repos = [];
    try {
      repos = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch (_) {
      continue;
    }
    for (const repo of repos) files.push(path.join(root, repo.name, "repodata", "repomd.xml"));
  }
  return files;
}

// How long ago the most recently written of these files was touched, worded as
// the cards do. "just now" is already a whole phrase, so it takes no "ago".
function ageOf(files) {
  for (const group of files) {
    // Each group is one source, in order of trust: apt's own "I refreshed"
    // stamp beats a cache file that any install also rewrites. Within a group
    // the newest wins.
    const times = [].concat(group).map(fileMtime).filter(Boolean);
    if (!times.length) continue;
    const newest = new Date(Math.max(...times.map((d) => d.getTime())));
    const age = humanAge(newest.toISOString());
    if (age == null) continue; // a future mtime says nothing
    return age === "just now" ? age : age + " ago";
  }
  return "Unknown";
}

// `apt-get -s dist-upgrade` lists one "Inst <package> ..." line per package it
// would install.
function parseAptUpgrades(stdout) {
  return (stdout || "").split("\n").filter((l) => /^Inst\s+\S/.test(l)).length;
}

// `dnf check-update` lists "<package>.<arch> <version> <repo>" per update.
// A name too wide for the column is printed on a line of its own with the rest
// indented beneath it, so the package line is what counts and an indented
// continuation is skipped. The "Obsoleting Packages" section that can follow
// lists what an update replaces, which is not something to install.
function parseDnfCheckUpdate(stdout) {
  let count = 0;
  for (const line of (stdout || "").split("\n")) {
    if (/^Obsoleting Packages/i.test(line)) break;
    if (!line.trim() || /^\s/.test(line)) continue; // blank, or a continuation
    if (/^Last metadata/i.test(line)) continue;
    if (/^\S+\.\S+(\s|$)/.test(line)) count++;
  }
  return count;
}

// detectUpdates' JSON → the os fields the renderer merges.
function parseWindowsUpdates(stdout) {
  let o;
  try {
    o = JSON.parse((stdout || "").trim()) || {};
  } catch (_) {
    return UNKNOWN_UPDATES;
  }
  const age = humanAge(o.lastCheck);
  return {
    pendingUpdates: typeof o.pending === "number" ? o.pending : null,
    // "just now" is already a whole phrase, so it takes no "ago".
    lastUpdateCheck: !age ? "Unknown" : age === "just now" ? age : `${age} ago`,
    lastUpdateKind: !age ? null : o.source === "install" ? "installed" : "checked",
  };
}

// Apps that compete for bandwidth/CPU. Real running processes matched against
// a list of common bandwidth-heavy apps, plus a count of installed browser
// extensions (another common source of background resource use).
async function detectBackgroundApps() {
  const KNOWN = {
    zoom: "Zoom", teams: "Microsoft Teams", "ms-teams": "Microsoft Teams",
    skype: "Skype", webex: "Webex", discord: "Discord", slack: "Slack",
    dropbox: "Dropbox", onedrive: "OneDrive", steam: "Steam",
    spotify: "Spotify", chrome: "Chrome", msedge: "Microsoft Edge",
    firefox: "Firefox", code: "VS Code",
  };

  let runningApps = [];
  try {
    const procs = await si.processes();
    const names = (procs.list || []).map((p) => (p.name || "").toLowerCase());
    const found = new Set();
    for (const n of names) {
      for (const key of Object.keys(KNOWN)) {
        if (n.includes(key)) found.add(KNOWN[key]);
      }
    }
    runningApps = [...found];
  } catch (_) {
    /* leave empty */
  }
  return { browserExtensions: countBrowserExtensions(), runningApps };
}

// Count installed browser extensions across Chromium-based browsers' default
// profiles (each extension is a folder named by its ID).
function countBrowserExtensions() {
  const home = os.homedir();
  const dirs = [];
  if (process.platform === "win32") {
    const lad = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    dirs.push(path.join(lad, "Google", "Chrome", "User Data", "Default", "Extensions"));
    dirs.push(path.join(lad, "Microsoft", "Edge", "User Data", "Default", "Extensions"));
    dirs.push(path.join(lad, "BraveSoftware", "Brave-Browser", "User Data", "Default", "Extensions"));
  } else if (process.platform === "darwin") {
    const as = path.join(home, "Library", "Application Support");
    dirs.push(path.join(as, "Google", "Chrome", "Default", "Extensions"));
    dirs.push(path.join(as, "Microsoft Edge", "Default", "Extensions"));
    dirs.push(path.join(as, "BraveSoftware", "Brave-Browser", "Default", "Extensions"));
  } else if (process.platform === "linux") {
    // ~/.config, or wherever XDG_CONFIG_HOME points.
    const cfg = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
    for (const b of ["google-chrome", "chromium", "microsoft-edge", "BraveSoftware/Brave-Browser"]) {
      dirs.push(path.join(cfg, ...b.split("/"), "Default", "Extensions"));
    }
  }
  let count = 0;
  for (const d of dirs) {
    try {
      count += fs
        .readdirSync(d, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== "Temp").length;
    } catch (_) {
      /* browser not installed */
    }
  }
  return count;
}

// DNS servers actually configured for resolution. With systemd-resolved,
// resolv.conf lists only its local stub (127.0.0.53), which says nothing about
// where queries go, so ask resolved for the upstream servers instead.
async function detectDnsServers() {
  let servers = [];
  try {
    servers = dns.getServers().filter((s) => s && !s.startsWith("fe80"));
  } catch (_) {
    /* fall through */
  }
  if (process.platform === "linux" && servers.length && servers.every(isLoopback)) {
    // By full path and in toolEnv, like the other Linux tools: run by name it
    // inherited an AppImage's LD_LIBRARY_PATH, could fail to load, and left
    // the card on the 127.0.0.53 stub in the shipped build only.
    const resolvectl = findTool("/usr/bin/resolvectl", "/bin/resolvectl");
    const out = resolvectl ? await runCmd(resolvectl, ["dns"], { timeout: 5000 }) : null;
    const upstream = out ? parseResolvectlDns(out) : [];
    if (upstream.length) return upstream;
  }
  return servers;
}

const isLoopback = (addr) => /^127\./.test(addr) || addr === "::1";

// `resolvectl dns` → unique servers, in order. Lines look like
// "Link 2 (enp3s0): 192.168.1.1 fe80::1%enp3s0"; a DNS-over-TLS server carries
// its name after a "#" ("1.1.1.1#cloudflare-dns.com").
function parseResolvectlDns(stdout) {
  const found = [];
  for (const line of String(stdout || "").split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    for (const tok of line.slice(colon + 1).trim().split(/\s+/)) {
      const addr = tok.split("#")[0].split("%")[0];
      if (addr && !addr.startsWith("fe80") && !found.includes(addr)) found.push(addr);
    }
  }
  return found;
}

// The volume the user actually runs on. Picking the biggest volume instead
// reports a large empty data/backup drive as "the" disk, which reads as 0% used.
//
// On macOS (APFS, Catalina on) / is the sealed, read-only system volume, and
// the home folder lives on /System/Volumes/Data through a firmlink, so its path
// never starts with that mount. Matching by path picked /, which holds only the
// OS and read as a nearly empty disk.
function pickPrimaryFs(fsSize, homeDir = os.homedir(), platform = process.platform) {
  const list = (fsSize || []).filter((f) => f && f.mount && f.size);
  if (platform === "darwin") {
    const data = list.find((f) => f.mount === "/System/Volumes/Data");
    if (data) return data;
  }
  const home = homeDir.toLowerCase();
  const onHome = list
    .filter((f) => home.startsWith(f.mount.toLowerCase()))
    .sort((a, b) => b.mount.length - a.mount.length)[0];
  return onHome || [...list].sort((a, b) => b.size - a.size)[0] || {};
}

// "External" means a physically separate panel, not "not the primary one" —
// an external monitor is very often the main display on a docked laptop.
function isExternalDisplay(d) {
  if (typeof d.builtin === "boolean") return !d.builtin;
  return !/internal|built-?in|lvds|edp/i.test(d.connection || "");
}

// systeminformation reports "wired" / "wireless" (and "virtual" / "unknown" on
// Linux); every other label in the app is capitalised. A VPN tunnel reads as
// "Virtual" even where the OS calls its adapter wired, as Windows does.
//
// systeminformation's own "virtual" is not a tunnel: on Linux it gives that
// type to lo and to bond* (link aggregation over real cables), so it is read
// like a missing type, and tunnels are recognised by name instead.
function interfaceType(type, isWired, isVirtual = false) {
  if (isVirtual) return "Virtual";
  if (!type || /^virtual$/i.test(type)) return isWired ? "Wired" : "Wireless";
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function formatLinkSpeed(speed) {
  if (!speed || speed < 0) return "Unknown";
  return speed >= 1000 ? `${round1(speed / 1000)} Gbps` : `${Math.round(speed)} Mbps`;
}

function ramPressure(mem) {
  const ratio = mem.total ? mem.available / mem.total : 1;
  if (ratio < 0.1) return "High";
  if (ratio < 0.25) return "Moderate";
  return "Normal";
}

// Does the kernel say this Linux interface is Wi-Fi? Its uevent file carries
// DEVTYPE=wlan for every wireless card, whatever driver or tools are present.
function isLinuxWlan(name, readFile = fs.readFileSync) {
  if (!name || /[/\\]/.test(name)) return false;
  try {
    return /^DEVTYPE=wlan$/m.test(readFile(`/sys/class/net/${name}/uevent`, "utf8"));
  } catch (_) {
    return false;
  }
}

// Interface names of VPN clients and tunnel drivers.
const VPN_RE =
  /\b(vpn|tun\d*|tap\d*|wg\d*|wireguard|nordlynx|tailscale|utun\d*|anyconnect|cisco\s*secure\s*client|openvpn|globalprotect|pangp|forticlient|zscaler|expressvpn|protonvpn|mullvad)\b/i;

const ifaceNames = (n) => `${n.iface || ""} ${n.ifaceName || ""}`;

// Is this interface a tunnel rather than a physical link? Only the name gives
// it away. systeminformation's type "virtual" does not: on Linux it also
// covers bond* (several real cables bonded into one link), which is not a VPN.
function isVirtualInterface(iface) {
  if (!iface) return false;
  return VPN_RE.test(ifaceNames(iface));
}

// Heuristic VPN detection: look for an *active* tunnel interface (up + has an
// IPv4) whose name matches a known VPN client / tunnel driver. Requiring an
// active IPv4 avoids the always-present-but-idle WAN Miniport adapters on
// Windows and the idle utun interfaces on macOS.
function detectVpn(net) {
  const list = Array.isArray(net) ? net : [net];
  const active = list.find((n) => {
    const state = (n.operstate || "").toLowerCase();
    const up = state === "up" || state === "";
    return up && !!n.ip4 && VPN_RE.test(ifaceNames(n));
  });
  if (active) {
    return { detected: true, name: active.ifaceName || active.iface };
  }
  return { detected: false, name: null };
}

function pickAudio(audio, dir) {
  const list = (audio || []).filter((a) => dir === "out" ? /out|speaker|headphone/i.test(a.type || "") : /in|mic/i.test(a.type || ""));
  const d = (list[0] || (audio || [])[0] || {});
  return d.name || "System default";
}

// Classify the selected output device only. Scanning every device instead
// matches any Bluetooth/USB driver that happens to be installed.
//
// Windows names a Bluetooth headset's endpoints after its profiles:
// "Headset (WH-1000XM4 Hands-Free AG Audio)" for calls and
// "Headphones (WH-1000XM4 Stereo)" for music. Those are checked before the
// generic "headset" match, which would otherwise call them wired USB. An
// explicit "USB" still wins over "Stereo", as in "Speakers (USB Stereo Audio)".
// The Stereo rule needs Windows' closing parenthesis: a Linux device id ends
// in "analog-stereo" for a built-in sound card too.
function classifyHeadset(outputName) {
  const s = (outputName || "").toLowerCase();
  if (/airpod|bluetooth|wireless|bluez|hands-?free|a2dp/.test(s)) return "Bluetooth";
  if (/usb/.test(s)) return "USB headset";
  if (/\bstereo\)$/.test(s)) return "Bluetooth";
  if (/headset|plantronics|jabra|logitech|sennheiser/.test(s)) return "USB headset";
  return "Built-in";
}

function humanUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  if (d > 0) return `${d} day${d !== 1 ? "s" : ""}, ${h} hour${h !== 1 ? "s" : ""}`;
  const m = Math.floor((sec % 3600) / 60);
  return `${h} hour${h !== 1 ? "s" : ""}, ${m} min`;
}

module.exports = {
  collectFacts,
  detectDeferred,
  probeTimings,
  // Exported for unit tests — pure helpers with no OS/process dependency.
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
  parsePactlInfo,
  pactlDescription,
  parseAptUpgrades,
  parseDnfCheckUpdate,
  // The Linux plumbing. Exported so the choices that are easy to revert by
  // accident — the loader variables a spawned tool must not inherit, which
  // stamp file outranks which — are pinned by a test rather than by a comment.
  toolEnv,
  findTool,
  ageOf,
  runningProcessNames,
  parseWindowsUpdates,
  parseDefaultAudio,
  detectMacAv,
  isVirtualInterface,
  isLinuxWlan,
  summarizeDisplays,
  summarizeMonitors,
  monitorsFromGraphics,
  parseMutterState,
  parseResolvectlDns,
  detectAudio,
  audioNames,
  parseWpctlInspect,
};
