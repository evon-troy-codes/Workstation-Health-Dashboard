/* global React, ReactDOM, Icon */
// Renderer entry. In the Electron build, real workstation facts are injected
// as window.__KAUNEONGA_FACTS__ by bootstrap.js (which calls the preload
// bridge) BEFORE this file runs. If that global is absent (e.g. opened in a
// plain browser for design work), we fall back to the mock object below so
// the UI always renders.

const { useState, useEffect, useRef } = React;

// ---- Mock fallback (used only when no live facts were injected) ------------
const MOCK_FACTS = {
  // Identity & assignment (validation-form fields)
  agentName: "Logan Shooster",
  agentEmail: "logan.shooster@kauneonga.com",
  extension: "1042",
  hostname: "logan-shooster-macbook-pro",
  user: "Logan Shooster",
  agentLogin: "logan.shooster@kauneonga.com",
  uptime: "3 days, 4 hours",
  helperVersion: "1.4.2",
  state: "NY",
  profileType: "Permanent agent · Berkshire Medical",
  phoneType: "Softphone (Liberty WebRTC)",

  cpu: {
    model: "Apple M4 Pro",
    cores: 14,
    perfCores: 10,
    effCores: 4,
    ghz: 4.5,
    family: "Apple Silicon",
    arch: "arm64",
    series: "M-series",   // matched against "no Intel T/U/G" rule
    approved: true,
  },
  machineType: "Apple MacBook Pro 16\" (2024)",
  ram: { totalGB: 32, freeGB: 14.2, type: "LPDDR5", approved: true },
  disk: { totalGB: 1024, freeGB: 614, usedPercent: 40, ssd: true, approved: true },
  display: { resolution: "1728 × 1117", external: true, externalSize: "27\"", externalConnection: "Thunderbolt (DisplayPort)", approved: true },
  os: {
    name: "macOS",
    version: "26.1",
    build: "26A123",
    lastUpdateCheck: "2 hours ago",
    pendingUpdates: 0,
    approved: true,
  },
  network: {
    interface: "en0",
    type: "Ethernet (Thunderbolt → USB-C)",
    linkSpeed: "1 Gbps",
    mtu: 1500,
    mac: "F8:4D:89:••:••:••",
    ipv4: "192.168.1.42",
    ipv6Disabled: true,
    gateway: "192.168.1.1",
    dns: ["1.1.1.1", "8.8.8.8"],
    ssid: null,             // null when wired
    isWired: true,
    isDedicated: true,      // not shared / dorm / hotel
    approved: true,
  },
  bandwidth: {
    downMbps: 487,
    upMbps: 38,
    ping: 7,
    jitter: 0.4,
    measuredAt: "3 minutes ago",
    approvedDown: true,     // ≥ 100 Mbps
    approvedUp: true,       // ≥ 10 Mbps
  },
  vpn: { detected: false, name: null, approved: true },
  antivirus: {
    products: [{ name: "Microsoft Defender for Endpoint", version: "101.24112.0001", running: true, definitionsAge: "12 hours" }],
    approved: true,
  },
  conflictingApps: { sipClients: [], browserExtensions: 4, runningCallApps: [] },
  backgroundConsumers: [
    { name: "Slack", upMbps: 0.2, downMbps: 0.3 },
    { name: "Dropbox", upMbps: 0.0, downMbps: 0.0 },
    { name: "iCloud Drive", upMbps: 0.1, downMbps: 0.0 },
  ],
  power: { onBattery: false, batteryLevel: 100, plugged: true, lidClosed: false },
  audio: {
    output: "Plantronics Blackwire 5220 (USB)",
    input: "Plantronics Blackwire 5220 (USB)",
    isWired: true,
    headsetConnected: true,
    headsetClass: "USB headset",  // USB headset | Bluetooth | Built-in
    pcReadyCertified: true,        // Telnyx/SignalWire compatibility flag
    sampleRate: 48000,
  },
  mfa: { enabled: true, methods: ["TOTP", "WebAuthn"] },

  // Human-completed checklist (Validation form)
  workspace: {
    quiet: true,
    private: true,
    secure: true,
    safe: true,
    clean: true,
    notes: "Home office, door closes. Backup ISP available.",
  },
  validation: {
    completedBy: "Karen Liu (Supervisor)",
    completedAt: "2026-05-18 10:14",
    status: "eligible",            // eligible | temp_accommodation | not_eligible
    tempAccommodation: false,
    eligible: true,
  },
};

// Live facts are injected by the Electron bootstrap; fall back to the mock.
const FACTS = (typeof window !== "undefined" && window.__KAUNEONGA_FACTS__) || MOCK_FACTS;

// Shown for fields that will come from the Liberty CRM but aren't wired yet.
const PENDING = "Pending Liberty";

// Compute overall verdict
function computeVerdict(f) {
  const pass = [];
  const warn = [];
  const fail = [];
  if (f.cpu.approved) pass.push("CPU on approved list"); else fail.push("CPU not on approved list");
  if (f.ram.totalGB >= 16) pass.push("RAM ≥ 16 GB"); else fail.push("RAM below 16 GB");
  if (f.disk.freeGB >= 50 && f.disk.totalGB >= 128 && f.disk.ssd) pass.push("Storage meets spec"); else warn.push("Storage below spec");
  if (f.display.resolution) pass.push("Resolution OK");
  if (f.os.approved) pass.push("OS supported"); else fail.push("OS not supported");
  if (f.network.isWired) pass.push("Wired Ethernet"); else warn.push("Not wired");
  if (f.network.ipv6Disabled) pass.push("IPv6 disabled"); else warn.push("IPv6 enabled");
  if (f.network.isDedicated === true) pass.push("Dedicated connection"); else if (f.network.isDedicated === false) warn.push("Shared connection");
  if (f.bandwidth.approvedDown && f.bandwidth.approvedUp) pass.push("Bandwidth OK"); else fail.push("Bandwidth below 100/10");
  if (f.antivirus.approved && f.antivirus.products.length === 1) pass.push("One AV, current"); else if (f.antivirus.products.length === 0) fail.push("No antivirus"); else warn.push("Multiple AVs");
  if (f.audio.headsetConnected && f.audio.isWired) pass.push("USB/PC-ready headset"); else warn.push("No wired USB headset");
  if (f.display.external) pass.push("External monitor ≥ 22\"");
  if (f.power.plugged) pass.push("Plugged in"); else warn.push("On battery");
  if (f.mfa.enabled === true) pass.push("MFA enabled"); else if (f.mfa.enabled === false) fail.push("MFA not enabled"); // null = pending Liberty, neutral
  if (!f.vpn.detected) pass.push("No VPN"); else warn.push("VPN active");
  const ws = f.workspace;
  const wsKnown = [ws.quiet, ws.private, ws.secure, ws.safe, ws.clean].every((v) => v != null);
  if (wsKnown) {
    if (ws.quiet && ws.private && ws.secure && ws.safe && ws.clean) pass.push("Workspace ✓");
    else warn.push("Workspace incomplete");
  } // null = pending Liberty, neutral
  return { pass, warn, fail };
}

// Workspace checklist items (booleans from Liberty; null = not yet wired).
function wsVal(v) { return v == null ? PENDING : v ? "Yes" : "No"; }
function wsStat(v) { return v == null ? null : v ? "pass" : "warn"; }

// Recomputed in place after a live measurement (e.g. the speed test) updates
// FACTS; components read these module-level values at render time, so a parent
// re-render picks up the new verdict.
let VERDICT = computeVerdict(FACTS);
let STATUS = VERDICT.fail.length ? "fail" : VERDICT.warn.length ? "warn" : "pass";
function recomputeVerdict() {
  VERDICT = computeVerdict(FACTS);
  STATUS = VERDICT.fail.length ? "fail" : VERDICT.warn.length ? "warn" : "pass";
}

// Shared speed-test controller. Auto-runs once at startup and can be re-run from
// the Network tab. Holds testing/progress so every screen can reflect it, and
// dispatches "speedtest-progress" (re-render) + "facts-updated" (verdict) events.
const SpeedTest = {
  testing: false,
  progress: 0,
  hasRun: false,
  async run() {
    if (this.testing || !window.ascSpeedTest) return;
    this.testing = true;
    this.progress = 0;
    window.dispatchEvent(new CustomEvent("speedtest-progress"));
    try {
      const res = await window.ascSpeedTest.run((pct) => {
        this.progress = pct;
        window.dispatchEvent(new CustomEvent("speedtest-progress"));
      });
      FACTS.bandwidth = { ...FACTS.bandwidth, ...res };
      recomputeVerdict();
      this.hasRun = true;
    } catch (e) {
      window.dispatchEvent(new CustomEvent("liberty-toast", { detail: "Speed test failed" }));
    } finally {
      this.testing = false;
      window.dispatchEvent(new CustomEvent("speedtest-progress"));
      window.dispatchEvent(new CustomEvent("facts-updated"));
    }
  },
};

// ---- UI --------------------------------------------------------------------

function Header({ syncedAgo }) {
  return (
    <div className="helper-head">
      <div className="brand">
        <Icon name="cloud" size={26} color="var(--kau-cyan)" />
        <div>
          <div className="brand-name">Kauneonga Helper</div>
          <div className="brand-sub">Workstation health for Liberty · v{FACTS.helperVersion}</div>
        </div>
      </div>
      <div className="head-right">
        <div className={`live-dot ${STATUS}`}></div>
        <div>
          <div className="syncline">Connected to Liberty</div>
          <div className="syncsub">Last sync {syncedAgo}s ago · {FACTS.hostname}</div>
        </div>
      </div>
    </div>
  );
}

function VerdictBar() {
  const status = FACTS.validation.status;
  const statusLabel = status === "eligible" ? "Eligible to handle calls" :
                      status === "temp_accommodation" ? "Eligible with temporary accommodation" :
                      status === "pending" ? PENDING :
                      "Not eligible";
  return (
    <div className={`verdict-bar verdict-${STATUS}`}>
      <div className="verdict-left">
        <div className={`big-dot ${STATUS}`}></div>
        <div>
          <div className="verdict-h">
            {STATUS === "pass" ? "Workstation is healthy" :
             STATUS === "warn" ? "Minor issues detected" :
             "Out of IT spec"}
          </div>
          <div className="verdict-d">
            Validation status: <strong style={{ color: "#18222d" }}>{statusLabel}</strong> · {VERDICT.pass.length} pass · {VERDICT.warn.length} warn · {VERDICT.fail.length} fail
          </div>
        </div>
      </div>
      <button className="send-btn" onClick={() => { if (window.kauneonga && window.kauneonga.sendReport) { window.kauneonga.sendReport(FACTS); } window.dispatchEvent(new CustomEvent("liberty-toast", { detail: "Health report sent to Liberty" })); }}>
        <Icon name="paper-plane" /> Send health report
      </button>
    </div>
  );
}

function Card({ icon, title, status, children, sub }) {
  return (
    <div className="hcard">
      <div className="hcard-head">
        <div className="hcard-icon"><Icon name={icon} size={16} /></div>
        <div className="hcard-title">
          <div className="t">{title}</div>
          {sub && <div className="s">{sub}</div>}
        </div>
        <div className={`hpill ${status}`}>
          {status === "pass" ? "Pass" : status === "warn" ? "Warn" : status === "fail" ? "Fail" : "Info"}
        </div>
      </div>
      <div className="hcard-body">{children}</div>
    </div>
  );
}

function KV({ k, v, status }) {
  return (
    <div className="kv">
      <span className="kv-k">{k}</span>
      <span className="kv-v">{v}{status && <span className={`kv-dot ${status}`}></span>}</span>
    </div>
  );
}

function HelperApp() {
  const [screen, setScreen] = useState("overview"); // overview | system | network | validation
  const [syncedAgo, setSyncedAgo] = useState(2);
  const [, setTick] = useState(0); // bumped on "facts-updated" to re-render with new data
  useEffect(() => {
    // Startup data (deferred scans + speed test) is gathered by <App> before
    // this dashboard mounts; here we only keep the UI in sync with re-runs.
    const id = setInterval(() => setSyncedAgo((s) => (s >= 60 ? 0 : s + 1)), 1000);
    const onUpdate = () => setTick((t) => t + 1);
    window.addEventListener("facts-updated", onUpdate);
    window.addEventListener("speedtest-progress", onUpdate);
    return () => {
      clearInterval(id);
      window.removeEventListener("facts-updated", onUpdate);
      window.removeEventListener("speedtest-progress", onUpdate);
    };
  }, []);

  return (
    <div className="helper-shell">
      <Sidebar active={screen} onChange={setScreen} />
      <div className="helper-main">
        <Header syncedAgo={syncedAgo} />
        <VerdictBar />
        <div className="screen-wrap">
          {screen === "overview"   && <OverviewScreen onJump={setScreen} />}
          {screen === "system"     && <SystemScreen />}
          {screen === "network"    && <NetworkScreen />}
          {screen === "validation" && <ValidationScreen />}
        </div>
        <div className="helper-foot">
          <div>
            <div style={{ fontWeight: 700, fontSize: 13, color: "#18222d" }}>Data source</div>
            <div style={{ fontSize: 12, color: "var(--fg-3)", marginTop: 2 }}>
              Collected locally via osquery + native OS APIs. Reports are signed and sent over TLS to Liberty.
              Nothing is shared with third parties.
            </div>
          </div>
          <div className="foot-actions">
            <button className="foot-btn" onClick={() => { if (window.kauneonga && window.kauneonga.rescan) { window.dispatchEvent(new CustomEvent("liberty-toast", { detail: "Re-scanning workstation…" })); window.kauneonga.rescan().then(() => location.reload()); } else { location.reload(); } }}><Icon name="arrow-rotate-right" size={12} /> Re-scan now</button>
            <a className="foot-btn" href="https://www.kauneonga.com/docs/help-center/it/it-best-practices" target="_blank" rel="noopener"><Icon name="book" size={12} /> View IT Best Practices</a>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Sidebar nav
// ============================================================================
function Sidebar({ active, onChange }) {
  const items = [
    { id: "overview",   label: "Overview",   icon: "house",      badge: null },
    { id: "system",     label: "System",     icon: "cog",        badge: null },
    { id: "network",    label: "Network",    icon: "globe",      badge: null },
    { id: "validation", label: "Validation", icon: "circle-check", badge: FACTS.validation.eligible === false ? "!" : null },
  ];
  return (
    <aside className="helper-sidebar">
      <div className="sb-brand">
        <Icon name="cloud" size={22} color="var(--kau-cyan)" />
        <div>
          <div className="sb-name">Helper</div>
          <div className="sb-sub">v{FACTS.helperVersion}</div>
        </div>
      </div>
      <nav className="sb-nav">
        {items.map((it) => (
          <button key={it.id} className={`sb-item ${active === it.id ? "active" : ""}`} onClick={() => onChange(it.id)}>
            <Icon name={it.icon} size={15} />
            <span className="sb-label">{it.label}</span>
            {it.badge && <span className="sb-badge">{it.badge}</span>}
          </button>
        ))}
      </nav>
      <div className="sb-foot">
        <div className="sb-foot-name">{FACTS.agentName || FACTS.user}</div>
        <div className="sb-foot-sub">
          {FACTS.extension ? `Ext. ${FACTS.extension}` : FACTS.hostname}
          {FACTS.state ? ` · ${FACTS.state}` : ""}
        </div>
      </div>
    </aside>
  );
}

// ============================================================================
// Screen 1 — Overview
// ============================================================================
function OverviewScreen({ onJump }) {
  const allRows = [
    ...VERDICT.fail.map((t) => ({ sev: "fail", text: t })),
    ...VERDICT.warn.map((t) => ({ sev: "warn", text: t })),
  ];
  return (
    <>
      {/* Big numbers row */}
      <div className="ov-stats">
        <div className="ov-stat ov-pass">
          <div className="ov-stat-v">{VERDICT.pass.length}</div>
          <div className="ov-stat-l">Pass</div>
        </div>
        <div className="ov-stat ov-warn">
          <div className="ov-stat-v">{VERDICT.warn.length}</div>
          <div className="ov-stat-l">Warn</div>
        </div>
        <div className="ov-stat ov-fail">
          <div className="ov-stat-v">{VERDICT.fail.length}</div>
          <div className="ov-stat-l">Fail</div>
        </div>
        <div className="ov-stat ov-mos">
          <div className="ov-stat-v">{FACTS.bandwidth.downMbps == null ? "—" : FACTS.bandwidth.downMbps}</div>
          <div className="ov-stat-l">Mbps down</div>
        </div>
      </div>

      <div className="card-grid card-grid-2">
        <Card icon="users" title="Agent & assignment" status="info" sub="Provided by Liberty">
          <KV k="Name" v={FACTS.agentName || PENDING} />
          <KV k="Email" v={FACTS.agentEmail || PENDING} />
          <KV k="Extension" v={FACTS.extension || PENDING} />
          <KV k="State" v={FACTS.state || PENDING} />
          <KV k="Profile type" v={FACTS.profileType || PENDING} />
          <KV k="Phone type" v={FACTS.phoneType || PENDING} />
        </Card>

        <Card icon="circle-check" title="Validation" status={FACTS.validation.eligible == null ? "info" : FACTS.validation.eligible ? "pass" : "fail"} sub={FACTS.validation.completedBy || "Provided by Liberty"}>
          <KV k="Status" v={
            FACTS.validation.status === "eligible" ? "Eligible to handle calls" :
            FACTS.validation.status === "temp_accommodation" ? "Eligible — temp accommodation" :
            FACTS.validation.status === "pending" ? PENDING :
            "Not eligible"
          } status={FACTS.validation.eligible == null ? null : FACTS.validation.eligible ? "pass" : "fail"} />
          <KV k="Temp accommodation" v={FACTS.validation.tempAccommodation == null ? PENDING : FACTS.validation.tempAccommodation ? "Granted" : "No"} />
          <KV k="Completed by" v={FACTS.validation.completedBy || PENDING} />
          <KV k="Completed at" v={FACTS.validation.completedAt || PENDING} />
        </Card>

        <Card icon="triangle-exclamation" title={`Findings (${allRows.length})`} status={allRows.length === 0 ? "pass" : VERDICT.fail.length > 0 ? "fail" : "warn"} sub={allRows.length === 0 ? "Nothing to flag" : "Items needing attention"}>
          {allRows.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--semantic-green)", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Icon name="circle-check" size={14} /> Workstation meets every check.
            </div>
          ) : (
            allRows.map((r, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", fontSize: 12, color: "var(--fg-1)" }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: r.sev === "fail" ? "var(--state-hungup)" : "var(--semantic-orange)" }}></span>
                {r.text}
              </div>
            ))
          )}
        </Card>

        <Card icon="cloud" title="Session" status="info" sub="Helper session details">
          <KV k="Hostname" v={FACTS.hostname} />
          <KV k="Agent login" v={FACTS.agentLogin} />
          <KV k="Uptime" v={FACTS.uptime} />
          <KV k="Helper version" v={`v${FACTS.helperVersion}`} />
        </Card>
      </div>

      <div className="quick-jump">
        <button className="qj-btn" onClick={() => onJump("system")}><Icon name="cog" size={13} /> System details</button>
        <button className="qj-btn" onClick={() => onJump("network")}><Icon name="globe" size={13} /> Network & speed</button>
        <button className="qj-btn" onClick={() => onJump("validation")}><Icon name="circle-check" size={13} /> Validation</button>
      </div>
    </>
  );
}

// ============================================================================
// Screen 2 — System
// ============================================================================
function SystemScreen() {
  return (
    <div className="card-grid card-grid-2">
      <Card icon="cog" title="Processor" status={FACTS.cpu.approved ? "pass" : "fail"} sub={`${FACTS.cpu.cores} cores · ${FACTS.cpu.ghz} GHz · ${FACTS.cpu.arch}`}>
        <KV k="Model" v={FACTS.cpu.model} />
        <KV k="Machine" v={FACTS.machineType} />
        <KV k="Family / series" v={`${FACTS.cpu.family} · ${FACTS.cpu.series}`} />
        <KV k="Cores" v={`${FACTS.cpu.cores} (${FACTS.cpu.perfCores}P + ${FACTS.cpu.effCores}E)`} />
        <KV k="Meets req." v={FACTS.cpu.approved ? "On approved list" : "Not on approved list"} status={FACTS.cpu.approved ? "pass" : "fail"} />
      </Card>

      <Card icon="grip" title="Memory" status={FACTS.ram.totalGB >= 16 ? "pass" : "fail"} sub="≥16 GB required">
        <KV k="Total" v={`${FACTS.ram.totalGB} GB ${FACTS.ram.type}`} />
        <KV k="Free" v={`${FACTS.ram.freeGB} GB`} />
        <KV k="Pressure" v={FACTS.ram.pressure} status={FACTS.ram.pressure === "Normal" ? "pass" : FACTS.ram.pressure === "Moderate" ? "warn" : "fail"} />
        <KV k="Meets req." v={FACTS.ram.totalGB >= 16 ? "Yes" : "No"} status={FACTS.ram.totalGB >= 16 ? "pass" : "fail"} />
      </Card>

      <Card icon="briefcase" title="Hard drive" status={FACTS.disk.ssd == null ? "info" : FACTS.disk.freeGB >= 50 && FACTS.disk.totalGB >= 128 && FACTS.disk.ssd ? "pass" : "warn"} sub={`${FACTS.disk.ssd == null ? "Checking…" : FACTS.disk.ssd ? "SSD" : "HDD"} · ${FACTS.disk.totalGB} GB total`}>
        <KV k="Total" v={`${FACTS.disk.totalGB} GB`} />
        <KV k="Free" v={`${FACTS.disk.freeGB} GB`} status={FACTS.disk.freeGB >= 50 ? "pass" : "fail"} />
        <KV k="Used" v={`${FACTS.disk.usedPercent}%`} />
        <KV k="Drive type" v={FACTS.disk.ssd == null ? "Checking…" : FACTS.disk.ssd ? "SSD" : "HDD"} status={FACTS.disk.ssd == null ? null : FACTS.disk.ssd ? "pass" : "warn"} />
        <KV k="Meets req." v={FACTS.disk.ssd == null ? "Checking…" : FACTS.disk.totalGB >= 128 && FACTS.disk.freeGB >= 50 && FACTS.disk.ssd ? "Yes" : "Below spec"} status={FACTS.disk.ssd == null ? null : FACTS.disk.totalGB >= 128 && FACTS.disk.freeGB >= 50 && FACTS.disk.ssd ? "pass" : "fail"} />
      </Card>

      <Card icon="house" title="Operating system" status={FACTS.os.approved ? "pass" : "fail"} sub={`${FACTS.os.name} ${FACTS.os.version}`}>
        <KV k="Computer name" v={FACTS.hostname} />
        <KV k="Version" v={`${FACTS.os.version} (${FACTS.os.build})`} />
        <KV k="Meets req." v={FACTS.os.approved ? "Yes" : "No"} status={FACTS.os.approved ? "pass" : "fail"} />
      </Card>

      <Card icon="circle-info" title="OS updates" status={FACTS.os.pendingUpdates == null ? "info" : FACTS.os.pendingUpdates === 0 ? "pass" : "warn"} sub={`Last checked ${FACTS.os.lastUpdateCheck}`}>
        <KV k="Pending updates" v={FACTS.os.pendingUpdates == null ? "Unknown" : FACTS.os.pendingUpdates === 0 ? "None" : `${FACTS.os.pendingUpdates} pending`} status={FACTS.os.pendingUpdates == null ? null : FACTS.os.pendingUpdates === 0 ? "pass" : "warn"} />
        <KV k="Last check" v={FACTS.os.lastUpdateCheck} />
        <KV k="Meets req." v={FACTS.os.pendingUpdates == null ? "Unknown" : FACTS.os.pendingUpdates === 0 ? "Yes" : "No"} status={FACTS.os.pendingUpdates == null ? null : FACTS.os.pendingUpdates === 0 ? "pass" : "warn"} />
      </Card>

      <Card icon="circle-check" title="Antivirus" status={FACTS.antivirus.products.length === 1 ? "pass" : FACTS.antivirus.products.length === 0 ? "fail" : "warn"} sub="One product required">
        {FACTS.antivirus.products.length === 0 && (
          <KV k="Status" v="No antivirus detected" status="fail" />
        )}
        {FACTS.antivirus.products.map((p, i) => (
          <KV key={i} k={p.name} v={
            [p.version ? `v${p.version}` : null, p.definitionsAge ? `defs ${p.definitionsAge}` : null]
              .filter(Boolean).join(" · ") || (p.running ? "Active" : "Inactive")
          } status={p.running ? "pass" : "fail"} />
        ))}
        <KV k="Meets req." v={FACTS.antivirus.products.length === 1 ? "Yes (one active)" : FACTS.antivirus.products.length === 0 ? "No AV" : "Multiple AVs"} status={FACTS.antivirus.products.length === 1 ? "pass" : "fail"} />
      </Card>

      <Card icon="circle-info" title="Security" status={FACTS.mfa.enabled == null ? "info" : FACTS.mfa.enabled ? "pass" : "fail"} sub="MFA + conflict checks">
        <KV k="MFA enabled" v={FACTS.mfa.enabled == null ? PENDING : FACTS.mfa.enabled ? "Yes" : "No"} status={FACTS.mfa.enabled == null ? null : FACTS.mfa.enabled ? "pass" : "fail"} />
        <KV k="MFA methods" v={FACTS.mfa.methods && FACTS.mfa.methods.length ? FACTS.mfa.methods.join(", ") : PENDING} />
        <KV k="VPN detected" v={FACTS.vpn.detected ? FACTS.vpn.name || "Unknown" : "None"} status={FACTS.vpn.detected ? "warn" : "pass"} />
        <KV k="Other SIP clients" v={FACTS.conflictingApps.sipClients.length === 0 ? "None" : FACTS.conflictingApps.sipClients.join(", ")} status={FACTS.conflictingApps.sipClients.length > 1 ? "fail" : "pass"} />
      </Card>

      <Card icon="phone" title="Power" status={FACTS.power.plugged ? "pass" : "warn"} sub={`${FACTS.power.batteryLevel}% · ${FACTS.power.plugged ? "Plugged in" : "On battery"}`}>
        <KV k="Battery" v={`${FACTS.power.batteryLevel}%`} status="pass" />
        <KV k="Power source" v={FACTS.power.plugged ? "AC adapter" : "Battery"} status={FACTS.power.plugged ? "pass" : "warn"} />
        <KV k="Lid closed" v={FACTS.power.lidClosed == null ? "Unknown" : FACTS.power.lidClosed ? "Yes" : "No"} />
      </Card>
    </div>
  );
}

// Latency/jitter quality: lower is better. good ≤ thresholds[0], ok ≤ [1].
function qualityLabel(v, good, ok) {
  if (v == null) return "—";
  if (v <= good) return "Excellent";
  if (v <= ok) return "Good";
  return "High";
}
function qualityClass(v, good, ok) {
  if (v == null) return "";
  if (v <= good) return "pass";
  if (v <= ok) return "warn";
  return "fail";
}

// ============================================================================
// Screen 3 — Network
// ============================================================================
function NetworkScreen() {
  // State lives in the shared SpeedTest controller (auto-started at app launch);
  // this screen reflects it and can re-trigger a run.
  const testing = SpeedTest.testing;
  const progress = SpeedTest.progress;
  const runTest = () => SpeedTest.run();
  const b = FACTS.bandwidth;
  return (
    <>
      {/* Big speed card */}
      <div className="speed-hero">
        <div className="sh-col">
          <div className="sh-label">Download</div>
          <div className="sh-value">{b.downMbps == null ? "—" : b.downMbps}<span className="sh-unit">Mbps</span></div>
          {b.downMbps == null
            ? <div className="sh-tag">{testing ? "Testing…" : "—"}</div>
            : <div className={`sh-tag ${b.approvedDown ? "pass" : "fail"}`}>{b.approvedDown ? "≥ 100 ✓" : "Below 100"}</div>}
        </div>
        <div className="sh-col">
          <div className="sh-label">Upload</div>
          <div className="sh-value">{b.upMbps == null ? "—" : b.upMbps}<span className="sh-unit">Mbps</span></div>
          {b.upMbps == null
            ? <div className="sh-tag">{testing ? "Testing…" : "—"}</div>
            : <div className={`sh-tag ${b.approvedUp ? "pass" : "fail"}`}>{b.approvedUp ? "≥ 10 ✓" : "Below 10"}</div>}
        </div>
        <div className="sh-col">
          <div className="sh-label">Ping</div>
          <div className="sh-value">{b.ping == null ? "—" : b.ping}<span className="sh-unit">ms</span></div>
          <div className={`sh-tag ${qualityClass(b.ping, 50, 100)}`}>{qualityLabel(b.ping, 50, 100)}</div>
        </div>
        <div className="sh-col">
          <div className="sh-label">Jitter</div>
          <div className="sh-value">{b.jitter == null ? "—" : b.jitter}<span className="sh-unit">ms</span></div>
          <div className={`sh-tag ${qualityClass(b.jitter, 5, 20)}`}>{qualityLabel(b.jitter, 5, 20)}</div>
        </div>
        <div className="sh-action">
          <button className="send-btn" onClick={runTest} disabled={testing}>
            {testing ? <Spinner size={14} color="#fff" /> : <Icon name="arrow-rotate-right" />}
            {testing ? ` Testing… ${progress}%` : " Run speed test"}
          </button>
          <div className="sh-meta">Measured {testing ? "now…" : b.measuredAt}</div>
        </div>
      </div>

      <div className="card-grid card-grid-2">
        <Card icon="globe" title="Network interface" status={FACTS.network.approved ? "pass" : "warn"} sub={FACTS.network.type}>
          <KV k="Connection type" v={FACTS.network.isWired ? "Wired Ethernet" : "Wireless"} status={FACTS.network.isWired ? "pass" : "warn"} />
          <KV k="Interface" v={`${FACTS.network.interface} · ${FACTS.network.linkSpeed}`} />
          <KV k="Dedicated line" v={FACTS.network.isDedicated == null ? "Unknown" : FACTS.network.isDedicated ? "Yes (private)" : "Shared"} status={FACTS.network.isDedicated == null ? null : FACTS.network.isDedicated ? "pass" : "warn"} />
          <KV k="MAC address" v={FACTS.network.mac} />
          <KV k="MTU" v={FACTS.network.mtu} />
        </Card>

        <Card icon="cloud" title="Routing" status="pass" sub="IPv4, gateway, DNS">
          <KV k="IPv4" v={FACTS.network.ipv4} />
          <KV k="Gateway" v={FACTS.network.gateway} />
          <KV k="DNS" v={FACTS.network.dns.join(", ")} />
          <KV k="IPv6" v={FACTS.network.ipv6Disabled ? "Disabled" : "Enabled"} status={FACTS.network.ipv6Disabled ? "pass" : "warn"} />
        </Card>

        <Card icon="circle-check" title="VPN" status={FACTS.vpn.detected ? "warn" : "pass"} sub="Traditional VPNs may add jitter">
          <KV k="Detected" v={FACTS.vpn.detected ? FACTS.vpn.name || "Unknown VPN" : "None"} status={FACTS.vpn.detected ? "warn" : "pass"} />
          {FACTS.vpn.detected && <KV k="Note" v="Recommend zero-trust access if endpoint controls are needed." />}
        </Card>

        <Card icon="users" title="Background apps" status={FACTS.conflictingApps.sipClients.length > 1 ? "fail" : "pass"} sub="Apps competing for bandwidth or audio">
          <KV k="Other SIP clients" v={FACTS.conflictingApps.sipClients.length === 0 ? "None" : FACTS.conflictingApps.sipClients.join(", ")} status={FACTS.conflictingApps.sipClients.length > 1 ? "fail" : "pass"} />
          <KV k="Browser extensions" v={`${FACTS.conflictingApps.browserExtensions} installed`} status={FACTS.conflictingApps.browserExtensions > 3 ? "warn" : "pass"} />
          {FACTS.backgroundConsumers.map((c) => (
            <KV key={c.name} k={c.name} v={`↓ ${c.downMbps} Mbps  ↑ ${c.upMbps} Mbps`} />
          ))}
        </Card>
      </div>
    </>
  );
}

// ============================================================================
// Screen 4 — Validation
// ============================================================================
function ValidationScreen() {
  return (
    <>
      <div className="card-grid card-grid-2">
        <Card icon="users" title="Agent & assignment" status="info" sub="Provided by Liberty">
          <KV k="Name" v={FACTS.agentName || PENDING} />
          <KV k="Email" v={FACTS.agentEmail || PENDING} />
          <KV k="Extension" v={FACTS.extension || PENDING} />
          <KV k="State" v={FACTS.state || PENDING} />
          <KV k="Profile type" v={FACTS.profileType || PENDING} />
          <KV k="Phone type" v={FACTS.phoneType || PENDING} />
        </Card>

        <Card icon="microphone" title="Headset" status={FACTS.audio.isWired && FACTS.audio.pcReadyCertified ? "pass" : "warn"} sub={FACTS.audio.headsetClass}>
          <KV k="Model" v={FACTS.audio.input} />
          <KV k="USB or PC-ready" v={FACTS.audio.isWired ? "USB" : "Bluetooth / built-in"} status={FACTS.audio.isWired ? "pass" : "warn"} />
          <KV k="PC-ready certified" v={FACTS.audio.pcReadyCertified ? "Yes" : "No"} status={FACTS.audio.pcReadyCertified ? "pass" : "warn"} />
          <KV k="Sample rate" v={FACTS.audio.sampleRate ? `${FACTS.audio.sampleRate} Hz` : "Unknown"} />
          <KV k="Meets req." v={FACTS.audio.isWired && FACTS.audio.pcReadyCertified ? "Yes" : "No"} status={FACTS.audio.isWired && FACTS.audio.pcReadyCertified ? "pass" : "warn"} />
        </Card>

        <Card icon="fullscreen" title="External monitor" status={FACTS.display.external ? "pass" : "warn"} sub={"≥ 22\" required for permanent agents"}>
          <KV k="Built-in resolution" v={FACTS.display.resolution} />
          <KV k="External monitor" v={FACTS.display.external ? `${FACTS.display.externalSize} display` : "None detected"} status={FACTS.display.external ? "pass" : "warn"} />
          <KV k="Connection" v={FACTS.display.external ? FACTS.display.externalConnection : "—"} />
          <KV k="Meets req." v={FACTS.display.external ? "Yes" : "No"} status={FACTS.display.external ? "pass" : "warn"} />
        </Card>

        <Card icon="house" title="Workspace check" status={[FACTS.workspace.quiet, FACTS.workspace.private, FACTS.workspace.secure, FACTS.workspace.safe, FACTS.workspace.clean].some((v) => v == null) ? "info" : FACTS.workspace.quiet && FACTS.workspace.private && FACTS.workspace.secure && FACTS.workspace.safe && FACTS.workspace.clean ? "pass" : "warn"} sub="Completed in Liberty by your supervisor">
          <KV k="Quiet" v={wsVal(FACTS.workspace.quiet)} status={wsStat(FACTS.workspace.quiet)} />
          <KV k="Private" v={wsVal(FACTS.workspace.private)} status={wsStat(FACTS.workspace.private)} />
          <KV k="Secure" v={wsVal(FACTS.workspace.secure)} status={wsStat(FACTS.workspace.secure)} />
          <KV k="Safe" v={wsVal(FACTS.workspace.safe)} status={wsStat(FACTS.workspace.safe)} />
          <KV k="Clean" v={wsVal(FACTS.workspace.clean)} status={wsStat(FACTS.workspace.clean)} />
          {FACTS.workspace.notes && <KV k="Notes" v={FACTS.workspace.notes} />}
        </Card>
      </div>

      <div className="sign-off">
        <div className="so-left">
          <div className="so-title">Final validation <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--fg-3)", marginLeft: 8, background: "#eef1f4", padding: "3px 7px", borderRadius: 4 }}>Read-only</span></div>
          <div className="so-row">
            <div className={`so-badge ${FACTS.validation.eligible == null ? "" : FACTS.validation.eligible ? "pass" : "fail"}`} style={FACTS.validation.eligible == null ? { background: "#eef1f4", color: "var(--fg-2)" } : undefined}>
              <Icon name={FACTS.validation.eligible == null ? "circle-info" : FACTS.validation.eligible ? "circle-check" : "circle-xmark"} size={14} />
              {FACTS.validation.status === "eligible" ? "Eligible to handle calls" :
               FACTS.validation.status === "temp_accommodation" ? "Eligible — temp accommodation granted" :
               FACTS.validation.status === "pending" ? PENDING :
               "Not eligible"}
            </div>
            <div className="so-meta">
              {FACTS.validation.completedBy
                ? <>Completed by <strong>{FACTS.validation.completedBy}</strong> at {FACTS.validation.completedAt}. Contact your supervisor to update.</>
                : "Validation is completed in Liberty by your supervisor."}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// macOS-style window frame (traffic lights + title). Wraps whatever is showing —
// the loading screen during startup, then the dashboard.
function Frame({ children }) {
  return (
    <div style={{ minHeight: "100vh", background: "#fff", display: "flex", justifyContent: "center", alignItems: "flex-start" }}>
      <div style={{ width: "100%", background: "#fff", overflow: "hidden" }}>
        <div style={{
          height: 38, background: "#ededed", borderBottom: "1px solid #d6d6d6",
          display: "flex", alignItems: "center", padding: "0 14px",
          position: "relative",
        }}>
          <div style={{ display: "flex", gap: 8 }}>
            <span style={{ width: 12, height: 12, borderRadius: "50%", background: "#ff5f57", border: "0.5px solid rgba(0,0,0,0.18)" }}></span>
            <span style={{ width: 12, height: 12, borderRadius: "50%", background: "#febc2e", border: "0.5px solid rgba(0,0,0,0.18)" }}></span>
            <span style={{ width: 12, height: 12, borderRadius: "50%", background: "#28c840", border: "0.5px solid rgba(0,0,0,0.18)" }}></span>
          </div>
          <div style={{
            position: "absolute", left: "50%", top: "50%",
            transform: "translate(-50%, -50%)",
            fontSize: 13, fontWeight: 600, color: "#3a3a3a",
            fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
          }}>
            Kauneonga Helper
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

// Shown until startup checks finish. The network speed test MUST complete before
// the dashboard renders, otherwise the verdict would briefly show a false
// "bandwidth fail" while the test is still running.
function LoadingScreen({ status, progress }) {
  return (
    <div style={{ minHeight: 600, background: "#f7f8f9", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 40, textAlign: "center" }}>
      <Icon name="cloud" size={42} color="var(--kau-cyan)" />
      <div style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 600, color: "#18222d", marginTop: 16 }}>Checking your workstation…</div>
      <div style={{ fontSize: 13, color: "var(--fg-2)", marginTop: 10, display: "inline-flex", alignItems: "center", gap: 8 }}>
        <Spinner size={14} color="var(--kau-cyan)" /> {status}
      </div>
      <div style={{ width: 340, maxWidth: "80%", marginTop: 22 }}>
        <div style={{ height: 8, background: "#e3e6e9", borderRadius: 999, overflow: "hidden" }}>
          <div style={{ height: "100%", width: progress + "%", background: "var(--kau-cyan)", borderRadius: 999, transition: "width 200ms ease" }}></div>
        </div>
        <div style={{ fontSize: 12, color: "var(--fg-3)", marginTop: 8 }}>Network speed test · {progress}%</div>
      </div>
      <div style={{ fontSize: 12, color: "var(--fg-3)", marginTop: 22, maxWidth: 380 }}>
        Please wait — the speed test must finish before your results are shown.
      </div>
    </div>
  );
}

// Gates the dashboard: collects the deferred scans and runs the speed test to
// completion, then renders results once — so they're never shown half-measured.
function App() {
  const [ready, setReady] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Running network speed test…");
  useEffect(() => {
    const onProg = () => setProgress(SpeedTest.progress);
    window.addEventListener("speedtest-progress", onProg);

    const deferredP = (window.kauneonga && window.kauneonga.getDeferred)
      ? window.kauneonga.getDeferred().then((d) => {
          if (d) {
            FACTS.os.pendingUpdates = d.pendingUpdates;
            FACTS.os.lastUpdateCheck = d.lastUpdateCheck;
            FACTS.disk.ssd = d.ssd;
          }
        }).catch(() => {})
      : Promise.resolve();

    const speedP = SpeedTest.run();

    Promise.all([deferredP, speedP]).then(() => {
      recomputeVerdict(); // bandwidth + SSD now final
      setStatus("Finishing up…");
      setReady(true);
    });

    return () => window.removeEventListener("speedtest-progress", onProg);
  }, []);

  return (
    <Frame>
      {ready ? <HelperApp /> : <LoadingScreen status={status} progress={progress} />}
    </Frame>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<><App /><window.LibertyToast /></>);
