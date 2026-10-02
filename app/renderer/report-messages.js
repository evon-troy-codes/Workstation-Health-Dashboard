// report-messages.js — the text for a share that didn't work and for a
// failed AI explanation. Kept apart from the JSX so they can be unit tested;
// the reason codes come from main.js (whd:share-*) and app/main/report.js.

// Why sharing the report didn't work, in words. A cancelled save isn't a
// failure and gets no message.
export function shareFailure(res) {
  switch (res && res.reason) {
    case "cancelled":    return null;
    case "no-scan":      return "There's no scan to share yet.";
    case "no-mail-app":  return "Couldn't open an email app. Save the report as a file instead, and attach it to an email.";
    case "write-failed": return "Couldn't save the file there. Try another folder.";
    default:             return "That didn't work. Try again, or pick another way to share.";
  }
}

// Why "Explain my results" failed, in words. Reasons come from
// app/main/report.js (requestExplanation) and the Worker's /explain.
export function explainFailure(res) {
  const r = res || {};
  if (r.reason === "no-endpoint") return "AI explanations aren't set up in this build.";
  if (r.reason === "no-scan") return "There's no scan to explain yet.";
  if (r.reason === "timeout") return "The AI took too long to answer. Try again in a moment.";
  if (r.reason === "unreachable" || r.reason === "redirected" || r.reason === "insecure-url") {
    return "Couldn't reach the AI service. Check the connection and try again.";
  }
  switch (r.error) {
    case "not-configured": return "The AI service isn't set up yet.";
    case "rate-limited":
    case "ai-busy": return "The AI service is busy. Try again in a minute.";
    case "ai-daily-limit": return "AI explanations have reached today's limit. Try again tomorrow.";
    case "ai-monthly-limit": return "AI explanations have reached this month's limit.";
    case "ai-refused": return "The AI declined to assess this scan.";
    // Out of prepaid credit: trying again won't help, so it doesn't say to.
    case "ai-unavailable": return "AI explanations are unavailable right now.";
    case "ai-timeout": return "The AI took too long to answer. Try again in a moment.";
    case "ai-unreachable": return "The AI service couldn't reach the AI model. Try again in a moment.";
    default: return "Couldn't get an explanation. Try again in a moment.";
  }
}
