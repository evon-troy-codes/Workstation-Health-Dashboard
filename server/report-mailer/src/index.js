// report-mailer — a Cloudflare Worker that emails a Workstation Scanner report
// to the address the user typed into the app.
//
// POST / with JSON { email, report } → emails the report through Resend and
// answers { ok: true }. The Resend API key lives here as a Worker secret, never
// in the app: the app is public and its installers can be unpacked.
//
// Anyone can call this endpoint, and it sends mail to an address the caller
// chooses, so it is built to be useless as a spam relay:
//   - The email carries only report fields, escaped and trimmed, laid out by
//     this code. There is no free-text field for a caller's own message.
//   - Rate limits per client IP and per recipient address (RATE_LIMITER).
//   - An optional ALLOWED_DOMAINS list restricts who can receive reports.
//   - Bodies over MAX_BODY_BYTES are refused before they are parsed.
//
// Configuration (wrangler.toml / `wrangler secret put`):
//   RESEND_API_KEY   secret, required
//   FROM_ADDRESS     "Workstation Scanner <reports@your-domain>", on a domain
//                    verified in Resend
//   ALLOWED_DOMAINS  comma-separated recipient domains; empty allows any
//   RATE_LIMITER     Workers rate-limiting binding

const MAX_BODY_BYTES = 256 * 1024;
const MAX_TEXT = 200; // longest string copied from the report into the email
const MAX_LIST = 20; // most items copied from any list (DNS servers, apps)

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// The same rule the app applies before sending: one @, a dot in the domain,
// no spaces, within the 254 characters an address may have.
function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

// ALLOWED_DOMAINS as a list; empty means any domain may receive reports.
function allowedDomains(env) {
  return String(env.ALLOWED_DOMAINS || "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

function recipientAllowed(email, env) {
  const domains = allowedDomains(env);
  if (!domains.length) return true;
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  return domains.includes(domain);
}

// Workers rate limiting: one call per key. Without the binding (local tests,
// or a deploy that forgot it) nothing is limited rather than everything
// refused, and the deploy guide says to configure it.
async function underLimit(env, key) {
  if (!env.RATE_LIMITER) return true;
  const { success } = await env.RATE_LIMITER.limit({ key });
  return success;
}

async function handleRequest(request, env, fetchImpl = fetch) {
  if (request.method !== "POST") return json(405, { ok: false, error: "method-not-allowed" });

  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_BODY_BYTES) return json(413, { ok: false, error: "too-large" });
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json(413, { ok: false, error: "too-large" });

  let body;
  try {
    body = JSON.parse(raw);
  } catch (_) {
    return json(400, { ok: false, error: "bad-request" });
  }
  const email = normalizeEmail(body && body.email);
  if (!email) return json(400, { ok: false, error: "invalid-email" });
  const report = body.report;
  if (!report || typeof report !== "object" || Array.isArray(report) || typeof report.hostname !== "string") {
    return json(400, { ok: false, error: "invalid-report" });
  }
  if (!recipientAllowed(email, env)) return json(403, { ok: false, error: "recipient-not-allowed" });

  // Per client and per recipient: one machine can't flood the service, and
  // many machines can't flood one inbox.
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!(await underLimit(env, `ip:${ip}`)) || !(await underLimit(env, `to:${email.toLowerCase()}`))) {
    return json(429, { ok: false, error: "rate-limited" });
  }

  if (!env.RESEND_API_KEY || !env.FROM_ADDRESS) {
    return json(500, { ok: false, error: "not-configured" });
  }

  const sentAt = new Date();
  const { subject, html, text } = renderEmail(report, sentAt);
  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.FROM_ADDRESS,
      to: [email],
      subject,
      html,
      text,
      attachments: [{
        filename: `workstation-report-${fileSafe(report.hostname)}-${sentAt.toISOString().slice(0, 10)}.json`,
        content: base64(JSON.stringify(report, null, 2)),
      }],
    }),
  });
  if (!res.ok) return json(502, { ok: false, error: "send-failed", status: res.status });
  return json(200, { ok: true });
}

// ---- rendering ------------------------------------------------------------

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

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const fileSafe = (s) => val(s).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60) || "workstation";

const obj = (o) => (o && typeof o === "object" && !Array.isArray(o) ? o : {});

// One row per monitor, each with its own resolution and refresh rate. Reports
// from before per-monitor detection carry only the main display's.
function displayRows(raw, display) {
  if (!raw) return [["Display", "—"]];
  const monitors = Array.isArray(display.monitors) ? display.monitors.slice(0, MAX_LIST) : null;
  if (!monitors) {
    return [["Display", `${val(display.resolution)}${display.external ? `, external ${[display.externalSize, display.externalConnection].filter(Boolean).map(val).join(" ") || "monitor"}` : ""}`]];
  }
  if (!monitors.length) return [["Display", "None found"]];
  return monitors.map((m) => {
    const q = obj(m);
    const label = q.main && monitors.length > 1 ? `${val(q.name)} (main)` : val(q.name);
    return [label, [q.resolution, q.refreshRate, q.size].filter((v) => typeof v === "string" && v).map(val).join(" · ") || "—"];
  });
}

// Sections of [label, value] rows, taken only from known report fields.
function reportSections(r) {
  const cpu = obj(r.cpu), ram = obj(r.ram), disk = obj(r.disk), os = obj(r.os);
  const net = obj(r.network), bw = obj(r.bandwidth), vpn = obj(r.vpn);
  const power = obj(r.power), audio = obj(r.audio), apps = obj(r.backgroundApps);
  const display = obj(r.display);
  const av = Array.isArray(obj(r.antivirus).products) ? obj(r.antivirus).products : [];
  const num = (v, unit) => (typeof v === "number" && Number.isFinite(v) ? `${v} ${unit}` : "—");

  return [
    ["Workstation", [
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
      ["Disk", `${num(disk.totalGB, "GB")} (${num(disk.freeGB, "GB")} free, ${num(disk.usedPercent, "%").replace(" %", "%")} used)`],
      ...displayRows(r.display, display),
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
    ["Security", av.length
      ? av.slice(0, MAX_LIST).map((p) => {
        const q = obj(p);
        const state = q.running == null ? "Installed" : q.running ? "Active" : "Inactive";
        return [val(q.name), q.definitionsAge ? `${state} · definitions ${val(q.definitionsAge)}` : state];
      })
      : [["Antivirus", "None detected"]]],
    ["Audio, power and apps", [
      ["Audio output", `${val(audio.output)} (${val(audio.headsetClass)})`],
      ["Audio input", val(audio.input)],
      ["Power", power.hasBattery
        ? `${num(power.batteryLevel, "%").replace(" %", "%")} · ${power.plugged ? "plugged in" : "on battery"}`
        : "No battery"],
      ["Background apps", list(apps.runningApps)],
    ]],
  ];
}

function renderEmail(report, sentAt = new Date()) {
  const r = obj(report);
  const host = val(r.hostname);
  const when = sentAt.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const subject = `Workstation report: ${host}`;
  const sections = reportSections(r);

  const text = [
    `Workstation Scanner report for ${host}, sent ${when}.`,
    "",
    ...sections.flatMap(([title, rows]) => [title, ...rows.map(([k, v]) => `  ${k}: ${v}`), ""]),
    "The full report is attached as JSON.",
  ].join("\n");

  const td = "padding:6px 12px;border-bottom:1px solid #e5e7eb;font-size:14px;";
  const html = `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#1f2937;">
<div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:8px;padding:24px;">
<h1 style="margin:0 0 4px;font-size:20px;">Workstation report: ${escapeHtml(host)}</h1>
<p style="margin:0 0 16px;color:#6b7280;font-size:13px;">Sent ${escapeHtml(when)} by Workstation Scanner. The full report is attached as JSON.</p>
${sections.map(([title, rows]) => `<h2 style="margin:20px 0 6px;font-size:15px;color:#5b4bd6;">${escapeHtml(title)}</h2>
<table style="width:100%;border-collapse:collapse;">${rows.map(([k, v]) =>
    `<tr><td style="${td}color:#6b7280;width:40%;">${escapeHtml(k)}</td><td style="${td}">${escapeHtml(v)}</td></tr>`).join("")}</table>`).join("\n")}
</div></body></html>`;

  return { subject, html, text };
}

// UTF-8 → base64, in chunks: String.fromCharCode(...bytes) on a whole report
// would overflow the argument limit.
function base64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export default {
  fetch: (request, env) => handleRequest(request, env),
};

export { handleRequest, renderEmail, normalizeEmail, recipientAllowed, base64, MAX_BODY_BYTES };
