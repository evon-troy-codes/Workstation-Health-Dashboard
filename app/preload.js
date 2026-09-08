// preload.js — bridges the renderer to the main-process collector.
// Exposes a tiny, safe API on window.whd. No Node access leaks to the page.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("whd", {
  // Returns the full FACTS object (Promise). Renderer's bootstrap calls this.
  getFacts: () => ipcRenderer.invoke("whd:get-facts"),
  // Slow scans (OS updates + SSD flag), fetched after the UI has rendered.
  getDeferred: () => ipcRenderer.invoke("whd:get-deferred"),
  // Re-run the scan on demand (the "Re-scan now" button calls this).
  rescan: () => ipcRenderer.invoke("whd:get-facts"),
  // Send the health report to an optional backend (wire WHD_REPORT_URL in main).
  sendReport: (facts) => ipcRenderer.invoke("whd:send-report", facts),
});
