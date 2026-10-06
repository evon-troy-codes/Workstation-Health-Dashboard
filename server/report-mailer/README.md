# report-mailer

The Cloudflare Worker behind Workstation Scanner's **Explain my results**. The
app POSTs a scan with everything identifying already removed; the Worker asks
Claude for a short assessment and returns it. The Anthropic API key lives only
here, as a Worker secret: the app is public and its installers can be
unpacked.

It used to email reports too, which is where its name and URL come from (they
stay, so installed apps keep finding it). That was removed on 2026-10-02: the
app is going public, and a service that emails any address anyone types is a
spam relay in waiting, with mail that looks like phishing to people who never
heard of the app. The app now shares reports from the person's own email, a
saved file or the clipboard. `POST /` answers **410** `{ "error":
"email-removed" }`.

| Request | Answer |
| --- | --- |
| `POST /explain` with `{ "scan": { … } }` | see below |
| `POST /` | 410 `email-removed` |
| Any other path | 404 `not-found` |
| Not a POST | 405 `method-not-allowed` |
| Body over 256 KB | 413 `too-large` |

## AI explanations (`POST /explain`)

The app's **Explain my results** posts `{ "scan": { … } }` here, a copy of its
report with everything identifying removed. The Worker keeps only the fields
it knows (`src/explain.js`), asks Claude for a summary and up to five findings,
and answers `{ ok: true, summary, findings, model }`. The Anthropic key is a
Worker secret, `ANTHROPIC_API_KEY`.

Only `Content-Type: application/json` is accepted (anything else is 415
`unsupported-media-type`). The app always sends it, and a web page can't send
it to another site without a CORS preflight, which the Worker refuses, so no
page can make its visitors' browsers spend the budget. Bodies are capped at
256 KB, counted in bytes as they arrive.

Every call spends Anthropic credit and anyone can make one, so it is capped
four ways:

- About five calls a minute per client IP (`RATE_LIMITER`, key `ai:<ip>`).
- `AI_DAILY_PER_IP_LIMIT` calls a day per caller (default 3), so one person
  with a script can't use up everyone's day. A caller is an IPv4 address or
  an IPv6 /64, kept in the budget counter only as a hash salted afresh each
  UTC day. Past it, that caller gets 429 `ai-daily-limit`.
- `AI_MONTHLY_LIMIT` calls a calendar month and `AI_DAILY_LIMIT` a day, in
  UTC, across all callers (`src/budget.js`, a Durable Object bound as
  `AI_BUDGET`). Past either, `/explain` answers 429 `ai-monthly-limit` or
  `ai-daily-limit` and doesn't call Claude. The defaults, 100 and 10, keep a
  month under about $5 at 3-4 cents a call on Opus 5.5; change them in
  `wrangler.toml`. The daily limit stops one burst of abuse using up the
  month on its first day. If the counter can't be reached, the call is
  refused (503 `ai-busy`), as it is if the rate limiter fails. A call that never reached Claude (no key, no
  connection, or an API error such as a rate limit or an empty balance) is
  given back to the budget, so an outage doesn't use up the day; a call that
  timed out stays counted, since it may have run. A failure the Worker didn't
  expect is given back too, and answered as JSON (502 `ai-failed`) rather
  than Cloudflare's error page.
- Once Claude's day or month is spent, answers come from a free Workers AI
  model instead (`FREE_AI_MODEL`, default Gemma 4, through the `AI`
  binding), within Cloudflare's free daily allocation of 10,000 neurons
  (about 20 per explanation). It has its own caps, `FREE_AI_DAILY_LIMIT`
  (250) a day and `FREE_AI_DAILY_PER_IP_LIMIT` (10) per caller, kept in the
  same counter under `usage:free`. When those, or Cloudflare's allocation,
  run out, the answer is 429 `ai-daily-limit`. Thinking is turned off for
  Gemma 4 (`chat_template_kwargs.enable_thinking`): on, it took 30-60 s.
  Empty `FREE_AI_MODEL` turns the fallback off.
- The Anthropic credit itself: prepaid, with auto-reload off, it is the hard
  ceiling. When it runs out, `/explain` answers 503 `ai-unavailable`, and the
  app says explanations are unavailable rather than asking to try again.

Each call is one attempt of at most 50 seconds, with no retry, so it always
ends inside the app's own 60-second wait.

## Deploy

You need a Cloudflare account (the free plan is enough) and an Anthropic API
key with prepaid credit.

1. **Deploy** from this folder:

   ```bash
   npm install
   npx wrangler login
   npx wrangler secret put ANTHROPIC_API_KEY   # paste the key; it isn't shown
   npx wrangler deploy
   ```

   Wrangler prints the Worker's URL, like
   `https://workstation-scanner-report-mailer.<you>.workers.dev`.

   Deploy with wrangler, not by pasting `src/index.js` into the Cloudflare
   dashboard: only `wrangler deploy` sets up the rate limit and the AI budget
   counter from `wrangler.toml`. A wrangler deploy replaces the dashboard's
   variables with `wrangler.toml`'s, and keeps secrets.
2. **Point the app at it:** put that URL in the repo's `package.json`,

   ```json
   "workstationScanner": { "reportUrl": "https://workstation-scanner-report-mailer.<you>.workers.dev/" }
   ```

   and build the installers (a push to `main`, or `npm run dist`). An installed
   app reads the URL from there. `WHD_REPORT_URL` overrides it, which is handy
   for testing against `npx wrangler dev`.
3. **Try it:** open the app and click **Explain my results**. It uses one of
   the day's explanations.

## Tests

`src/index.test.js` (routing), `src/explain.test.js` and `src/budget.test.js`
run with the rest of the repo's tests (`npm test` at the repo root). The
Anthropic API, the rate limiter and the budget counter are stubbed, so the
tests send nothing and spend nothing.
