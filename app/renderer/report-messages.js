// report-messages.js — the text for a failed report, and the address check
// the email dialog runs before sending. Kept apart from the JSX so they can be
// unit tested; the reason codes come from app/main/report.js, and the HTTP
// statuses from the report-mailer Worker (server/report-mailer).

// The same address rule main and the Worker apply: one @, a dot in the domain,
// no spaces, at most 254 characters.
export function isEmail(value) {
  if (typeof value !== "string") return false;
  const email = value.trim();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Why a report failed, in words, so a bad setting and a network problem don't
// look alike.
export function reportFailure(res) {
  switch (res && res.reason) {
    case "insecure-url": return "Report failed: endpoint must use https";
    case "timeout":      return "Report failed: timed out";
    case "unreachable":  return "Report failed: couldn't reach the server";
    case "redirected":   return "Report failed: endpoint redirected, not sent";
    case "http":
      if (res.status === 403) return "Report not sent: that email domain isn't allowed";
      if (res.status === 429) return "Report not sent: too many reports, try again in a minute";
      return `Report failed (HTTP ${res.status})`;
    case "no-scan":      return "Report failed: no scan to send yet";
    case "invalid-email": return "Report not sent: enter a valid email address";
    default:             return "Report failed";
  }
}
