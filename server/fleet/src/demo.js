// demo.js — made-up computers for the public demo (DEMO=1).
//
// The demo is read-only and needs no sign-in: anyone can look around the
// dashboard without installing anything. Its data is generated here, the
// same 40 computers every time (a fixed seed), with timestamps relative to
// now, and rebuilt daily so "last report" never drifts into the past.
// Nothing here is a real computer, person or address: names are invented,
// IPs are in RFC 5737 documentation ranges.

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const SEED = 20261007;
const COMPUTERS = 40;
const HISTORY_DAYS = 14;
const LATEST_APP = "1.5.0";
const DEMO_ORGANIZATION = "Example Co. (demo: made-up computers)";

// A small, seedable random number generator (mulberry32).
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ["alex", "sam", "jordan", "priya", "chen", "maria", "omar", "lena", "diego", "aisha", "tom", "yuki", "noah", "fatima", "ivan", "grace", "liam", "zara", "kofi", "hana"];
const LAST = ["rivera", "patel", "chen", "okafor", "smith", "nguyen", "garcia", "kim", "haddad", "novak", "silva", "berg", "tanaka", "mensah", "kowalski", "reyes", "ali", "jensen", "costa", "ward"];

const PLATFORMS = [
  { weight: 18, os: () => ({ name: "Windows 11 Pro", version: "10.0.26300" }), prefix: "EX-LT",
    machine: ["Dell Inc. Latitude 7450", "LENOVO ThinkPad T14 Gen 5", "HP EliteBook 840 G11"],
    cpu: ["Intel Core Ultra 7 165U", "Intel Core Ultra 5 135U", "AMD Ryzen 7 PRO 8840U"],
    firewall: (r) => ({ checked: true, products: [{ name: "Windows Firewall", active: r() > 0.08, detail: r() > 0.85 ? "Off for: Public" : null }] }),
    antivirus: (r) => ({ checked: true, products: r() > 0.06 ? [{ name: "Microsoft Defender", version: null, running: r() > 0.05, updated: true, definitionsAge: `${1 + Math.floor(r() * 20)} hours` }] : [] }),
    updates: (r) => (r() > 0.55 ? 0 : 1 + Math.floor(r() * 7)), apps: () => ({}) },
  { weight: 9, os: (r) => ({ name: "macOS", version: r() > 0.3 ? "15.4" : "14.7" }), prefix: "EX-MBP",
    machine: ["Apple MacBook Pro (M3, 2023)", "Apple MacBook Air (M2, 2022)", "Apple MacBook Pro (M4, 2024)"],
    cpu: ["Apple M3 Pro", "Apple M2", "Apple M4"],
    firewall: (r) => ({ checked: true, products: [{ name: "macOS Firewall", active: r() > 0.35, detail: null }] }),
    antivirus: () => ({ checked: true, products: [{ name: "Built-in protection (XProtect)", version: null, running: null, updated: null, definitionsAge: "3 days" }] }),
    updates: (r) => (r() > 0.6 ? 0 : 1 + Math.floor(r() * 3)), apps: () => ({}) },
  { weight: 9, os: (r) => ({ name: "Ubuntu", version: r() > 0.4 ? "24.04" : "22.04" }), prefix: "EX-DEV",
    machine: ["Dell Inc. XPS 15 9530", "Framework Laptop 13", "LENOVO ThinkPad X1 Carbon Gen 12"],
    cpu: ["Intel Core i7-13700H", "AMD Ryzen 7 7840U", "Intel Core Ultra 7 155H"],
    firewall: (r) => ({ checked: true, products: [{ name: "UFW", active: r() > 0.5, detail: null }] }),
    antivirus: () => null,
    updates: (r) => Math.floor(r() * 25), apps: (r) => ({ snap: Math.floor(r() * 5) }) },
  { weight: 4, os: () => ({ name: "Fedora Linux", version: "44" }), prefix: "EX-WS",
    machine: ["System76 Lemur Pro", "Framework Laptop 16"],
    cpu: ["Intel Core Ultra 7 155U", "AMD Ryzen 9 7940HS"],
    firewall: () => ({ checked: true, products: [{ name: "firewalld", active: true, detail: null }] }),
    antivirus: () => null,
    updates: (r) => Math.floor(r() * 40), apps: (r) => ({ flatpak: Math.floor(r() * 3) }) },
];

function pick(r, list) {
  return list[Math.floor(r() * list.length)];
}

function pickPlatform(r) {
  const total = PLATFORMS.reduce((a, p) => a + p.weight, 0);
  let x = r() * total;
  for (const p of PLATFORMS) {
    x -= p.weight;
    if (x < 0) return p;
  }
  return PLATFORMS[0];
}

// The computers, as { id, name, appVersion, silentDays, reports: [report] },
// oldest report first. Deterministic: the same list every call.
function demoComputers() {
  const r = random(SEED);
  const used = new Set();
  const list = [];
  for (let i = 0; i < COMPUTERS; i++) {
    const p = pickPlatform(r);
    let name;
    do name = `${p.prefix}-${String(100 + Math.floor(r() * 900))}`; while (used.has(name));
    used.add(name);
    const user = `${pick(r, FIRST)}.${pick(r, LAST)}`;
    const os = p.os(r);
    const machineType = pick(r, p.machine);
    const cpu = pick(r, p.cpu);
    const ramGB = pick(r, [8, 16, 16, 32]);
    const diskGB = pick(r, [256, 512, 512, 1024]);
    let used0 = 25 + Math.floor(r() * 55);
    if (i === 7 || i === 23) used0 = 88; // two that fill up during the history
    const firewall = p.firewall(r);
    const antivirus = p.antivirus(r);
    const appVersion = r() > 0.82 ? pick(r, ["1.4.1", "1.4.0"]) : LATEST_APP;
    const silentDays = i === 11 ? 9 : i === 29 ? 4 : 0; // two that have gone quiet
    const wired = r() > 0.6;
    const ip = `198.51.100.${10 + i}`;
    const updatesNow = p.updates(r);
    const apps = p.apps(r);
    const down = Math.round(80 + r() * 600);
    const reports = [];
    for (let d = HISTORY_DAYS - 1; d >= 0; d--) {
      const usedPct = Math.min(99, used0 - Math.round(d * (used0 >= 88 ? 0.6 : 0.15)));
      reports.push({
        daysAgo: d + silentDays,
        report: {
          hostname: name, user, appVersion, machineType,
          uptime: `${1 + Math.floor(r() * 9)} days, ${Math.floor(r() * 23)} hours`,
          cpu: { model: cpu, cores: 8, threads: 12, ghz: 4.5, ghzKind: "max" },
          ram: { totalGB: ramGB, freeGB: Math.round(ramGB * (0.2 + r() * 0.5) * 10) / 10, type: "", pressure: r() > 0.9 ? "High" : "Normal" },
          disk: { totalGB: diskGB, freeGB: Math.round(diskGB * (1 - usedPct / 100)), usedPercent: usedPct, ssd: true },
          os: { ...os, build: "", pendingUpdates: d === 0 ? updatesNow : Math.max(0, updatesNow - (d % 3)), appUpdates: apps,
            lastUpdateCheck: `${1 + Math.floor(r() * 20)} hours ago`, lastUpdateKind: "checked" },
          network: { interface: wired ? "Ethernet" : "Wi-Fi", type: wired ? "Wired Ethernet" : "Wireless", linkSpeed: wired ? "1 Gbps" : "866 Mbps",
            mtu: 1500, ipv4: ip, ipv6Disabled: false, gateway: "198.51.100.1", dns: ["198.51.100.1"], isWired: wired, isVirtual: false },
          vpn: { detected: r() > 0.8, name: "WireGuard" },
          bandwidth: { downMbps: Math.round(down * (0.85 + r() * 0.3)), upMbps: Math.round(down / 6), ping: 8 + Math.round(r() * 30), jitter: Math.round(r() * 60) / 10, measuredAt: null },
          firewall, antivirus,
          power: { hasBattery: true, onBattery: r() > 0.7, batteryLevel: 20 + Math.floor(r() * 80), plugged: r() > 0.3 },
          audio: { output: "Speakers", input: "Microphone", isWired: false, headsetConnected: false, headsetClass: "Built-in" },
          backgroundApps: { runningApps: [], browserExtensions: Math.floor(r() * 12) },
        },
      });
    }
    list.push({ id: `demo-${String(i + 1).padStart(4, "0")}-${name.toLowerCase()}`, name, appVersion, silentDays, reports });
  }
  return list;
}

// Replaces everything with the demo computers, timed relative to `now`.
// Only ever called with DEMO=1. One batch, so it's all or nothing, and two
// requests seeding at once can't interleave; and few statements (rows come
// in as JSON through json_each), well inside D1's queries per request. No
// enrollment key or device token works: the stored "hashes" aren't SHA-256
// hex, so nothing hashes to them.
const PER_STATEMENT = 10; // computers' reports per INSERT, ~180 KB of JSON

async function seedDemo(sql, now) {
  const devices = [];
  const reports = [];
  for (const c of demoComputers()) {
    const offset = (c.name.charCodeAt(c.name.length - 1) % 6) * HOUR_MS;
    const at = (daysAgo) => new Date(now.getTime() - daysAgo * DAY_MS - offset).toISOString();
    const rows = c.reports.map(({ daysAgo, report }) => ({ device: c.id, at: at(daysAgo), app: c.appVersion, body: JSON.stringify(report) }));
    devices.push({ id: c.id, name: c.name, app: c.appVersion, enrolled: at(HISTORY_DAYS + 30), seen: rows[rows.length - 1].at });
    reports.push(rows);
  }
  const statements = [
    ["DELETE FROM reports"],
    ["DELETE FROM devices"],
    ["DELETE FROM settings"],
    ["INSERT INTO settings (key, value) VALUES ('organization', ?), ('enrollment_key_hash', 'demo'), ('retention_days', '90'), ('demo_seeded_at', ?)",
      [DEMO_ORGANIZATION, now.toISOString()]],
    [`INSERT INTO devices (id, token_hash, name, grp, app_version, enrolled_at, last_seen)
      SELECT value ->> '$.id', 'demo:' || (value ->> '$.id'), value ->> '$.name', '', value ->> '$.app', value ->> '$.enrolled', value ->> '$.seen'
      FROM json_each(?)`, [JSON.stringify(devices)]],
  ];
  for (let i = 0; i < reports.length; i += PER_STATEMENT) {
    statements.push([`INSERT INTO reports (device_id, received_at, schema, app_version, body)
      SELECT value ->> '$.device', value ->> '$.at', 1, value ->> '$.app', value ->> '$.body'
      FROM json_each(?) ORDER BY key`, [JSON.stringify(reports.slice(i, i + PER_STATEMENT).flat())]]);
  }
  await sql.batch(statements);
}

// Seeds the demo if it never was, or more than a day ago.
async function ensureDemo(sql, now) {
  const row = await sql.first("SELECT value FROM settings WHERE key = 'demo_seeded_at'");
  if (row && now.getTime() - new Date(row.value).getTime() < DAY_MS) return false;
  await seedDemo(sql, now);
  return true;
}

export { demoComputers, seedDemo, ensureDemo, DEMO_ORGANIZATION, COMPUTERS, LATEST_APP };
