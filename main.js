// ═══════════════════════════════════════════════════════
//  ELECTRON MAIN PROCESS
//
//  Hosts the Workstation Scanner UI (renderer at
//  app/renderer). The main process collects real system
//  facts via systeminformation and exposes them to the
//  renderer over the `window.whd` bridge (see app/preload.js).
// ═══════════════════════════════════════════════════════
const { app, BrowserWindow, ipcMain, session, shell, clipboard, dialog } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");
const fs = require("fs");
const { collectFacts, detectDeferred } = require("./app/main/system-facts");
const {
  buildReport, reportEndpoint,
  buildAiScan, explainEndpoint, requestExplanation,
} = require("./app/main/report");
const { selfTestResult, RENDERED_CHECK } = require("./app/main/selftest");
const { attachZoom } = require("./app/main/zoom");
const { reportText, reportHtml, reportFileName, mailtoLink } = require("./app/main/share");
const { fromApp } = require("./app/main/ipc-guard");

const APP_DIR = path.join(__dirname, "app");
const INDEX_FILE = path.join(APP_DIR, "renderer", "index.html");

// The webContents ids of the windows createWindow opened.
const appContents = new Set();

function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromApp(event, appContents)) throw new Error("refused: not the app page");
    return fn(...args);
  });
}

// The last scan main collected, so a report is built from main's own data
// rather than whatever the renderer sends. scanCount stops a deferred result
// from an older scan being kept after a re-scan.
let lastFacts = null;
let lastDeferred = null;
let scanCount = 0;

// CI's check of an installed build (.github/workflows/ci.yml). The Electron
// fuses stop a test harness from reaching into the packaged app, so when
// WHD_SELFTEST_FILE names a file, the app writes to it once the slow scans are
// back, after asking the page whether the dashboard is on screen. It says
// which readings came back, as true/false only (app/main/selftest.js): no
// values, so nothing about the machine is written. Unset, as it is for every
// user, nothing happens.
const SELFTEST_FILE = process.env.WHD_SELFTEST_FILE || "";

// Asks the page whether the dashboard is actually on screen: the renderer
// requests the slow scans just before React draws, so the request alone
// proves only that the page ran, not that it rendered.
async function writeSelfTest(facts, deferred) {
  const [win] = BrowserWindow.getAllWindows();
  const rendered = win ? await win.webContents.executeJavaScript(RENDERED_CHECK).catch(() => false) : false;
  const result = selfTestResult({ facts, deferred, rendered, version: app.getVersion(), packaged: app.isPackaged });
  try {
    fs.writeFileSync(SELFTEST_FILE, JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`self-test: could not write ${SELFTEST_FILE}: ${err.message}`);
  }
}

// The report service (server/report-mailer), which now only answers "Explain
// my results": WHD_REPORT_URL, else package.json's workstationScanner.reportUrl.
// Unset in a build without one, and the Explain button is hidden.
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
  // The page has no links, so nothing it opens is wanted: refuse every new
  // window rather than pass https URLs to the browser, which a compromised
  // page could use to open any site.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());

  // The id is read now: the webContents is already destroyed by "closed".
  const id = win.webContents.id;
  appContents.add(id);
  win.on("closed", () => appContents.delete(id));

  // Ctrl/Cmd with + / - / 0 zooms, remembered between launches.
  attachZoom(win, app.getPath("userData"));

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
      // Not awaited: the page's own results shouldn't wait on the check.
      if (SELFTEST_FILE && scan === scanCount) writeSelfTest(lastFacts, deferred);
      return deferred;
    });

    // Whether this build has the report service, which Explain needs.
    handle("whd:explain-enabled", () => Boolean(REPORT_ENDPOINT));

    // "Share report": the report built from main's own scan (only the speed
    // test from the renderer, as with every report), shared the way the
    // person chooses. Nothing is sent by the app itself: share.js.
    const shareable = (fromRenderer) => (lastFacts ? buildReport(lastFacts, lastDeferred, fromRenderer) : null);

    // As plain text, on the clipboard.
    handle("whd:share-copy", (fromRenderer) => {
      const report = shareable(fromRenderer);
      if (!report) return { ok: false, reason: "no-scan" };
      clipboard.writeText(reportText(report));
      return { ok: true };
    });

    // As a page, saved where the person picks (Documents to start with).
    handle("whd:share-save", async (fromRenderer) => {
      const report = shareable(fromRenderer);
      if (!report) return { ok: false, reason: "no-scan" };
      const at = new Date();
      const [win] = BrowserWindow.getAllWindows();
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        title: "Save report",
        defaultPath: path.join(app.getPath("documents"), reportFileName(report, at)),
        filters: [{ name: "Web page", extensions: ["html"] }],
      });
      if (canceled || !filePath) return { ok: false, reason: "cancelled" };
      try {
        fs.writeFileSync(filePath, reportHtml(report, at));
        return { ok: true, fileName: path.basename(filePath) };
      } catch (err) {
        return { ok: false, reason: "write-failed", error: err.message };
      }
    });

    // As an email in the person's own email app, with no recipient filled in:
    // they choose who it goes to, and send it from their own account.
    handle("whd:share-email", async (fromRenderer) => {
      const report = shareable(fromRenderer);
      if (!report) return { ok: false, reason: "no-scan" };
      const { url, shortened } = mailtoLink(report);
      try {
        await shell.openExternal(url);
        return { ok: true, shortened };
      } catch (err) {
        return { ok: false, reason: "no-mail-app", error: err.message };
      }
    });

    // "Explain my results": the AI assessment. Sends buildAiScan's copy of
    // the scan (identifying details removed) to the report mailer's /explain.
    handle("whd:explain", async (fromRenderer) => {
      if (!lastFacts) return { ok: false, reason: "no-scan" };
      const scan = buildAiScan(buildReport(lastFacts, lastDeferred, fromRenderer));
      return requestExplanation(explainEndpoint(REPORT_ENDPOINT), scan);
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
