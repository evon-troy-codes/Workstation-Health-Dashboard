// preload.js — bridges the renderer to the main-process collector.
// Exposes a tiny, safe API on window.kauneonga. No Node access leaks to the page.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kauneonga", {
  // Returns the full FACTS object (Promise). Renderer's bootstrap.js calls this.
  getFacts: () => ipcRenderer.invoke("kauneonga:get-facts"),
  // Slow scans (OS updates + SSD flag), fetched after the UI has rendered.
  getDeferred: () => ipcRenderer.invoke("kauneonga:get-deferred"),
  // Re-run the scan on demand (the "Re-scan now" button can call this).
  rescan: () => ipcRenderer.invoke("kauneonga:get-facts"),
  // Send the signed health report to your backend (wire in main).
  sendReport: (facts) => ipcRenderer.invoke("kauneonga:send-report", facts),
});
