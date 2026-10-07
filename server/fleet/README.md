# Workstation Scanner for Teams: the fleet server

The server a company's computers report to, so its IT team can see every
computer's readings in one dashboard. The design, and why it works this way,
is in [docs/design/fleet-mode.md](../../docs/design/fleet-mode.md).

**Status:** in progress. This folder has the server's core; the Cloudflare
and Docker packaging and the dashboard come next.

## What's here

| File | What it does |
| --- | --- |
| `src/app.js` | The routes computers use: health, enroll, reports |
| `src/store.js` | Setup, enrollment, tokens and reports, written once |
| `src/sql.js` | The small SQL interface `store.js` uses, over Cloudflare D1 or Node's `node:sqlite` |
| `src/schema.js` | The tables (`settings`, `devices`, `reports`) |
| `src/http.js` | JSON-only bodies, the size cap, bearer tokens |
| `src/crypto.js` | Random keys and tokens, SHA-256 |

It uses only Web Crypto and the Fetch `Request`/`Response`, so the same code
runs in a Cloudflare Worker and in Node 24, with no dependencies.

## The API

| Route | Body | Answer |
| --- | --- | --- |
| `GET /v1/health` | none | `200 { ok, organization }`, or `{ ok, setUp: false }` |
| `POST /v1/enroll` | `{ enrollmentKey, deviceId, name }` | `200 { ok, deviceToken }` |
| `POST /v1/reports` | the app's report envelope, with `Authorization: Bearer <deviceToken>` | `202 { ok }` |

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

## Tests

`npm test` at the repo root runs `src/app.test.js` against a real
in-memory SQLite database (`node:sqlite`), with no setup.
