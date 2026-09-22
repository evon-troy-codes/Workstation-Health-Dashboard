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
let APP_VERSION = "1.1.0";
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
function probe(promise, fallback) {
  return Promise.resolve(promise).then(
    (v) => (v == null ? fallback : v),
    () => fallback,
  );
}

async function collectFacts() {
  // Everything fast runs in one parallel batch. Deliberately excluded and
  // resolved lazily instead (see detectDeferred): si.diskLayout() (SSD flag,
  // ~7s Windows storage provider), the OS update check, and si.processes(),
  // which is among the slowest calls on Windows.
  const [cpu, mem, memLayout, osInfo, system, fsSize, net, gateway,
         battery, graphics, audio, defIfaceName,
         antivirus, defaultAudio, dnsServers] = await Promise.all([
    probe(si.cpu(), {}), probe(si.mem(), {}), probe(si.memLayout(), []),
    probe(si.osInfo(), {}), probe(si.system(), {}), probe(si.fsSize(), []),
    probe(si.networkInterfaces(), []), probe(si.networkGatewayDefault(), ""),
    probe(si.battery(), {}), probe(si.graphics(), {}), probe(si.audio(), []),
    probe(si.networkInterfaceDefault(), ""),
    probe(detectAntivirus(), { products: [] }), probe(detectDefaultAudio(), null),
    probe(detectDnsServers(), []),
  ]);

  // --- default network interface ---
  const iface = (Array.isArray(net) ? net : [net]).find((n) => n.iface === defIfaceName) || {};
  // A full-tunnel VPN owns the default route, and is neither wired nor Wi-Fi.
  const isVirtual = isVirtualInterface(iface);
  const isWired = !isVirtual && (
    /ethernet|wired|thunderbolt|usb/i.test(iface.type || "") ||
    (!/wifi|wireless|wi-fi/i.test(iface.type || "") && (iface.speed || 0) >= 100));

  // --- disk (system volume); ssd flag filled in lazily (null = checking) ---
  const primaryFs = pickPrimaryFs(fsSize);

  // --- display ---
  const displays = (graphics && graphics.displays) || [];
  const main = displays.find((d) => d.main) || displays[0] || {};
  const externals = displays.filter(isExternalDisplay);
  const external = externals.length > 0;
  const ext = externals[0];

  // --- memory type ---
  const memType = (memLayout && memLayout[0] && memLayout[0].type) || "";

  // Prefer the real endpoint names; fall back to the driver list off Windows.
  const outputName = (defaultAudio && defaultAudio.output) || pickAudio(audio, "out");
  const inputName = (defaultAudio && defaultAudio.input) || pickAudio(audio, "in");
  const headsetClass = classifyHeadset(outputName);

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
    display: {
      resolution: main.resolutionX ? `${main.resolutionX} × ${main.resolutionY}` : "Unknown",
      external,
      // sizeX/sizeY come back in centimetres, not millimetres.
      externalSize: ext && ext.sizeX ? `${Math.round(Math.hypot(ext.sizeX, ext.sizeY) / 2.54)}"` : null,
      externalConnection: ext ? (ext.connection || "External") : null,
    },
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
      type: interfaceType(iface.type, isWired, isVirtual),
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

function detectDefaultAudio() {
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

  return Promise.resolve({ products: [] });
}

// macOS has no Security Center, so this finds known AV app bundles. A bundle
// on disk says the product is installed, not that it is running or current,
// so both stay null rather than reporting a check that never happened.
function detectMacAv(exists = fs.existsSync) {
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
    .filter((p) => exists(p))
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
  if (sec < 0) return "just now";
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
  const [updates, ssd, backgroundApps] = await Promise.all([
    probe(detectUpdates(), UNKNOWN_UPDATES),
    probe(detectSsd(), null),
    probe(detectBackgroundApps(), { browserExtensions: 0, runningApps: [] }),
  ]);
  return { ...updates, ssd, backgroundApps };
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
    // humanAge says "just now" for a time in the future (clock skew), which
    // must not become "just now ago".
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
    const upstream = await new Promise((resolve) => {
      execFile("resolvectl", ["dns"], { timeout: 5000 }, (err, stdout) =>
        resolve(err ? [] : parseResolvectlDns(stdout)));
    });
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
function interfaceType(type, isWired, isVirtual = false) {
  if (isVirtual) return "Virtual";
  if (!type) return isWired ? "Wired" : "Wireless";
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

// Interface names of VPN clients and tunnel drivers.
const VPN_RE =
  /\b(vpn|tun\d*|tap\d*|wg\d*|wireguard|nordlynx|tailscale|utun\d*|anyconnect|cisco\s*secure\s*client|openvpn|globalprotect|pangp|forticlient|zscaler|expressvpn|protonvpn|mullvad)\b/i;

const ifaceNames = (n) => `${n.iface || ""} ${n.ifaceName || ""}`;

// Is this interface a tunnel rather than a physical link? Linux reports
// "virtual"; elsewhere only the name gives it away.
function isVirtualInterface(iface) {
  if (!iface) return false;
  return /virtual/i.test(iface.type || "") || VPN_RE.test(ifaceNames(iface));
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
function classifyHeadset(outputName) {
  const s = (outputName || "").toLowerCase();
  if (/airpod|bluetooth|wireless|hands-?free|a2dp/.test(s)) return "Bluetooth";
  if (/usb/.test(s)) return "USB headset";
  if (/\bstereo\)?$/.test(s)) return "Bluetooth";
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
  parseWindowsUpdates,
  parseDefaultAudio,
  detectMacAv,
  isVirtualInterface,
  parseResolvectlDns,
};
