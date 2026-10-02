# Architecture notes

`app/` is the Electron renderer + main-process code for Workstation Scanner. This doc covers how the pieces fit together and how to extend them.

```
app/
├── main/
│   ├── system-facts.js     ← MAIN process: collects real OS facts → FACTS shape
│   └── report.js           ← MAIN process: POSTs the report to be emailed,
│                              and the AI scan to be explained
├── preload.js               ← contextBridge → window.whd (getFacts, explain…)
└── renderer/
    ├── index.html            ← window entry (loads the vendored React + bundle)
    ├── helper-app.jsx        ← bundle entry: the 3-screen UI + app state
    ├── helper.css
    ├── assets/theme.css      ← semantic surface/text tokens (dark only)
    ├── react-globals.js      ← re-exports the React/ReactDOM UMD globals
    ├── icons.jsx
    ├── speedtest.js          ← real Cloudflare-based speed test
    ├── report-dialog.jsx     ← "Email this report" dialog
    ├── explain-dialog.jsx    ← "Explain my results" (AI) dialog
    ├── hints.js              ← the "?" explanations, one sentence each
    ├── dialog-focus.js       ← keeps Tab inside an open dialog
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
interface + link speed + MAC (shown on the card, never sent) + IPv4 + gateway,
each display's resolution, refresh rate and size, battery/power, audio devices, uptime, hostname, antivirus, VPN
detection (`null` on Linux when none is installed), background apps,
browser-extension count, OS pending updates.

**Filled in at runtime, not from the OS**: `bandwidth` — measured live by the
Network tab's speed test and merged into `FACTS` after the app collects it.

## Readability

The Overview leads with four "at a glance" tiles (internet, storage, OS
updates, power), each a button to its details. Labels whose meaning isn't
obvious (jitter, MTU, gateway…) carry a "?" that opens a one-sentence
explanation under the row; the text lives in `renderer/hints.js`, and
explains the term without judging the reading. Ctrl/Cmd with + / - / 0 zooms
the window, remembered in `zoom.json` in the app's userData
(`main/zoom.js`).

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
username and IP address. `buildReport` leaves out the network card's MAC
address and the Wi-Fi network's name. The endpoint is normally the
[`server/report-mailer`](../server/report-mailer/) Worker, which emails the
report through Resend, attaching it as JSON rebuilt from its known fields
(`reportAttachment`); any service taking the same JSON works.

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

## Explain my results (AI)

The footer's **Explain my results** button, shown only when the build has a
report endpoint, opens `renderer/explain-dialog.jsx`. Nothing is sent until
the user clicks Explain in the dialog.

```
window.whd.explain(facts)                 [preload.js]
  └─ ipcRenderer.invoke("whd:explain")    [main.js]
       └─ buildAiScan(buildReport(…))     [main/report.js]  ← allow-list
            └─ requestExplanation()       POST { scan } to <endpoint>/explain
                 └─ server/report-mailer  sanitizeScan → Claude → shapeAnswer
```

As with reports, main builds the scan from its own last scan and takes only
the speed-test numbers from the renderer. `buildAiScan` is an allow-list with
nothing identifying: no hostname, user, addresses, Wi-Fi, device or monitor
names. A field added to the report stays out until it is added there, and the
Worker filters again (`sanitizeScan`). The request is `https://` only, refuses
redirects, and gives up after 60 s; the Worker makes one attempt of at most
50 s, so it always answers first.

It resolves `{ ok: true, summary, findings, model }`, where each finding is
`{ severity: "high" | "medium" | "low" | "ok", title, detail, fix }` (at most
five), or `{ ok: false, reason, status?, error? }`. `reason` is as for reports
(`"no-endpoint"`, `"no-scan"`, `"timeout"`, `"unreachable"`, `"http"`…); with
`"http"`, `error` is the Worker's code: `rate-limited` (per IP),
`ai-daily-limit` / `ai-monthly-limit` (the shared budget, 10 a day and 100 a
month), `ai-unavailable` (out of Anthropic credit), `ai-busy`, `ai-timeout`,
`ai-refused`, `ai-unreachable`, `ai-failed`, `ai-incomplete`,
`ai-bad-answer` or `not-configured`. `renderer/report-messages.js`
(`explainFailure`) words each one. A call that never reached Claude is given
back to the budget. The answer is labelled as an AI assessment; the cards stay
the source of truth.

## Report format changes

Anyone reading the reports should key on `appVersion`, which every report
carries.

**1.3.1**

- New `antivirus.checked` (true or false) whenever `antivirus` is an object.
  `false` means the check itself failed (on Windows: Security Center missing,
  as on Server editions, or PowerShell failing or timing out): the card says
  "Unknown", the email "Unknown (the check failed)", and the AI is told it
  wasn't checked. An empty `products` with `checked: true` is a real "none
  installed".
- macOS with no third-party product reports `"Built-in protection (XProtect)"`
  (`running: null`, so "Installed", with its definitions age when readable),
  instead of an empty list: every Mac has it.
- A rolling Linux release with no `VERSION_ID` (Arch) reports its `BUILD_ID`
  as `os.version` ("rolling"); systeminformation's lowercase "unknown" now
  reads "Unknown".
- Display `size` over 150" is treated as unknown (a garbled EDID).

**1.3.0**

- `antivirus` can be `null` on Linux: none of the known products is installed,
  so there is nothing to report (the card is hidden, and the email has no
  Security section). Check for null before reading `antivirus.products`. On
  Windows and macOS it is always `{ products: [...] }`.
- `network.mac` and `network.ssid` are no longer in reports. The card still
  shows the MAC; it just stays on the machine.
- New `cpu.ghzKind`: `"max"` when `cpu.ghz` is the maximum boost clock,
  `"base"` when only the base clock was known, `null` when neither was (and
  `cpu.ghz` is 0). The card shows "up to" the maximum, or no speed.
- On Linux, `os.name`, `os.version` and `os.build` come from `/etc/os-release`
  (`NAME`, `VERSION_ID`, `BUILD_ID`), falling back to `/usr/lib/os-release`.
  A derivative now reports itself ("Omarchy 4.0.4", not "Arch Linux").
  `os.build` is empty when it only repeats the version.
- `os.pendingUpdates` and `os.lastUpdateCheck` now work on Arch and its
  derivatives (pacman), and `pendingUpdates` is `null`, not 0, when pacman
  reports an error.
- `display.monitors[].main` is true only for a display the OS calls main.
  Hyprland has none, so none is marked; the single-display fields describe
  the first. Monitors under Hyprland come from `hyprctl`, with sizes.
- `backgroundApps.runningApps` matches whole process names, so an Electron
  app's `chrome_crashpad_handler` no longer reads as Chrome.
- The emailed JSON attachment is rebuilt from known fields by the Worker;
  anything else in the report is dropped.

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
- `display` arrives with the slow scans (it is `null` in the first scan), and
  gains `count`, `refreshRate` and `externalCount`. `display.resolution` is
  now the mode the main display is running in, which systeminformation
  reports on Linux where the old field was often empty ("Unknown").
- `display.monitors` lists every monitor, main first:
  `{ name, builtin, main, resolution, refreshRate, connection, size }`. The
  single-display fields still describe the main display. On GNOME with
  Wayland the facts come from Mutter (GNOME's display service), because the
  X11 view systeminformation reads there reports scaled, wrong modes.
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
- **Electron fuses** (`tools/after-pack.js`): the packaged binary can't run
  as plain Node or take NODE_OPTIONS or `--inspect`, and loads only its own
  `app.asar`. On Windows and macOS, asar integrity checking is on as well.
  CI checks every fuse in the installed builds (`tools/check-fuses.js`).
- **Installed-build check in CI**: packaging runs install and start each
  installer (`.github/workflows/ci.yml`). With `WHD_SELFTEST_FILE` set, the
  app writes a small result file (true/false per reading, never values) once
  it has scanned and the page confirms the dashboard is on screen
  (`main/selftest.js`); `tools/check-selftest.js` asserts it. Unset, as it is for
  users, the app writes nothing.

Still open:

- **Code-sign** the app (Apple Developer ID + Microsoft Authenticode) to avoid
  SmartScreen / Gatekeeper warnings.
- **Auto-update** via `electron-updater`.
- **First-scan latency**: `collectFacts()` takes ~6s on Windows because the
  `systeminformation` probes contend on WMI. Splitting the batch so the
  Overview card can paint from a couple of fast probes would cut the wait.
