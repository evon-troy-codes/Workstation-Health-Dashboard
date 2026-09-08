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
let APP_VERSION = "1.0.0";
try {
  APP_VERSION = require("../../package.json").version || APP_VERSION;
} catch (_) {
  /* keep default */
}

// Recommended CPU families (substring match, case-insensitive). Edit this list
// to whatever spec you want the "approved" checks to compare against.
const APPROVED_CPU = ["Apple M", "Core i5", "Core i7", "Core i9", "Ryzen 5", "Ryzen 7", "Ryzen 9"];

const GB = 1024 * 1024 * 1024;
const round1 = (n) => Math.round(n * 10) / 10;

function cpuApproved(brand, list) {
  const b = (brand || "").toLowerCase();
  return list.some((p) => b.includes(p.toLowerCase()));
}

async function collectFacts() {
  // Everything fast runs in one parallel batch. si.diskLayout() (SSD flag) is
  // deliberately excluded — it hits a ~7s Windows storage provider, so the
  // SSD flag is resolved lazily alongside OS updates (see detectDeferred).
  const [cpu, mem, memLayout, osInfo, fsSize, net, gateway,
         battery, graphics, audio, defIfaceName,
         antivirus, background] = await Promise.all([
    si.cpu(), si.mem(), si.memLayout(), si.osInfo(), si.fsSize(),
    si.networkInterfaces(), si.networkGatewayDefault(),
    si.battery(), si.graphics(), si.audio(),
    si.networkInterfaceDefault(),
    detectAntivirus(), detectBackgroundApps(),
  ]).catch((e) => { throw new Error("systeminformation failed: " + e.message); });

  // --- default network interface ---
  const iface = (Array.isArray(net) ? net : [net]).find((n) => n.iface === defIfaceName) || {};
  const isWired = /ethernet|wired|thunderbolt|usb/i.test(iface.type || "") ||
                  (!/wifi|wireless|wi-fi/i.test(iface.type || "") && (iface.speed || 0) >= 100);

  // --- disk (primary volume); ssd flag filled in lazily (null = checking) ---
  const primaryFs = (fsSize || []).sort((a, b) => b.size - a.size)[0] || {};

  // --- display ---
  const displays = (graphics && graphics.displays) || [];
  const main = displays.find((d) => d.main) || displays[0] || {};
  const external = displays.some((d) => !d.main);
  const ext = displays.find((d) => !d.main);

  // --- memory type ---
  const memType = (memLayout && memLayout[0] && memLayout[0].type) || "";

  const inputName = pickAudio(audio, "in");

  const facts = {
    hostname: os.hostname(),
    user: os.userInfo().username,
    uptime: humanUptime(os.uptime()),
    appVersion: APP_VERSION,

    cpu: {
      model: `${cpu.manufacturer} ${cpu.brand}`.trim(),
      cores: cpu.cores,
      perfCores: cpu.performanceCores || cpu.physicalCores || cpu.cores,
      effCores: cpu.efficiencyCores || 0,
      ghz: round1(cpu.speedMax || cpu.speed || 0),
      family: cpu.manufacturer,
      arch: os.arch(),
      series: cpu.brand,
      approved: cpuApproved(cpu.brand, APPROVED_CPU),
    },
    machineType: `${osInfo.manufacturer || ""} ${osInfo.model || os.platform()}`.trim(),
    ram: {
      totalGB: Math.round(mem.total / GB),
      freeGB: round1(mem.available / GB),
      type: memType,
      pressure: ramPressure(mem),
      approved: mem.total / GB >= 16,
    },
    disk: {
      totalGB: Math.round(primaryFs.size / GB) || 0,
      freeGB: Math.round(primaryFs.available / GB) || 0,
      usedPercent: Math.round(primaryFs.use || 0),
      ssd: null, // resolved lazily (slow Windows storage provider)
      approved: (primaryFs.available / GB) >= 50,
    },
    display: {
      resolution: main.resolutionX ? `${main.resolutionX} × ${main.resolutionY}` : "Unknown",
      external,
      externalSize: ext && ext.sizeX ? `${Math.round(Math.hypot(ext.sizeX, ext.sizeY) / 25.4)}"` : null,
      externalConnection: ext ? (ext.connection || "External") : null,
      approved: external,
    },
    os: {
      name: osInfo.distro || os.type(),
      version: osInfo.release,
      build: osInfo.build || "",
      lastUpdateCheck: "Checking…", // filled in by the lazy get-updates call
      pendingUpdates: null, // number once the lazy update check resolves
      approved: osApproved(osInfo),
    },
    network: {
      interface: iface.iface || defIfaceName || "Unknown",
      type: iface.type || (isWired ? "Wired" : "Wireless"),
      linkSpeed: iface.speed ? `${iface.speed >= 1000 ? iface.speed / 1000 + " Gbps" : iface.speed + " Mbps"}` : "Unknown",
      mtu: iface.mtu || null,
      mac: iface.mac || "",
      ipv4: iface.ip4 || "",
      ipv6Disabled: !iface.ip6,
      gateway: gateway || "",
      dns: getDnsServers(osInfo),
      ssid: isWired ? null : (iface.ssid || null),
      isWired,
      approved: isWired,
    },
    // Bandwidth is a measurement, not a static fact — filled in once the
    // renderer's speed test completes.
    bandwidth: {
      downMbps: null, upMbps: null, ping: null, jitter: null,
      measuredAt: "not yet run", approvedDown: false, approvedUp: false,
    },
    vpn: detectVpn(net),
    antivirus,
    backgroundApps: background,
    power: {
      onBattery: battery.hasBattery ? !battery.acConnected : false,
      batteryLevel: battery.hasBattery ? battery.percent : 100,
      plugged: battery.hasBattery ? battery.acConnected : true,
      lidClosed: null, // not reliably detectable across platforms
    },
    audio: {
      output: pickAudio(audio, "out"),
      input: inputName,
      isWired: /usb|wired/i.test(JSON.stringify(audio || [])),
      headsetConnected: (audio || []).length > 0,
      headsetClass: classifyHeadset(audio),
      sampleRate: null, // not exposed by the OS without device-specific APIs
    },
  };

  return facts;
}

// Antivirus detection. systeminformation has no AV API, so this queries the
// platform directly: Windows Security Center (where McAfee/Norton/etc register)
// on Windows, and known app bundles on macOS. Returns the FACTS.antivirus shape:
//   { products: [{ name, version, running, updated, definitionsAge }], approved }
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
          resolve({ products, approved: products.some((p) => p.running) });
        },
      );
    });
  }

  if (plat === "darwin") {
    const fs = require("fs");
    const path = require("path");
    const apps = [
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
    const products = apps
      .filter((p) => fs.existsSync(p))
      .map((p) => ({
        name: path.basename(p, ".app"),
        version: null,
        running: true,
        updated: true,
        definitionsAge: null,
      }));
    return Promise.resolve({ products, approved: products.length > 0 });
  }

  return Promise.resolve({ products: [], approved: false });
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
  if (sec < 86400) return Math.round(sec / 3600) + " hours";
  return Math.round(sec / 86400) + " days";
}

// Slow detections, fetched lazily after first paint: OS update status and the
// SSD flag (both hit slow Windows providers). Returned together so the renderer
// merges once and recomputes the verdict once.
async function detectDeferred() {
  const [updates, ssd] = await Promise.all([detectUpdates(), detectSsd()]);
  return { ...updates, ssd };
}

// Is the primary disk an SSD? si.diskLayout() is the reliable source but slow.
function detectSsd() {
  return si
    .diskLayout()
    .then((layout) => (layout || []).some((d) => /ssd|nvme/i.test(d.type || "")))
    .catch(() => null);
}

// OS update status. Windows: an offline WU search (fast — uses the last synced
// metadata, no network round-trip) for the pending count, plus the agent's last
// successful detect time from the registry. Other platforms return unknown.
function detectUpdates() {
  if (process.platform !== "win32") {
    return Promise.resolve({ pendingUpdates: null, lastUpdateCheck: "Unknown" });
  }
  const ps =
    "$ErrorActionPreference='SilentlyContinue';" +
    "$r=[ordered]@{pending=$null;lastCheck=$null};" +
    "try{ $s=(New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher(); $s.Online=$false; $r.pending=($s.Search('IsInstalled=0 and IsHidden=0').Updates).Count }catch{};" +
    "$lc=(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\Results\\Detect').LastSuccessTime;" +
    "if(-not $lc){ $lc=(Get-HotFix | Where-Object InstalledOn | Sort-Object InstalledOn -Descending | Select-Object -First 1).InstalledOn };" +
    "if($lc){$r.lastCheck=(Get-Date $lc -Format 's')};" +
    "[pscustomobject]$r | ConvertTo-Json -Compress";
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
      { timeout: 25000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve({ pendingUpdates: null, lastUpdateCheck: "Unknown" });
        let o = {};
        try {
          o = JSON.parse((stdout || "").trim()) || {};
        } catch (_) {
          /* ignore */
        }
        const pending = typeof o.pending === "number" ? o.pending : null;
        const age = humanAge(o.lastCheck);
        resolve({
          pendingUpdates: pending,
          lastUpdateCheck: age ? age + " ago" : "Unknown",
        });
      },
    );
  });
}

// Apps that compete for bandwidth/CPU. Real running processes matched against
// a list of common bandwidth-heavy apps, plus a count of installed browser
// extensions (another common source of background resource use).
async function detectBackgroundApps() {
  const KNOWN = {
    zoom: "Zoom", teams: "Microsoft Teams", "ms-teams": "Microsoft Teams",
    skype: "Skype", webex: "Webex", discord: "Discord", slack: "Slack",
    dropbox: "Dropbox", onedrive: "OneDrive", steam: "Steam",
    spotify: "Spotify", chrome: "Chrome", code: "VS Code",
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

// DNS servers actually configured for resolution.
function getDnsServers(osInfo) {
  try {
    const servers = dns.getServers().filter((s) => s && !s.startsWith("fe80"));
    if (servers.length) return servers;
  } catch (_) {
    /* fall through */
  }
  return osInfo.servers || [];
}

function ramPressure(mem) {
  const ratio = mem.total ? mem.available / mem.total : 1;
  if (ratio < 0.1) return "High";
  if (ratio < 0.25) return "Moderate";
  return "Normal";
}

// Heuristic VPN detection: look for an *active* tunnel interface (up + has an
// IPv4) whose name matches a known VPN client / tunnel driver. Requiring an
// active IPv4 avoids the always-present-but-idle WAN Miniport adapters on
// Windows and the idle utun interfaces on macOS.
function detectVpn(net) {
  const list = Array.isArray(net) ? net : [net];
  const VPN_RE =
    /\b(vpn|tun\d*|tap\d*|wg\d*|wireguard|nordlynx|tailscale|utun\d*|anyconnect|cisco\s*secure\s*client|openvpn|globalprotect|pangp|forticlient|zscaler|expressvpn|protonvpn|mullvad)\b/i;
  const active = list.find((n) => {
    const state = (n.operstate || "").toLowerCase();
    const up = state === "up" || state === "";
    const name = `${n.iface || ""} ${n.ifaceName || ""}`;
    return up && !!n.ip4 && VPN_RE.test(name);
  });
  if (active) {
    return { detected: true, name: active.ifaceName || active.iface, approved: true };
  }
  return { detected: false, name: null, approved: true };
}

function osApproved(osInfo) {
  const p = (osInfo.platform || "").toLowerCase();
  const rel = parseFloat(osInfo.release) || 0;
  if (p.includes("win")) return rel >= 10;        // refine: Win 11 build ≥ 22000
  if (p.includes("darwin") || p.includes("mac")) return rel >= 13;
  return true;
}

function pickAudio(audio, dir) {
  const list = (audio || []).filter((a) => dir === "out" ? /out|speaker|headphone/i.test(a.type || "") : /in|mic/i.test(a.type || ""));
  const d = (list[0] || (audio || [])[0] || {});
  return d.name || "System default";
}

function classifyHeadset(audio) {
  const s = JSON.stringify(audio || []).toLowerCase();
  if (/airpod|bluetooth|wireless/.test(s)) return "Bluetooth";
  if (/usb|headset|plantronics|jabra|logitech|sennheiser/.test(s)) return "USB headset";
  return "Built-in";
}

function humanUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  if (d > 0) return `${d} day${d !== 1 ? "s" : ""}, ${h} hour${h !== 1 ? "s" : ""}`;
  const m = Math.floor((sec % 3600) / 60);
  return `${h} hour${h !== 1 ? "s" : ""}, ${m} min`;
}

module.exports = { collectFacts, detectDeferred };
