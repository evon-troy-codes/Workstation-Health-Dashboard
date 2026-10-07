// summary.js — a stored report as the dashboard's columns, the list's
// filters, and the CSV export. Pure functions, no HTML.
//
// As in the app: the dashboard reports facts, it doesn't grade them. A
// reading that couldn't be known is "Unknown", never a guess. The filters
// are facts IT can apply to its own policy ("firewall not active"), not
// verdicts.

const DAY_MS = 86400000;

const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

// A database row (listDevices) → the list's columns.
function summarize(row, now = new Date()) {
  let report = null;
  try {
    report = row.body ? JSON.parse(row.body) : null;
  } catch (_) {
    report = null;
  }
  const r = obj(report);
  const os = obj(r.os);
  const lastSeen = row.last_seen ? new Date(row.last_seen) : null;
  return {
    id: row.id,
    name: str(row.name) || "(unnamed)",
    revoked: Boolean(row.revoked),
    reported: Boolean(report),
    user: str(r.user),
    os: [str(os.name), str(os.version)].filter(Boolean).join(" ") || null,
    ipv4: str(obj(r.network).ipv4),
    appVersion: str(row.app_version),
    lastSeen,
    daysSinceSeen: lastSeen ? Math.floor((now - lastSeen) / DAY_MS) : null,
    updates: updatesOf(os),
    firewall: firewallOf(r.firewall),
    antivirus: antivirusOf(r.antivirus),
    diskUsed: num(obj(r.disk).usedPercent),
  };
}

// Pending updates: the system's count plus every known snap and Flatpak
// count. Unknown when the system's own count is.
function updatesOf(os) {
  const system = num(os.pendingUpdates);
  if (system == null) return { count: null, text: "Unknown" };
  const apps = Object.values(obj(os.appUpdates)).filter((v) => num(v) != null);
  const count = apps.reduce((a, b) => a + b, system);
  return { count, text: count === 0 ? "None" : String(count) };
}

// → { status: "active" | "inactive" | "none" | "unknown", text }
function firewallOf(fw) {
  if (fw == null) return { status: "unknown", text: "Unknown" };
  const f = obj(fw);
  const products = Array.isArray(f.products) ? f.products.map(obj) : [];
  if (!products.length) return f.checked === false ? { status: "unknown", text: "Unknown" } : { status: "none", text: "No firewall service found" };
  const active = products.filter((p) => p.active === true).map((p) => str(p.name)).filter(Boolean);
  if (active.length) return { status: "active", text: active.join(", ") };
  if (products.some((p) => p.active == null)) return { status: "unknown", text: "Installed" };
  return { status: "inactive", text: "Not active" };
}

// → { status: "active" | "inactive" | "installed" | "none" | "not-reported"
//   | "unknown", text }. null is the app's "nothing to report" on Linux, where
// antivirus is rare (CLAUDE.md); an empty list, on Windows or macOS, is a
// real "none detected", which the filter should catch.
function antivirusOf(av) {
  if (av == null) return { status: "not-reported", text: "None reported" };
  const a = obj(av);
  if (a.checked === false) return { status: "unknown", text: "Unknown" };
  const products = Array.isArray(a.products) ? a.products.map(obj) : [];
  if (!products.length) return { status: "none", text: "None detected" };
  const active = products.filter((p) => p.running === true).map((p) => str(p.name)).filter(Boolean);
  if (active.length) return { status: "active", text: active.join(", ") };
  if (products.some((p) => p.running == null)) return { status: "installed", text: products.map((p) => str(p.name)).filter(Boolean).join(", ") || "Installed" };
  return { status: "inactive", text: "Not active" };
}

// "1.10.0" > "1.9.2". Non-numeric parts count as 0.
function compareVersions(a, b) {
  const pa = String(a || "").split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b || "").split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

// The list's filters, from the query string. Unknown readings match the
// "needs a look" filters: IT can't confirm them, so they're worth seeing.
function parseFilters(params) {
  const p = params instanceof URLSearchParams ? params : new URLSearchParams(params || "");
  const n = (k) => {
    const v = parseInt(p.get(k) || "", 10);
    return Number.isFinite(v) && v >= 0 ? v : null;
  };
  return {
    q: (p.get("q") || "").trim().slice(0, 100),
    updates: p.get("updates") === "1",
    firewall: p.get("firewall") === "1",
    antivirus: p.get("antivirus") === "1",
    disk: n("disk"),
    stale: n("stale"),
    outdated: p.get("outdated") === "1",
    sort: ["name", "lastSeen", "updates", "disk", "app"].includes(p.get("sort")) ? p.get("sort") : "name",
    dir: p.get("dir") === "desc" ? "desc" : "asc",
  };
}

function applyFilters(rows, f) {
  const latest = rows.map((r) => r.appVersion).filter(Boolean).sort(compareVersions).pop() || null;
  const q = f.q.toLowerCase();
  const kept = rows.filter((r) =>
    (!q || [r.name, r.user, r.os, r.ipv4].some((v) => v && v.toLowerCase().includes(q)))
    && (!f.updates || r.updates.count == null || r.updates.count > 0)
    && (!f.firewall || r.firewall.status !== "active")
    && (!f.antivirus || ["inactive", "none", "unknown"].includes(r.antivirus.status))
    && (f.disk == null || (r.diskUsed != null && r.diskUsed >= f.disk))
    && (f.stale == null || r.daysSinceSeen == null || r.daysSinceSeen >= f.stale)
    && (!f.outdated || (latest && r.appVersion && compareVersions(r.appVersion, latest) < 0)));
  const key = {
    name: (r) => r.name.toLowerCase(),
    lastSeen: (r) => (r.lastSeen ? r.lastSeen.getTime() : -1),
    updates: (r) => (r.updates.count == null ? -1 : r.updates.count),
    disk: (r) => (r.diskUsed == null ? -1 : r.diskUsed),
    app: (r) => r.appVersion || "",
  }[f.sort];
  const cmp = f.sort === "app" ? (a, b) => compareVersions(key(a), key(b)) : (a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  kept.sort((a, b) => cmp(a, b) || a.name.localeCompare(b.name));
  if (f.dir === "desc") kept.reverse();
  return { rows: kept, latestVersion: latest };
}

// A cell for CSV: quoted, and with a leading = + - @ (or tab or carriage
// return) defused, so a computer name can't become a spreadsheet formula.
function csvCell(v) {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function toCsv(rows) {
  const head = ["Computer", "User", "OS", "IPv4", "Last report (UTC)", "Pending updates", "Firewall", "Antivirus", "Disk used %", "App version", "Removed"];
  const lines = rows.map((r) => [r.name, r.user, r.os, r.ipv4, r.lastSeen ? r.lastSeen.toISOString() : "", r.updates.text,
    r.firewall.text, r.antivirus.text, r.diskUsed, r.appVersion, r.revoked ? "yes" : "no"].map(csvCell).join(","));
  return `${[head.map(csvCell).join(","), ...lines].join("\r\n")}\r\n`;
}

export { summarize, updatesOf, firewallOf, antivirusOf, compareVersions, parseFilters, applyFilters, csvCell, toCsv };
