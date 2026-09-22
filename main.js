// ═══════════════════════════════════════════════════════
//  ELECTRON MAIN PROCESS
//
//  Hosts the Workstation Scanner UI (renderer at
//  app/renderer). The main process collects real system
//  facts via systeminformation and exposes them to the
//  renderer over the `window.whd` bridge (see app/preload.js).
// ═══════════════════════════════════════════════════════
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const { collectFacts, detectDeferred } = require("./app/main/system-facts");
const { sendReport } = require("./app/main/report");

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
    title: "Workstation Scanner",
    // Packaged builds take the icon from electron-builder; setting it here is
    // what gives `npm start` a branded window and taskbar entry too.
    icon: path.join(APP_DIR, "renderer", "assets", "logo", "icon-256.png"),
    backgroundColor: "#12161c", // matches --surface-page, so open/resize don't flash
    webPreferences: {
      preload: path.join(APP_DIR, "preload.js"),
      contextIsolation: true, // required — preload uses contextBridge
      nodeIntegration: false, // keep the renderer sandboxed
      sandbox: true, // the preload only needs ipcRenderer, which survives it
    },
  });

  // The renderer has no reason to navigate anywhere or spawn windows. Anything
  // that tries is either a bug or something hostile, so send external links to
  // the real browser and refuse the rest.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event) => event.preventDefault());

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(APP_DIR, "renderer", "index.html"));
  return win;
}

// A second launch should surface the window that already exists rather than
// starting a duplicate scan.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    ipcMain.handle("whd:get-facts", async () => collectFacts());

    // Slow scans (OS updates, SSD flag, process list), fetched after first paint.
    ipcMain.handle("whd:get-deferred", () => detectDeferred());

    // POST the health report to an optional backend. No-ops when REPORT_ENDPOINT is unset.
    // https only, no redirects; see app/main/report.js.
    ipcMain.handle("whd:send-report", (_evt, facts) => sendReport(REPORT_ENDPOINT, facts));

    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
