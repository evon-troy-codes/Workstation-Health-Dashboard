// ═══════════════════════════════════════════════════════
//  ELECTRON MAIN PROCESS
//
//  Hosts the Workstation Health Dashboard UI (renderer at
//  app/renderer). The main process collects real system
//  facts via systeminformation and exposes them to the
//  renderer over the `window.whd` bridge (see app/preload.js).
// ═══════════════════════════════════════════════════════
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { collectFacts, detectDeferred } = require("./app/main/system-facts");

const APP_DIR = path.join(__dirname, "app");

// Optional endpoint to POST health reports to. Unset by default; the
// send-report handler no-ops gracefully so the UI still works standalone.
const REPORT_ENDPOINT = process.env.WHD_REPORT_URL || "";

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 860,
    minWidth: 920,
    minHeight: 680,
    title: "Workstation Health Dashboard",
    webPreferences: {
      preload: path.join(APP_DIR, "preload.js"),
      contextIsolation: true, // required — preload uses contextBridge
      nodeIntegration: false, // keep the renderer sandboxed
    },
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(APP_DIR, "renderer", "index.html"));
}

app.whenReady().then(() => {
  ipcMain.handle("whd:get-facts", async () => collectFacts());

  // Slow scans (OS updates + SSD flag), fetched lazily after first paint.
  ipcMain.handle("whd:get-deferred", () => detectDeferred());

  // POST the health report to an optional backend. No-ops when REPORT_ENDPOINT is unset.
  ipcMain.handle("whd:send-report", async (_evt, facts) => {
    if (!REPORT_ENDPOINT) {
      return { ok: true, skipped: true, reason: "No WHD_REPORT_URL configured" };
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
