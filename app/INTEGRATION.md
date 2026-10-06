# Architecture notes

`app/` is the Electron renderer + main-process code for Workstation Scanner. This doc covers how the pieces fit together and how to extend them.

```
app/
├── main/
│   ├── system-facts.js     ← MAIN process: collects real OS facts → FACTS shape
│   ├── report.js           ← MAIN process: builds the report and the AI scan;
│   │                          POSTs the scan to be explained
│   └── share.js            ← MAIN process: the report as text, a page, an email link
├── preload.js               ← contextBridge → window.whd (getFacts, share…, explain…)
└── renderer/
    ├── index.html            ← window entry (loads the vendored React + bundle)
    ├── helper-app.jsx        ← bundle entry: the 3-screen UI + app state
    ├── helper.css
    ├── assets/theme.css      ← semantic surface/text tokens (dark only)
    ├── react-globals.js      ← re-exports the React/ReactDOM UMD globals
    ├── icons.jsx
    ├── speedtest.js          ← real Cloudflare-based speed test
    ├── share-dialog.jsx      ← "Share this report" dialog
    ├── explain-dialog.jsx    ← "Explain my results" (AI) dialog
    ├── hints.js              ← the "?" explanations, one sentence each
    ├── dialog-focus.js       ← keeps Tab inside an open dialog
    ├── report-messages.js    ← text for a share or explanation that failed
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

## Sharing a report

The footer's **Share report** button opens `renderer/share-dialog.jsx`, with
three choices. Each calls main (`window.whd.shareEmail`, `shareSave`,
`shareCopy`, passing `facts` for the speed-test numbers only). Main builds the
report from its own last scan (`buildReport`, which leaves out the MAC address
and Wi-Fi name) and formats it in `main/share.js`:

- **Email:** `mailtoLink` → `shell.openExternal("mailto:?subject=…&body=…")`.
  No recipient, so the person picks one in their own email app. If the full
  text would make the link longer than `MAX_MAILTO` (1,900 characters), the
  body is `shortText`, a summary that says to save and attach the full report.
  Result: `{ ok: true, shortened }`, or `{ ok: false, reason: "no-mail-app" }`.
- **Save:** a save dialog (Documents, `reportFileName`), then `reportHtml`: a
  self-contained page with every value escaped, no scripts and nothing loaded
  from outside. Result: `{ ok: true, fileName }`, or `reason` `"cancelled"` or
  `"write-failed"`.
- **Copy:** `reportText` on the clipboard. Result: `{ ok: true }`.

Any of them answers `{ ok: false, reason: "no-scan" }` before the first scan.
`renderer/report-messages.js` (`shareFailure`) words each reason.

The app no longer emails reports itself (changed 2026-10-02, for a public
release): a service that mails any address anyone types is a spam relay in
waiting, and its mail looks like phishing to people who never heard of the
app. Sharing from the person's own email, a file or the clipboard needs no
server at all.

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
`ai-daily-limit` / `ai-monthly-limit` (the shared Claude budget, 10 a day and 100 a
month, of which one caller gets at most 3 a day), `unsupported-media-type`
(not sent as `application/json`), `ai-unavailable` (out of Anthropic credit), `ai-busy`, `ai-timeout`,
`ai-refused`, `ai-unreachable`, `ai-failed`, `ai-incomplete`,
`ai-bad-answer` or `not-configured`. `renderer/report-messages.js`
(`explainFailure`) words each one. A call that never reached Claude is given
back to the budget. The answer is labelled as an AI assessment; the cards stay
the source of truth.

## Report format changes

Anyone reading the reports should key on `appVersion`, which every report
carries.

**1.4.0**

- New `firewall`: `{ checked, products: [{ name, active, detail }] }`,
  never null once the scan has finished. `active` is true, false, or null
  when only the product's presence is known ("Installed"). `detail`
  qualifies an active reading ("Off for: Public"). An empty `products`
  with `checked: true` means no firewall service was found; on Linux the
  rules themselves need root, so this is not proof there are no rules.
  `checked: false` is a check that failed ("Unknown"). It is collected
  after first paint, so a report made before then has `firewall: null`
  ("Unknown"). Shared reports list it under Security, which is now always
  present.
- `network.interface` no longer carries a MAC address: a Linux USB adapter
  named `enx`/`wlx` + MAC is reported as `"USB Ethernet adapter"` or
  `"USB Wi-Fi adapter"`.
- New `audio.headsetClass` value `"Display audio"`: sound sent to a monitor
  or TV over HDMI or DisplayPort, which was `"Built-in"`.
  `audio.headsetConnected` is now true only for `"Bluetooth"` and
  `"USB headset"`.
- `os.pendingUpdates` and `os.lastUpdateCheck` now work on macOS, from
  Software Update's last check. A count it didn't record is `null`.
- A battery level that can't be read shows as "Unknown", not "null%".
- Explain's `model` can now be a Workers AI model id
  (`@cf/google/gemma-4-26b-a4b-it`): once Claude's daily or monthly budget
  is spent, the Worker answers from that free model instead, with the same
  answer shape. `ai-daily-limit` then means the free model's day is spent
  too.
- New `os.appUpdates`: `{ snap?, flatpak? }`, a key only for an app store
  that is installed, holding its count of pending updates, or `null` when
  it couldn't be checked (offline, daemon down). `{}` when neither is
  installed (always on Windows and macOS). `os.pendingUpdates` is still the
  system package manager's count alone; the Overview tile shows the total.
- `disk.ssd` is `null` (Unknown) unless the OS says SSD or HDD; on Windows
  it now comes from `Get-PhysicalDisk`'s MediaType, and "Unspecified" is
  `null`, not `false`.

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
  used to receive the report alone. (Since 1.4.0, reports are
  shared from the person's own email, a file or the clipboard instead; see
  "Sharing a report" above.)

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
