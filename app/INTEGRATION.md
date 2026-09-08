# Architecture notes

`app/` is the Electron renderer + main-process code for Workstation Health
Dashboard. This doc covers how the pieces fit together and how to extend them.

```
app/
├── main/
│   └── system-facts.js     ← MAIN process: collects real OS facts → FACTS shape
├── preload.js               ← contextBridge → window.whd.getFacts()
└── renderer/
    ├── index.html            ← window entry (bootstrap fetches facts, then mounts)
    ├── helper-app.jsx        ← the 3-screen UI (Overview / System / Network)
    ├── helper.css
    ├── icons.jsx
    ├── speedtest.js          ← real Cloudflare-based speed test
    ├── toast.jsx
    └── assets/               ← design tokens + brand font
```

## How the data flows

```
renderer/index.html (bootstrap)
   └─ window.whd.getFacts()          [preload.js]
        └─ ipcRenderer.invoke("whd:get-facts")
             └─ collectFacts()        [main/system-facts.js]  ← REAL OS data
        ← FACTS object
   window.__WHD_FACTS__ = facts
   → injects helper-app.jsx, which reads that global
```

`helper-app.jsx` reads `window.__WHD_FACTS__` and falls back to a mock object
if it's absent — so the same file still renders in a plain browser for design
work.

## What's real vs. what's a static default

**Real from the OS today** (in `system-facts.js`): CPU model/cores/arch, total
& free RAM + type, disk size/free/SSD, OS name/version/build, network
interface + link speed + MAC + IPv4 + gateway, display resolution + external
monitor, battery/power, audio devices, uptime, hostname, antivirus, VPN
detection, background apps, browser-extension count, OS pending updates.

**Filled in at runtime, not from the OS**: `bandwidth` — measured live by the
Network tab's speed test and merged into `FACTS` after the app collects it.

## Adding a new check

1. Add the raw fact to the shape returned by `collectFacts()` in
   `main/system-facts.js`.
2. Add a `pass`/`warn`/`fail` rule for it in `computeVerdict()` in
   `helper-app.jsx`.
3. Surface it in a `<Card>`/`<KV>` on whichever screen makes sense.

## Optional report endpoint

The **Send health report** button calls `window.whd.sendReport(FACTS)`,
which POSTs the FACTS object as JSON to the `WHD_REPORT_URL` environment
variable if one is set (see `main.js`). With no env var configured, it no-ops
gracefully — the button and the rest of the app work fully offline.

## Production hardening (before shipping)

- **Bundle React/Babel** instead of CDN: either vendor the UMD files locally,
  or convert the `.jsx` to a real build step (Vite/esbuild) and drop Babel.
  The UI has no other runtime deps.
- **Tighten CSP** in `index.html` — remove the CDN allowances once self-hosted.
- **Code-sign** the app (Apple Developer ID + Microsoft Authenticode) to avoid
  SmartScreen / Gatekeeper warnings.
- **Auto-update** via `electron-updater`.
