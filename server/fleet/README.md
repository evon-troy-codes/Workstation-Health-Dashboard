# Workstation Scanner for Teams: the fleet server

The server a company's computers report to, so its IT team can see every
computer's readings in one dashboard. The design, and why it works this way,
is in [docs/design/fleet-mode.md](../../docs/design/fleet-mode.md).

**Status:** in progress. The server runs on Cloudflare or in Docker,
computers can enroll and report, and IT sees them in the dashboard. The app
supports managed mode, with automated validation covering the config parser
and fleet enrollment flow; live VM validation against a private test
deployment remains.

## What's here

| File | What it does |
| --- | --- |
| `src/app.js` | The routes computers use: health, enroll, reports |
| `src/store.js` | Setup, enrollment, tokens and reports, written once |
| `src/sql.js` | The small SQL interface `store.js` uses, over Cloudflare D1 or Node's `node:sqlite` |
| `src/schema.js` | The tables (`settings`, `devices`, `reports`) |
| `src/http.js` | JSON-only bodies, the size cap, bearer tokens |
| `src/crypto.js` | Random keys and tokens, SHA-256 |
| `src/dashboard.js` | The IT dashboard: sign-in, setup, the computers list, a page per computer, settings |
| `src/summary.js` | A report as the list's columns, its filters, and the CSV export |
| `src/session.js` | The dashboard's signed session cookie |
| `src/worker.js` | The Cloudflare Worker's entry: D1, the rate limiter binding, the daily cron |
| `src/node-server.js` | The plain Node server, for Docker: SQLite file, in-memory rate limits |
| `wrangler.toml` | The Cloudflare configuration |
| `Dockerfile`, `compose.yaml` | The container |

It uses only Web Crypto and the Fetch `Request`/`Response`, so the same code
runs in a Cloudflare Worker and in Node 24, with no dependencies.

## The API

| Route | Body | Answer |
| --- | --- | --- |
| `GET /v1/health` | none | `200 { ok, organization }`, or `{ ok, setUp: false }` |
| `POST /v1/enroll` | `{ enrollmentKey, deviceId, name }` | `200 { ok, deviceToken }` |
| `POST /v1/reports` | the app's report envelope, with `Authorization: Bearer <deviceToken>` | `202 { ok }` |
| `POST /v1/admin/setup` | `{ organization }`, with `Authorization: Bearer <admin token>` | `200 { ok, enrollmentKey }` |
| `POST /v1/admin/rotate-key` | none, with the admin token | `200 { ok, enrollmentKey }` |

Errors are JSON `{ ok: false, error }`: `bad-enrollment-key` (403),
`revoked` (403 on enroll, 401 on reports), `unknown-device` (401),
`not-set-up` (503), `unsupported-schema` (422), `bad-device-id`,
`invalid-report` and `bad-request` (400), `unsupported-media-type` (415),
`too-large` (413), `rate-limited` (429).

- Only hashes of the enrollment key and of device tokens are stored.
- A revoked computer can't re-enroll with the enrollment key.
- Re-enrolling (after a reinstall) replaces the computer's token.
- Each report is stored as the server re-serialized it, never as the raw
  text it received.

## Running it

Choose one. Both need an **admin token**: a long random secret that turns on
the admin routes. Make one with `openssl rand -base64 32`, and keep it safe.

### On Cloudflare

From this folder, with a Cloudflare account and
[Wrangler](https://developers.cloudflare.com/workers/wrangler/) logged in:

1. `npx wrangler d1 create workstation-scanner-teams`, then paste the
   database's `database_id` into `wrangler.toml`.
2. `npx wrangler secret put ADMIN_TOKEN` and paste the admin token.
3. `npx wrangler deploy`. The tables are created on the first request.

### With Docker

From this folder:

1. Put `ADMIN_TOKEN=<the admin token>` in a `.env` file here.
2. `docker compose up -d`. The database lives in the `fleet-data` volume.
3. Put HTTPS in front of port 8080 with your reverse proxy (Caddy, Traefik
   or nginx). The server speaks plain HTTP and must not be exposed without
   HTTPS. `compose.yaml` only listens on 127.0.0.1 for that reason.

### Setting it up

Open the server's address in a browser, sign in with the admin token, and
name your organization. The dashboard shows the enrollment key once, with
the managed settings ready to copy for each OS: a `.reg` file for Windows,
a configuration profile's settings for macOS, and a JSON file for Linux.

Or, from a script (replace the address and token):

```
curl -X POST https://teams.example.com/v1/admin/setup \
  -H "Authorization: Bearer <admin token>" -H "Content-Type: application/json" \
  -d '{"organization":"Acme IT"}'
```

The answer holds the enrollment key, shown this once. It goes in each
computer's managed settings (below). To replace it later (old computers keep working,
new ones need the new key): `POST /v1/admin/rotate-key` with the same
header.

Reports older than 90 days are deleted daily; each computer's latest is
always kept.

### Pointing computers at it

Each computer needs managed settings, in the place its OS keeps settings
only an administrator or your device management can set, so users can't
switch it off or point it elsewhere:

| OS | Where | Deploy with |
| --- | --- | --- |
| Windows | registry values under `HKLM\SOFTWARE\Policies\WorkstationScanner` | Group Policy, Intune, a `.reg` file |
| macOS | a configuration profile, computer scope, with custom settings for the preference domain `com.evontroy.workstation-scanner` | Jamf, Intune, Kandji, any MDM |
| Linux | `/etc/workstation-scanner/managed.json`, owned by root and writable only by root (the app ignores it otherwise) | Ansible, Puppet, a package, a script |

The settings, as the Linux file:

```json
{
  "version": 1,
  "organization": "Acme IT",
  "fleetUrl": "https://teams.example.com/",
  "enrollmentKey": "ek_…",
  "speedTest": "open",
  "explain": true
}
```

On Windows they are values of the same names: strings, except `version`
and `explain`, which are DWORDs (`explain` 0 or 1). `fleetUrl` must be
https. `explain: false` hides the app's "Explain my results" button.
`speedTest` is `"open"`; `"daily"` is accepted, and acts as `"open"` until
the app scans in the background.

The app then shows a permanent "Managed by Acme IT" line, with a "What's
sent" link that lists, in plain words, what goes to your server. It enrolls
once and sends a report each time it's opened or re-scanned. Your staff
should be told: collecting data from employees' computers needs notice in
many places (GDPR in Europe, some US states), and that notice is yours to
give.

## The dashboard

Every page needs signing in with the admin token, so the data is never
public even if nothing is in front of the server. A session lasts 12 hours,
in a cookie that scripts can't read, that is only sent over HTTPS (or to
localhost), and never on a request from another site. Changing ADMIN_TOKEN
signs everyone out. For your staff's own sign-in on top, put **Cloudflare
Access** in front (Cloudflare) or an SSO proxy such as **oauth2-proxy**
(Docker).

- **Computers:** one row per computer with its user, OS, last report,
  pending updates (including snap and Flatpak), firewall, antivirus, disk
  and app version. Search, sort, and filter by pending updates, firewall or
  antivirus not active, disk over a percentage, silent for some days, or an
  older app version. Unknown readings show under those filters too, since
  they can't be confirmed. **Download this list as CSV** exports what's on
  screen.
- **A computer:** its latest readings, its recent history, and **Remove**,
  which stops its token working (its history stays), or **Restore**.
- **Settings:** the managed settings for each OS, and a new enrollment key
  when the old one is lost or leaked.

The pages have no JavaScript: their Content Security Policy allows no
scripts at all. Every value from a report is escaped, and the CSV export
defuses anything a spreadsheet would run as a formula.

## Tests

`npm test` at the repo root runs the tests in `src/` against a real
in-memory SQLite database (`node:sqlite`), with no setup: the routes, the
store, the Worker (against a D1 stand-in over SQLite), and the Node server
over real HTTP.
