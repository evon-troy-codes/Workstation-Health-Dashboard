// ═══════════════════════════════════════════════════════
//  PRELOAD — secure bridge between renderer and main
//
//  Exposes a minimal, explicit API on window.ascAPI. The
//  renderer never gets direct Node access (contextIsolation
//  is on); it can only call what we expose here.
// ═══════════════════════════════════════════════════════
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ascAPI", {
  platform: process.platform, // 'win32' | 'darwin' | 'linux'
  collectSystemInfo: () => ipcRenderer.invoke("collect-system-info"),
});
