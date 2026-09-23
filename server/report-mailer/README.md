# report-mailer

A Cloudflare Worker that emails a Workstation Scanner report to the address the
user types into the app's **Send report** dialog. The app POSTs
`{ email, report }` here; the Worker lays the report out as an email, attaches
the full report as JSON, and sends it through [Resend](https://resend.com).

The Resend API key lives only in the Worker, as a secret. It is never built into
the app: the repo is public and the installers can be unpacked.

## What it accepts

`POST /` with `Content-Type: application/json`:

```json
{ "email": "name@example.com", "report": { "hostname": "…", "cpu": { … }, … } }
```

| Status | Body | Meaning |
| --- | --- | --- |
| 200 | `{ "ok": true }` | Sent |
| 400 | `{ "error": "invalid-email" }`, `"invalid-report"` or `"bad-request"` | The request was malformed |
| 403 | `{ "error": "recipient-not-allowed" }` | The address's domain isn't in `ALLOWED_DOMAINS` |
| 405 | `{ "error": "method-not-allowed" }` | Not a POST |
| 413 | `{ "error": "too-large" }` | Body over 256 KB |
| 429 | `{ "error": "rate-limited" }` | Too many reports from this client or to this address |
| 500 | `{ "error": "not-configured" }` | `RESEND_API_KEY` or `FROM_ADDRESS` missing |
| 502 | `{ "error": "send-failed", "status": … }` | Resend refused the email |

## Abuse protection

Anyone can call this endpoint, and it sends mail to an address the caller
picks. It is built so that isn't worth abusing:

- The email contains only report fields, escaped, cut to 200 characters each
  and 20 items per list, in a fixed layout. A caller can't send a message of
  their own.
- Five reports a minute per client IP, and five per recipient address.
- `ALLOWED_DOMAINS` can limit recipients to your organization's domains. Set it
  if the app is only for your own people.

## Deploy

You need a Cloudflare account and a Resend account (both have free tiers), and
a domain you can add DNS records to, for Resend to send from.

1. **Resend:** add and verify your sending domain (Resend shows the DNS records
   to add), then create an API key with "Sending access".
2. **Configure** `wrangler.toml`: set `FROM_ADDRESS` to an address on the
   verified domain, and `ALLOWED_DOMAINS` if you want to limit recipients.
3. **Deploy** from this folder:

   ```bash
   npm install
   npx wrangler login
   npx wrangler secret put RESEND_API_KEY   # paste the Resend key
   npx wrangler deploy
   ```

   Wrangler prints the Worker's URL, like
   `https://workstation-scanner-report-mailer.<you>.workers.dev`.
4. **Point the app at it:** put that URL in the repo's `package.json`,

   ```json
   "workstationScanner": { "reportUrl": "https://workstation-scanner-report-mailer.<you>.workers.dev/" }
   ```

   and build the installers (a push to `main`, or `npm run dist`). An installed
   app reads the URL from there. `WHD_REPORT_URL` overrides it, which is handy
   for testing against `npx wrangler dev`.
5. **Try it:** open the app, click **Send report**, and send one to yourself.

## Tests

`src/index.test.js` runs with the rest of the repo's tests (`npm test` at the
repo root). Resend and the rate limiter are stubbed, so the tests send nothing.
