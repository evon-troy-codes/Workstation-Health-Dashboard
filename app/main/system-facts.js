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
let APP_VERSION = "1.4.0";
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

// Like runCmd, for a tool whose exit code alone can't tell success from
// failure: resolves { code, stdout, stderr } whatever it exits with, or null
// when it can't be started or runs past the timeout.
function runCmdResult(cmd, args, { timeout = 10000 } = {}) {
  return new Promise((resolve) => {
    const opts = { timeout, windowsHide: true, env: toolEnv(), maxBuffer: 4 * 1024 * 1024 };
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err && typeof err.code !== "number") return resolve(null); // not started, killed or timed out
      resolve({ code: err ? err.code : 0, stdout: stdout || "", stderr: stderr || "" });
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
    // On Linux, null (nothing to report) stays null; see linuxAntivirus.
    probe(detectAntivirus(), process.platform === "linux" ? null : { products: [], checked: false }, "antivirus"),
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

  // --- OS name: on Linux, the distribution's own os-release ---
  const osFields = osNameVersion(process.platform === "linux" ? linuxOsRelease() : null, osInfo);

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
      ...cpuSpeed(cpu),
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
      ...osFields,
      lastUpdateCheck: "Checking…", // filled in by the lazy get-updates call
      // "checked" or "installed": which event lastUpdateCheck dates. null
      // until the update check resolves, or when nothing could be read.
      lastUpdateKind: null,
      pendingUpdates: null, // number once the lazy update check resolves
      // { snap?, flatpak? } once it resolves: a key per installed tool.
      appUpdates: null,
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
    // Resolved lazily (detectDeferred): on Windows it is one more PowerShell,
    // and the first paint already waits on several.
    firewall: null,
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
      headsetConnected: headsetClass === "Bluetooth" || headsetClass === "USB headset",
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

// The query reports whether it ran ("ok"), so an empty product list can
// be told apart from a query that failed: Security Center missing (Server
// editions), WMI broken, PowerShell timing out at login. A failed check
// is reported as such (checked: false), never as "no antivirus".
const WINDOWS_AV_SCRIPT =
  "$ErrorActionPreference='SilentlyContinue';" +
  "$r=@{ok=$false;products=@()};" +
  "try {" +
  "  $av = Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction Stop;" +
  "  $r.products = @(foreach ($p in $av) {" +
  "    $hex = ([Convert]::ToString($p.productState,16)).PadLeft(6,'0');" +
  "    [pscustomobject]@{ name=$p.displayName; enabled=($hex.Substring(2,2) -in '10','11'); updated=($hex.Substring(4,2) -eq '00'); timestamp=$p.timestamp }" +
  "  });" +
  "  $r.ok = $true" +
  "} catch {};" +
  "[pscustomobject]$r | ConvertTo-Json -Compress -Depth 4";

// Antivirus detection. systeminformation has no AV API, so this queries the
// platform directly: Windows Security Center (where McAfee/Norton/etc register)
// on Windows, known app bundles on macOS, and known products on Linux. Returns
// the FACTS.antivirus shape, or null on Linux when there's nothing to report:
//   { products: [{ name, version, running, updated, definitionsAge }] }
// running/updated are null when the platform gives no way to know.
function detectAntivirus() {
  const plat = process.platform;

  if (plat === "win32") {
    // WINDOWS_AV_SCRIPT decodes productState (a hex bitfield): middle byte =
    // real-time protection on (0x10/0x11), last byte = signatures up to date.
    return new Promise((resolve) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_AV_SCRIPT],
        { timeout: 15000, windowsHide: true },
        (err, stdout) => {
          if (err) return resolve({ products: [], checked: false });
          let { products, checked } = parseWindowsAvResult((stdout || "").trim());
          // Prefer third-party AV: drop the built-in Defender when another
          // product is present, so a single real AV reads as "one AV".
          const thirdParty = products.filter(
            (p) => !/windows defender|microsoft defender/i.test(p.name),
          );
          if (thirdParty.length) products = thirdParty;
          resolve({ products, checked });
        },
      );
    });
  }

  if (plat === "darwin") return Promise.resolve({ products: withMacBuiltIn(detectMacAv(), xprotectAge()), checked: true });

  if (plat === "linux") return linuxAntivirus();

  return Promise.resolve({ products: [], checked: false });
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

// null when none of them is installed: antivirus is rare on a personal Linux
// machine, so "none found" there is nothing to report, and the card, the
// emailed report and the AI leave antivirus out rather than flag its absence.
// A work machine running one of these still reports it.
async function linuxAntivirus() {
  const installed = LINUX_AV.filter((p) => exists(p.marker));
  if (!installed.length) return null;
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
  return { products, checked: true };
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

// Every Mac has Apple's own malware protection, XProtect, built in. With no
// third-party product found, the card says that rather than "no antivirus",
// which would be wrong on every Mac. Like Windows dropping Defender when
// another product is present, it isn't listed alongside a third-party one.
// Its running state isn't visible, so it reads "Installed"; the age is when
// Apple last updated its definitions, when the bundle can be read.
function withMacBuiltIn(products, definitionsAge = null) {
  if (products.length) return products;
  return [{ name: "Built-in protection (XProtect)", version: null, running: null, updated: null, definitionsAge }];
}

// When XProtect's definitions were last updated: its bundle's Info.plist is
// replaced with each update. Its home moved in macOS 11; null if neither is
// there. Untested on a real Mac from the Linux machine.
function xprotectAge() {
  for (const f of [
    "/Library/Apple/System/Library/CoreServices/XProtect.bundle/Contents/Info.plist",
    "/System/Library/CoreServices/XProtect.bundle/Contents/Info.plist",
  ]) {
    const m = fileMtime(f);
    if (m) return humanAge(m.toISOString());
  }
  return null;
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

// The Windows query's JSON → { products, checked }. checked is false when the
// query says it failed, or printed nothing usable: an empty but successful
// query is a real "none installed". Output without the ok field (a bare
// product list) is read as checked.
function parseWindowsAvResult(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout || "");
  } catch (_) {
    return { products: [], checked: false };
  }
  if (parsed && !Array.isArray(parsed) && typeof parsed === "object" && "ok" in parsed) {
    return { products: parseWindowsAv(JSON.stringify(parsed.products || [])), checked: parsed.ok === true };
  }
  return { products: parseWindowsAv(stdout), checked: parsed != null };
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

// ---- Firewall ---------------------------------------------------------------
//
// facts.firewall: { checked, products: [{ name, active, detail }] }.
// active is true or false when the platform says, null when only the
// product's presence is known ("Installed"). detail qualifies an active
// reading ("Off for: Public"). checked: false is a check that failed
// ("Unknown"), never "none". Unlike antivirus, an empty list is reported on
// Linux too: the card says "No firewall service found" (owner's call,
// 2026-10-05). Without root the rules themselves can't be read, so "found"
// means a firewall service set up and running, and the wording says so.

// Windows Firewall's three profiles, and any third-party firewall registered
// with Security Center (which Windows Firewall itself is not). Both without
// admin rights. ok is whether the profile query ran.
const WINDOWS_FIREWALL_SCRIPT =
  "$ErrorActionPreference='SilentlyContinue';" +
  "$r=@{ok=$false;profiles=@();products=@()};" +
  "try {" +
  "  $r.profiles = @(Get-NetFirewallProfile -ErrorAction Stop | ForEach-Object {" +
  "    [pscustomobject]@{ name=[string]$_.Name; enabled=([string]$_.Enabled -eq 'True') } });" +
  "  $r.ok = $true" +
  "} catch {};" +
  "try {" +
  "  $fw = Get-CimInstance -Namespace root/SecurityCenter2 -ClassName FirewallProduct -ErrorAction Stop;" +
  "  $r.products = @(foreach ($p in $fw) {" +
  "    $hex = ([Convert]::ToString($p.productState,16)).PadLeft(6,'0');" +
  "    [pscustomobject]@{ name=$p.displayName; enabled=($hex.Substring(2,2) -in '10','11') }" +
  "  })" +
  "} catch {};" +
  "[pscustomobject]$r | ConvertTo-Json -Compress -Depth 4";

function detectFirewall() {
  const plat = process.platform;
  if (plat === "win32") {
    return new Promise((resolve) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_FIREWALL_SCRIPT],
        { timeout: 15000, windowsHide: true },
        (err, stdout) => resolve(err ? { products: [], checked: false } : parseWindowsFirewall((stdout || "").trim())),
      );
    });
  }
  if (plat === "darwin") return macFirewall();
  if (plat === "linux") return linuxFirewall();
  return Promise.resolve({ products: [], checked: false });
}

// The Windows query's JSON → facts.firewall. Third-party firewalls first,
// then Windows Firewall: on in every profile, off in every one, or on with
// the profiles that are off named.
function parseWindowsFirewall(stdout) {
  let r;
  try {
    r = JSON.parse(stdout || "");
  } catch (_) {
    return { products: [], checked: false };
  }
  if (!r || typeof r !== "object") return { products: [], checked: false };
  const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  const products = asList(r.products)
    .filter((p) => p && typeof p.name === "string" && p.name)
    .map((p) => ({ name: p.name, active: !!p.enabled, detail: null }));
  const profiles = asList(r.profiles).filter((p) => p && typeof p.name === "string");
  if (r.ok === true && profiles.length) {
    const off = profiles.filter((p) => !p.enabled).map((p) => p.name);
    products.push({
      name: "Windows Firewall",
      active: off.length < profiles.length,
      detail: off.length && off.length < profiles.length ? `Off for: ${off.join(", ")}` : null,
    });
  }
  return { products, checked: r.ok === true || products.length > 0 };
}

// macOS's built-in application firewall, plus known third-party firewall
// apps (installed only: their state isn't visible). Untested on a real Mac
// from the Linux machine.
const MAC_FIREWALL_APPS = ["/Applications/Little Snitch.app", "/Applications/LuLu.app"];

async function macFirewall(has = exists) {
  const others = MAC_FIREWALL_APPS.filter((p) => has(p))
    .map((p) => ({ name: path.basename(p, ".app"), active: null, detail: null }));
  const out = await runCmd("/usr/libexec/ApplicationFirewall/socketfilterfw", ["--getglobalstate"]);
  const active = parseMacFirewall(out);
  if (active == null) return { products: others, checked: others.length > 0 };
  return { products: [...others, { name: "macOS Firewall", active, detail: null }], checked: true };
}

// "Firewall is enabled. (State = 1)", "... blocking all non-essential ...
// (State = 2)" or "Firewall is disabled. (State = 0)" → true, false, or null
// when the output says neither.
function parseMacFirewall(stdout) {
  const m = /State = (\d)/.exec(stdout || "");
  if (m) return m[1] !== "0";
  if (/\bdisabled\b/i.test(stdout || "")) return false;
  if (/\benabled\b/i.test(stdout || "")) return true;
  return null;
}

// Linux: the firewall front ends and services, by what can be read without
// root: whether each is installed, UFW's own on/off setting, and which
// services systemd is running. `nft list ruleset` and `ufw status` need root.
const LINUX_FIREWALL_UNITS = ["ufw", "firewalld", "nftables", "iptables", "netfilter-persistent"];

async function linuxFirewall() {
  const systemctl = findTool("/usr/bin/systemctl", "/bin/systemctl");
  const result = systemctl ? await runCmdResult(systemctl, ["is-active", ...LINUX_FIREWALL_UNITS]) : null;
  return linuxFirewallFrom({
    ufwInstalled: exists("/usr/sbin/ufw") || exists("/usr/bin/ufw"),
    firewalldInstalled: exists("/usr/sbin/firewalld") || exists("/usr/bin/firewalld"),
    ufwEnabled: ufwConfigEnabled(),
    services: result ? parseSystemctlIsActive(result.stdout, LINUX_FIREWALL_UNITS) : null,
  });
}

// /etc/ufw/ufw.conf's ENABLED= → true or false, null if it can't be read.
function ufwConfigEnabled(readFile = fs.readFileSync) {
  try {
    const m = /^\s*ENABLED\s*=\s*"?(yes|no)"?\s*$/im.exec(readFile("/etc/ufw/ufw.conf", "utf8"));
    return m ? m[1].toLowerCase() === "yes" : null;
  } catch (_) {
    return null;
  }
}

// `systemctl is-active a b c` prints one state per unit, in order ("active",
// "inactive", "failed", ...; "inactive" for a unit that doesn't exist).
// → { unit: state }, or null when the output doesn't line up.
function parseSystemctlIsActive(stdout, units) {
  const lines = String(stdout || "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length !== units.length) return null;
  return Object.fromEntries(units.map((u, i) => [u, lines[i]]));
}

// What linuxFirewall read → facts.firewall. Pure, for the tests.
//   ufwInstalled, firewalldInstalled: booleans
//   ufwEnabled: UFW's ENABLED= setting, null if unread
//   services: { unit: state } from systemctl, null without systemd
// UFW is active when it is set to on and its service ran (on Arch, `ufw
// enable` without the service enabled is off after a reboot). nftables and
// iptables are listed only when their service is running: the tools are on
// nearly every system whether anything uses them or not.
function linuxFirewallFrom({ ufwInstalled, firewalldInstalled, ufwEnabled, services }) {
  const products = [];
  const state = (u) => (services ? services[u] === "active" : null);
  if (ufwInstalled) {
    // Ubuntu's ufw.service is active even with UFW off, so a running service
    // with the setting unread is unknown.
    let active = ufwEnabled;
    if (services && ufwEnabled !== false) active = !state("ufw") ? false : ufwEnabled === true ? true : null;
    products.push({ name: "UFW", active, detail: null });
  }
  if (firewalldInstalled) products.push({ name: "firewalld", active: state("firewalld"), detail: null });
  if (services) {
    if (state("nftables")) products.push({ name: "nftables", active: true, detail: null });
    if (state("iptables") || state("netfilter-persistent")) products.push({ name: "iptables", active: true, detail: null });
  }
  // Without systemd, a machine with no front end could still have rules
  // loaded some other way, so that is unknown rather than none.
  return { products, checked: services != null || products.length > 0 };
}

// Slow detections, fetched lazily after first paint: OS update status, the SSD
// flag (both hit slow Windows providers), the running-process scan and the
// firewall (a PowerShell on Windows). Returned
// together so the renderer merges them in a single re-render. Each is wrapped
// so one slow provider cannot strand the others.
async function detectDeferred() {
  const [updates, ssd, backgroundApps, graphics, firewall, appUpdates] = await Promise.all([
    probe(detectUpdates(), UNKNOWN_UPDATES, "deferred:updates"),
    probe(detectSsd(), null, "deferred:ssd"),
    probe(detectBackgroundApps(), { browserExtensions: 0, runningApps: [] }, "deferred:backgroundApps"),
    probe(detectDisplays(), [], "deferred:graphics"),
    probe(detectFirewall(), { products: [], checked: false }, "deferred:firewall"),
    probe(detectAppUpdates(), {}, "deferred:appUpdates"),
  ]);
  return { ...updates, ssd, backgroundApps, display: summarizeMonitors(graphics), firewall, appUpdates };
}

// The monitors, one entry each: { name, connection, builtin, main, width,
// height, refreshHz, sizeInches }.
//
// On GNOME with Wayland the X11 view systeminformation reads (through
// XWayland) is scaled: a 5120 × 1440 120 Hz monitor read 10240 × 2880 at
// 23.69 Hz, and a 1920 × 1200 panel 3072 × 1920. GNOME's own display service,
// Mutter, has the real modes, so it is asked first there. Hyprland (Omarchy's
// desktop) is asked next: systeminformation found no displays at all under it,
// and the card read "None found". Everywhere else, and whenever neither can
// answer, systeminformation's list is used.
async function detectDisplays() {
  const fromMutter = await mutterMonitors().catch(() => null);
  if (fromMutter && fromMutter.length) return fromMutter;
  const fromHyprland = await hyprlandMonitors().catch(() => null);
  if (fromHyprland && fromHyprland.length) return fromHyprland;
  return withoutXwaylandModes(monitorsFromGraphics(await si.graphics().catch(() => ({}))));
}

// `hyprctl monitors -j` in a Hyprland session. Resolves null anywhere else
// (not Linux, not Hyprland, no hyprctl).
async function hyprlandMonitors(env = process.env) {
  if (process.platform !== "linux" || !env.HYPRLAND_INSTANCE_SIGNATURE) return null;
  const hyprctl = findTool("/usr/bin/hyprctl", "/bin/hyprctl", "/usr/local/bin/hyprctl");
  if (!hyprctl) return null;
  const out = await runCmd(hyprctl, ["monitors", "-j"], { timeout: 3000 });
  return out ? parseHyprlandMonitors(out) : null;
}

// hyprctl's monitor list (JSON) → monitors. Each entry has the connector
// (`name`, "eDP-1"), `make` and `model`, and the mode it runs in: `width` and
// `height` in real pixels, before scaling, and `refreshRate` in Hz. Hyprland
// has no primary display, so none is marked main and the first listed leads.
// `physicalWidth` and `physicalHeight` are the panel's size in millimetres,
// from its EDID. A few displays (projectors, some TVs) report none or only an
// aspect ratio, so a diagonal under 5 inches reads as unknown.
// `description` and `serial` carry the monitor's serial number, which is never
// kept. A disabled monitor shows nothing and is left out.
function parseHyprlandMonitors(stdout) {
  let list;
  try {
    list = JSON.parse(String(stdout || "").trim());
  } catch (_) {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const text = (v) => (typeof v === "string" ? v.trim() : "");
  const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  return list
    .filter((m) => m && typeof m === "object" && !m.disabled)
    .map((m) => {
      const connector = text(m.name) || null;
      const builtin = /^(eDP|LVDS|DSI)/i.test(connector || "");
      const model = [text(m.make), text(m.model)].filter(Boolean).join(" ");
      return {
        name: builtin ? "Built-in display" : model || (connector ? `External display (${connector})` : "Display"),
        connection: connector,
        builtin,
        main: false,
        width: num(m.width),
        height: num(m.height),
        refreshHz: num(m.refreshRate),
        sizeInches: diagonalInches(num(m.physicalWidth), num(m.physicalHeight)),
      };
    });
}

// A panel's width and height in millimetres → its diagonal in whole inches,
// or null when unknown or implausible: under 5 inches (no size, or only an
// aspect ratio) or over 150 (no real display; a garbled EDID).
function diagonalInches(widthMm, heightMm) {
  if (!widthMm || !heightMm) return null;
  const inches = Math.round(Math.hypot(widthMm, heightMm) / 25.4);
  return inches >= 5 && inches <= 150 ? inches : null;
}

// In a Linux Wayland session, systeminformation's modes come from XWayland,
// which scales them (a 5120 × 1440 120 Hz monitor read 10240 × 2880 at
// 23.69 Hz). Without Mutter to ask (KDE, or GNOME's service unreachable),
// each monitor keeps its name and role, and its resolution and refresh rate
// read "Unknown" rather than a number that may be wrong.
function withoutXwaylandModes(monitors, env = process.env, platform = process.platform) {
  if (platform !== "linux" || !env.WAYLAND_DISPLAY) return monitors;
  return monitors.map((m) => ({ ...m, width: null, height: null, refreshHz: null }));
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
  // A GVariant string as gdbus prints it: single-quoted, or double-quoted
  // when it contains a ' ("Sam's monitor"), with backslash escapes either way.
  const STR = String.raw`(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")`;
  const unquote = (v) => v.slice(1, -1).replace(/\\(.)/g, "$1");
  const header = new RegExp(String.raw`\(\((${STR}), (${STR}), (${STR}), ${STR}\), \[`, "g");
  const starts = [];
  for (let m; (m = header.exec(text));) {
    starts.push({ at: m.index, connector: unquote(m[1]), vendor: unquote(m[2]), product: unquote(m[3]) });
  }
  // Which connector the primary logical monitor shows.
  const primaryMatch = new RegExp(String.raw`\(-?\d+, -?\d+, [\d.]+, (?:uint32 )?\d+, true, \[\((${STR})`).exec(text);
  const primary = primaryMatch ? unquote(primaryMatch[1]) : null;
  // The mode id's own form varies (interlaced "1920x1080i@60.000",
  // variable refresh "5120x1440@119.999+vrr"), so any string is taken, and
  // the numbers after it are what's read.
  const mode = new RegExp(String.raw`\(${STR}, (\d+), (\d+), ([\d.]+), [\d.]+, \[[^\]]*\], \{([^}]*)\}\)`, "g");
  const nameRe = new RegExp(String.raw`'display-name': <(${STR})>`);
  const monitors = [];
  starts.forEach((mon, i) => {
    const seg = text.slice(mon.at, i + 1 < starts.length ? starts[i + 1].at : text.length);
    let current = null;
    mode.lastIndex = 0;
    for (let m; (m = mode.exec(seg));) {
      if (/'is-current': <true>/.test(m[4])) {
        current = { width: Number(m[1]), height: Number(m[2]), refreshHz: Number(m[3]) };
        break;
      }
    }
    if (!current) return;
    const builtinMatch = /'is-builtin': <(true|false)>/.exec(seg);
    const nameMatch = nameRe.exec(seg);
    const builtin = builtinMatch ? builtinMatch[1] === "true" : /^(eDP|LVDS|DSI)/i.test(mon.connector);
    monitors.push({
      name: nameMatch ? unquote(nameMatch[1]) : builtin ? "Built-in display" : mon.connector,
      connection: mon.connector,
      builtin,
      main: mon.connector === primary,
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
      // Only a display the OS called the main one. The first stands in for
      // the single-display fields below, but isn't labelled main: Hyprland,
      // for one, has no main display.
      main: m === main && Boolean(m.main),
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
  if (process.platform === "win32") return windowsSsd();
  return si
    .diskLayout()
    .then((layout) => diskIsSsd((layout || []).map((d) => d.type)))
    .catch(() => null);
}

// ---- App updates: snap and Flatpak ------------------------------------------
//
// Apps installed as snaps or Flatpaks update outside the system package
// manager, so apt (or dnf, pacman) saying "none" can hide a pending browser
// update (the Ubuntu VM, 2026-10-06: apt 0, four snaps including Firefox).
// → { snap?, flatpak? }: a key only for a tool that is installed, holding
// the count, or null when the tool couldn't answer (offline, daemon down).
// Unlike the system check, both ask their store what's new: snapd sends it
// the installed snaps, as it does on its own several times a day, and
// Flatpak fetches each remote's index (owner's call, 2026-10-06).
async function detectAppUpdates() {
  const snap = findTool("/usr/bin/snap", "/snap/bin/snap");
  const flatpak = findTool("/usr/bin/flatpak");
  const [snapResult, flatpakResult] = await Promise.all([
    snap ? runCmdResult(snap, ["refresh", "--list"], { timeout: 25000 }) : null,
    flatpak ? runCmdResult(flatpak, ["remote-ls", "--updates", "--columns=ref"], { timeout: 25000 }) : null,
  ]);
  const out = {};
  if (snap) out.snap = parseSnapRefreshList(snapResult);
  if (flatpak) out.flatpak = parseFlatpakUpdates(flatpakResult);
  return out;
}

// `snap refresh --list` → how many snaps have an update, or null. With none
// it prints "All snaps up to date." (to stderr) and exits 0; otherwise a
// table headed "Name  Version  Rev ...". Offline or with snapd down it
// exits non-zero ("error: cannot refresh ...").
function parseSnapRefreshList(result) {
  if (!result || result.code !== 0) return null;
  if (/all snaps up to date/i.test(`${result.stdout}\n${result.stderr}`)) return 0;
  const lines = String(result.stdout || "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length || !/^name\s+version\b/i.test(lines[0])) return null;
  return lines.slice(1).filter((l) => /^[a-z0-9][a-z0-9-]*\s/.test(l)).length;
}

// `flatpak remote-ls --updates --columns=ref` → how many apps and runtimes
// have an update, or null. Each update is a ref ("app/org.mozilla.firefox/
// x86_64/stable"); an empty list with exit 0 is none.
function parseFlatpakUpdates(result) {
  if (!result || result.code !== 0) return null;
  return String(result.stdout || "").split("\n").map((l) => l.trim())
    .filter((l) => /^(app|runtime)\/[^/\s]+\/[^/\s]+\/\S+$/.test(l)).length;
}

// Each physical disk's MediaType, straight from Windows. systeminformation
// labels every Windows disk "HD" first and swaps in MediaType only when it
// can match the disk across two queries by serial number or name; a disk
// with a blank serial and different names in each (the Windows 11 VM's
// "Red Hat VirtIO" disk) kept the "HD" guess. MediaType is a number from
// CIM (0 Unspecified, 3 HDD, 4 SSD, 5 SCM); its name is accepted too.
const WINDOWS_DISK_SCRIPT =
  "$ErrorActionPreference='SilentlyContinue';" +
  "$r=@{ok=$false;types=@()};" +
  "try {" +
  "  $r.types = @(Get-PhysicalDisk -ErrorAction Stop | ForEach-Object { [string]$_.MediaType });" +
  "  $r.ok = $true" +
  "} catch {};" +
  "[pscustomobject]$r | ConvertTo-Json -Compress";

function windowsSsd() {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_DISK_SCRIPT],
      { timeout: 15000, windowsHide: true },
      (err, stdout) => resolve(err ? null : parseWindowsDiskTypes((stdout || "").trim())),
    );
  });
}

// WINDOWS_DISK_SCRIPT's JSON → diskIsSsd's answer, or null when the query
// failed or printed nothing usable.
function parseWindowsDiskTypes(stdout) {
  let r;
  try {
    r = JSON.parse(stdout || "");
  } catch (_) {
    return null;
  }
  if (!r || r.ok !== true) return null;
  const names = { 3: "HD", hdd: "HD", 4: "SSD", ssd: "SSD", 5: "SCM", scm: "SCM" };
  const types = (Array.isArray(r.types) ? r.types : [r.types])
    .map((t) => names[String(t).trim().toLowerCase()] || "Unspecified");
  return diskIsSsd(types);
}

// systeminformation's disk types → true (an SSD), false (only spinning
// disks) or null (unknown). Windows reports some disks' media type as
// "Unspecified" (virtual disks, some RAID controllers and USB enclosures),
// and systeminformation passes that on; calling those HDD was a guess.
// "SCM" is storage-class memory, faster than any SSD.
function diskIsSsd(types) {
  const list = (Array.isArray(types) ? types : []).map((t) => (typeof t === "string" ? t.trim() : ""));
  if (list.some((t) => /ssd|nvme|scm/i.test(t))) return true;
  if (list.length && list.every((t) => /^(hd|hdd)$/i.test(t))) return false;
  return null;
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
  if (process.platform === "darwin") return macUpdates();
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

// systeminformation's si.cpu() → the Processor card's speed. `speedMax` is the
// highest boost clock and `speed` the base clock; many machines report only
// the base. `ghzKind` says which one `ghz` is: the card shows "up to" the
// maximum, and no speed when only the base is known or neither is (ghz 0,
// ghzKind null). Reports and the AI scan still carry ghz as before.
function cpuSpeed(cpu) {
  const c = cpu || {};
  if (c.speedMax > 0) return { ghz: round1(c.speedMax), ghzKind: "max" };
  if (c.speed > 0) return { ghz: round1(c.speed), ghzKind: "base" };
  return { ghz: 0, ghzKind: null };
}

// The OS card's name, version and build. On Linux they come from os-release
// when it can be read, all three from the same file; a rolling release with no
// VERSION_ID (Arch) shows its BUILD_ID ("rolling") as the version. The build
// is left out when it only repeats the version. systeminformation's own
// fallback for an unknown release is a lowercase "unknown", which reads
// "Unknown" like every other card.
function osNameVersion(release, osInfo = {}, fallback = { type: os.type(), release: os.release() }) {
  const known = (v) => (typeof v === "string" && v && !/^unknown$/i.test(v) ? v : null);
  if (release && release.name) {
    const version = release.version || release.build || known(osInfo.release) || "Unknown";
    return { name: release.name, version, build: release.build && release.build !== version ? release.build : "" };
  }
  const version = known(osInfo.release) || fallback.release || "Unknown";
  const build = known(osInfo.build) || "";
  return {
    name: known(osInfo.distro) || fallback.type,
    version,
    // Windows' build is already the version's third part ("10.0.26300" and
    // "26300"), so showing it again said nothing new. macOS's ("23F79") isn't.
    build: build && !version.split(".").includes(build) ? build : "",
  };
}

// The distribution's name and version from os-release. /etc/os-release wins
// and /usr/lib/os-release is only the fallback, as the os-release spec says.
// systeminformation reads both and lets the second overwrite the first, so a
// distribution built on another one, which leaves its base's file in
// /usr/lib, showed up under its base's name: Omarchy as "Arch Linux 4.0.4",
// Arch's name with Omarchy's version. null when neither file can be read.
function linuxOsRelease(readFile = fs.readFileSync) {
  for (const file of ["/etc/os-release", "/usr/lib/os-release"]) {
    let text;
    try {
      text = readFile(file, "utf8");
    } catch (_) {
      continue;
    }
    const release = parseOsRelease(text);
    if (release.name) return release;
  }
  return null;
}

// os-release's KEY=value lines → { name, version, build }. NAME rather than
// PRETTY_NAME, which often has the version in it already ("Debian GNU/Linux
// 13 (trixie)"), so the card's "name version" would say it twice. Values
// follow shell quoting: a double-quoted value may escape \ " $ and `.
// Windows line endings are tolerated.
function parseOsRelease(text) {
  const values = {};
  for (const line of (text || "").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (/^"(?:[^"\\]|\\.)*"$/.test(v)) v = v.slice(1, -1).replace(/\\([\\"$`])/g, "$1");
    else if (/^'[^']*'$/.test(v)) v = v.slice(1, -1);
    values[m[1]] = v;
  }
  return { name: values.NAME || null, version: values.VERSION_ID || null, build: values.BUILD_ID || null };
}

// Pending updates on the three families this app targets: Debian/Ubuntu
// (apt), Fedora/RHEL (dnf) and Arch and its derivatives such as Omarchy
// (pacman). Each is asked to work from its existing metadata rather than
// refresh it, so this costs no network round-trip, no root and no lock.
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
    // Fedora Workstation checks for updates through GNOME Software, i.e.
    // PackageKit, which keeps its own cache: dnf's can be empty ("no cache
    // for repository", the Fedora 44 VM) while PackageKit's is current.
    // `pkcon -c -1` reads that cache only, offline, in a fraction of a second.
    const pkMeta = packageKitMetadataFiles();
    const pkcon = out == null && pkMeta.length ? findTool("/usr/bin/pkcon") : null;
    const pk = pkcon ? await runCmdResult(pkcon, ["-p", "-c", "-1", "get-updates"], { timeout: 25000 }) : null;
    return withKind({
      pendingUpdates: out != null ? parseDnfCheckUpdate(out) : parsePkconUpdates(pk),
      lastUpdateCheck: ageOf([
        "/var/cache/dnf/last_makecache", // dnf4 only
        [...repoMetadataFiles(), ...pkMeta], // dnf5, dnf4 without the stamp, and PackageKit: newest repo wins
      ]),
    });
  }
  const pacman = findTool("/usr/bin/pacman", "/bin/pacman");
  if (pacman) {
    // `pacman -Qu` lists what the last `pacman -Sy` found newer than what is
    // installed. Without synced databases there is nothing to compare, so the
    // count is unknown rather than 0.
    const dbs = pacmanSyncDbs();
    const result = dbs.length ? await runCmdResult(pacman, ["-Qu"]) : null;
    return withKind({
      pendingUpdates: pacmanPending(result),
      lastUpdateCheck: lastPacmanSync(dbs),
    });
  }
  return UNKNOWN_UPDATES;
}

const PACMAN_SYNC_DIR = "/var/lib/pacman/sync";
const PACMAN_LOG = "/var/log/pacman.log";

// The synced repository databases (core.db, extra.db, …).
function pacmanSyncDbs() {
  try {
    return fs.readdirSync(PACMAN_SYNC_DIR).filter((f) => f.endsWith(".db")).map((f) => path.join(PACMAN_SYNC_DIR, f));
  } catch (_) {
    return [];
  }
}

// When pacman last refreshed its package lists, worded as the cards do.
// pacman's log records each refresh; the databases' mtimes are only the
// fallback, since pacman gives a downloaded database the mirror's time for
// it rather than the time it was fetched.
function lastPacmanSync(dbs) {
  const synced = parsePacmanLastSync(readTail(PACMAN_LOG, 512 * 1024));
  const age = synced ? humanAge(synced.toISOString()) : null;
  if (age != null) return age === "just now" ? age : age + " ago";
  return ageOf([dbs]);
}

// The last `bytes` of a file as text, or "" if it can't be read. pacman's log
// is never rotated and grows for the life of the install.
function readTail(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    return buf.toString("utf8");
  } catch (_) {
    return "";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// The time of the last "synchronizing package lists" line in pacman's log
// ("[2026-09-29T00:26:42+0000] [PACMAN] synchronizing package lists"), or
// null. The offset is written without a colon, which Date doesn't parse
// reliably, so one is put in.
function parsePacmanLastSync(log) {
  const re = /^\[(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)([+-]\d\d):?(\d\d)\] \[PACMAN\] synchronizing package lists/gm;
  let last = null;
  for (let m; (m = re.exec(log || ""));) last = `${m[1]}${m[2]}:${m[3]}`;
  const date = last ? new Date(last) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

// `pacman -Qu`'s result ({ code, stdout, stderr }, or null if it couldn't run)
// → the pending count, or null when it can't be known. pacman exits 1 both
// when nothing is upgradable and on a real failure (an unreadable config or
// database), so exit 1 counts as "none pending" only when pacman printed no
// "error:" line. Otherwise a broken pacman would read as up to date.
function pacmanPending(result) {
  if (!result) return null;
  if (result.code === 0) return parsePacmanUpgrades(result.stdout);
  if (result.code === 1 && !/^error:/m.test(result.stderr || "") && !(result.stdout || "").trim()) return 0;
  return null;
}

// `pacman -Qu` lists "<package> <installed> -> <available>" per update. A
// package held back by IgnorePkg ends in "[ignored]" and won't be installed.
function parsePacmanUpgrades(stdout) {
  return (stdout || "").split("\n")
    .filter((l) => /^\S+\s+\S+\s+->\s+\S+/.test(l) && !/\[ignored\]\s*$/.test(l))
    .length;
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
// PackageKit's per-repository metadata, rewritten on each refresh:
// /var/cache/PackageKit/<release>/metadata/<repo>/repodata/repomd.xml.
function packageKitMetadataFiles(root = "/var/cache/PackageKit") {
  const files = [];
  let releases = [];
  try {
    releases = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch (_) {
    return files;
  }
  for (const release of releases) {
    const meta = path.join(root, release.name, "metadata");
    let repos = [];
    try {
      repos = fs.readdirSync(meta, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch (_) {
      continue;
    }
    for (const repo of repos) {
      const file = path.join(meta, repo.name, "repodata", "repomd.xml");
      if (exists(file)) files.push(file);
    }
  }
  return files;
}

// `pkcon -p get-updates` → how many updates, or null. Each update is a line
// under "Results:", an update kind and then the package and its repository:
// "Bug fix      NetworkManager-1:1.56.1-2.fc44.x86_64 (updates)". With none,
// it says so instead of listing any; pkcon exits 5 for "nothing to do".
function parsePkconUpdates(result) {
  if (!result || ![0, 5].includes(result.code)) return null;
  const text = String(result.stdout || "");
  if (/no updates/i.test(text)) return 0;
  const at = text.search(/^Results:/m);
  if (at < 0) return null;
  return text.slice(at).split("\n").slice(1)
    .filter((l) => /^\S.*\s{2,}\S+\s+\([^)]+\)\s*$/.test(l)).length;
}

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
// macOS records its last Software Update check, and how many recommended
// updates it found, in a preferences file anyone can read. Like apt's cached
// metadata, the count is as of that check: nothing is fetched here.
// Untested on a real Mac from the Linux machine.
async function macUpdates() {
  const out = await runCmd("/usr/bin/defaults", ["read", "/Library/Preferences/com.apple.SoftwareUpdate"]);
  return parseMacSoftwareUpdate(out);
}

// `defaults read`'s old-style plist ("LastSuccessfulDate = "2026-10-01
// 08:07:22 +0000";", "LastRecommendedUpdatesAvailable = 2;") → the updates
// shape. A missing key is unknown, never 0.
function parseMacSoftwareUpdate(stdout) {
  const text = stdout || "";
  const date = /LastSuccessfulDate\s*=\s*"?(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d)"?;/.exec(text);
  const count = /LastRecommendedUpdatesAvailable\s*=\s*(\d+);/.exec(text);
  const age = date ? humanAge(`${date[1]}T${date[2]}${date[3]}:${date[4]}`) : null;
  return {
    pendingUpdates: count ? Number(count[1]) : null,
    lastUpdateCheck: !age ? "Unknown" : age === "just now" ? age : `${age} ago`,
    lastUpdateKind: age ? "checked" : null,
  };
}

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
  let runningApps = [];
  try {
    const procs = await si.processes();
    runningApps = matchBackgroundApps((procs.list || []).map((p) => p.name));
  } catch (_) {
    /* leave empty */
  }
  return { browserExtensions: countBrowserExtensions(), runningApps };
}

// Each app's process names on Windows, macOS and Linux, lower case, without
// ".exe". Whole names only: matching a fragment named Chrome for any
// Electron app's chrome_crashpad_handler (VS Code runs one), and VS Code for
// Xcode. A helper process (Chrome's renderers, Steam's web helper) is only
// running while its main process is, so the main name is enough.
const BACKGROUND_APPS = {
  Zoom: ["zoom", "zoom.us"],
  "Microsoft Teams": ["teams", "ms-teams", "msteams", "microsoft teams", "microsoft teams (work or school)", "teams-for-linux"],
  Skype: ["skype", "skypeforlinux"],
  Webex: ["webex", "ciscowebexstart", "webexhost"],
  Discord: ["discord", "discordptb", "discordcanary"],
  Slack: ["slack"],
  Dropbox: ["dropbox"],
  OneDrive: ["onedrive"],
  Steam: ["steam"],
  Spotify: ["spotify"],
  Chrome: ["chrome", "google chrome", "google-chrome"],
  "Microsoft Edge": ["msedge", "microsoft edge"],
  Firefox: ["firefox", "firefox-bin", "firefox-esr"],
  "VS Code": ["code", "code - insiders", "visual studio code"],
};

// Process names → the known apps among them, in the list's order.
function matchBackgroundApps(names) {
  const running = new Set((names || [])
    .filter((n) => typeof n === "string")
    .map((n) => n.trim().toLowerCase().replace(/\.exe$/, "")));
  return Object.keys(BACKGROUND_APPS).filter((app) => BACKGROUND_APPS[app].some((n) => running.has(n)));
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
  // Sound sent to a monitor or TV over its video cable: PulseAudio's
  // "hdmi-stereo" profile, Windows' "NVIDIA/AMD High Definition Audio" and
  // "Intel(R) Display Audio" endpoints.
  if (/hdmi|displayport|display audio|(nvidia|amd) high definition audio/.test(s)) return "Display audio";
  // The computer's own sound: its speakers, or whatever is plugged into its
  // headphone jack (the two share one device).
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
  parsePacmanUpgrades,
  parsePacmanLastSync,
  parseOsRelease,
  linuxOsRelease,
  cpuSpeed,
  pacmanPending,
  matchBackgroundApps,
  parseWindowsAvResult,
  WINDOWS_AV_SCRIPT,
  parseWindowsFirewall,
  WINDOWS_FIREWALL_SCRIPT,
  parseMacFirewall,
  macFirewall,
  ufwConfigEnabled,
  parseSystemctlIsActive,
  linuxFirewallFrom,
  withMacBuiltIn,
  osNameVersion,
  // The Linux plumbing. Exported so the choices that are easy to revert by
  // accident — the loader variables a spawned tool must not inherit, which
  // stamp file outranks which — are pinned by a test rather than by a comment.
  toolEnv,
  findTool,
  ageOf,
  runningProcessNames,
  parseWindowsUpdates,
  parseMacSoftwareUpdate,
  diskIsSsd,
  parseSnapRefreshList,
  parseFlatpakUpdates,
  parsePkconUpdates,
  packageKitMetadataFiles,
  parseWindowsDiskTypes,
  WINDOWS_DISK_SCRIPT,
  parseDefaultAudio,
  detectMacAv,
  isVirtualInterface,
  isLinuxWlan,
  summarizeDisplays,
  summarizeMonitors,
  monitorsFromGraphics,
  parseMutterState,
  parseHyprlandMonitors,
  withoutXwaylandModes,
  parseResolvectlDns,
  detectAudio,
  audioNames,
  parseWpctlInspect,
};
