# Workstation Scanner for Teams: design

**Status:** agreed 2026-10-07; phases 1 and 3 done, phase 2 in progress. **Last updated:** 2026-10-08.

Workstation Scanner for Teams ("fleet mode" in the code) lets a company's IT team see every enrolled computer's latest
Workstation Scanner reading in one web dashboard. Each company runs its own
copy of the dashboard in its own Cloudflare account, so no computer's data
passes through anyone else's servers.

There is **one app**: the same installer from the same Releases page, for
individuals and companies. A computer becomes part of a team only when IT
sets managed settings on it. Without them, nothing changes: the
app sends nothing unless the person using it shares a report or asks for an
AI explanation. The only separate piece is the server and dashboard, which
only companies install, either on Cloudflare or as a Docker container.

## Contents

1. [Goals and non-goals](#goals-and-non-goals)
2. [How it works](#how-it-works)
3. [Managed mode in the app](#managed-mode-in-the-app)
4. [What a computer sends](#what-a-computer-sends)
5. [Enrollment and authentication](#enrollment-and-authentication)
6. [The fleet server](#the-fleet-server)
7. [The dashboard](#the-dashboard)
8. [Scanning in the background](#scanning-in-the-background)
9. [Command-line JSON output](#command-line-json-output)
10. [Privacy and consent](#privacy-and-consent)
11. [Security](#security)
12. [Deployment and the public demo](#deployment-and-the-public-demo)
13. [Phases](#phases)
14. [Testing](#testing)
15. [Decisions](#decisions)

## Goals and non-goals

**Goals**

- An IT team can see, for every enrolled computer, the readings the app
  already collects: OS and pending updates, antivirus, firewall, disk, memory,
  network, speed test, and when it last reported.
- They can filter the list by what needs attention, for example "pending
  updates", "firewall not active", or "disk over 90% full".
- A company deploys it to its own Cloudflare account, or runs it as a Docker
  container on its own server, in a few minutes, and its data stays there.
- The person using a managed computer can always see that it is managed and
  what is sent.
- The consumer app keeps working exactly as it does today.

**Non-goals**

- Remote control, remote shell, or running commands on computers. The app
  reports; it doesn't act. Companies already have tools for that.
- Grading computers or deciding what is "healthy". The app reports facts;
  the dashboard's filters are for IT to apply to its own policy.
- A hosted, multi-company service run by the project. Each company runs its
  own copy.
- Replacing a device-management system (Intune, Jamf, an RMM). Fleet mode is
  a lightweight health view, and the command-line output feeds those tools.

## How it works

```
 Company computers                         Company's Cloudflare account
┌───────────────────────┐   HTTPS POST   ┌──────────────────────────────┐
│ Workstation Scanner   │  /v1/reports   │ Fleet Worker                 │
│  managed settings     │ ─────────────► │  checks the device token,    │
│  (Intune, Jamf, GPO…) │                │  validates, stores           │
│  "Managed by Acme IT" │                │        │                     │
└───────────────────────┘                │        ▼                     │
                                         │ D1 database: devices,        │
 IT staff                                │ reports                      │
┌───────────────────────┐  Cloudflare    │        │                     │
│ Browser               │ ◄───Access──── │ Dashboard (served by the     │
│ (company sign-in)     │   (SSO)        │ same Worker)                 │
└───────────────────────┘                └──────────────────────────────┘
```

1. IT deploys the fleet server (a Cloudflare Worker with a D1 database) to
   its own account, behind Cloudflare Access for its staff's sign-in.
2. IT pushes the managed settings to its computers with the tools it already
   uses (a registry policy, a configuration profile, or a file in `/etc`).
   They hold the fleet server's address and an enrollment key.
3. On each computer, the app sees them, shows that it is managed, enrolls
   once, and from then on sends each scan to the fleet server.
4. IT opens the dashboard and sees every computer.

Every connection is outbound from the computer, over HTTPS. Nothing connects
to the computers.

## Managed mode in the app

### The managed settings

The app reads its managed settings from the place each OS sets aside for
settings only an administrator or the company's device management can set,
as browsers, Zoom and Slack do. A user can't create or change them, so
managed mode can't be switched on or off without IT. (Changed 2026-10-08
from a `managed.json` on every OS: on Windows, ordinary users can create
files in a new folder under `%ProgramData%` by default, so a user could have
written the file before IT did.)

| OS | Where | Deployed with |
| --- | --- | --- |
| Windows | registry key `HKLM\SOFTWARE\Policies\WorkstationScanner` (64-bit view) | Group Policy, Intune (registry settings or a script) |
| macOS | a configuration profile for `com.evontroy.workstation-scanner`, device scope, read from `/Library/Managed Preferences/com.evontroy.workstation-scanner.plist` | Jamf, Intune, Kandji, any MDM |
| Linux | `/etc/workstation-scanner/managed.json` | Ansible, Puppet, a package, a script |

The same settings everywhere, as JSON on Linux:

```json
{
  "version": 1,
  "organization": "Acme IT",
  "fleetUrl": "https://fleet.acme.example/",
  "enrollmentKey": "ek_2f9c…",
  "scanEveryHours": 6,
  "speedTest": "open",
  "explain": true
}
```

On Windows they are registry values of the same names: strings
(`REG_SZ`), except `version`, `scanEveryHours` and `explain` (`REG_DWORD`,
`explain` 0 or 1). In a profile they are plist keys of the same names.

- `organization` is shown to the user in the notice below.
- `fleetUrl` must be `https://`. Redirects are refused, as the AI request
  already does.
- `enrollmentKey` is shared by every computer in the company; see
  [enrollment](#enrollment-and-authentication).
- `scanEveryHours` applies once background scanning exists (phase 4).
- `speedTest` is `"open"` (the default: a speed test runs when someone
  opens the app, never in the background) or `"daily"` (also once a day in
  the background). Each run uses up to 350 MB, so `"daily"` can reach about
  10 GB a month per computer. Until phase 4, `"daily"` is accepted and acts
  as `"open"`, so the settings IT writes now keep working.
- `explain` shows or hides the "Explain my results" button (default `true`,
  as in the consumer app). Some companies won't want scans sent to an AI
  service, even with identifying details removed.
- An `include` setting, to send the MAC address and Wi-Fi name, is left out
  of phase 2 (2026-10-08): nobody has asked for it, and it is the one piece
  that adds identifying data. It can come later.

No settings means fleet mode is off. Settings that can't be read, are
missing `fleetUrl` or `enrollmentKey`, or have a non-https `fleetUrl` also
mean off, and the app says so in the notice ("Managed settings couldn't be
read") instead of failing silently. On Linux the file is also ignored, with
the same notice, unless root owns it and only root can write it (and the
same for its folder), as `sshd` checks its own files.

The settings are read in the main process only. The renderer is told whether
the computer is managed and by whom, never the key.

### What the user sees

A managed computer shows a permanent line in the footer, next to "Data
source":

> **Managed by Acme IT.** Scans from this computer are sent to Acme IT.
> [What's sent]

"What's sent" opens a dialog listing, in plain words, what is sent, when it
was last sent, and the fleet server's address. No JSON: as with the Explain
dialog, the people reading it aren't technical.

## What a computer sends

The report the app already builds (`buildReport` in `app/main/report.js`),
plus a small envelope:

```json
{
  "schema": 1,
  "appVersion": "1.5.0",
  "sentAt": "2026-10-07T14:03:00Z",
  "trigger": "launch",
  "report": { "...": "buildReport's output" }
}
```

- `schema` is a version number for this format, so the server can accept old
  and new apps side by side.
- `trigger` is `launch`, `rescan`, or `schedule`.
- The report includes the computer name, user name, IP addresses, OS, and
  every card's reading. IT needs the computer name and user to know which
  machine is which.
- The MAC address and Wi-Fi network name stay out unless `include` turns them
  on, as in shared reports today.
- The speed test numbers are included when one has run. A scheduled scan in
  the background runs one only when `speedTest` is `"daily"`.
- **One report per launch or Re-scan.** The app sends once the slow scans
  and the speed test have finished (or the speed test failed), so each
  report has everything; sending twice would double the dashboard's rows.
  If the window closes first, it sends what it has.
- **Offline:** only the latest unsent report is kept, and sent on the next
  launch or Re-scan. Old readings aren't worth a queue.

## Enrollment and authentication

Each computer gets its own credential, so one can be revoked without
touching the others.

1. **Enroll, once.** The app sends `POST /v1/enroll` with the enrollment key,
   the computer name, and a random device ID it creates. The server answers
   with a device token.
2. **Report.** Every report goes to `POST /v1/reports` with
   `Authorization: Bearer <device token>`.
3. **Store the token** with Electron's `safeStorage`, which uses the OS
   keychain (Windows DPAPI, macOS Keychain, Linux libsecret), in the app's
   user data folder. On a Linux desktop with no keychain (`safeStorage`
   reports `basic_text`, which only disguises), the token is stored in a
   file only that user can read (mode 0600) instead of refusing to enroll:
   it can only send reports for this computer, and IT can revoke it.
   The token and device ID are per OS user, so two people on one computer
   show as two rows, each with its user name. Accepted for now: one ID per
   computer would need an administrator at install time.
4. **Revoke.** IT can revoke a device in the dashboard; its next report gets
   `401` and the app shows "This computer was removed from Acme IT's
   dashboard" and stops sending, until IT lets it back in.
5. **Rotate the enrollment key** in the dashboard. Already enrolled computers
   keep working; new ones need the new key in their managed settings.

There is one enrollment key per company to start with. The `devices` table
has a `group` column, so per-group keys ("Sales", "London office") can be
added later, letting the dashboard filter by group, without changing
anything on the computers.

The enrollment key alone can't read anything. At worst, someone who has it
can add fake computers, which shows up as unknown names in the dashboard and
is fixed by rotating the key.

## The fleet server

A Cloudflare Worker in its own folder, `server/fleet/`, deployed with
`wrangler deploy`, as `server/report-mailer` is.

**Storage (D1, Cloudflare's SQLite):**

| Table | Holds |
| --- | --- |
| `devices` | device ID, token hash, computer name, group (empty for now), first and last seen, revoked |
| `reports` | device ID, received at, schema, app version, report JSON |
| `settings` | enrollment key hash, organization name, retention days |

Only hashes of tokens and the enrollment key are stored.

**API (computers):**

| Route | Purpose |
| --- | --- |
| `POST /v1/enroll` | enrollment key in, device token out |
| `POST /v1/reports` | one report, with the device token |

Both accept only `application/json`, cap the body size, and rate-limit per
device, reusing what `/explain` already does (`readCapped`, the JSON-only
check, the rate limiter).

**API (dashboard):** read-only routes behind Cloudflare Access: list devices
with their latest report, one device's history, revoke, rotate the enrollment
key.

**Retention:** reports older than `retentionDays` (default 90) are deleted by
a daily scheduled Worker run. The latest report per device is always kept.

### Two ways to run it

The server's code is written once, against a small storage interface, and
packaged two ways:

| | Cloudflare | Docker |
| --- | --- | --- |
| Runs on | a Cloudflare Worker | a Node 24 container on the company's server |
| Database | D1 | SQLite in a mounted volume (Node's built-in `node:sqlite`) |
| Sign-in | Cloudflare Access | the company's reverse proxy or SSO gateway in front (e.g. oauth2-proxy), as the README will describe |
| Deploy | "Deploy to Cloudflare" button | `docker compose up -d` |

Both run the same tests. The routes, checks and dashboard are identical.

## The dashboard

Served by the same server. Every page needs signing in with the company's
admin token (a signed, HttpOnly, Secure, SameSite=Strict session cookie), so
the data is never public even if a company forgets to put SSO in front.
Cloudflare Access (Cloudflare) or an SSO proxy such as oauth2-proxy (Docker)
in front adds the company's own staff login as a second layer. (Changed
2026-10-07 from "Access only": built-in sign-in makes the safe setup the
default.)

**Computers list:** one row per computer, with name, user, OS, last report,
pending updates, firewall, antivirus, disk used, and app version. Each column
sorts. The filters are facts, not grades:

- pending updates > 0
- firewall not active, or unknown
- antivirus not active, or unknown
- disk used over a chosen percentage
- not reported for more than N days
- app version older than the latest

**Computer page:** the latest report laid out like the app's cards, plus a
history of the readings that change (pending updates, disk used, speed).

**Export:** CSV of the current list.

Every value is escaped when shown (reports come from computers, so a computer
name is untrusted text), with a Content Security Policy as strict as the
app's.

## Scanning in the background

Today the app scans only while it is open. For the dashboard to stay
current, a managed computer needs to scan on its own:

- Start at login, hidden, with a tray icon (Windows and Linux) or a menu bar
  icon (macOS).
- Scan every `scanEveryHours`, and on wake from sleep if the last scan is
  older than that.
- Only in managed mode. The consumer app stays a normal window.

This is the largest change in the app, so it comes last (phase 4). Until
then, the dashboard shows each computer as of the last time someone opened
the app, and "last report" makes that visible.

## Command-line JSON output

```
workstation-scanner --report-json > scan.json
```

Runs one scan without a window, prints the report as JSON (the same envelope
as above), and exits. It is useful on its own: companies with an RMM or a
device-management tool can run it as a script on every computer and collect
the output in the tool they already use, with no fleet server at all. It
needs nothing but the installed app, so it ships first (phase 1).

The MAC address and Wi-Fi name stay out here too.

## Privacy and consent

Collecting data from employees' computers is regulated in many places (GDPR
in Europe, and notice requirements in some US states), so:

- The user is always told: the permanent "Managed by…" line, and the "What's
  sent" dialog.
- Only health readings are sent: no file names, browsing history, screen
  contents, or keystrokes, and the app has no way to collect them.
- The report contents are documented in `app/INTEGRATION.md`, so a company
  can show its staff exactly what is sent.
- The data stays in the company's own Cloudflare account.
- Retention is limited by default (90 days).

The project provides the tool. Each company is responsible for its own
notice to staff; the README for fleet mode will say so.

## Security

| Risk | Mitigation |
| --- | --- |
| Someone sends fake reports | Device tokens per computer; reports without one are refused |
| The enrollment key leaks | It can only enroll, not read; IT rotates it and revokes unknown devices |
| A device token is stolen | Stored with `safeStorage` (OS keychain); revocable per device |
| A malicious computer name or reading attacks the dashboard | Every value escaped; strict CSP; reports validated against the schema on arrival |
| Someone outside IT opens the dashboard | Built-in sign-in with the admin token on every page, plus Cloudflare Access or an SSO proxy in front |
| Another site posts a form as a signed-in IT person | SameSite=Strict cookie, and every form POST must carry this server's Origin |
| Flooding the server | JSON-only, body size cap, per-device rate limit, as `/explain` does |
| The app sends to the wrong place | `fleetUrl` only from the admin-only managed settings, https only, no redirects |
| A user switches fleet mode off or on | The settings live where only an administrator or MDM can write: a `Policies` registry key, a configuration profile, or a root-owned file in `/etc` that the app checks |

## Deployment and the public demo

**On Docker:** `docker compose up -d` with a published image and a volume
for the database, behind the company's own HTTPS and sign-in.

**On Cloudflare:** a "Deploy to Cloudflare" button in `server/fleet/README.md`
creates the Worker and D1 database in the company's own account. Then:

1. Turn on Cloudflare Access for the dashboard's address.
2. Open the dashboard once to set the organization name and get the
   enrollment key.
3. Push the managed settings with Group Policy, Intune, Jamf, or a script.

**Public demo:** a separate deployment filled with made-up computers (about
40, a few with pending updates, one with its firewall off, one nearly full),
open to anyone, with sign-in, enrollment and revoking switched off. It
shows the idea without anyone installing anything, and it's what a LinkedIn
post links to.

## Phases

| Phase | What | Useful on its own because |
| --- | --- | --- |
| 1 | `--report-json` | RMM and device-management tools can collect scans straight away |
| 2 | Managed mode in the app: the managed settings, the notice, enrollment, sending on launch and Re-scan | Companies can start collecting scans |
| 3 | Fleet server and dashboard (Cloudflare and Docker), the public demo | The full story, and the showcase |
| 4 | Background scanning, tray icon, start at login | Keeps the dashboard current without anyone opening the app |
| 5 | Optional: email or webhook alerts for chosen filters | IT hears about problems instead of checking |

Each phase ends with a release.

## Testing

Following the repo's conventions (`CLAUDE.md`):

- **Pure functions with sample input:** validating the managed settings
  (missing, malformed, non-https, unknown fields), parsing `reg query`'s
  output and a profile converted with `plutil -convert json`, the Linux
  ownership check from `stat` values, building the envelope.
- **Worker tests** in Node with a stubbed D1, as `server/report-mailer`'s
  are: enrollment, bad and revoked tokens, oversized and non-JSON bodies,
  rate limits, retention, and escaping in the dashboard's HTML.
- **CI:** the packaged app run with `--report-json` on each OS, checking the
  output parses and matches the schema, alongside the existing self-test.
- **The VMs:** managed settings put on each of the Windows (registry),
  Ubuntu and Fedora (`/etc`) VMs, reporting to a private test deployment,
  `workstation-scanner-teams-test` on Cloudflare: real https, set up as a
  company would. Its admin token is set by the owner with
  `npx wrangler secret put ADMIN_TOKEN`.

## Decisions

Agreed 2026-10-07:

1. **A Docker version** of the server for companies that don't use
   Cloudflare, alongside the Cloudflare one.
2. **One enrollment key per company** to start, with room for per-group keys
   later.
3. **Speed tests:** IT's choice in the managed settings (`speedTest`), defaulting
   to only when someone opens the app.
4. **The Explain button:** IT's choice in the managed settings (`explain`).
5. **The name:** Workstation Scanner for Teams.
6. **One app** for individuals and companies; managed mode comes from
   the managed settings.

Agreed 2026-10-08, for phase 2:

7. **Where the settings live:** each OS's standard place for admin-only
   settings (a `Policies` registry key, a configuration profile, a root-owned
   file in `/etc` that the app checks), not a JSON file on every OS.
8. **No keychain on Linux:** a file only the user can read, rather than
   refusing to enroll.
9. **One report per launch or Re-scan**, after the speed test.
10. **Offline:** keep only the latest unsent report.
11. **Shared computers:** one row per OS user, for now.
12. **`include`:** not in phase 2.
13. **"What's sent":** plain words, no JSON.
14. **`speedTest: "daily"`** accepted now, acting as `"open"` until phase 4.
15. **VM tests** against a private test deployment on Cloudflare.
