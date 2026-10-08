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
  // "Share report": copy it, save it as a page, or open it as an email in the
  // person's own email app. Main builds it from its own last scan and takes
  // only facts.bandwidth from here. The app sends nothing itself.
  shareCopy: (facts) => ipcRenderer.invoke("whd:share-copy", facts),
  shareSave: (facts) => ipcRenderer.invoke("whd:share-save", facts),
  shareEmail: (facts) => ipcRenderer.invoke("whd:share-email", facts),
  // Whether this build has the report service, which Explain needs.
  explainEnabled: () => ipcRenderer.invoke("whd:explain-enabled"),
  // "Explain my results": the AI's assessment of the scan. Main builds what is
  // sent from its own scan (identifying details removed) and takes only
  // facts.bandwidth from here.
  explain: (facts) => ipcRenderer.invoke("whd:explain", facts),
  // Workstation Scanner for Teams: whether IT manages this computer, and by
  // whom (never the enrollment key); sending the latest scan to the
  // company's fleet server once it's complete (main builds the report and
  // takes only facts.bandwidth from here); and how the last send went.
  managed: () => ipcRenderer.invoke("whd:managed"),
  fleetReport: (facts) => ipcRenderer.invoke("whd:fleet-report", facts),
  fleetStatus: () => ipcRenderer.invoke("whd:fleet-status"),
});
