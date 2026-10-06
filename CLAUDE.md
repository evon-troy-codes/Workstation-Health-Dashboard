# CLAUDE.md

Guidance for Claude Code sessions in this repo. The project is worked on from
more than one machine (Windows 11, Debian Linux, and Omarchy Linux), and sessions don't share
history, so anything a future session needs to know goes here, in commit
messages, or in the private notes repo below.

## Start of every session

1. `git fetch` and `git status`. Another machine may have pushed to `main`. On
   2026-09-22 two sessions renamed the app in parallel and 20 files conflicted.
   If `main` moved, pull (or merge) before starting.
   If `git status` reports the branch has **diverged** from `origin` with
   dozens of commits on each side, this clone predates the 2026-09-28 history
   rewrite (see Decisions): re-clone instead of pulling or pushing.
2. Read the to-do list in the private notes repo,
   `evon-troy-codes/workstation-scanner-notes` (`TODO.md`). It is cloned next
   to this repo as `../workstation-scanner-notes`; if it isn't there, clone it,
   or read it with
   `gh api repos/evon-troy-codes/workstation-scanner-notes/contents/TODO.md -H "Accept: application/vnd.github.raw"`.
   Keep the to-do list there, not here: this repo is public.
3. When work from the list lands, update `TODO.md` in the notes repo and push
   it.

## What this is

Workstation Scanner is an Electron + React desktop app that reports real local
system facts (CPU, RAM, disk, OS, network, antivirus, audio, power) and runs a
Cloudflare speed test, on Windows, macOS and Linux. The README covers running
and installing, and `app/INTEGRATION.md` covers the architecture. The GitHub
repo keeps its old name, `Workstation-Health-Dashboard`; the `whd` prefixes
and `WHD_REPORT_URL` come from that name and stay, so existing configuration
keeps working.

## Commands

| Task | Command |
| --- | --- |
| Unit tests (node:test, under a second) | `npm test` |
| Build the renderer | `npm run build` |
| Run the app | `npm start` |
| Launch smoke test | `npm run build` then `npx electron tools/smoke.js` |
| Installers for this OS | `npm run dist` |
| Postman checks (uses the network) | `npm run test:postman` |
| Deploy the report mailer | `cd server/report-mailer && npx wrangler deploy` (see its README) |

`npm run icons` rewrites `build/` and `app/renderer/assets/logo/`, and
`npm run screenshots` rewrites `docs/screenshots/`. Run them only on purpose.

## Machine setup

- **Node 24** (what CI uses). Where it comes from depends on the machine:
  - Debian: nvm, not on PATH in a non-interactive shell. Prefix commands
    with `. ~/.nvm/nvm.sh && ...`.
  - Omarchy (Arch, host `devops`): mise, already on PATH (Node 26 there,
    which passes the tests too). There is no `~/.nvm`; skip the prefix.
- **Fresh clone**: run `npm ci` at the root *and* in `server/report-mailer`.
  `npm test` runs the Worker's tests too, and they fail to load without its
  `@anthropic-ai/sdk`. The first `npm start` downloads Electron's binary
  (about 125 MB, a minute or so).
- **`ELECTRON_RUN_AS_NODE`**: VS Code sets it to `1`, which makes Electron run
  as plain Node (`app` is undefined). Run every Electron command as
  `env -u ELECTRON_RUN_AS_NODE ...` (bash, including Git Bash on Windows), or
  `Remove-Item Env:ELECTRON_RUN_AS_NODE` first in PowerShell.
- **GitHub**: pushing and CI use the `gh` CLI. Debian: installed at
  `~/.local/bin/gh`; Omarchy: from mise. Windows: `winget install GitHub.cli`. Then
  `gh auth login` once per machine; it also sets git's credential helper.
- **Git identity**: `Evon Troy Alexander <evon.codes@gmail.com>`.

## Conventions

- **Tests** sit beside the code as `*.test.js`. Renderer ES modules are loaded
  in tests from a `data:` URL (see `speedtest.test.js`). Timing is tested on a
  fake clock (`t.mock.timers` for `setTimeout` and `Date`, with
  `performance.now` mocked), never against wall-clock time. `fetch` is
  stubbed.
- **OS-specific detection** (PowerShell, `pactl`, `apt`, `/sys`, app bundles)
  keeps its parsing in small exported pure functions, tested against sample
  output. That's the only way Windows and macOS code gets tested on Linux, and
  the reverse.
- **The renderer reads `facts.*` directly**, so a renamed or missing field
  shows up as `undefined` on a card, not as an error. The contract tests at the
  bottom of `app/main/system-facts.test.js` list the fields the UI reads;
  update them with any change to the shape.
- **The app reports facts; it doesn't grade them.** When a value can't be
  known, show "Unknown" or "Installed", never a guess ("Active", "100%").
- **Commit messages** follow [Conventional Commits 1.0](https://www.conventionalcommits.org/)
  (adopted 2026-10-05; earlier history stays as it was):
  - Subject: `type(scope): summary`. Imperative, lower case, no full stop,
    50 characters or fewer where possible and never over 72.
  - Types: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `build`,
    `ci`, `chore`. Add `!` after the type (`feat(worker)!:`) or a
    `BREAKING CHANGE:` footer for anything that breaks installed apps or
    existing configuration.
  - Scope: the area touched, such as `system`, `network`, `overview`,
    `share`, `report`, `explain`, `worker`, `build`, `deps`. Leave it out
    when a change spans the app.
  - Body, after a blank line, wrapped at 72: what was wrong and why the
    change fixes it, often as bullets. End with what was verified and how,
    including what couldn't be verified on this machine.
  - One logical change per commit. Don't push `wip` or `tmp` commits, and
    don't merge branches into a feature branch; rebase instead.
  - PR titles use the same format, since they end up in the merge commit.
- **Work on a branch** and merge to `main` once it's checked. A push to `main`
  runs CI on all three OSes and builds installers. Pull requests run CI without
  packaging, and **Actions → CI → Run workflow** packages any branch.
- **Stacked PRs** (one PR based on another's branch): before merging the
  bottom one, retarget the one above it with `gh pr edit <n> --base main`.
  Deleting a PR's base branch (`gh pr merge --delete-branch`) makes GitHub
  close the PR on top rather than move it, and a closed PR can't be
  retargeted until its old base branch is pushed back. This happened on
  2026-09-24 with #2 and #3.

## Decisions already made

- **Logo**: the monitor showing two lines of text on the `#7d6bee` tile,
  generated by `tools/make-icons.js` from `assets/logo/logo-mark.svg`.
- **History was rewritten on 2026-09-28** to remove the previous brand's name
  and logo (and an early third-party logo) from every commit, with
  `git filter-repo`. Every commit ID changed. **A clone made before then must
  not be pushed from:** re-clone it, or `git fetch` and reset each branch to
  `origin/<branch>`. Old commit IDs in notes and PR text no longer resolve.
- **IPC sender check** (`main.js`): it identifies the app's window by its
  webContents id, not by comparing URLs. Chromium re-encodes file URLs, so a
  string comparison refused every call when the install path held `%` or
  `[ ]`. The window loads `pathToFileURL(index.html)`, because `loadFile` leaves
  `%` unescaped.
- **Reports** are built in main from main's own last scan (`buildReport`).
  Only the speed-test numbers come from the renderer.
- **Linux packaging**: a `.deb` plus the AppImage. The AppImage doesn't start
  on Ubuntu 23.10+ (AppArmor restricts user namespaces). The `.deb`'s
  `build/linux/after-install.tpl` installs an AppArmor profile, and falls back
  to a setuid `chrome-sandbox` only where nothing else works. CI installs and
  launches the `.deb` with the restriction on. Never ship `--no-sandbox`.
- **Linux Wi-Fi**: systeminformation can call a Wi-Fi card "wired"; the kernel's
  `DEVTYPE=wlan` decides.
- **Sharing reports, not emailing them** (changed 2026-10-02: the app is
  going public, and reports may go to anyone, not just IT). **Share report**
  emails from the person's own email app (a `mailto:` link, no recipient),
  saves an HTML page, or copies text (`app/main/share.js`). The app sends
  nothing itself: a server that mails any address anyone types is a spam
  relay, its mail looks like phishing, and it needed a paid domain. The
  MAC address and Wi-Fi name stay out of reports (`buildReport`). The
  report-mailer Worker's email route was removed (`POST /` answers 410
  `email-removed`); the Worker now only serves `/explain`. Don't revive it.
- **AI "Explain my results"** (prototype): the Worker's `POST /explain` asks
  Claude (`AI_MODEL`, default `claude-opus-5-5`, with `fallbacks: "default"`)
  for a summary and up to five findings in a fixed JSON schema. What leaves
  the machine is `buildAiScan` in `app/main/report.js`, an allow-list with
  nothing identifying; the Worker filters again (`sanitizeScan`). Opt-in per
  click, and the answer labelled as AI: keep both. The dialog says in plain
  words that identifying details are removed; it no longer shows the JSON
  payload (removed 2026-09-29: users aren't technical and it meant nothing
  to them).
  The Anthropic key is a Worker secret, never in the app. `/explain` has no
  login, so its spend is capped: per-IP rate limit, then a global Durable
  Object counter (`src/budget.js`, `AI_MONTHLY_LIMIT` 100 and
  `AI_DAILY_LIMIT` 10, UTC), sized for a $5-a-month budget. The 10 a day is
  shared by everyone on purpose (owner's call, 2026-09-29), but since
  2026-10-05 each caller (an IPv4 address or IPv6 /64, stored as a daily
  salted hash) gets at most `AI_DAILY_PER_IP_LIMIT` 3 of it, and only
  `application/json` is accepted, so a web page can't spend it through its
  visitors' browsers. A call that never
  reached Claude is refunded. Once Claude's day or month is spent, a free
  Workers AI model answers instead (`FREE_AI_MODEL`, Gemma 4 with thinking
  off, within Cloudflare's free daily allocation and its own caps: 250 a
  day, 10 per caller), and the dialog names it as the free model (owner's
  call, 2026-10-06). Keep it, and resize the limits if the model or
  budget changes.
- **No persistent PowerShell on Windows.** systeminformation's
  `si.powerShellStart()` (one shared session instead of a PowerShell per
  call) hung on every attempt on windows-latest (4 of 4, past 120 s), while
  the default mode's first scan took ~4 s. Don't adopt it. The benchmark is
  `tools/bench-scan.js` on branch `experiment/ps-session`.
- **CI's Linux job is pinned to `ubuntu-24.04`**; an `ubuntu-26.04` job runs
  alongside, allowed to fail, as an early warning (2026-10-02). Move the pin
  once 26.04 passes.
- **CI installs and starts every installer but the AppImage and the Intel
  .dmg** on packaging runs (push to `main`, or Run workflow): the `.deb`,
  the Windows NSIS installer (silent, then uninstalled) and the Apple
  silicon `.dmg`. The fuses stop a harness reaching into a packaged app, so
  the app checks itself: with `WHD_SELFTEST_FILE` set, `main.js` writes
  true/false per reading (never values, `app/main/selftest.js`) once it has
  scanned and the page confirms the dashboard is on screen,
  and `tools/check-selftest.js` asserts it. SmartScreen and Gatekeeper
  aren't exercised (they act only on browser downloads).
- **Electron fuses are flipped in `tools/after-pack.js`, before the macOS
  ad-hoc signing** (RunAsNode, NODE_OPTIONS, `--inspect` off;
  OnlyLoadAppFromAsar on; asar integrity on for Windows and macOS). CI
  checks them in every installed build (`tools/check-fuses.js`). Not through electron-builder's `electronFuses`
  setting: it flips them after the afterPack hook, which changes the Mac
  binary after it was signed and brings back "is damaged and can't be
  opened". A test harness can't reach into a packaged app any more, which is
  why CI uses the self-test below.
- **Linux antivirus: `null` when none is installed** (owner's call,
  2026-09-30). Antivirus is rare on personal Linux machines, so "none found"
  there is nothing to report: the card is hidden, the email has no Security
  section, and the AI is told it wasn't checked. A work machine running one of
  the known products (CrowdStrike, SentinelOne, Defender for Linux…) still
  shows it. Windows and macOS always report a reading: a failed check is
  `checked: false` ("Unknown", never "none"), and a Mac with no third-party
  product shows "Built-in protection (XProtect)" (owner's call, 2026-10-02).
- **Firewall card: shown on every OS, never hidden** (owner's call,
  2026-10-05), unlike Linux antivirus: a firewall matters on any laptop on
  public Wi-Fi, and "UFW installed, inactive" (Ubuntu's default) is the
  reading most worth seeing. Without root the rules can't be read, so Linux
  reports firewall *services* (UFW by `/etc/ufw/ufw.conf` plus its unit,
  firewalld, nftables, iptables/netfilter-persistent via `systemctl
  is-active`) and says "No firewall service found", never "No firewall".
  Docker's iptables rules don't count. Neutral styling, no warning. Windows
  reads `Get-NetFirewallProfile` plus Security Center's FirewallProduct;
  macOS reads `socketfilterfw --getglobalstate`.
- **Snap and Flatpak updates are counted** (owner's call, 2026-10-06): a
  user may install apps from either, and the system package manager
  doesn't see them (the Ubuntu VM: apt 0, four snaps including Firefox).
  `os.appUpdates` has a key per installed store, `null` when it couldn't be
  checked; the Overview tile shows the total. These are the app's only
  checks that contact a server besides the speed test and Explain: snapd
  sends the store the installed snaps (as it does itself several times a
  day), and Flatpak fetches each remote's index.
- **No Power card on a desktop** (owner's call, 2026-10-05): with no
  battery it only ever said "No battery · AC adapter". The System card and
  the Overview tile are hidden; the Firewall tile takes the tile's slot.
  Shared reports and the AI keep "no battery", which tells IT it's a
  desktop.
- **Installer checksums** (2026-10-06): every packaging run writes
  `dist/SHA256SUMS-<OS>.txt` (`tools/checksums.js`), naming files as a
  GitHub release does (spaces become dots), and keeps it with the
  installers. For a release, join the Linux, Windows and macOS files (not
  the ubuntu-26.04 duplicate) into one `SHA256SUMS.txt` asset, and check
  it against the assets' `digest` in the releases API.
- **The installers are unsigned.** The README's Installing section walks users
  past SmartScreen, Gatekeeper and AppImage permissions.

## Agents

`.claude/agents/` holds two agents, committed so every machine has them:

- `project-manager`: read-only review, suggestions, roadmap, ship verdicts.
- `qa-engineer`: runs the tests, the build and the real app, tries to break
  things, writes tests, and reports bugs. It never changes app code or commits.
