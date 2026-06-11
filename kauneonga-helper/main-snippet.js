// main-snippet.js — paste these pieces into your existing Electron main process.
// Shown as a standalone window; adapt to however you create windows already.

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { collectFacts } = require("./main/system-facts");

// 1) Register the IPC handler ONCE (e.g. in app.whenReady()).
//    Wire `policyOverride` to your backend: agent identity, validation,
//    workspace checklist, approved-device lists, last speed-test result.
ipcMain.handle("kauneonga:get-facts", async () => {
  let policyOverride = {};
  try {
    // const res = await fetch("https://api.kauneonga.com/v1/agent/policy", {...});
    // policyOverride = await res.json();
  } catch (e) { /* fall back to OS-only facts */ }
  return collectFacts(policyOverride);
});

ipcMain.handle("kauneonga:send-report", async (_evt, facts) => {
  // POST the signed health report to your backend.
  // await fetch("https://api.kauneonga.com/v1/health-reports", { method: "POST", body: sign(facts) });
  return { ok: true };
});

// 2) Create the Helper window (or route to it from your existing nav).
function createHelperWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 860,
    title: "Kauneonga Helper",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,   // required — preload uses contextBridge
      nodeIntegration: false,   // keep the renderer sandboxed
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  return win;
}

// app.whenReady().then(createHelperWindow);
module.exports = { createHelperWindow };
