/* global React, ReactDOM, Icon */
// Renderer entry. In the Electron build, real workstation facts are injected
// as window.__WHD_FACTS__ by bootstrap (which calls the preload bridge)
// BEFORE this file runs. If that global is absent (e.g. opened in a plain
// browser for design work), we fall back to the mock object below so the
// UI always renders.

const { useState, useEffect, useRef } = React;

// ---- Mock fallback (used only when no live facts were injected) ------------
const MOCK_FACTS = {
  hostname: "logan-macbook-pro",
  user: "logan",
  uptime: "3 days, 4 hours",
  appVersion: "1.0.0",

  cpu: {
    model: "Apple M4 Pro",
    cores: 14,
    perfCores: 10,
    effCores: 4,
    ghz: 4.5,
    family: "Apple Silicon",
    arch: "arm64",
    series: "M-series",
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
    ssid: null,
    isWired: true,
    approved: true,
  },
  bandwidth: {
    downMbps: 487,
    upMbps: 38,
    ping: 7,
    jitter: 0.4,
    measuredAt: "3 minutes ago",
    approvedDown: true,
    approvedUp: true,
  },
  vpn: { detected: false, name: null, approved: true },
  antivirus: {
    products: [{ name: "Microsoft Defender for Endpoint", version: "101.24112.0001", running: true, definitionsAge: "12 hours" }],
    approved: true,
  },
  backgroundApps: { browserExtensions: 4, runningApps: ["Slack", "Dropbox"] },
  power: { onBattery: false, batteryLevel: 100, plugged: true, lidClosed: false },
  audio: {
    output: "Plantronics Blackwire 5220 (USB)",
    input: "Plantronics Blackwire 5220 (USB)",
    isWired: true,
    headsetConnected: true,
    headsetClass: "USB headset",
    sampleRate: 48000,
  },
};

// Live facts are injected by the Electron bootstrap; fall back to the mock.
const FACTS = (typeof window !== "undefined" && window.__WHD_FACTS__) || MOCK_FACTS;

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
  if (f.bandwidth.approvedDown && f.bandwidth.approvedUp) pass.push("Bandwidth OK"); else fail.push("Bandwidth below 100/10");
  if (f.antivirus.approved && f.antivirus.products.length === 1) pass.push("One AV, current"); else if (f.antivirus.products.length === 0) fail.push("No antivirus"); else warn.push("Multiple AVs");
  if (f.audio.headsetConnected && f.audio.isWired) pass.push("Wired audio device"); else warn.push("No wired headset/mic");
  if (f.display.external) pass.push("External monitor ≥ 22\"");
  if (f.power.plugged) pass.push("Plugged in"); else warn.push("On battery");
  if (!f.vpn.detected) pass.push("No VPN"); else warn.push("VPN active");
  return { pass, warn, fail };
}

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
    if (this.testing || !window.whdSpeedTest) return;
    this.testing = true;
    this.progress = 0;
    window.dispatchEvent(new CustomEvent("speedtest-progress"));
    try {
      const res = await window.whdSpeedTest.run((pct) => {
        this.progress = pct;
        window.dispatchEvent(new CustomEvent("speedtest-progress"));
      });
      FACTS.bandwidth = { ...FACTS.bandwidth, ...res };
      recomputeVerdict();
      this.hasRun = true;
    } catch (e) {
      window.dispatchEvent(new CustomEvent("whd-toast", { detail: "Speed test failed" }));
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
        <Icon name="cloud" size={26} color="var(--whd-cyan)" />
        <div>
          <div className="brand-name">Workstation Health Dashboard</div>
          <div className="brand-sub">Local diagnostics · v{FACTS.appVersion}</div>
        </div>
      </div>
      <div className="head-right">
        <div className={`live-dot ${STATUS}`}></div>
        <div>
          <div className="syncline">{FACTS.hostname}</div>
          <div className="syncsub">Last scan {syncedAgo}s ago</div>
        </div>
      </div>
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
  const [screen, setScreen] = useState("overview"); // overview | system | network
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
        <div className="screen-wrap">
          {screen === "overview" && <OverviewScreen onJump={setScreen} />}
          {screen === "system"   && <SystemScreen />}
          {screen === "network"  && <NetworkScreen />}
        </div>
        <div className="helper-foot">
          <div>
            <div style={{ fontWeight: 700, fontSize: 13, color: "#18222d" }}>Data source</div>
            <div style={{ fontSize: 12, color: "var(--fg-3)", marginTop: 2 }}>
              Collected locally via native OS APIs. Nothing leaves this machine
              unless you configure a report endpoint.
            </div>
          </div>
          <div className="foot-actions">
            <button className="foot-btn" onClick={() => { if (window.whd && window.whd.rescan) { window.dispatchEvent(new CustomEvent("whd-toast", { detail: "Re-scanning workstation…" })); window.whd.rescan().then(() => location.reload()); } else { location.reload(); } }}><Icon name="arrow-rotate-right" size={12} /> Re-scan now</button>
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
    { id: "overview", label: "Overview", icon: "house" },
    { id: "system",   label: "System",   icon: "cog" },
    { id: "network",  label: "Network",  icon: "globe" },
  ];
  return (
    <aside className="helper-sidebar">
      <div className="sb-brand">
        <Icon name="cloud" size={22} color="var(--whd-cyan)" />
        <div>
          <div className="sb-name">Health Dashboard</div>
          <div className="sb-sub">v{FACTS.appVersion}</div>
        </div>
      </div>
      <nav className="sb-nav">
        {items.map((it) => (
          <button key={it.id} className={`sb-item ${active === it.id ? "active" : ""}`} onClick={() => onChange(it.id)}>
            <Icon name={it.icon} size={15} />
            <span className="sb-label">{it.label}</span>
          </button>
        ))}
      </nav>
      <div className="sb-foot">
        <div className="sb-foot-name">{FACTS.user}</div>
        <div className="sb-foot-sub">{FACTS.hostname}</div>
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
        <Card icon="cog" title="Quick specs" status="info" sub={FACTS.machineType || FACTS.os.name}>
          <KV k="CPU" v={FACTS.cpu.model} />
          <KV k="RAM" v={`${FACTS.ram.totalGB} GB ${FACTS.ram.type}`} />
          <KV k="Storage" v={`${FACTS.disk.totalGB} GB ${FACTS.disk.ssd == null ? "" : FACTS.disk.ssd ? "SSD" : "HDD"}`.trim()} />
          <KV k="OS" v={`${FACTS.os.name} ${FACTS.os.version}`} />
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

        <Card icon="cloud" title="Session" status="info" sub="This scan">
          <KV k="Hostname" v={FACTS.hostname} />
          <KV k="User" v={FACTS.user} />
          <KV k="Uptime" v={FACTS.uptime} />
          <KV k="App version" v={`v${FACTS.appVersion}`} />
        </Card>
      </div>

      <div className="quick-jump">
        <button className="qj-btn" onClick={() => onJump("system")}><Icon name="cog" size={13} /> System details</button>
        <button className="qj-btn" onClick={() => onJump("network")}><Icon name="globe" size={13} /> Network & speed</button>
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

      <Card icon="microphone" title="Audio" status={FACTS.audio.isWired ? "pass" : "warn"} sub={FACTS.audio.headsetClass}>
        <KV k="Output" v={FACTS.audio.output} />
        <KV k="Input" v={FACTS.audio.input} />
        <KV k="Connection" v={FACTS.audio.isWired ? "Wired" : "Wireless/built-in"} status={FACTS.audio.isWired ? "pass" : "warn"} />
        <KV k="Sample rate" v={FACTS.audio.sampleRate ? `${FACTS.audio.sampleRate} Hz` : "Unknown"} />
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
        </Card>

        <Card icon="users" title="Background apps" status="info" sub="Apps that may compete for bandwidth or CPU">
          <KV k="Running" v={FACTS.backgroundApps.runningApps.length === 0 ? "None detected" : FACTS.backgroundApps.runningApps.join(", ")} />
          <KV k="Browser extensions" v={`${FACTS.backgroundApps.browserExtensions} installed`} status={FACTS.backgroundApps.browserExtensions > 15 ? "warn" : "pass"} />
        </Card>
      </div>
    </>
  );
}

// macOS-style window frame (traffic lights + title). Wraps whatever is showing —
// the loading screen during startup, then the dashboard.
function Frame({ children }) {
  return (
    <div style={{ minHeight: "100vh", background: "#e8e8e8", display: "flex", justifyContent: "center", alignItems: "flex-start" }}>
      <div style={{ width: "100%", background: "#e8e8e8", overflow: "hidden" }}>
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
            Workstation Health Dashboard
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
      <Icon name="cloud" size={42} color="var(--whd-cyan)" />
      <div style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 600, color: "#18222d", marginTop: 16 }}>Checking your workstation…</div>
      <div style={{ fontSize: 13, color: "var(--fg-2)", marginTop: 10, display: "inline-flex", alignItems: "center", gap: 8 }}>
        <Spinner size={14} color="var(--whd-cyan)" /> {status}
      </div>
      <div style={{ width: 340, maxWidth: "80%", marginTop: 22 }}>
        <div style={{ height: 8, background: "#e3e6e9", borderRadius: 999, overflow: "hidden" }}>
          <div style={{ height: "100%", width: progress + "%", background: "var(--whd-cyan)", borderRadius: 999, transition: "width 200ms ease" }}></div>
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

    const deferredP = (window.whd && window.whd.getDeferred)
      ? window.whd.getDeferred().then((d) => {
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

ReactDOM.createRoot(document.getElementById("root")).render(<><App /><window.WhdToast /></>);
