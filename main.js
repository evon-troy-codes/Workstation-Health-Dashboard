// ═══════════════════════════════════════════════════════
//  ELECTRON MAIN PROCESS
//
//  Hosts the Workstation Scanner UI (renderer at
//  app/renderer). The main process collects real system
//  facts via systeminformation and exposes them to the
//  renderer over the `window.whd` bridge (see app/preload.js).
// ═══════════════════════════════════════════════════════
const { app, BrowserWindow, ipcMain, session, shell, clipboard, dialog, safeStorage } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { collectFacts, detectDeferred } = require("./app/main/system-facts");
const {
  buildReport, reportEndpoint,
  buildAiScan, explainEndpoint, requestExplanation,
} = require("./app/main/report");
const { selfTestResult, RENDERED_CHECK } = require("./app/main/selftest");
const { attachZoom } = require("./app/main/zoom");
const { reportText, reportHtml, reportFileName, mailtoLink } = require("./app/main/share");
const { fromApp } = require("./app/main/ipc-guard");
const { parseCliArgs, buildEnvelope } = require("./app/main/fleet");
const { readManagedSettings } = require("./app/main/managed-settings");
const { createFleetClient } = require("./app/main/fleet-client");

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

// Workstation Scanner for Teams (docs/design/fleet-mode.md): when IT has set
// managed settings, each scan is sent to the company's fleet server, once
// per launch or Re-scan. Read once at startup; null until then.
let managed = null; // readManagedSettings's result
let fleetClient = null;
let reportedScan = 0; // the scanCount last sent, so a scan is sent once
let sending = null; // the send in flight, which quitting waits for

// The device token's state file, in the user data folder: readable by this
// user alone, and written whole (to a temporary file, then renamed) so a
// crash can't leave half of it.
const fleetStateFile = () => path.join(app.getPath("userData"), "fleet.json");
function readFleetState() {
  try {
    return JSON.parse(fs.readFileSync(fleetStateFile(), "utf8"));
  } catch (_) {
    return null;
  }
}
function writeFleetState(state) {
  const file = fleetStateFile();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// The OS keychain, through safeStorage. On Linux with no keychain service,
// safeStorage falls back to "basic_text", which only disguises: then the
// token goes in the 0600 file as it is (fleet-client.js).
function keychain() {
  let available = false;
  try {
    available = safeStorage.isEncryptionAvailable()
      && !(process.platform === "linux" && ["basic_text", "unknown"].includes(safeStorage.getSelectedStorageBackend()));
  } catch (_) {
    available = false;
  }
  return {
    available,
    encrypt: (text) => safeStorage.encryptString(text).toString("base64"),
    decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, "base64")),
  };
}

async function loadManaged() {
  managed = await readManagedSettings();
  if (managed.status === "on") {
    fleetClient = createFleetClient({
      settings: managed,
      readState: readFleetState,
      writeState: writeFleetState,
      keychain: keychain(),
      randomUUID: () => crypto.randomUUID(),
      hostname: () => os.hostname(),
    });
  }
  return managed;
}

// Sends the latest scan, if it hasn't been sent. The first scan is the
// launch's; later ones are Re-scans.
function sendScan(fromRenderer) {
  if (!fleetClient || !lastFacts || reportedScan === scanCount) return null;
  reportedScan = scanCount;
  const envelope = buildEnvelope(buildReport(lastFacts, lastDeferred, fromRenderer || {}),
    { appVersion: app.getVersion(), trigger: scanCount === 1 ? "launch" : "rescan" });
  const p = fleetClient.send(envelope);
  sending = p;
  p.finally(() => { if (sending === p) sending = null; });
  return p;
}

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

// `--report-json[=<path>]`: one scan, as JSON, with no window, for IT's
// device-management and RMM tools (docs/design/fleet-mode.md, phase 1). It
// skips the single-instance lock, so it runs while the app is open too.
// Exits 0 on success, 1 if the scan or the write fails, 2 for a bad flag.
async function runReportJson(out) {
  try {
    const [facts, deferred] = await Promise.all([collectFacts(), detectDeferred()]);
    const envelope = buildEnvelope(buildReport(facts, deferred, {}), { appVersion: app.getVersion(), trigger: "cli" });
    const json = `${JSON.stringify(envelope, null, 2)}\n`;
    if (out) {
      fs.writeFileSync(out, json);
      app.exit(0);
    } else {
      process.stdout.write(json, () => app.exit(0));
    }
  } catch (err) {
    process.stderr.write(`workstation-scanner: --report-json failed: ${err && err.message ? err.message : err}\n`);
    app.exit(1);
  }
}

const cli = parseCliArgs(process.argv);

// A second launch should surface the window that already exists rather than
// starting a duplicate scan.
const gotLock = cli.reportJson || cli.error ? true : app.requestSingleInstanceLock();
if (cli.error) {
  process.stderr.write(`workstation-scanner: ${cli.error}\n`);
  app.exit(2);
} else if (cli.reportJson) {
  if (app.dock) app.dock.hide(); // no Dock icon on macOS for a scan with no window
  app.whenReady().then(() => runReportJson(cli.out));
} else if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  // Started before the window opens; the handlers that need it wait for it.
  let managedReady = null;

  // On quit, a scan not yet sent (the window closed before the speed test
  // finished) is sent with what there is, and a send in flight is let
  // finish: up to 5 seconds either way.
  let quitting = false;
  app.on("before-quit", (event) => {
    const unsent = fleetClient && lastFacts && reportedScan !== scanCount;
    if (quitting || !(unsent || sending)) return;
    event.preventDefault();
    quitting = true;
    const done = unsent ? sendScan({}) : sending;
    Promise.race([done, new Promise((resolve) => setTimeout(resolve, 5000))]).finally(() => app.quit());
  });

  app.whenReady().then(() => {
    managedReady = loadManaged();

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
    // IT can switch Explain off in the managed settings (`explain: false`).
    const explainAllowed = () => Boolean(REPORT_ENDPOINT) && !(managed && managed.status === "on" && !managed.explain);
    handle("whd:explain-enabled", async () => {
      await managedReady;
      return explainAllowed();
    });

    // Whether this computer is managed, and by whom, for the footer's notice.
    // Never the enrollment key.
    handle("whd:managed", async () => {
      const m = await managedReady;
      if (m.status === "invalid") return { managed: false, problem: true };
      if (m.status !== "on") return { managed: false, problem: false };
      return { managed: true, organization: m.organization, server: new URL(m.fleetUrl).host };
    });

    // The renderer asks once the slow scans and the speed test have finished,
    // so the report has everything. Main builds it from its own scan; only
    // the speed test comes from the renderer, as with every report.
    handle("whd:fleet-report", async (fromRenderer) => {
      await managedReady;
      const sent = sendScan(fromRenderer);
      return sent ? { result: await sent } : { result: null };
    });

    handle("whd:fleet-status", async () => {
      await managedReady;
      return fleetClient ? fleetClient.status() : { result: null, lastSentAt: null };
    });

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
      await managedReady;
      if (!explainAllowed()) return { ok: false, reason: "no-endpoint" };
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
