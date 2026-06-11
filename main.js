// ═══════════════════════════════════════════════════════
//  ELECTRON MAIN PROCESS
//
//  Hosts the Kauneonga Helper "Workstation health" dashboard
//  (renderer at kauneonga-helper/renderer). The main process
//  collects real system facts via systeminformation and
//  exposes them to the renderer over the `window.kauneonga`
//  bridge (see kauneonga-helper/preload.js).
// ═══════════════════════════════════════════════════════
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { collectFacts, detectDeferred } = require("./kauneonga-helper/main/system-facts");

const HELPER_DIR = path.join(__dirname, "kauneonga-helper");

// Backend endpoint for health reports. Wire to your real API; when unset the
// send-report handler no-ops gracefully so the UI still works offline.
const REPORT_ENDPOINT = process.env.KAUNEONGA_REPORT_URL || "";

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 860,
    minWidth: 920,
    minHeight: 680,
    title: "Kauneonga Helper",
    webPreferences: {
      preload: path.join(HELPER_DIR, "preload.js"),
      contextIsolation: true, // required — preload uses contextBridge
      nodeIntegration: false, // keep the renderer sandboxed
    },
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(HELPER_DIR, "renderer", "index.html"));
}

app.whenReady().then(() => {
  // Collect real OS facts. `policyOverride` is where backend-sourced values
  // (agent identity, validation, antivirus, bandwidth, etc.) would be merged in.
  ipcMain.handle("kauneonga:get-facts", async () => {
    let policyOverride = {};
    // TODO: fetch agent policy from your backend and assign to policyOverride.
    return collectFacts(policyOverride);
  });

  // Slow scans (OS updates + SSD flag), fetched lazily after first paint.
  ipcMain.handle("kauneonga:get-deferred", () => detectDeferred());

  // POST the health report to the backend. No-ops when REPORT_ENDPOINT is unset.
  ipcMain.handle("kauneonga:send-report", async (_evt, facts) => {
    if (!REPORT_ENDPOINT) {
      return { ok: true, skipped: true, reason: "No KAUNEONGA_REPORT_URL configured" };
    }
    try {
      const res = await fetch(REPORT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(facts),
      });
      return { ok: res.ok, status: res.status };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
