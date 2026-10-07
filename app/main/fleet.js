// fleet.js — Workstation Scanner for Teams ("fleet mode"): what the app
// sends, or prints, for IT. See docs/design/fleet-mode.md.
//
// Phase 1 is `--report-json`: one scan, printed as JSON (or written to a
// file), with no window, so device-management and RMM tools can collect it.

// The report envelope's version. Bump it when its shape changes, so a fleet
// server can accept old and new apps side by side.
const SCHEMA = 1;

// The command line → { reportJson, out } or { error }. `--report-json`
// prints to stdout; `--report-json=<path>` writes the file instead (the
// reliable form on Windows, where a windowed app's stdout reaches only a
// redirect). Anything else on the line is left for Electron and Chromium.
function parseCliArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const hits = args.filter((a) => a === "--report-json" || (typeof a === "string" && a.startsWith("--report-json=")));
  if (!hits.length) return { reportJson: false };
  if (hits.length > 1) return { error: "--report-json was given more than once" };
  const [flag] = hits;
  if (flag === "--report-json") return { reportJson: true, out: null };
  const out = flag.slice("--report-json=".length).trim();
  if (!out) return { error: "--report-json= needs a file path after the =" };
  return { reportJson: true, out };
}

// A report (buildReport's output) in the envelope a fleet server receives:
// { schema, appVersion, sentAt, trigger, report }. trigger is "cli",
// "launch", "rescan" or "schedule".
function buildEnvelope(report, { appVersion, trigger, now = new Date() }) {
  return {
    schema: SCHEMA,
    appVersion: typeof appVersion === "string" ? appVersion : null,
    sentAt: now.toISOString(),
    trigger,
    report,
  };
}

module.exports = { parseCliArgs, buildEnvelope, SCHEMA };
