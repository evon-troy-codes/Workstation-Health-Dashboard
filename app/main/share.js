// share.js — "Share report": the report as text to copy, a page to save, and
// an email the person sends from their own account to whoever they choose.
//
// Nothing here sends anything. The app is public, so it no longer emails
// reports from a server of its own: that made it a service anyone could use
// to mail anyone, and its mail looked like phishing to people who had never
// heard of the app. Built in main from main's own scan (buildReport), so the
// MAC address and Wi-Fi name are already gone.

const MAX_TEXT = 200; // longest value shown from the report
const MAX_LIST = 20; // most items shown from any list

// Some Windows mail apps cut a mailto: link off around 2,000 characters;
// keep the whole link under that.
const MAX_MAILTO = 1900;

const obj = (o) => (o && typeof o === "object" && !Array.isArray(o) ? o : {});

// A report value as display text: trimmed, capped, and "—" when missing.
function val(v) {
  if (v == null || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "—";
  if (typeof v !== "string") return "—";
  const s = v.replace(/\s+/g, " ").trim();
  if (!s) return "—";
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s;
}

const list = (a) =>
  Array.isArray(a) && a.length
    ? a.slice(0, MAX_LIST).map(val).join(", ") + (a.length > MAX_LIST ? ", …" : "")
    : "—";

const num = (v, unit) => (typeof v === "number" && Number.isFinite(v) ? `${v} ${unit}` : "—");
const pct = (v) => num(v, "%").replace(" %", "%");

const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// One row per monitor, each with its own resolution and refresh rate.
function displayRows(display) {
  const d = obj(display);
  const monitors = Array.isArray(d.monitors) ? d.monitors.slice(0, MAX_LIST) : [];
  if (!monitors.length) return [["Display", display == null ? "—" : "None found"]];
  return monitors.map((m) => {
    const q = obj(m);
    const label = q.main && monitors.length > 1 ? `${val(q.name)} (main)` : val(q.name);
    return [label, [q.resolution, q.refreshRate, q.size].filter((v) => typeof v === "string" && v).map(val).join(" · ") || "—"];
  });
}

function antivirusRows(antivirus) {
  if (antivirus == null) return null; // Linux with none installed: nothing to report
  const av = obj(antivirus);
  if (av.checked === false) return [["Antivirus", "Unknown (the check failed)"]];
  const products = Array.isArray(av.products) ? av.products.slice(0, MAX_LIST) : [];
  if (!products.length) return [["Antivirus", "None detected"]];
  return products.map((p) => {
    const q = obj(p);
    const state = q.running == null ? "Installed" : q.running ? "Active" : "Inactive";
    return [val(q.name), q.definitionsAge ? `${state} · definitions ${val(q.definitionsAge)}` : state];
  });
}

// Never hidden: an empty list is "No firewall service found" on every OS.
function firewallRows(firewall) {
  if (firewall == null) return [["Firewall", "Unknown"]]; // not read at all
  const fw = obj(firewall);
  const products = Array.isArray(fw.products) ? fw.products.slice(0, MAX_LIST) : [];
  if (!products.length) return [["Firewall", fw.checked === false ? "Unknown (the check failed)" : "No firewall service found"]];
  return products.map((p) => {
    const q = obj(p);
    const state = q.active == null ? "Installed" : q.active ? "Active" : "Inactive";
    return [val(q.name), q.detail ? `${state} · ${val(q.detail)}` : state];
  });
}

// Sections of [label, value] rows, from the report's known fields.
function reportSections(report) {
  const r = obj(report);
  const cpu = obj(r.cpu), ram = obj(r.ram), disk = obj(r.disk), os = obj(r.os);
  const net = obj(r.network), bw = obj(r.bandwidth), vpn = obj(r.vpn);
  const power = obj(r.power), audio = obj(r.audio), apps = obj(r.backgroundApps);
  const security = [...(antivirusRows(r.antivirus) || []), ...firewallRows(r.firewall)];
  return [
    ["Computer", [
      ["Computer name", val(r.hostname)],
      ["User", val(r.user)],
      ["Machine", val(r.machineType)],
      ["Uptime", val(r.uptime)],
      ["App version", val(r.appVersion)],
    ]],
    ["System", [
      ["Operating system", `${val(os.name)} ${os.version ? val(os.version) : ""}`.trim()],
      ["CPU", val(cpu.model)],
      ["Cores / threads", `${val(cpu.cores)} / ${val(cpu.threads)}`],
      ["Memory", `${num(ram.totalGB, "GB")} (${num(ram.freeGB, "GB")} free, pressure ${val(ram.pressure)})`],
      ["Disk", `${num(disk.totalGB, "GB")} (${num(disk.freeGB, "GB")} free, ${pct(disk.usedPercent)} used)`],
      ...displayRows(r.display),
      ["Pending updates", val(os.pendingUpdates)],
      [os.lastUpdateKind === "installed" ? "Last update installed" : "Last update check", val(os.lastUpdateCheck)],
    ]],
    ["Network", [
      ["Connection", val(net.type)],
      ["Interface", `${val(net.interface)} · ${val(net.linkSpeed)}`],
      ["IPv4", val(net.ipv4)],
      ["Gateway", val(net.gateway)],
      ["DNS", list(net.dns)],
      ["VPN", vpn.detected ? val(vpn.name) : "None detected"],
      ["Download", num(bw.downMbps, "Mbps")],
      ["Upload", num(bw.upMbps, "Mbps")],
      ["Ping / jitter", `${num(bw.ping, "ms")} / ${num(bw.jitter, "ms")}`],
    ]],
    ["Security", security],
    ["Audio, power and apps", [
      ["Audio output", `${val(audio.output)} (${val(audio.headsetClass)})`],
      ["Audio input", val(audio.input)],
      ["Power", power.hasBattery ? `${pct(power.batteryLevel)} · ${power.plugged ? "plugged in" : "on battery"}` : "No battery"],
      ["Background apps", list(apps.runningApps)],
    ]],
  ];
}

const stamp = (at) => at.toISOString().replace("T", " ").slice(0, 16) + " UTC";

const title = (report) => `Workstation report: ${val(obj(report).hostname)}`;

// The whole report as plain text, for Copy and for the email body.
function reportText(report, at = new Date()) {
  return [
    `Workstation Scanner report for ${val(obj(report).hostname)}, ${stamp(at)}.`,
    "",
    ...reportSections(report).flatMap(([name, rows]) => [name, ...rows.map(([k, v]) => `  ${k}: ${v}`), ""]),
  ].join("\n").trimEnd();
}

const SAVE_AND_ATTACH = "The full report is too long for an email link: in Workstation Scanner, choose Share report, then Save as a file, and attach it.";

// A short version for an email link too long for the full one: the readings
// people ask about first, and a pointer to the saved report.
function shortText(report, at = new Date()) {
  const keep = new Set(["Computer name", "Operating system", "CPU", "Memory", "Disk", "Download", "Upload", "Ping / jitter"]);
  const rows = reportSections(report).flatMap(([, r]) => r).filter(([k]) => keep.has(k));
  return [
    `Workstation Scanner report for ${val(obj(report).hostname)}, ${stamp(at)} (summary).`,
    "",
    ...rows.map(([k, v]) => `${k}: ${v}`),
    "",
    SAVE_AND_ATTACH,
  ].join("\n");
}

// A mailto: link with the report filled in and no recipient, so the person
// picks who it goes to in their own email app. Falls back to the summary
// when the full text would make the link too long, and to only the pointer to
// the saved file when even the summary would: that takes very long or
// non-ASCII names, which percent-encoding makes up to nine times longer.
// → { url, shortened }
function mailtoLink(report, at = new Date()) {
  const link = (subject, body) => `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const full = link(title(report), reportText(report, at));
  if (full.length <= MAX_MAILTO) return { url: full, shortened: false };
  const short = link(title(report), shortText(report, at));
  if (short.length <= MAX_MAILTO) return { url: short, shortened: true };
  return { url: link("Workstation report", SAVE_AND_ATTACH), shortened: true };
}

// The report as a self-contained page: no scripts, no outside files, every
// value escaped. Opens in any browser and attaches to any email or ticket.
function reportHtml(report, at = new Date()) {
  const td = "padding:6px 12px;border-bottom:1px solid #e5e7eb;font-size:14px;vertical-align:top;";
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(title(report))}</title></head>
<body style="margin:0;padding:24px;background:#f6f7f9;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#1f2937;">
<div style="max-width:680px;margin:0 auto;background:#ffffff;border-radius:8px;padding:24px;">
<h1 style="margin:0 0 4px;font-size:20px;">${escapeHtml(title(report))}</h1>
<p style="margin:0 0 16px;color:#6b7280;font-size:13px;">Made by Workstation Scanner on ${escapeHtml(stamp(at))}.</p>
${reportSections(report).map(([name, rows]) => `<h2 style="margin:20px 0 6px;font-size:15px;color:#5b4bd6;">${escapeHtml(name)}</h2>
<table style="width:100%;border-collapse:collapse;">${rows.map(([k, v]) =>
    `<tr><td style="${td}color:#6b7280;width:40%;">${escapeHtml(k)}</td><td style="${td}">${escapeHtml(v)}</td></tr>`).join("")}</table>`).join("\n")}
</div></body></html>
`;
}

// workstation-report-<computer>-<date>.html, safe on every OS.
function reportFileName(report, at = new Date()) {
  const host = val(obj(report).hostname).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "computer";
  return `workstation-report-${host}-${at.toISOString().slice(0, 10)}.html`;
}

module.exports = { reportSections, reportText, shortText, mailtoLink, reportHtml, reportFileName, MAX_MAILTO };
