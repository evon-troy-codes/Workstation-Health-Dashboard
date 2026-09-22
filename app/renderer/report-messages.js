// report-messages.js — the toast text for a failed report. Kept apart from the
// JSX so it can be unit tested; the reason codes come from app/main/report.js.

// Why a report failed, in words, so a bad setting and a network problem don't
// look alike.
export function reportFailure(res) {
  switch (res && res.reason) {
    case "insecure-url": return "Report failed: endpoint must use https";
    case "timeout":      return "Report failed: timed out";
    case "unreachable":  return "Report failed: couldn't reach the server";
    case "redirected":   return "Report failed: endpoint redirected, not sent";
    case "http":         return `Report failed (HTTP ${res.status})`;
    case "no-scan":      return "Report failed: no scan to send yet";
    default:             return "Report failed";
  }
}
