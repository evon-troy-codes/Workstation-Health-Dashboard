// ═══════════════════════════════════════════════════════
//  CONFIGURATION — fill in before deploying
// ═══════════════════════════════════════════════════════
const CONFIG = {
  thresholds: {
    downloadMbps: 100,
    uploadMbps: 10,
    ramGB: 14,
    ramGBAmd: 10,
    diskFreeGB: 50,
    cpuCores: 4,
    cpuGHz: 2.0,
  },
  requiredOS: "Windows 11",

  emailjs: {
    publicKey: "k4E4C5-tO2FG8PFmB",
    serviceId: "service_wz5mwq8",
    templateId: "template_vgggpq5",
  },
};

const MAC_VERSION_NAMES = { 13: "Ventura", 14: "Sonoma", 15: "Sequoia" };

function isMacPlatform() {
  return /macintosh|mac os x/i.test(navigator.userAgent);
}

// ═══════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════
let sysData = {};
let speedRes = { download: null, upload: null };
let userInfo = {};

// ═══════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════
(function init() {
  if (isMacPlatform()) {
    document.getElementById("steps-windows").style.display = "none";
    document.getElementById("steps-mac").style.display = "";
  }

  const p = new URLSearchParams(window.location.search);
  if (p.get("syscheck") === "1") {
    sysData = {
      cpu: decodeURIComponent(p.get("cpu") || ""),
      cores: parseInt(p.get("cores") || "0"),
      speedMHz: parseInt(p.get("speed") || "0"),
      ramGB: parseFloat(p.get("ramGB") || "0"),
      os: decodeURIComponent(p.get("os") || ""),
      build: p.get("build") || "",
      diskFree: parseFloat(p.get("diskFree") || "0"),
      av: decodeURIComponent(p.get("av") || ""),
      usbHeadset: decodeURIComponent(p.get("usbHeadset") || ""),
      defaultMic: decodeURIComponent(p.get("defaultMic") || ""),
    };
    show("screen-info");
  } else {
    show("screen-landing");
  }
})();

function show(id) {
  document
    .querySelectorAll(".screen")
    .forEach((s) => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  window.scrollTo(0, 0);
}

// ═══════════════════════════════════════════════════════
//  DOWNLOAD CHECKER (.bat with Base64-encoded PowerShell)
//
//  Encoding the PS script as UTF-16LE Base64 and passing
//  it via -EncodedCommand is the most reliable way to run
//  PowerShell from a .bat file — no polyglot tricks, no
//  escaping issues, no -File path problems.
// ═══════════════════════════════════════════════════════
function downloadScript() {
  if (isMacPlatform()) {
    downloadMacScript();
    return;
  }
  const baseUrl = window.location.href.split("?")[0];

  const psLines = [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$baseUrl = "' + baseUrl + '"',
    "",
    "# CPU",
    "$cpu      = Get-CimInstance Win32_Processor | Select-Object -First 1",
    '$cpuName  = ($cpu.Name -replace "\\s+", " ").Trim()',
    "$cpuCores = $cpu.NumberOfCores",
    "$cpuSpeed = $cpu.MaxClockSpeed",
    "",
    "# RAM",
    "$ramBytes = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory",
    "$ramGB    = [math]::Round($ramBytes / 1GB, 1)",
    "",
    "# OS",
    "$osInfo    = Get-CimInstance Win32_OperatingSystem",
    "$osCaption = $osInfo.Caption.Trim()",
    "$osBuild   = $osInfo.BuildNumber",
    "",
    "# Disk (C: free space)",
    "$diskFreeGB = 0",
    "try {",
    "    $d = Get-PSDrive C -ErrorAction Stop",
    "    $diskFreeGB = [math]::Round($d.Free / 1GB, 1)",
    "} catch {",
    "    try {",
    "        $d = Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='C:'\"",
    "        $diskFreeGB = [math]::Round($d.FreeSpace / 1GB, 1)",
    "    } catch {}",
    "}",
    "",
    "# Antivirus",
    '$avName = "None detected"',
    "try {",
    "    $avList = Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction Stop",
    "    if ($avList) {",
    '        $p = $avList | Where-Object { $_.displayName -notmatch "Windows Defender|Microsoft Defender" } | Select-Object -First 1',
    "        $avName = if ($p) { $p.displayName } else { ($avList | Select-Object -First 1).displayName }",
    "    }",
    '} catch { $avName = "Could not detect" }',
    "",
    "# USB Headset & Default Microphone",
    '$usbHeadset = "None detected"',
    '$defaultMic = "None detected"',
    "try {",
    "    $allUsb = Get-CimInstance Win32_PnPEntity -ErrorAction Stop | Where-Object {",
    "        $_.DeviceID -match '^USB' -and $_.Status -eq 'OK'",
    "    }",
    "    # Exclude cameras/webcams so their built-in mics don't count as a headset",
    "    $nonCamera = $allUsb | Where-Object { $_.PNPClass -notmatch 'Camera|Image' -and $_.Name -notmatch 'Camera|Webcam|Web Cam|HD Cam' -and $_.Service -notmatch 'usbvideo' }",
    "    # USB audio devices: match by audio PNPClass, by name, or by the USB audio class driver service (catches vendor-named devices like 'Poly BW8225')",
    "    $usbAudio = $nonCamera | Where-Object { $_.PNPClass -match 'AudioEndpoint|MEDIA|Audio' -or $_.Service -match 'usbaudio|USBAUDIO' -or $_.Name -match 'Audio|Headset|Headphone|Microphone|Mic|Speaker' }",
    "    if ($usbAudio) {",
    "        $headset = $usbAudio | Where-Object { $_.Name -notmatch 'Microphone|Mic' } | Select-Object -First 1",
    "        if ($headset) { $usbHeadset = $headset.Name }",
    "        else { $usbHeadset = ($usbAudio | Select-Object -First 1).Name }",
    "    }",
    "    $usbMic = $usbAudio | Where-Object { $_.Name -match 'Microphone|Mic' } | Select-Object -First 1",
    "    if ($usbMic) { $defaultMic = $usbMic.Name }",
    "    elseif ($usbAudio) { $defaultMic = ($usbAudio | Select-Object -First 1).Name }",
    "} catch {}",
    "",
    "function UE($s) { return [Uri]::EscapeDataString($s) }",
    "",
    '$q  = "syscheck=1"',
    '$q += "&cpu="      + (UE $cpuName)',
    '$q += "&cores="    + $cpuCores',
    '$q += "&speed="    + $cpuSpeed',
    '$q += "&ramGB="    + $ramGB',
    '$q += "&os="       + (UE $osCaption)',
    '$q += "&build="    + $osBuild',
    '$q += "&diskFree=" + $diskFreeGB',
    '$q += "&av="       + (UE $avName)',
    '$q += "&usbHeadset=" + (UE $usbHeadset)',
    '$q += "&defaultMic=" + (UE $defaultMic)',
    "",
    'Start-Process ($baseUrl + "?" + $q)',
    "Start-Sleep -Seconds 2",
  ];

  const ps = psLines.join("\r\n");

  // Encode as UTF-16LE Base64 — required by PowerShell -EncodedCommand
  const bytes = new Uint8Array(ps.length * 2);
  for (let i = 0; i < ps.length; i++) {
    bytes[i * 2] = ps.charCodeAt(i) & 0xff;
    bytes[i * 2 + 1] = (ps.charCodeAt(i) >> 8) & 0xff;
  }
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  const encoded = btoa(binary);

  const bat =
    "@echo off\r\npowershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand " +
    encoded +
    "\r\n";

  const blob = new Blob([bat], { type: "application/octet-stream" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "ASC_Checker.bat";
  a.click();
  URL.revokeObjectURL(a.href);
}

function downloadMacScript() {
  const baseUrl = window.location.href.split("?")[0];

  const lines = [
    "#!/bin/bash",
    "# Make ourselves executable so double-click works next time",
    'chmod +x "$0" 2>/dev/null',
    "",
    'BASE_URL="' + baseUrl + '"',
    "",
    "# CPU name",
    "CPU_NAME=$(sysctl -n machdep.cpu.brand_string 2>/dev/null)",
    'if [ -z "$CPU_NAME" ]; then',
    "  CPU_NAME=$(system_profiler SPHardwareDataType 2>/dev/null | awk -F': ' '/Chip/{gsub(/^[[:space:]]+/,\"\",$2); print $2; exit}')",
    "fi",
    '[ -z "$CPU_NAME" ] && CPU_NAME="Unknown"',
    "",
    "# CPU cores and speed",
    "CPU_CORES=$(sysctl -n hw.physicalcpu 2>/dev/null || echo 0)",
    "CPU_SPEED_HZ=$(sysctl -n hw.cpufrequency 2>/dev/null || echo 0)",
    "CPU_SPEED_MHZ=$(( CPU_SPEED_HZ / 1000000 ))",
    "",
    "# RAM",
    "RAM_BYTES=$(sysctl -n hw.memsize 2>/dev/null || echo 0)",
    'RAM_GB=$(awk "BEGIN{printf \\"%.1f\\", $RAM_BYTES/1073741824}")',
    "",
    "# OS",
    'OS_NAME=$(sw_vers -productName 2>/dev/null || echo "macOS")',
    'OS_VER=$(sw_vers -productVersion 2>/dev/null || echo "")',
    'OS_FULL="${OS_NAME} ${OS_VER}"',
    'OS_BUILD=$(sw_vers -buildVersion 2>/dev/null || echo "")',
    "",
    "# Disk (/ free space)",
    "DISK_FREE_GB=$(df -k / 2>/dev/null | tail -1 | awk '{printf \"%.1f\", $4/1048576}')",
    '[ -z "$DISK_FREE_GB" ] && DISK_FREE_GB=0',
    "",
    "# Antivirus",
    'AV_NAME="None detected"',
    'for av_path in "/Applications/Malwarebytes.app" "/Applications/Norton 360.app" "/Applications/Bitdefender Antivirus for Mac.app" "/Applications/ESET Endpoint Antivirus.app" "/Applications/Kaspersky Internet Security.app" "/Applications/Sophos Home.app" "/Applications/Webroot SecureAnywhere.app" "/Applications/CrowdStrike Falcon.app" "/Applications/SentinelOne.app"',
    "do",
    '  if [ -d "$av_path" ]; then',
    '    AV_NAME=$(basename "$av_path" .app)',
    "    break",
    "  fi",
    "done",
    "",
    "# USB Headset & Default Microphone",
    'USB_HEADSET="None detected"',
    'DEFAULT_MIC="None detected"',
    'USB_AUDIO=$(system_profiler SPUSBDataType 2>/dev/null | grep -i "audio\\|headset\\|headphone" | head -1 | sed "s/^[[:space:]]*//" | sed "s/:$//")',
    'if [ -n "$USB_AUDIO" ]; then',
    '  USB_HEADSET="$USB_AUDIO"',
    "fi",
    'AUDIO_INPUT=$(system_profiler SPAudioDataType 2>/dev/null | awk "/Input/,/Default Input Device/{print}" | grep "Default Input Device" | awk -F": " "{print \\$2}" | sed "s/^[[:space:]]*//")',
    'if [ -n "$AUDIO_INPUT" ]; then',
    '  DEFAULT_MIC="$AUDIO_INPUT"',
    'elif [ -n "$USB_AUDIO" ]; then',
    '  DEFAULT_MIC="$USB_AUDIO"',
    "fi",
    "",
    "# URL encode",
    'UE() { python3 -c "import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1],safe=\'\'))" "$1"; }',
    "",
    'Q="syscheck=1"',
    'Q="${Q}&cpu=$(UE "$CPU_NAME")"',
    'Q="${Q}&cores=${CPU_CORES}"',
    'Q="${Q}&speed=${CPU_SPEED_MHZ}"',
    'Q="${Q}&ramGB=${RAM_GB}"',
    'Q="${Q}&os=$(UE "$OS_FULL")"',
    'Q="${Q}&build=${OS_BUILD}"',
    'Q="${Q}&diskFree=${DISK_FREE_GB}"',
    'Q="${Q}&av=$(UE "$AV_NAME")"',
    'Q="${Q}&usbHeadset=$(UE "$USB_HEADSET")"',
    'Q="${Q}&defaultMic=$(UE "$DEFAULT_MIC")"',
    "",
    'open "${BASE_URL}?${Q}"',
  ];

  const sh = lines.join("\n");
  const blob = new Blob([sh], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "ASC_Checker.command";
  a.click();
  URL.revokeObjectURL(a.href);
}

// ═══════════════════════════════════════════════════════
//  SPEED TEST
// ═══════════════════════════════════════════════════════
function startSpeedTest(e) {
  e.preventDefault();
  userInfo = {
    firstName: document.getElementById("firstName").value.trim(),
    lastName: document.getElementById("lastName").value.trim(),
    email: document.getElementById("userEmail").value.trim(),
  };
  show("screen-testing");
  runChecks();
}

async function runChecks() {
  await sleep(300);
  setTest("sys", "done", "Collected ✓");

  setTest("dl", "running", "Testing…");
  try {
    speedRes.download = await measureDownload();
    setTest("dl", "done", speedRes.download.toFixed(1) + " Mbps");
  } catch {
    speedRes.download = 0;
    setTest("dl", "done", "Test failed");
  }

  setTest("ul", "running", "Testing…");
  try {
    speedRes.upload = await measureUpload();
    setTest("ul", "done", speedRes.upload.toFixed(1) + " Mbps");
  } catch {
    speedRes.upload = 0;
    setTest("ul", "done", "Test failed");
  }

  await sleep(600);
  showResults();
}

function setTest(key, state, text) {
  document.getElementById("tstatus-" + key).textContent = text;
  const spinner = document.getElementById("tspinner-" + key);
  const check = document.getElementById("tcheck-" + key);
  if (spinner) spinner.style.display = state === "running" ? "block" : "none";
  if (check)
    check.innerHTML =
      state === "done" ? '<span class="check-done">✓</span>' : "";
}

async function measureDownload() {
  const DURATION_MS = 10_000;
  const CHUNK_BYTES = 25_000_000; // large chunk = fewer requests = less chance of rate-limit
  const deadline = performance.now() + DURATION_MS;
  let totalBits = 0;
  let totalSec = 0;
  while (performance.now() < deadline) {
    const t0 = performance.now();
    const res = await fetch(
      "https://speed.cloudflare.com/__down?bytes=" + CHUNK_BYTES,
      { cache: "no-store" },
    );
    if (!res.ok) break;
    await res.arrayBuffer();
    const sec = (performance.now() - t0) / 1000;
    totalBits += CHUNK_BYTES * 8;
    totalSec += sec;
    await sleep(500); // brief pause between requests to avoid rate-limiting
  }
  return totalSec > 0 ? totalBits / totalSec / 1_000_000 : 0;
}

async function measureUpload() {
  const DURATION_MS = 10_000;
  const CHUNK_BYTES = 2_000_000; // smaller chunks so uploads complete quickly
  // Fill with a repeating pattern — crypto.getRandomValues has a 65 536-byte
  // limit per call so it cannot be used for multi-MB buffers.
  const data = new Uint8Array(CHUNK_BYTES).map((_, i) => i & 0xff);
  const blob = new Blob([data], { type: "text/plain" });
  const deadline = performance.now() + DURATION_MS;
  let totalBits = 0;
  let totalSec = 0;
  let iterations = 0;
  while (performance.now() < deadline || iterations === 0) {
    const t0 = performance.now();
    await fetch("https://speed.cloudflare.com/__up", {
      method: "POST",
      body: blob,
      mode: "cors",
      cache: "no-store",
    });
    const sec = (performance.now() - t0) / 1000;
    totalBits += CHUNK_BYTES * 8;
    totalSec += sec;
    iterations++;
    await sleep(500); // brief pause between requests to avoid rate-limiting
  }
  return totalSec > 0 ? totalBits / totalSec / 1_000_000 : 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════
//  ELIGIBILITY EVALUATION
// ═══════════════════════════════════════════════════════
function evaluate() {
  const rows = [];

  const dl = speedRes.download ?? 0;
  rows.push({
    label: "Download Speed",
    value: dl > 0 ? dl.toFixed(1) + " Mbps" : "Unable to test",
    eligible: dl >= CONFIG.thresholds.downloadMbps,
    note: "Minimum: " + CONFIG.thresholds.downloadMbps + " Mbps",
  });

  const ul = speedRes.upload ?? 0;
  rows.push({
    label: "Upload Speed",
    value: ul > 0 ? ul.toFixed(1) + " Mbps" : "Unable to test",
    eligible: ul >= CONFIG.thresholds.uploadMbps,
    note: "Minimum: " + CONFIG.thresholds.uploadMbps + " Mbps",
  });

  const isMacOS = /^macos\s/i.test(sysData.os);
  let osEligible, osNote;
  if (isMacOS) {
    const m = sysData.os.match(/(\d+)\./);
    const major = m ? parseInt(m[1]) : 0;
    const vname = MAC_VERSION_NAMES[major] || "v" + major;
    osEligible = major >= 13;
    osNote = osEligible
      ? "macOS " + vname + " \u2014 meets requirement"
      : "macOS " + vname + " \u2014 macOS Ventura (13) or newer required";
  } else {
    osEligible = sysData.os.includes(CONFIG.requiredOS);
    osNote = "Required: " + CONFIG.requiredOS;
  }
  rows.push({
    label: "Operating System",
    value: sysData.os || "Unknown",
    eligible: osEligible,
    note: osNote,
  });

  const isAmd = /amd/i.test(sysData.cpu);
  const ramMinGB = isAmd ? CONFIG.thresholds.ramGBAmd : CONFIG.thresholds.ramGB;
  rows.push({
    label: "RAM",
    value: sysData.ramGB + " GB",
    eligible: sysData.ramGB >= ramMinGB,
    note:
      "Minimum: " + ramMinGB + " GB" + (isAmd ? " (AMD unified memory)" : ""),
  });

  rows.push({
    label: isMacOS ? "Free Disk Space" : "Free Disk Space (C:)",
    value: sysData.diskFree + " GB available",
    eligible: sysData.diskFree >= CONFIG.thresholds.diskFreeGB,
    note: "Minimum: " + CONFIG.thresholds.diskFreeGB + " GB free",
  });

  const cpuRes = evalCPU(sysData.cpu, sysData.cores, sysData.speedMHz);
  rows.push({
    label: "Processor",
    value: sysData.cpu || "Unknown",
    eligible: cpuRes.eligible,
    note: cpuRes.note,
  });

  const avRes = evalAV(sysData.av);
  rows.push({
    label: "Antivirus",
    value: sysData.av || "None detected",
    eligible: avRes.eligible,
    note: avRes.note,
  });

  const headsetRes = evalHeadset(sysData.usbHeadset, sysData.defaultMic);
  rows.push({
    label: "USB Headset",
    value: headsetRes.value,
    eligible: headsetRes.eligible,
    note: headsetRes.note,
  });


  return rows;
}

// ── CPU ──────────────────────────────────────────────────
function evalCPU(name, cores, speedMHz) {
  const ghz = speedMHz / 1000;
  const n = (name || "").toUpperCase();

  // Apple Silicon — no traditional clock speed; evaluate by chip generation
  if (n.includes("APPLE M")) {
    const m = n.match(/APPLE\s+M(\d+)/);
    const gen = m ? parseInt(m[1]) : 0;
    if (gen >= 1) {
      return {
        eligible: true,
        note: "Apple M" + gen + " \u2014 meets recommended specification",
      };
    }
    return {
      eligible: false,
      note: "Apple processor detected \u2014 manual verification required",
    };
  }

  if (cores < CONFIG.thresholds.cpuCores || ghz < CONFIG.thresholds.cpuGHz) {
    return {
      eligible: false,
      note:
        "Below minimum — found " +
        cores +
        " core(s) @ " +
        ghz.toFixed(2) +
        " GHz" +
        " (need \u2265" +
        CONFIG.thresholds.cpuCores +
        " cores @ \u2265" +
        CONFIG.thresholds.cpuGHz +
        " GHz)",
    };
  }

  if (n.includes("INTEL")) {
    if (n.includes("CELERON")) {
      return { eligible: false, note: "Intel Celeron is not eligible" };
    }
    if (n.includes("PENTIUM") || /\bI3[- ]\d/.test(n)) {
      return {
        eligible: false,
        note: "Intel Pentium / Core i3 does not meet the recommended i5/i7/i9 specification",
      };
    }

    const m = n.match(/\bI([579])[- ](\d{4,5})([A-Z0-9]*)/);
    if (m) {
      const suffix = m[3];
      if (suffix && !/^(HX|[HFV])/.test(suffix)) {
        return {
          eligible: false,
          note:
            'Processor suffix "' +
            suffix +
            '" is not eligible (allowed suffixes: H, F, V, HX)',
        };
      }
      const modelStr = m[2];
      const gen =
        modelStr.length >= 5
          ? parseInt(modelStr.substring(0, 2))
          : parseInt(modelStr.charAt(0));
      if (gen >= 9) {
        return {
          eligible: true,
          note:
            "Intel Core i" +
            m[1] +
            " \u2014 " +
            gen +
            ord(gen) +
            " gen, meets recommended specification",
        };
      }
      return {
        eligible: false,
        note:
          "Intel Core i" +
          m[1] +
          " " +
          gen +
          ord(gen) +
          " gen \u2014 9th generation or newer required",
      };
    }
    return {
      eligible: false,
      note: "Intel processor does not meet the recommended Core i5/i7/i9 9th gen+ specification",
    };
  }

  if (n.includes("AMD")) {
    const m = n.match(/RYZEN\s+(\d+)\s+(\d{4,5})([A-Z0-9]*)/);
    if (m) {
      const tier = parseInt(m[1]);
      const model = parseInt(m[2]);
      if (tier >= 9 && model >= 3000) {
        return {
          eligible: true,
          note: "AMD Ryzen 9 \u2014 meets recommended specification",
        };
      }
      if (tier === 7 && model >= 3700) {
        return {
          eligible: true,
          note: "AMD Ryzen 7 3700X or superior \u2014 meets recommended specification",
        };
      }
      return {
        eligible: false,
        note:
          "AMD Ryzen " +
          tier +
          " " +
          m[2] +
          " does not meet minimum recommended spec (Ryzen 7 3700X or superior)",
      };
    }
    return {
      eligible: false,
      note: "AMD processor does not meet the recommended Ryzen 7 3700X+ specification",
    };
  }

  return {
    eligible: false,
    note: "Could not identify processor \u2014 manual verification required",
  };
}

function ord(n) {
  if (n === 1) return "st";
  if (n === 2) return "nd";
  if (n === 3) return "rd";
  return "th";
}

// ── Antivirus ────────────────────────────────────────────
const PAID_AV = [
  "norton",
  "mcafee",
  "bitdefender",
  "kaspersky",
  "eset",
  "trend micro",
  "malwarebytes premium",
  "sophos",
  "webroot",
  "avast premium",
  "avg internet security",
  "f-secure",
  "cylance",
  "crowdstrike",
  "symantec",
  "carbon black",
  "sentinel",
  "cortex xdr",
  "huntress",
  "cybereason",
  "totalav",
  "vipre",
  "bullguard",
  "panda dome",
  "g data",
  "aura",
  "surfshark antivirus",
  "cisco secure endpoint",
];
const FREE_AV = [
  "windows defender",
  "microsoft defender",
  "avast free",
  "avg free",
  "avira free",
  "comodo free",
  "malwarebytes free",
  "none detected",
  "could not detect",
  "none",
];

function evalAV(av) {
  if (!av)
    return {
      eligible: false,
      note: "No antivirus detected \u2014 paid antivirus required",
    };
  const lower = av.toLowerCase();
  if (FREE_AV.some((f) => lower.includes(f))) {
    return {
      eligible: false,
      note: "Free / built-in antivirus is not eligible \u2014 paid antivirus required",
    };
  }
  if (PAID_AV.some((p) => lower.includes(p))) {
    return { eligible: true, note: "Paid antivirus detected" };
  }
  return {
    eligible: true,
    note: "Antivirus detected \u2014 please verify it is an active paid subscription",
  };
}

// ── USB Headset ─────────────────────────────────────────
function evalHeadset(usbHeadset, defaultMic) {
  const noHeadset =
    !usbHeadset || /^none|^could not/i.test(usbHeadset);
  const noMic =
    !defaultMic || /^none|^could not/i.test(defaultMic);

  if (noHeadset && noMic) {
    return {
      value: "No USB headset detected",
      eligible: false,
      note: "A USB headset with microphone is required",
    };
  }

  if (noHeadset && !noMic) {
    return {
      value: "Mic: " + defaultMic,
      eligible: false,
      note:
        "Microphone detected but no USB headset found \u2014 a USB headset is required",
    };
  }

  const micIsUsb =
    !noMic &&
    (defaultMic.toLowerCase().includes("usb") ||
      defaultMic.toLowerCase() === usbHeadset.toLowerCase() ||
      usbHeadset.toLowerCase().includes(defaultMic.toLowerCase()) ||
      defaultMic.toLowerCase().includes(usbHeadset.toLowerCase()));

  if (!noHeadset && noMic) {
    return {
      value: usbHeadset,
      eligible: false,
      note:
        "USB headset detected but no microphone found \u2014 verify headset mic is enabled",
    };
  }

  if (!noHeadset && !noMic && micIsUsb) {
    return {
      value: usbHeadset + " (Mic: " + defaultMic + ")",
      eligible: true,
      note: "USB headset with microphone detected",
    };
  }

  return {
    value: usbHeadset + " (Mic: " + defaultMic + ")",
    eligible: false,
    note:
      "USB headset detected but default microphone does not appear to be from the USB headset",
  };
}

// ═══════════════════════════════════════════════════════
//  RENDER RESULTS
// ═══════════════════════════════════════════════════════
function showResults() {
  const rows = evaluate();
  const passCount = rows.filter((r) => r.eligible).length;
  const dateStr = new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  document.getElementById("score-display").textContent =
    passCount + " / " + rows.length;
  document.getElementById("results-meta").textContent =
    userInfo.firstName +
    " " +
    userInfo.lastName +
    "  \u00b7  " +
    userInfo.email +
    "  \u00b7  " +
    dateStr;

  document.getElementById("results-grid").innerHTML = rows
    .map(function (r) {
      return (
        '<div class="result-row ' +
        (r.eligible ? "eligible" : "ineligible") +
        '">' +
        '<span class="result-badge">' +
        (r.eligible ? "\u2705" : "\u274c") +
        "</span>" +
        '<div class="result-body">' +
        '<div class="result-top">' +
        '<span class="result-label">' +
        esc(r.label) +
        "</span>" +
        '<span class="result-value">' +
        esc(r.value) +
        "</span>" +
        '<span class="result-pill">' +
        (r.eligible ? "ELIGIBLE" : "NOT ELIGIBLE") +
        "</span>" +
        "</div>" +
        '<div class="result-note">' +
        esc(r.note) +
        "</div>" +
        "</div>" +
        "</div>"
      );
    })
    .join("");

  const disclaimer = document.getElementById("results-disclaimer");
  if (disclaimer) disclaimer.style.display = "";

  show("screen-results");
  sendReport();
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ═══════════════════════════════════════════════════════
//  SEND REPORT (EmailJS)
// ═══════════════════════════════════════════════════════
async function sendReport() {
  const rows = evaluate();
  const passCount = rows.filter((r) => r.eligible).length;

  const fullName = userInfo.firstName + " " + userInfo.lastName;
  const checkDate = new Date().toLocaleString();
  const scoreStr = passCount + " / " + rows.length;

  const rowsHtml = rows
    .map(function (r) {
      const bgColor = r.eligible
        ? "rgba(46,125,50,0.13)"
        : "rgba(198,40,40,0.13)";
      const borderColor = r.eligible
        ? "rgba(46,125,50,0.35)"
        : "rgba(198,40,40,0.35)";
      const pillBg = r.eligible
        ? "rgba(46,125,50,0.25)"
        : "rgba(198,40,40,0.25)";
      const pillColor = r.eligible ? "#66bb6a" : "#ef5350";
      const badge = r.eligible ? "\u2705" : "\u274c";
      const pillText = r.eligible ? "ELIGIBLE" : "NOT ELIGIBLE";
      return (
        '<tr><td style="padding:6px 0;">' +
        '<table width="100%" cellpadding="0" cellspacing="0" style="background:' +
        bgColor +
        ";border:1px solid " +
        borderColor +
        ';border-radius:8px;"><tr><td style="padding:12px 14px;">' +
        '<table width="100%" cellpadding="0" cellspacing="0"><tr>' +
        '<td style="width:28px;vertical-align:top;font-size:16px;">' +
        badge +
        "</td>" +
        '<td style="padding-left:10px;">' +
        '<span style="font-weight:600;color:#c8ddf0;font-size:14px;">' +
        esc(r.label) +
        "</span>" +
        '&nbsp;&nbsp;<span style="color:#7a9abf;font-size:13px;">' +
        esc(r.value) +
        "</span>" +
        '&nbsp;&nbsp;<span style="background:' +
        pillBg +
        ";color:" +
        pillColor +
        ';font-size:11px;font-weight:700;padding:2px 9px;border-radius:20px;letter-spacing:0.04em;">' +
        pillText +
        "</span>" +
        '<br><span style="font-size:12px;color:#546e8a;">' +
        esc(r.note) +
        "</span>" +
        "</td></tr></table>" +
        "</td></tr></table>" +
        "</td></tr>"
      );
    })
    .join("");

  const bodyHtml =
    '<div style="background:#ffffff;padding:24px;font-family:Segoe UI,Tahoma,Geneva,Verdana,sans-serif;">' +
    '<table width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;margin:0 auto;background:#0f2035;border:1px solid #1a3a5c;border-radius:14px;padding:40px 44px;">' +
    "<tr><td>" +
    '<h2 style="color:#fff;font-size:20px;margin:0 0 6px;">System Check Report</h2>' +
    '<p style="color:#7a9abf;font-size:14px;margin:0 0 18px;">' +
    esc(fullName) +
    " &middot; " +
    esc(userInfo.email) +
    " &middot; " +
    esc(checkDate) +
    "</p>" +
    '<table width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#0d2d55 0%,#091828 100%);border:1px solid #1565c0;border-radius:10px;text-align:center;padding:22px;margin-bottom:22px;">' +
    '<tr><td><span style="font-size:40px;font-weight:700;color:#fff;">' +
    esc(scoreStr) +
    "</span>" +
    '<br><span style="font-size:13px;color:#7a9abf;">requirements met</span>' +
    "</td></tr></table>" +
    "<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\">" +
    rowsHtml +
    "</table>" +
    '<p style="font-size:13px;color:#7a6300;background:#fff8e1;border:1px solid #ffe082;border-radius:6px;padding:10px 14px;margin-top:16px;">' +
    "<strong>Note:</strong> These results are preliminary and subject to validation." +
    "</p>" +
    "</td></tr></table>" +
    "</div>";

  const templateParams = {
    to_email: "support@answeringservicecare.com,techspecs.3hksby@zapiermail.com",
    subject: "Computer Information Report — " + fullName,
    first_name: userInfo.firstName,
    last_name: userInfo.lastName,
    user_email: userInfo.email,
    score: scoreStr,
    check_date: checkDate,
    body_html: bodyHtml,
  };

  try {
    await emailjs.send(
      CONFIG.emailjs.serviceId,
      CONFIG.emailjs.templateId,
      templateParams,
      CONFIG.emailjs.publicKey,
    );
    toast("Report sent successfully.", "success");
  } catch (err) {
    console.error("Send report error:", err);
    toast("Failed to send report: " + (err.text || err.message || err), "error");
  }
}

// ═══════════════════════════════════════════════════════
//  TOAST
// ═══════════════════════════════════════════════════════
function toast(msg, type) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "toast " + (type || "") + " show";
  setTimeout(function () {
    el.className = "toast";
  }, 3800);
}
