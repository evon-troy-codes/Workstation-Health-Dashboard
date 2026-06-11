# Kauneonga Helper

An Electron desktop app that reports a remote agent's **workstation health** for the
Liberty CRM. It collects real system facts locally, runs a network speed test, and
shows a pass/warn/fail verdict across four tabs — **Overview, System, Network, and
Validation**.

---

## Running

```bash
npm install
npm start
```

On launch the app gathers system facts and runs a network speed test. Results are
only shown once the speed test completes, so the verdict is never displayed
half-measured.

---

## What it checks

**Detected locally (real data):**

| Area | Source |
| ---- | ------ |
| CPU, RAM + pressure, disk, OS, display, power, uptime | `systeminformation` + Node `os` |
| Antivirus | Windows Security Center / macOS app bundles |
| VPN | active tunnel-interface scan |
| DNS, running call/SIP apps, browser-extension count | Node `dns` + process/file scans |
| OS pending updates, SSD flag | Windows providers (fetched after first paint) |
| Network speed (download/upload/ping/jitter) | Cloudflare speed test |

**Provided by Liberty (shown as "Pending Liberty" until wired):** agent identity
(name/email/extension/state/profile), MFA status, validation sign-off, and the
workspace checklist. These render as neutral — not failures — in the verdict until
the CRM supplies real values.

---

## Project structure

```
Kauneonga-Helper/
├── main.js                       # Electron main process (window + IPC)
└── kauneonga-helper/
    ├── main/system-facts.js      # Collects real workstation facts → FACTS object
    ├── preload.js                # contextBridge → window.kauneonga
    ├── INTEGRATION.md            # Data flow + Liberty wiring notes
    └── renderer/                 # React UI (loaded by main.js)
        ├── index.html
        ├── helper-app.jsx        # 4-screen dashboard
        ├── speedtest.js          # Cloudflare speed test
        ├── icons.jsx, toast.jsx
        └── assets/               # design tokens + brand font
```

---

## Wiring Liberty

The Liberty-sourced fields come from `policyOverride` in the `kauneonga:get-facts`
handler in [main.js](main.js). Fetch the agent's record from your backend and merge
it in; the UI picks up real values with no changes. Health reports POST to the
endpoint in the `KAUNEONGA_REPORT_URL` environment variable (no-ops when unset).

See [kauneonga-helper/INTEGRATION.md](kauneonga-helper/INTEGRATION.md) for the full
data flow and the list of fields that must be wired.

---

## Notes

- React/Babel currently load from a CDN for development. For production, bundle them
  offline and tighten the CSP (see INTEGRATION.md).
- Code-sign the build before distribution to avoid SmartScreen / Gatekeeper warnings.
