# Integrating the Kauneonga Helper into your Electron app

This folder is a drop-in package. It adds a "Workstation health" window to your
existing Electron project, backed by **real** system data (via
[`systeminformation`](https://github.com/sebhildebrandt/systeminformation)) and
your backend policy data.

```
kauneonga-helper/
├── main/
│   └── system-facts.js     ← MAIN process: collects real OS facts → FACTS shape
├── preload.js              ← contextBridge → window.kauneonga.getFacts()
├── main-snippet.js         ← copy these pieces into your main process
└── renderer/
    ├── index.html          ← window entry (bootstrap fetches facts, then mounts)
    ├── helper-app.jsx       ← the 4-screen UI (Overview / System / Network / Validation)
    ├── helper.css
    ├── icons.jsx
    ├── toast.jsx
    └── assets/             ← design tokens + brand font
```

## 1. Install the one dependency

```bash
npm i systeminformation
```

React + Babel currently load from CDN inside `renderer/index.html`. For a
production desktop build you'll want them bundled offline — see step 5.

## 2. Drop the folder into your project

Copy `kauneonga-helper/` next to your main process file (or anywhere; just fix
the `path.join` references in `main-snippet.js`).

## 3. Wire the main process

Open `main-snippet.js` and copy its three pieces into your existing main file:

- `ipcMain.handle("kauneonga:get-facts", …)` — runs the collector. Wire
  `policyOverride` to your backend for the things the OS can't know: agent
  identity, validation sign-off, workspace checklist, approved-device lists,
  last speed-test result, MFA status.
- `ipcMain.handle("kauneonga:send-report", …)` — POSTs the signed health
  report to your backend.
- `createHelperWindow()` — opens the window with the preload attached. Call it
  from your menu / tray / nav, or `app.whenReady().then(createHelperWindow)`.

The window **must** use `contextIsolation: true` + `nodeIntegration: false` —
the preload bridge depends on it, and it keeps the renderer sandboxed.

## 4. How the data flows

```
renderer/index.html (bootstrap)
   └─ window.kauneonga.getFacts()        [preload.js]
        └─ ipcRenderer.invoke("kauneonga:get-facts")
             └─ collectFacts(policy)      [main/system-facts.js]  ← REAL OS data
        ← FACTS object
   window.__KAUNEONGA_FACTS__ = facts
   → injects helper-app.jsx, which reads that global
```

`helper-app.jsx` reads `window.__KAUNEONGA_FACTS__` and falls back to a mock
object if it's absent — so the same file still renders in a plain browser for
design work.

## 5. What's real vs. what you must wire

**Real from the OS today** (in `system-facts.js`): CPU model/cores/arch, total &
free RAM + type, disk size/free/SSD, OS name/version/build, network interface +
link speed + MAC + IPv4 + gateway, display resolution + external monitor,
battery/power, audio devices, uptime, hostname.

**You must wire these** (they're not discoverable from the OS — defaults are
conservative so the UI shows "warn"/"fail" until connected):

| Field | Source |
|---|---|
| `agentName / email / extension / state / profileType` | your backend (agent record) |
| `bandwidth` | run a speed test (e.g. `@cloudflare/speedtest`) and pass the result |
| `os.pendingUpdates / lastUpdateCheck` | OS update API or your MDM |
| `antivirus.products` | osquery, Windows Security Center / WMI, or MDM |
| `vpn.detected` | interface scan or MDM |
| `mfa` | your auth/IdP |
| `workspace` + `validation` | supervisor-completed records from your backend |
| `cpu.approved` | edit `approvedCpu` list in `system-facts.js` |
| `audio.pcReadyCertified` | your certified-headset list |

## 6. Production hardening (before shipping)

- **Bundle React/Babel** instead of CDN: either vendor the UMD files locally, or
  convert the `.jsx` to a real build step (Vite/esbuild) and drop Babel. The UI
  has no other runtime deps.
- **Tighten CSP** in `index.html` — remove the CDN allowances once self-hosted.
- **Code-sign** the app (Apple Developer ID + Microsoft Authenticode) so it
  installs cleanly via Intune / Jamf / Workspace ONE.
- **Sign the health-report payload** (JWS) before `sendReport`.
- **Auto-update** via `electron-updater`.

## 7. Buttons already wired to the bridge

- **Re-scan now** → `window.kauneonga.rescan()` (re-runs the collector)
- **Send health report** → `window.kauneonga.sendReport(FACTS)`

Both no-op gracefully in a plain browser.
