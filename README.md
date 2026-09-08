# Workstation Health Dashboard

A cross-platform Electron desktop app that checks a computer's health — CPU,
RAM, disk, OS, network, antivirus, and audio — and runs a real network speed
test. Everything is collected from real local system data (via
[`systeminformation`](https://github.com/sebhildebrandt/systeminformation)
and native OS APIs), shown as a pass/warn/fail verdict across three tabs —
**Overview, System, and Network**.

---

## Running

```bash
npm install
npm start
```

On launch the app gathers system facts and runs a network speed test. Results
are only shown once the speed test completes, so the verdict is never
displayed half-measured.

---

## What it checks

| Area | Source |
| ---- | ------ |
| CPU, RAM + pressure, disk, OS, display, power, uptime | `systeminformation` + Node `os` |
| Antivirus | Windows Security Center / macOS app bundles |
| VPN | active tunnel-interface scan |
| DNS, background apps, browser-extension count | Node `dns` + process/file scans |
| OS pending updates, SSD flag | Windows providers (fetched after first paint) |
| Network speed (download/upload/ping/jitter) | Cloudflare speed test |

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
        ├── helper-app.jsx    # 3-screen dashboard
        ├── speedtest.js      # Cloudflare speed test
        ├── icons.jsx, toast.jsx
        └── assets/            # design tokens + brand font
```

---

## Optional: report endpoint

The app can POST the collected facts (as JSON) to a backend of your own —
call `window.whd.sendReport(facts)` from the renderer and set `WHD_REPORT_URL`
in the main process. Neither is wired to the UI by default, so the app is
fully self-contained and works offline with no configuration.

See [app/INTEGRATION.md](app/INTEGRATION.md) for the full data flow and how
to add new checks.

---

## Notes

- React/Babel currently load from a CDN for development. For production,
  bundle them offline and tighten the CSP (see INTEGRATION.md).
- Code-sign the build before distribution to avoid SmartScreen / Gatekeeper
  warnings.
