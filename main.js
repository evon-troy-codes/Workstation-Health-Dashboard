// ═══════════════════════════════════════════════════════
//  ELECTRON MAIN PROCESS
//
//  Creates the application window and collects system
//  information directly via Node (systeminformation), then
//  exposes it to the renderer over IPC. This replaces the
//  old "download a .bat script that reopens the page with
//  URL params" workaround the web version needed.
// ═══════════════════════════════════════════════════════
const { app, BrowserWindow, ipcMain } = require("electron");
const { execFile } = require("child_process");
const path = require("path");
const si = require("systeminformation");

function createWindow() {
  const win = new BrowserWindow({
    width: 720,
    height: 900,
    minWidth: 520,
    minHeight: 640,
    icon: path.join(__dirname, "assets", "ASC_logo.jpg"),
    title: "ASC System Checker",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.loadFile("index.html");
}

app.whenReady().then(() => {
  ipcMain.handle("collect-system-info", collectSystemInfo);

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ═══════════════════════════════════════════════════════
//  SYSTEM INFO COLLECTION
//
//  Returns the same shape the renderer's evaluate() expects:
//    { cpu, cores, speedMHz, ramGB, os, build, diskFree,
//      av, usbHeadset, defaultMic }
// ═══════════════════════════════════════════════════════
async function collectSystemInfo() {
  const isMac = process.platform === "darwin";

  const [cpu, mem, osInfo, fsList, audio] = await Promise.all([
    si.cpu(),
    si.mem(),
    si.osInfo(),
    si.fsSize(),
    si.audio(),
  ]);

  return {
    cpu: normalizeCpuName(cpu),
    cores: cpu.physicalCores || cpu.cores || 0,
    // systeminformation reports clock speed in GHz; renderer expects MHz
    speedMHz: Math.round((cpu.speedMax || cpu.speed || 0) * 1000),
    ramGB: round1(mem.total / 1024 ** 3),
    os: buildOsString(osInfo, isMac),
    build: osInfo.build || "",
    diskFree: getFreeDiskGB(fsList, isMac),
    av: await detectAntivirus(isMac),
    ...detectAudio(audio),
  };
}

// CPU brand alone (e.g. "Core™ i5-8350U", "Ryzen 7 3700X") may
// lack the vendor keyword the renderer's evalCPU() matches on,
// so prefix it from the manufacturer field when missing.
function normalizeCpuName(cpu) {
  let name = (cpu.brand || "").trim();
  const vendor = (cpu.manufacturer || "").toLowerCase();
  if (vendor.includes("intel") && !/intel/i.test(name)) name = "Intel " + name;
  else if ((vendor.includes("amd") || vendor.includes("advanced micro")) && !/amd/i.test(name))
    name = "AMD " + name;
  else if (vendor.includes("apple") && !/apple/i.test(name)) name = "Apple " + name;
  return name || "Unknown";
}

// Renderer expects "Windows 11..." (substring match) or
// "macOS <major>.<minor>" (regex /^macos\s/ + major version parse).
function buildOsString(osInfo, isMac) {
  if (isMac) return ("macOS " + (osInfo.release || "")).trim();
  return osInfo.distro || "Unknown";
}

function getFreeDiskGB(fsList, isMac) {
  const target = isMac
    ? fsList.find((d) => d.mount === "/")
    : fsList.find((d) => /^C:/i.test(d.mount || d.fs || ""));
  const chosen = target || fsList[0];
  if (!chosen) return 0;
  const freeBytes =
    chosen.available != null ? chosen.available : (chosen.size || 0) - (chosen.used || 0);
  return round1(freeBytes / 1024 ** 3);
}

// systeminformation has no antivirus API, so this is the one
// piece that still needs a small platform-specific call.
function detectAntivirus(isMac) {
  return new Promise((resolve) => {
    if (isMac) {
      const fs = require("fs");
      const apps = [
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
      const found = apps.find((p) => fs.existsSync(p));
      resolve(found ? path.basename(found, ".app") : "None detected");
      return;
    }

    // Windows: query Security Center, excluding the built-in Defender
    const psScript =
      "$av = Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction SilentlyContinue; " +
      "if ($av) { $p = $av | Where-Object { $_.displayName -notmatch 'Windows Defender|Microsoft Defender' } | Select-Object -First 1; " +
      "if ($p) { $p.displayName } else { ($av | Select-Object -First 1).displayName } }";
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psScript],
      { timeout: 15000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve("Could not detect");
        const name = (stdout || "").trim();
        resolve(name || "None detected");
      },
    );
  });
}

// Best-effort USB headset / microphone detection. systeminformation's
// audio data is limited on Windows (in/out/default are often null), so
// USB devices are identified by their PnP id / name / interfaceType.
function detectAudio(audio) {
  const isUsb = (a) => /usb/i.test([a.id, a.name, a.interfaceType].join(" "));
  const isCamera = (a) => /camera|webcam/i.test(a.name || "");
  const isMic = (a) => /microphone|\bmic\b/i.test([a.name, a.type].join(" "));

  const usbAudio = audio.filter((a) => isUsb(a) && !isCamera(a));

  let usbHeadset = "None detected";
  if (usbAudio.length) {
    const headset = usbAudio.find((a) => !isMic(a)) || usbAudio[0];
    usbHeadset = headset.name;
  }

  let defaultMic = "None detected";
  const micCandidates = [
    audio.find((a) => a.in === true && a.default === true),
    usbAudio.find(isMic),
    usbAudio[0],
    audio.find(isMic),
  ];
  const mic = micCandidates.find(Boolean);
  if (mic) defaultMic = mic.name;

  return { usbHeadset, defaultMic };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}
