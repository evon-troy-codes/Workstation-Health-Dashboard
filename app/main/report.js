// report.js — builds the report (for Share report, see share.js) and the AI
// scan, and asks the report service (server/report-mailer) for an AI
// explanation. Kept out of main.js so the shapes the renderer depends on can
// be unit tested without Electron.
//
// Reports are no longer emailed from here: the app is public, and a service
// that mails any address anyone types was a spam relay in waiting. People
// share a report from their own email, a saved file or the clipboard.

// Where the report service is. WHD_REPORT_URL wins, so a developer or IT can point a
// build elsewhere; otherwise the URL built into package.json
// ("workstationScanner": { "reportUrl": ... }), which is how an installed
// app, started from a menu with no environment to set, finds it.
function reportEndpoint(env, pkg) {
  const fromEnv = env && env.WHD_REPORT_URL;
  if (fromEnv) return fromEnv;
  const cfg = pkg && pkg.workstationScanner;
  return (cfg && typeof cfg.reportUrl === "string" && cfg.reportUrl.trim()) || "";
}

// Maps a rejected fetch to a reason code.
function classifyReportError(err) {
  if (err && (err.name === "TimeoutError" || err.name === "AbortError")) return "timeout";
  // undici gives up connecting after 10 s, before our own timeout: a server
  // that accepts the connection and never answers is a timeout, not "can't
  // reach the server".
  if (err && err.cause && err.cause.code === "UND_ERR_CONNECT_TIMEOUT") return "timeout";
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

// systemd names a USB network adapter after its MAC address: "enx" + MAC for
// Ethernet, "wlx" + MAC for Wi-Fi. Shared, such a name would carry the MAC
// out of the report anyway, so it goes out as what it is instead.
const MAC_NAMED_IFACE = /^(en|wl)x[0-9a-f]{12}$/i;
function shareableInterface(name) {
  if (typeof name !== "string" || !MAC_NAMED_IFACE.test(name)) return name;
  return name.slice(0, 2).toLowerCase() === "wl" ? "USB Wi-Fi adapter" : "USB Ethernet adapter";
}

// The report main sends: its own last scan, with the deferred results merged
// in as the renderer merges them. Only the speed test runs in the renderer, so
// that is all taken from it, and only as numbers and flags. Anything else the
// renderer passes is ignored.
function buildReport(facts, deferred, fromRenderer) {
  const report = { ...facts };
  // The network card's MAC address and the Wi-Fi network's name stay on this
  // machine: lasting identifiers IT rarely needs from a report. The report
  // mailer leaves them out of the email too.
  if (facts.network) {
    const { mac, ssid, ...network } = facts.network;
    report.network = { ...network, interface: shareableInterface(network.interface) };
  }
  if (deferred) {
    report.os = {
      ...facts.os,
      pendingUpdates: deferred.pendingUpdates,
      lastUpdateCheck: deferred.lastUpdateCheck,
      lastUpdateKind: deferred.lastUpdateKind,
      appUpdates: deferred.appUpdates || {},
    };
    report.disk = { ...facts.disk, ssd: deferred.ssd };
    report.backgroundApps = deferred.backgroundApps || facts.backgroundApps;
    report.display = deferred.display || facts.display;
    report.firewall = deferred.firewall || facts.firewall;
  }
  const b = (fromRenderer && fromRenderer.bandwidth) || {};
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  report.bandwidth = {
    downMbps: num(b.downMbps),
    upMbps: num(b.upMbps),
    ping: num(b.ping),
    jitter: num(b.jitter),
    measuredAt: num(b.measuredAt),
  };
  if (typeof b.partial === "boolean") report.bandwidth.partial = b.partial;
  if (typeof b.failed === "boolean") report.bandwidth.failed = b.failed;
  return report;
}

// ---- AI assessment ("Explain my results") ---------------------------------
//
// The report mailer's /explain asks Claude to explain a scan. What leaves the
// machine is buildAiScan's copy: an allow-list of readings, with nothing that
// identifies the machine or the person (no hostname, user, MAC, IP, gateway,
// DNS servers, Wi-Fi name, audio or monitor names). A field added to the
// report later stays out until it is added here. The Worker filters again.

const AI_TIMEOUT_MS = 60000;

function buildAiScan(report) {
  const r = report || {};
  const o = (v) => (v && typeof v === "object" ? v : {});
  // Only plain values leave the machine: a field that holds an object
  // (whatever is nested in it) goes out as null.
  const p = (v) => (v == null || ["string", "number", "boolean"].includes(typeof v) ? v : null);
  const cpu = o(r.cpu), ram = o(r.ram), disk = o(r.disk), os = o(r.os), net = o(r.network);
  const bw = o(r.bandwidth), power = o(r.power), apps = o(r.backgroundApps), display = o(r.display);
  return {
    machineType: p(r.machineType),
    uptime: p(r.uptime),
    os: { name: p(os.name), version: p(os.version), pendingUpdates: p(os.pendingUpdates),
      lastUpdateCheck: p(os.lastUpdateCheck), lastUpdateKind: p(os.lastUpdateKind),
      // A key only for an installed app store: absent is "not installed",
      // null is "couldn't check".
      appUpdates: Object.fromEntries(["snap", "flatpak"].filter((k) => k in o(os.appUpdates))
        .map((k) => [k, p(os.appUpdates[k])])) },
    // The speed only with its kind (maximum or base clock), and none when
    // neither is known, rather than the 0 that stands for that.
    cpu: { model: p(cpu.model), cores: p(cpu.cores), threads: p(cpu.threads),
      ghz: cpu.ghzKind ? p(cpu.ghz) : null, ghzKind: p(cpu.ghzKind) || null },
    ram: { totalGB: p(ram.totalGB), freeGB: p(ram.freeGB), pressure: p(ram.pressure), type: p(ram.type) },
    disk: { totalGB: p(disk.totalGB), freeGB: p(disk.freeGB), usedPercent: p(disk.usedPercent), ssd: p(disk.ssd) },
    display: { monitors: (Array.isArray(display.monitors) ? display.monitors : []).map((m) => ({
      builtin: p(o(m).builtin), main: p(o(m).main), resolution: p(o(m).resolution), refreshRate: p(o(m).refreshRate) })) },
    network: { type: p(net.type), isWired: p(net.isWired), isVirtual: p(net.isVirtual), linkSpeed: p(net.linkSpeed) },
    vpn: { detected: p(o(r.vpn).detected) },
    bandwidth: { downMbps: p(bw.downMbps), upMbps: p(bw.upMbps), ping: p(bw.ping), jitter: p(bw.jitter),
      partial: p(bw.partial), failed: p(bw.failed) },
    // null (a Linux machine with none installed) stays null: not checked,
    // rather than "none found", which the AI might treat as a problem.
    // A Windows check that failed (checked: false) is "not checked" too.
    antivirus: r.antivirus == null || o(r.antivirus).checked === false ? null : { products: (Array.isArray(o(r.antivirus).products) ? r.antivirus.products : []).map((a) => ({
      name: p(o(a).name), running: p(o(a).running), definitionsAge: p(o(a).definitionsAge) })) },
    // Unlike antivirus, an empty list is a reading ("no firewall service
    // found"); only a failed check, or none at all, is null.
    firewall: r.firewall == null || (o(r.firewall).checked === false && !(Array.isArray(o(r.firewall).products) && r.firewall.products.length)) ? null
      : { products: (Array.isArray(o(r.firewall).products) ? r.firewall.products : []).map((f) => ({
        name: p(o(f).name), active: p(o(f).active), detail: p(o(f).detail) })) },
    power: { hasBattery: p(power.hasBattery), batteryLevel: p(power.batteryLevel), onBattery: p(power.onBattery) },
    audio: { headsetClass: p(o(r.audio).headsetClass) },
    backgroundApps: { runningApps: Array.isArray(apps.runningApps) ? apps.runningApps.filter((a) => typeof a === "string") : [],
      browserExtensions: p(apps.browserExtensions) },
  };
}

// The answer as the dialog renders it: a capped summary, at most five
// findings each of known severity with string fields, and the model's name.
// The Worker shapes its answer the same way (shapeAnswer); this holds even
// if WHD_REPORT_URL points at something else, where a finding with an
// object for a title would have crashed the dialog.
const ANSWER_TEXT = 600;
function shapeExplanation(body) {
  const b = body && typeof body === "object" ? body : {};
  const text = (v) => (typeof v === "string" ? v.trim().slice(0, ANSWER_TEXT) : "");
  const findings = (Array.isArray(b.findings) ? b.findings : [])
    .filter((f) => f && typeof f === "object" && ["high", "medium", "low", "ok"].includes(f.severity) && text(f.title))
    .slice(0, 5)
    .map((f) => ({ severity: f.severity, title: text(f.title), detail: text(f.detail), fix: text(f.fix) }));
  return { summary: text(b.summary), findings, model: typeof b.model === "string" ? b.model.slice(0, 100) : null };
}

// The Worker's /explain, next to the report endpoint ("…/" → "…/explain").
function explainEndpoint(reportUrl) {
  if (!reportUrl) return "";
  try {
    return new URL("explain", reportUrl.endsWith("/") ? reportUrl : `${reportUrl}/`).href;
  } catch (_) {
    return "";
  }
}

// POSTs { scan } to /explain: https only, no
// redirects, a time limit. Resolves { ok: true, summary, findings, model } or
// { ok: false, reason, status?, error? }.
async function requestExplanation(endpoint, scan, fetchImpl = fetch) {
  if (!endpoint) return { ok: false, reason: "no-endpoint" };
  if (!/^https:\/\//i.test(endpoint)) {
    return { ok: false, reason: "insecure-url", error: "the report URL must be an https:// URL" };
  }
  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scan }),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
      redirect: "error",
    });
    let body = null;
    try {
      body = await res.json();
    } catch (_) {
      /* not JSON */
    }
    if (res.ok && body && body.ok && typeof body.summary === "string") {
      return { ok: true, ...shapeExplanation(body) };
    }
    const error = body && typeof body.error === "string" ? body.error : undefined;
    return error ? { ok: false, reason: "http", status: res.status, error } : { ok: false, reason: "http", status: res.status };
  } catch (err) {
    return { ok: false, reason: classifyReportError(err), error: errorDetail(err) };
  }
}

module.exports = {
  buildReport, reportEndpoint, classifyReportError, errorDetail,
  buildAiScan, explainEndpoint, requestExplanation, shapeExplanation,
};
