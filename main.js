// ═══════════════════════════════════════════════════════
//  ELECTRON MAIN PROCESS
//
//  Hosts the Workstation Scanner UI (renderer at
//  app/renderer). The main process collects real system
//  facts via systeminformation and exposes them to the
//  renderer over the `window.whd` bridge (see app/preload.js).
// ═══════════════════════════════════════════════════════
const { app, BrowserWindow, ipcMain, session, shell } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");
const { collectFacts, detectDeferred } = require("./app/main/system-facts");
const { sendReport, buildReport, reportEndpoint, normalizeEmail } = require("./app/main/report");

const APP_DIR = path.join(__dirname, "app");
const INDEX_FILE = path.join(APP_DIR, "renderer", "index.html");

// The webContents ids of the windows createWindow opened.
const appContents = new Set();

// IPC is answered only for the top frame of a window this process opened on
// its own page. Nothing else should ever load, but if something did (a bug, an
// injected frame, another window) it gets no system facts and cannot send a
// report.
//
// This goes by which window sent the message, not by comparing its URL with
// the index.html path: Chromium re-encodes the URL it loaded (it leaves [ ]
// alone, for one), so a string comparison refused every call from an install
// path holding such characters and the app could never scan. The window cannot
// navigate away (will-navigate is refused), and the file: check still turns
// away anything else loaded into it.
function fromApp(event) {
  const frame = event.senderFrame;
  if (!frame || frame.parent) return false;
  return appContents.has(event.sender.id) && frame.url.startsWith("file:");
}

function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromApp(event)) throw new Error("refused: not the app page");
    return fn(...args);
  });
}

// The last scan main collected, so a report is built from main's own data
// rather than whatever the renderer sends. scanCount stops a deferred result
// from an older scan being kept after a re-scan.
let lastFacts = null;
let lastDeferred = null;
let scanCount = 0;

// Where "Send report" posts the report and the address to email it to:
// WHD_REPORT_URL, else package.json's workstationScanner.reportUrl. Unset in a
// build without a mailer, and the dialog then says emailing isn't set up.
const REPORT_ENDPOINT = reportEndpoint(process.env, require("./package.json"));

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

  // The id is read now: the webContents is already destroyed by "closed".
  const id = win.webContents.id;
  appContents.add(id);
  win.on("closed", () => appContents.delete(id));

  win.setMenuBarVisibility(false);
  // Not loadFile: it leaves "%" in the path unescaped, so a folder named like
  // "a%20b" is read back as "a b" and the page is not found. pathToFileURL
  // escapes it.
  win.loadURL(pathToFileURL(INDEX_FILE).href);
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
    // The dashboard needs no camera, microphone, location or notifications,
    // and Electron grants those requests by default.
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    session.defaultSession.setPermissionCheckHandler(() => false);

    handle("whd:get-facts", async () => {
      const facts = await collectFacts();
      scanCount++;
      lastFacts = facts;
      lastDeferred = null;
      return facts;
    });

    // Slow scans (OS updates, SSD flag, process list), fetched after first paint.
    handle("whd:get-deferred", async () => {
      const scan = scanCount;
      const deferred = await detectDeferred();
      if (scan === scanCount) lastDeferred = deferred;
      return deferred;
    });

    // Whether this build can email reports, so the dialog can say so before
    // anyone types an address.
    handle("whd:report-enabled", () => Boolean(REPORT_ENDPOINT));

    // Email the report: POST it and the address to the report endpoint.
    // No-ops when REPORT_ENDPOINT is unset; https only, no redirects (see
    // app/main/report.js). The address is checked here too, not only in the
    // dialog, since main is what sends it.
    handle("whd:send-report", async (fromRenderer, email) => {
      if (!lastFacts) return { ok: false, reason: "no-scan" };
      const to = normalizeEmail(email);
      if (!to) return { ok: false, reason: "invalid-email" };
      return sendReport(REPORT_ENDPOINT, { email: to, report: buildReport(lastFacts, lastDeferred, fromRenderer) });
    });

    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
