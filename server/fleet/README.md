# Workstation Scanner for Teams: the fleet server

The server a company's computers report to, so its IT team can see every
computer's readings in one dashboard. The design, and why it works this way,
is in [docs/design/fleet-mode.md](../../docs/design/fleet-mode.md).

**Status:** in progress. The server runs on Cloudflare or in Docker, and
computers can enroll and report. The dashboard comes next, and until then
setup is done with the admin routes below.

## What's here

| File | What it does |
| --- | --- |
| `src/app.js` | The routes computers use: health, enroll, reports |
| `src/store.js` | Setup, enrollment, tokens and reports, written once |
| `src/sql.js` | The small SQL interface `store.js` uses, over Cloudflare D1 or Node's `node:sqlite` |
| `src/schema.js` | The tables (`settings`, `devices`, `reports`) |
| `src/http.js` | JSON-only bodies, the size cap, bearer tokens |
| `src/crypto.js` | Random keys and tokens, SHA-256 |
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

Once it's running, set your organization's name and get the enrollment key
(replace the address and token):

```
curl -X POST https://teams.example.com/v1/admin/setup \
  -H "Authorization: Bearer <admin token>" -H "Content-Type: application/json" \
  -d '{"organization":"Acme IT"}'
```

The answer holds the enrollment key, shown this once. It goes in each
computer's `managed.json`. To replace it later (old computers keep working,
new ones need the new key): `POST /v1/admin/rotate-key` with the same
header.

Reports older than 90 days are deleted daily; each computer's latest is
always kept.

## Tests

`npm test` at the repo root runs the tests in `src/` against a real
in-memory SQLite database (`node:sqlite`), with no setup: the routes, the
store, the Worker (against a D1 stand-in over SQLite), and the Node server
over real HTTP.
