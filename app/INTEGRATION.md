# Architecture notes

`app/` is the Electron renderer + main-process code for Workstation Health
Dashboard. This doc covers how the pieces fit together and how to extend them.

```
app/
├── main/
│   ├── system-facts.js     ← MAIN process: collects real OS facts → FACTS shape
│   └── report.js           ← MAIN process: POSTs the report to be emailed
├── preload.js               ← contextBridge → window.whd.getFacts()
└── renderer/
    ├── index.html            ← window entry (loads the vendored React + bundle)
    ├── helper-app.jsx        ← bundle entry: the 3-screen UI + app state
    ├── helper.css
    ├── assets/theme.css      ← semantic surface/text tokens (dark only)
    ├── react-globals.js      ← re-exports the React/ReactDOM UMD globals
    ├── icons.jsx
    ├── speedtest.js          ← real Cloudflare-based speed test
    ├── report-dialog.jsx     ← "Email this report" dialog
    ├── report-messages.js    ← failure text and the address check
    ├── toast.jsx
    ├── assets/               ← design tokens + brand font
    └── dist/                 ← build output, git-ignored (see ../../build.js)
```

The `.jsx` sources are ES modules bundled by `build.js` (esbuild) into
`dist/app.js`. React is not bundled — its production UMD build is copied to
`dist/vendor` and loaded by a plain `<script>`, which `react-globals.js`
re-exports so source files can `import` it normally.

## How the data flows

```
<App> mounts                       [helper-app.jsx]
   └─ window.whd.getFacts()        [preload.js]
        └─ ipcRenderer.invoke("whd:get-facts")
             └─ collectFacts()      [main/system-facts.js]  ← REAL OS data
        ← facts object  → React state, published on AppContext
   ├─ window.whd.getDeferred()     → merges OS updates, SSD flag, process scan
   └─ speedtest.run()              → merges facts.bandwidth
```

Facts live in `<App>`'s React state and reach every screen through
`AppContext` (`useApp()`), so a re-scan or a finished speed test re-renders
the tree normally. Slow work never blocks first paint: the dashboard renders
as soon as `collectFacts()` returns, and `getDeferred()` and the speed test
merge their results in when they land.

## What's real vs. what's a static default

**Real from the OS today** (in `system-facts.js`): CPU model/cores/arch, total
& free RAM + type, disk size/free/SSD, OS name/version/build, network
interface + link speed + MAC + IPv4 + gateway, display resolution + external
monitor, battery/power, audio devices, uptime, hostname, antivirus, VPN
detection, background apps, browser-extension count, OS pending updates.

**Filled in at runtime, not from the OS**: `bandwidth` — measured live by the
Network tab's speed test and merged into `FACTS` after the app collects it.

## Colour

`assets/colors_and_type.css` holds the raw brand palette; `assets/theme.css`
maps it onto the roles the UI asks for (`--surface-card`, `--text-muted`,
`--accent`). Components reference those roles and never a literal hex, so a
palette change happens in one file.

The app is dark only. That is a deliberate constraint rather than a missing
feature: one set of values means there is no second appearance to verify
whenever a component is added.

## Adding a new check

1. Add the raw fact to the shape returned by `collectFacts()` in
   `main/system-facts.js`.
2. Surface it in a `<Card>`/`<KV>` on whichever screen makes sense in
   `helper-app.jsx`. The app is purely informational — it reports facts,
   it doesn't grade them.

## Emailing reports

The footer's **Send report** button opens `renderer/report-dialog.jsx`, which
asks for an email address. It first asks main whether this build can send at
all (`window.whd.reportEnabled()`); without a report endpoint it says emailing
isn't set up instead of asking for an address.

Sending calls `window.whd.sendReport(facts, email)`. Main checks the address
again (`normalizeEmail`), builds the report from its own last scan
(`buildReport`, taking only the speed-test numbers in `facts.bandwidth` from
the renderer), and POSTs `{ email, report }` as JSON to the report endpoint
(`main/report.js`). The endpoint is `WHD_REPORT_URL` if set, else
`workstationScanner.reportUrl` in `package.json`, which is how an installed
app finds it. It must be `https://`, since the report carries hostname,
username, MAC and IP. The endpoint is normally the
[`server/report-mailer`](../server/report-mailer/) Worker, which emails the
report through Resend; any service taking the same JSON works.

With no endpoint the handler returns
`{ ok: true, skipped: true, reason: "no-endpoint" }`, so the app works fully
offline. A delivered report returns `{ ok: true, status }`.

A failed send returns `{ ok: false, reason, status?, error? }`, where `reason`
is `"invalid-email"`, `"insecure-url"`, `"timeout"`, `"unreachable"`,
`"redirected"`, `"http"` (with the endpoint's `status`: the Worker uses 403 for
a domain it doesn't send to and 429 when rate-limited) or `"no-scan"`
(nothing scanned yet). The dialog shows the cause and stays open, so the
address can be fixed. `error` carries the raw text for debugging; for a
network failure that is the underlying cause, such as `connect ECONNREFUSED`,
rather than fetch's generic "fetch failed". Redirects are refused rather than
followed, so an https endpoint cannot bounce the report to a plain http://
URL; configure the final address.

A new `reason` code needs both ends: `main/report.js` produces it and
`renderer/report-messages.js` words it, and each has a `.test.js` beside it
that should cover the new code.

## Report format changes

Anyone reading the reports should key on `appVersion`, which every report
carries.

**1.2.0**

- `cpu.cores` is now **physical** cores. It used to be systeminformation's
  `cores`, which counts logical processors (threads). The thread count moved
  to the new `cpu.threads`.
- `power.batteryLevel` is `null` on a machine with no battery; it used to be
  `100`. The new `power.hasBattery` says which.
- `audio.headsetConnected` is true only when the selected output is a headset.
  It used to be true whenever any sound driver was installed.
- New fields: `network.isVirtual` (the default route runs over a VPN or
  tunnel) and `os.lastUpdateKind` (`"checked"` or `"installed"`, saying which
  event `os.lastUpdateCheck` dates; `null` when unknown).
- Antivirus products may report `running: null` (installed, with no way to see
  whether it runs, e.g. on macOS), rather than a guessed `true`.
- Reports are emailed: the endpoint receives `{ email, report }`, where it
  used to receive the report alone (see "Emailing reports" above).

## Production hardening

Done:

- **React is vendored and the JSX precompiled** (`build.js`), so there is no
  CDN dependency at launch and no in-browser Babel transform.
- **CSP** in `index.html` is `default-src 'none'` with `script-src 'self'`;
  the only remote allowance is `connect-src https://speed.cloudflare.com`.
- **Renderer lockdown** in `main.js`: `sandbox: true`, navigation blocked, and
  window-open requests denied (https links go to the system browser).

Still open:

- **Code-sign** the app (Apple Developer ID + Microsoft Authenticode) to avoid
  SmartScreen / Gatekeeper warnings.
- **Auto-update** via `electron-updater`.
- **First-scan latency**: `collectFacts()` takes ~6s on Windows because the
  `systeminformation` probes contend on WMI. Splitting the batch so the
  Overview card can paint from a couple of fast probes would cut the wait.
