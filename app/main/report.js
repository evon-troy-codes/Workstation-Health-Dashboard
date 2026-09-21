// report.js — POSTs the health report to the optional WHD_REPORT_URL endpoint.
// Kept out of main.js so the result shape the renderer depends on can be unit
// tested without Electron.
//
// Every result carries `ok`. A skipped or failed send also carries `reason`, a
// short code the renderer turns into a readable toast. A failure adds `error`,
// the raw text for anyone debugging the endpoint.

const REPORT_TIMEOUT_MS = 15000;

// Maps a rejected fetch to a reason code.
function classifyReportError(err) {
  if (err && (err.name === "TimeoutError" || err.name === "AbortError")) return "timeout";
  if (/redirect/i.test(String(err && err.cause && err.cause.message))) return "redirected";
  return "unreachable";
}

// The text worth keeping from a rejected fetch. undici wraps the real failure
// as `cause` under a generic "fetch failed"; and when a host resolves to both
// IPv6 and IPv4 and every address refuses, that cause is an AggregateError
// whose own message is empty, with the per-address errors inside it.
function errorDetail(err) {
  const cause = (err && err.cause) || err;
  if (cause && Array.isArray(cause.errors) && cause.errors.length) {
    return cause.errors.map(String).join("; ");
  }
  return String(cause);
}

async function sendReport(endpoint, facts, fetchImpl = fetch) {
  if (!endpoint) {
    return { ok: true, skipped: true, reason: "no-endpoint" };
  }
  // The report carries hostname, username, MAC and IP — refuse to put that
  // on the wire in the clear, however the endpoint was configured.
  if (!/^https:\/\//i.test(endpoint)) {
    return { ok: false, reason: "insecure-url", error: "WHD_REPORT_URL must be an https:// URL" };
  }
  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(facts),
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
      // Following redirects would let an https endpoint bounce the POST,
      // body and all, to a plain http:// URL, undoing the check above.
      redirect: "error",
    });
    return res.ok
      ? { ok: true, status: res.status }
      : { ok: false, reason: "http", status: res.status };
  } catch (err) {
    return { ok: false, reason: classifyReportError(err), error: errorDetail(err) };
  }
}

module.exports = { sendReport, classifyReportError, errorDetail };
