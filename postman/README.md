# Postman collection

`Cloudflare-Speed-Test.postman_collection.json` covers the HTTP endpoints the
dashboard's speed test measures against ([`speedtest.js`](../app/renderer/speedtest.js)),
with test scripts on every request.

## Running it

**In Postman:** Import → select the JSON file → open the collection → **Run**.
Run the requests in order; each one logs its measurement to the Postman
console.

**From the command line** (uses [Newman](https://github.com/postmanlabs/newman),
Postman's CLI runner; nothing to install first):

```bash
npm run test:postman
```

A full run downloads about 27 MB, most of it in request 4.

## What each request checks

| Request | Endpoint | Tests |
| --- | --- | --- |
| 1. Latency probe | `GET /__down?bytes=1000` | 200; exactly 1000 bytes; `application/octet-stream`; answers within 2 s; `Server-Timing` includes Cloudflare's TCP RTT |
| 2. Download chunk | `GET /__down?bytes=1000000` | 200; full chunk delivered; logs rough throughput |
| 3. Upload chunk | `POST /__up` | 200; empty reply body; logs rough throughput |
| 4. Download with 429 fallback | `GET /__down?bytes=…` | Steps down 25 → 10 → 5 → 1 MB on each 429, the same way the app does, until Cloudflare accepts |

## Reading the results

- **The throughput numbers are not benchmarks.** Each is one request over one
  connection, and Postman's response time includes connection setup and
  time-to-first-byte. The app runs parallel streams and counts only bytes moved
  over the measurement window, which is why it reports much higher figures.
- **Request 1 logs two latencies.** Postman's round trip includes HTTP and TLS
  overhead; the `Server-Timing` RTT is Cloudflare's measurement of the bare TCP
  connection. The gap between the two is protocol overhead, not network
  distance.
- **Request 4 usually succeeds on the first try.** Cloudflare only returns 429
  after a client has pulled a lot of data recently. Run the collection a few
  times in a row to see it step down. The retry uses `setNextRequest`, so it only
  works in the Collection Runner or Newman — sent alone from the request tab it
  makes one attempt.

To test the fallback without waiting on Cloudflare, point `baseUrl` at a server
that returns 429 for large requests:

```bash
npx newman run postman/Cloudflare-Speed-Test.postman_collection.json \
  --folder "4. Download with 429 fallback" \
  --env-var "baseUrl=http://127.0.0.1:<port>"
```
