# Zillow Workstation Health Dashboard

This application reports on a computer's health —
CPU, RAM, disk, OS, network, antivirus, and audio — and runs a real network
speed test. Everything is collected from real local system data (via
[`systeminformation`](https://github.com/sebhildebrandt/systeminformation)
and native OS APIs) and shown as plain facts across three tabs —
**Overview, System, and Network**.

---

## Running

```bash
npm install
npm start
```

`npm start` compiles the renderer first (`npm run build`): it vendors React's
production build into `app/renderer/dist/vendor` and precompiles the JSX with
esbuild. Nothing is fetched from a CDN at runtime, so the app launches on a
machine with no working network — which is exactly the machine you are most
likely to be diagnosing.

On launch the dashboard appears as soon as the system scan lands (about a
second or two). The network speed test runs in the background and fills in the
Network tab when it finishes; the slower OS-update, SSD and process scans do
the same.

---

## What it checks

| Area                                                  | Source                                        |
| ----------------------------------------------------- | --------------------------------------------- |
| CPU, RAM + pressure, disk, OS, display, power, uptime | `systeminformation` + Node `os`               |
| Antivirus                                             | Windows Security Center / macOS app bundles   |
| VPN                                                   | active tunnel-interface scan                  |
| DNS                                                   | Node `dns`                                    |
| Background apps, browser-extension count              | process/file scans (fetched after first paint) |
| OS pending updates, SSD flag                          | Windows providers (fetched after first paint) |
| Network speed (download/upload/ping/jitter)           | Cloudflare speed test                         |

---

## Project structure

```
Workstation-Health-Dashboard/
├── main.js                  # Electron main process (window + IPC)
└── app/
    ├── main/system-facts.js # Collects real workstation facts → FACTS object
    ├── preload.js            # contextBridge → window.whd
    ├── INTEGRATION.md        # Architecture notes + how to extend it
    └── renderer/              # React UI (loaded by main.js)
        ├── index.html
        ├── helper-app.jsx    # 3-screen dashboard (entry point)
        ├── speedtest.js      # Cloudflare speed test
        ├── react-globals.js  # React/ReactDOM from the vendored UMD builds
        ├── icons.jsx, toast.jsx
        ├── assets/            # design tokens + brand font
        └── dist/              # build output (git-ignored, made by build.js)
```

`build.js` at the repo root produces `app/renderer/dist`. Run it with
`npm run build`; `npm start` and `npm run dist` do it for you.

---

## Notes

- React ships with the app and the JSX is precompiled, so `index.html` enforces
  a strict CSP with no remote origins and no `unsafe-eval`. The one network
  allowance is `connect-src https://speed.cloudflare.com` for the speed test.
- Code-sign the build before distribution to avoid SmartScreen / Gatekeeper
  warnings.
