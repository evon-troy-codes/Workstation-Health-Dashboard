// dashboard.js — Workstation Scanner for Teams: the IT dashboard.
//
//   GET  /login, POST /login, POST /logout     sign in with the admin token
//   GET  /                                     setup (once), then the computers
//   POST /setup                                organization name → enrollment key
//   GET  /computers/<id>                       one computer: latest readings, history
//   POST /computers/<id>/remove | /restore     revoke or restore its token
//   GET  /export.csv                           the current list as CSV
//   GET  /settings, POST /settings/rotate-key  the enrollment key
//   GET  /assets/dashboard.css
//
// Server-rendered HTML with no JavaScript, so the Content Security Policy
// allows no scripts at all. Every value from a report is escaped: reports
// come from computers, so a computer name is untrusted text. Forms that
// change anything are POST, accepted only with the session cookie
// (SameSite=Strict) and an Origin matching this server.

import { summarize, parseFilters, applyFilters, toCsv, compareVersions } from "./summary.js";
import { createSession, isValidSession, sessionFrom, sessionCookie, clearedCookie } from "./session.js";
import { readCapped } from "./http.js";
import { sha256 } from "./crypto.js";

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const html = (status, body, headers = {}) =>
  new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS, ...headers } });
const redirect = (to, headers = {}) => new Response(null, { status: 303, headers: { Location: to, ...SECURITY_HEADERS, ...headers } });

const ago = (date, now) => {
  if (!date) return "Never";
  const s = Math.max(0, Math.round((now - date) / 1000));
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86400)} days ago`;
};

const DEMO_BANNER = `<div class="demo">This is a demo with made-up computers: look around freely, nothing can be changed.
It's <a href="https://github.com/evon-troy-codes/Workstation-Health-Dashboard">Workstation Scanner for Teams</a>, open source; a company runs its own copy on Cloudflare or Docker.</div>`;

function page(title, body, { org = null, signedIn = false, demo = false } = {}) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Workstation Scanner for Teams</title><link rel="stylesheet" href="/assets/dashboard.css"></head>
<body><header class="top"><a class="brand" href="/">Workstation Scanner <span>for Teams</span></a>
${org ? `<span class="org">${esc(org)}</span>` : ""}
${demo ? `<nav><a href="/">Computers</a></nav>` : signedIn ? `<nav><a href="/">Computers</a><a href="/settings">Settings</a><form method="post" action="/logout"><button class="link">Sign out</button></form></nav>` : ""}
</header>${demo ? DEMO_BANNER : ""}<main>${body}</main></body></html>`;
}

// ---- pages -----------------------------------------------------------------

function loginPage(error) {
  return page("Sign in", `<section class="narrow"><h1>Sign in</h1>
${error ? `<p class="error">${esc(error)}</p>` : ""}
<form method="post" action="/login"><label>Admin token<input type="password" name="token" autocomplete="current-password" required autofocus></label>
<button>Sign in</button></form>
<p class="muted">The admin token is the ADMIN_TOKEN this server was deployed with.</p></section>`);
}

function setupPage() {
  return page("Set up", `<section class="narrow"><h1>Set up Workstation Scanner for Teams</h1>
<p>Name your organization. Computers will show it: "Managed by <em>your organization</em>".</p>
<form method="post" action="/setup"><label>Organization name<input name="organization" maxlength="100" required autofocus></label>
<button>Set up</button></form></section>`, { signedIn: true });
}

function managedJson(origin, key) {
  return JSON.stringify({ version: 1, organization: "…", fleetUrl: `${origin}/`, enrollmentKey: key, scanEveryHours: 6, speedTest: "open", explain: true,
    include: { macAddress: false, wifiName: false } }, null, 2);
}

function keyPage(org, key, origin, heading) {
  return page(heading, `<section class="narrow"><h1>${esc(heading)}</h1>
<p><strong>Copy this enrollment key now.</strong> It's shown only once; the server keeps only a hash of it.</p>
<pre class="key">${esc(key)}</pre>
<p>Put it in each computer's <code>managed.json</code>, with your device-management tool:</p>
<pre>${esc(managedJson(origin, key).replace('"…"', JSON.stringify(org)))}</pre>
<p><a class="button" href="/">Go to the computers</a></p></section>`, { org, signedIn: true });
}

const STATUS_CLASS = { active: "ok", inactive: "warn", none: "warn", unknown: "muted", installed: "muted", "not-reported": "muted" };

function filtersForm(f) {
  const check = (name, label) => `<label class="check"><input type="checkbox" name="${name}" value="1"${f[name] ? " checked" : ""}> ${label}</label>`;
  return `<form class="filters" method="get" action="/">
<input type="search" name="q" value="${esc(f.q)}" placeholder="Search name, user, OS, IP">
${check("updates", "Pending updates")}${check("firewall", "Firewall not active")}${check("antivirus", "Antivirus not active")}${check("outdated", "Older app version")}
<label class="num">Disk ≥ <input type="number" name="disk" min="0" max="100" value="${f.disk ?? ""}">%</label>
<label class="num">Silent ≥ <input type="number" name="stale" min="0" value="${f.stale ?? ""}"> days</label>
<input type="hidden" name="sort" value="${esc(f.sort)}"><input type="hidden" name="dir" value="${esc(f.dir)}">
<button>Filter</button> <a href="/">Clear</a></form>`;
}

function listPage(org, rows, f, total, latest, now, query, demo = false) {
  const sortLink = (key, label) => {
    const p = new URLSearchParams(query);
    const dir = f.sort === key && f.dir === "asc" ? "desc" : "asc";
    p.set("sort", key);
    p.set("dir", dir);
    const mark = f.sort === key ? (f.dir === "asc" ? " ▲" : " ▼") : "";
    return `<a href="/?${esc(p.toString())}">${label}${mark}</a>`;
  };
  const csv = new URLSearchParams(query);
  const body = rows.map((r) => `<tr${r.revoked ? ' class="removed"' : ""}>
<td><a href="/computers/${encodeURIComponent(r.id)}">${esc(r.name)}</a>${r.revoked ? ' <span class="tag">removed</span>' : ""}</td>
<td>${esc(r.user || "—")}</td><td>${esc(r.os || "—")}</td>
<td title="${esc(r.lastSeen ? r.lastSeen.toISOString() : "")}">${esc(ago(r.lastSeen, now))}</td>
<td class="${r.updates.count == null ? "muted" : r.updates.count > 0 ? "warn" : "ok"}">${esc(r.updates.text)}</td>
<td class="${STATUS_CLASS[r.firewall.status]}">${esc(r.firewall.text)}</td>
<td class="${STATUS_CLASS[r.antivirus.status]}">${esc(r.antivirus.text)}</td>
<td>${r.diskUsed == null ? "—" : `${esc(r.diskUsed)}%`}</td>
<td class="${latest && r.appVersion && compareVersions(r.appVersion, latest) < 0 ? "warn" : ""}">${esc(r.appVersion || "—")}</td></tr>`).join("");
  return page("Computers", `<h1>Computers <span class="count">${rows.length} of ${total}</span></h1>
${filtersForm(f)}
${total === 0 ? `<p class="empty">No computers yet. Put the enrollment key in their <code>managed.json</code>; see <a href="/settings">Settings</a>.</p>` : `
<table><thead><tr><th>${sortLink("name", "Computer")}</th><th>User</th><th>OS</th><th>${sortLink("lastSeen", "Last report")}</th>
<th>${sortLink("updates", "Updates")}</th><th>Firewall</th><th>Antivirus</th><th>${sortLink("disk", "Disk")}</th><th>${sortLink("app", "App")}</th></tr></thead>
<tbody>${body || `<tr><td colspan="9" class="empty">No computers match.</td></tr>`}</tbody></table>
<p><a href="/export.csv?${esc(csv.toString())}">Download this list as CSV</a></p>`}`, { org, signedIn: true, demo });
}

// The latest report's sections, as name: value rows. Every value escaped.
function reportRows(report) {
  const r = report && typeof report === "object" ? report : {};
  const o = (v) => (v && typeof v === "object" ? v : {});
  const os = o(r.os), cpu = o(r.cpu), ram = o(r.ram), disk = o(r.disk), net = o(r.network), bw = o(r.bandwidth), power = o(r.power), audio = o(r.audio);
  const v = (x, unit = "") => (x == null || x === "" ? "—" : `${x}${unit}`);
  return [
    ["System", [["Computer name", v(r.hostname)], ["User", v(r.user)], ["Machine", v(r.machineType)], ["Uptime", v(r.uptime)], ["App version", v(r.appVersion)]]],
    ["Operating system", [["OS", `${v(os.name)} ${os.version || ""}`.trim()], ["Pending updates", v(os.pendingUpdates)],
      ["Snap / Flatpak updates", Object.entries(o(os.appUpdates)).map(([k, n]) => `${k} ${n ?? "unknown"}`).join(", ") || "—"], ["Last update check", v(os.lastUpdateCheck)]]],
    ["Hardware", [["CPU", v(cpu.model)], ["Cores / threads", `${v(cpu.cores)} / ${v(cpu.threads)}`], ["Memory", `${v(ram.totalGB, " GB")} (${v(ram.freeGB, " GB")} free)`],
      ["Disk", `${v(disk.totalGB, " GB")}, ${v(disk.usedPercent, "%")} used`], ["Battery", power.hasBattery ? v(power.batteryLevel, "%") : "No battery"]]],
    ["Network", [["Connection", v(net.type)], ["IPv4", v(net.ipv4)], ["Interface", `${v(net.interface)} · ${v(net.linkSpeed)}`],
      ["VPN", o(r.vpn).detected ? v(o(r.vpn).name) : "None detected"], ["Last speed test", bw.downMbps == null ? "—" : `${bw.downMbps} down / ${bw.upMbps} up Mbps, ${bw.ping} ms`]]],
    ["Security", [["Firewall", (Array.isArray(o(r.firewall).products) ? r.firewall.products : []).map((p) => `${o(p).name}: ${o(p).active == null ? "installed" : o(p).active ? "active" : "not active"}`).join("; ") || (r.firewall ? "No firewall service found" : "Unknown")],
      ["Antivirus", r.antivirus == null ? "None reported" : (Array.isArray(o(r.antivirus).products) ? r.antivirus.products : []).map((p) => `${o(p).name}: ${o(p).running == null ? "installed" : o(p).running ? "active" : "not active"}`).join("; ") || "None detected"]]],
    ["Audio", [["Output", v(audio.output)], ["Input", v(audio.input)]]],
  ];
}

function devicePage(org, device, history, now, demo = false) {
  const latest = history[0] ? safeJson(history[0].body) : null;
  const sections = latest ? reportRows(latest).map(([title, rows]) => `<section class="card"><h2>${esc(title)}</h2><dl>${rows.map(([k, v]) =>
    `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl></section>`).join("") : `<p class="empty">This computer hasn't reported yet.</p>`;
  const hist = history.map((h) => {
    const r = safeJson(h.body) || {};
    const s = summarize({ id: device.id, name: device.name, body: h.body, last_seen: h.received_at }, now);
    return `<tr><td>${esc(new Date(h.received_at).toISOString().replace("T", " ").slice(0, 16))} UTC</td><td>${esc(s.updates.text)}</td>
<td>${s.diskUsed == null ? "—" : `${esc(s.diskUsed)}%`}</td><td>${esc(r.bandwidth && r.bandwidth.downMbps != null ? `${r.bandwidth.downMbps} Mbps` : "—")}</td><td>${esc(h.app_version || "—")}</td></tr>`;
  }).join("");
  const action = device.revoked
    ? `<form method="post" action="/computers/${encodeURIComponent(device.id)}/restore"><button>Restore this computer</button></form><p class="muted">Removed: its reports are refused until restored.</p>`
    : `<form method="post" action="/computers/${encodeURIComponent(device.id)}/remove"><button class="danger">Remove this computer</button></form><p class="muted">Its token stops working and its reports are refused. Its history stays.</p>`;
  return page(device.name || "Computer", `<p><a href="/">← All computers</a></p>
<h1>${esc(device.name || "(unnamed)")}${device.revoked ? ' <span class="tag">removed</span>' : ""}</h1>
<p class="muted">Last report ${esc(ago(device.last_seen ? new Date(device.last_seen) : null, now))} · enrolled ${esc(device.enrolled_at.slice(0, 10))} · device ID ${esc(device.id)}</p>
<div class="cards">${sections}</div>
<h2>History</h2>${hist ? `<table><thead><tr><th>Received</th><th>Updates</th><th>Disk</th><th>Download</th><th>App</th></tr></thead><tbody>${hist}</tbody></table>` : `<p class="empty">No reports yet.</p>`}
${demo ? "" : `<h2>Remove</h2>${action}`}`, { org, signedIn: true, demo });
}

function settingsPage(org, origin) {
  return page("Settings", `<section class="narrow"><h1>Settings</h1>
<h2>Enrolling computers</h2>
<p>Each computer needs a <code>managed.json</code> holding this server's address and the enrollment key, in:</p>
<ul><li>Windows: <code>%ProgramData%\\WorkstationScanner\\managed.json</code></li>
<li>macOS: <code>/Library/Application Support/WorkstationScanner/managed.json</code></li>
<li>Linux: <code>/etc/workstation-scanner/managed.json</code></li></ul>
<pre>${esc(managedJson(origin, "ek_…").replace('"…"', JSON.stringify(org)))}</pre>
<p>The current key was shown once, when it was made. If it's lost, or may have leaked, make a new one. Computers already enrolled keep working; new ones need the new key.</p>
<form method="post" action="/settings/rotate-key"><button class="danger">Make a new enrollment key</button></form></section>`, { org, signedIn: true });
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

// ---- requests --------------------------------------------------------------

// A form body (x-www-form-urlencoded), capped small.
async function readForm(request) {
  if (!/^application\/x-www-form-urlencoded\b/i.test(request.headers.get("Content-Type") || "")) return null;
  const raw = await readCapped(request, 8 * 1024);
  return raw == null ? null : new URLSearchParams(raw);
}

// A form POST is accepted only from this server's own pages: its Origin must
// name this host. Compared by host, since a reverse proxy may serve HTTPS in
// front of a server that sees plain HTTP. With SameSite=Strict cookies, this
// stops another site posting forms with an IT person's session.
function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === (request.headers.get("Host") || new URL(request.url).host);
  } catch (_) {
    return false;
  }
}

// The origin computers should use, for managed.json examples.
function publicOrigin(request) {
  const url = new URL(request.url);
  const proto = request.headers.get("X-Forwarded-Proto") || url.protocol.replace(":", "");
  return `${proto === "http" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1" ? "https" : proto}://${request.headers.get("Host") || url.host}`;
}

// deps: as handleRequest's. Paths outside /v1/ come here.
async function handleDashboard(request, deps) {
  const { store, adminToken } = deps;
  const now = deps.now ? deps.now() : new Date();
  const allow = deps.rateLimit || (async () => true);
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/assets/dashboard.css" && method === "GET") {
    return new Response(CSS, { headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" } });
  }
  if (deps.demo) return handleDemo(request, deps, url, now);
  if (!adminToken) {
    return html(404, page("Dashboard off", `<section class="narrow"><h1>The dashboard is off</h1><p>Set ADMIN_TOKEN on this server to turn it on.</p></section>`));
  }

  if (path === "/login") {
    if (method === "GET") return html(200, loginPage());
    if (method !== "POST") return html(405, loginPage());
    if (!(await allow(`login:${deps.ip || "unknown"}`))) return html(429, loginPage("Too many attempts. Wait a minute and try again."));
    if (!sameOrigin(request)) return html(403, loginPage("Sign in from this page."));
    const form = await readForm(request);
    const token = form ? form.get("token") || "" : "";
    if (!token || (await sha256(token)) !== (await sha256(adminToken))) return html(401, loginPage("That isn't the admin token."));
    return redirect("/", { "Set-Cookie": sessionCookie(await createSession(adminToken, now)) });
  }

  // Everything else needs a session.
  const signedIn = await isValidSession(sessionFrom(request), adminToken, now);
  if (!signedIn) return method === "GET" ? redirect("/login") : html(403, loginPage("Your session ended. Sign in again."));
  if (method === "POST" && !sameOrigin(request)) return html(403, page("Refused", `<section class="narrow"><h1>Refused</h1><p>That request didn't come from this dashboard.</p></section>`));

  if (path === "/logout" && method === "POST") return redirect("/login", { "Set-Cookie": clearedCookie() });

  const org = await store.organization();
  if (path === "/setup" && method === "POST") {
    const form = await readForm(request);
    const result = await store.setUp({ organization: form ? form.get("organization") : "" });
    if (result.error === "already-set-up") return redirect("/");
    if (result.error) return html(400, setupPage());
    return html(200, keyPage(await store.organization(), result.enrollmentKey, publicOrigin(request), "Set up: your enrollment key"));
  }
  if (!org) return html(200, setupPage());

  if (path === "/" && method === "GET") {
    const f = parseFilters(url.searchParams);
    const all = (await store.listDevices()).map((row) => summarize(row, now));
    const { rows, latestVersion } = applyFilters(all, f);
    return html(200, listPage(org, rows, f, all.length, latestVersion, now, url.searchParams));
  }

  if (path === "/export.csv" && method === "GET") {
    const all = (await store.listDevices()).map((row) => summarize(row, now));
    const { rows } = applyFilters(all, parseFilters(url.searchParams));
    return new Response(toCsv(rows), { headers: { "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="computers-${now.toISOString().slice(0, 10)}.csv"`, ...SECURITY_HEADERS } });
  }

  const m = /^\/computers\/([A-Za-z0-9-]{8,64})(?:\/(remove|restore))?$/.exec(path);
  if (m) {
    const [, id, action] = m;
    if (action) {
      if (method !== "POST") return html(405, page("Not allowed", ""));
      if (!(await store.setRevoked(id, action === "remove"))) return html(404, page("Not found", `<p>No such computer.</p>`, { org, signedIn: true }));
      return redirect(`/computers/${id}`);
    }
    const device = await store.device(id);
    if (!device) return html(404, page("Not found", `<p>No such computer. <a href="/">All computers</a></p>`, { org, signedIn: true }));
    return html(200, devicePage(org, device, await store.history(id), now));
  }

  if (path === "/settings" && method === "GET") return html(200, settingsPage(org, publicOrigin(request)));
  if (path === "/settings/rotate-key" && method === "POST") {
    const result = await store.rotateEnrollmentKey();
    return html(200, keyPage(org, result.enrollmentKey, publicOrigin(request), "Your new enrollment key"));
  }

  return html(404, page("Not found", `<p>Not found. <a href="/">All computers</a></p>`, { org, signedIn: true }));
}

// The public demo (DEMO=1): the list, a computer's page and the CSV, with no
// sign-in; anything else, and every POST, is refused or sent to the list.
async function handleDemo(request, deps, url, now) {
  const { store } = deps;
  const path = url.pathname;
  if (request.method !== "GET") return html(403, page("Demo", `<section class="narrow"><h1>This is a demo</h1><p>Nothing can be changed here. <a href="/">Back to the computers</a></p></section>`, { demo: true }));
  const org = await store.organization();
  const all = async () => (await store.listDevices()).map((row) => summarize(row, now));
  if (path === "/") {
    const f = parseFilters(url.searchParams);
    const everything = await all();
    const { rows, latestVersion } = applyFilters(everything, f);
    return html(200, listPage(org, rows, f, everything.length, latestVersion, now, url.searchParams, true));
  }
  if (path === "/export.csv") {
    const { rows } = applyFilters(await all(), parseFilters(url.searchParams));
    return new Response(toCsv(rows), { headers: { "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="demo-computers-${now.toISOString().slice(0, 10)}.csv"`, ...SECURITY_HEADERS } });
  }
  const m = /^\/computers\/([A-Za-z0-9-]{8,80})$/.exec(path);
  if (m) {
    const device = await store.device(m[1]);
    if (!device) return html(404, page("Not found", `<p>No such computer. <a href="/">All computers</a></p>`, { org, demo: true }));
    return html(200, devicePage(org, device, await store.history(m[1]), now, true));
  }
  return redirect("/");
}

const CSS = `:root{--bg:#12161c;--card:#1b2129;--line:#2a323d;--text:#e6e9ee;--muted:#8b95a3;--accent:#7d6bee;--ok:#5ec98f;--warn:#f0b44c;--bad:#ef6b6b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
a{color:#b3a8ff}main{padding:20px 24px;max-width:1300px;margin:0 auto}
.top{display:flex;gap:16px;align-items:center;padding:12px 24px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.brand{color:var(--text);font-weight:700;text-decoration:none}.brand span{color:var(--accent)}
.org{color:var(--muted)}nav{margin-left:auto;display:flex;gap:16px;align-items:center}nav form{margin:0}
h1{font-size:22px;margin:8px 0 16px}h2{font-size:16px;margin:24px 0 8px}.count{color:var(--muted);font-weight:400;font-size:15px}
.narrow{max-width:640px}label{display:block;margin:12px 0}input{display:block;margin-top:4px;padding:8px 10px;width:100%;background:var(--card);color:var(--text);border:1px solid var(--line);border-radius:6px;font:inherit}
button,.button{background:var(--accent);color:#fff;border:0;border-radius:6px;padding:8px 14px;font:inherit;cursor:pointer;text-decoration:none;display:inline-block}
button.danger{background:#a33d3d}button.link{background:none;color:#b3a8ff;padding:0}
.filters{display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;margin-bottom:16px}
.filters input[type=search]{width:260px;margin:0}.filters label{margin:0;display:flex;gap:6px;align-items:center}.filters .check input{width:auto;margin:0}
.filters .num input{width:72px;margin:0}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600;font-size:13px}th a{color:var(--muted)}
tr.removed td{opacity:.55}.ok{color:var(--ok)}.warn{color:var(--warn)}.muted{color:var(--muted)}.error{color:var(--bad)}
.tag{font-size:12px;border:1px solid var(--line);border-radius:4px;padding:1px 6px;color:var(--muted)}.empty{color:var(--muted);padding:16px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 16px}
.card h2{margin:0 0 8px}dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:0}dt{color:var(--muted)}dd{margin:0;word-break:break-word}
pre{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:12px;overflow:auto}pre.key{font-size:16px;color:var(--warn)}code{color:#cfc8ff}
.demo{background:#2a2350;border-bottom:1px solid var(--accent);padding:10px 24px;font-size:14px}
@media (max-width:800px){main{padding:16px}table{display:block;overflow-x:auto}}`;

export { handleDemo, handleDashboard, esc, sameOrigin, publicOrigin, reportRows, CSS };
