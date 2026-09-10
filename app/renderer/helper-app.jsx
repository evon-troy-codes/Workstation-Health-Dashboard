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
  appVersion: "1.1.0",

  cpu: {
    model: "Apple M4 Pro",
    cores: 14,
    perfCores: 10,
    effCores: 4,
    ghz: 4.5,
    family: "Apple Silicon",
    arch: "arm64",
    series: "M-series",
  },
  machineType: "Apple MacBook Pro 16\" (2024)",
  ram: { totalGB: 32, freeGB: 14.2, type: "LPDDR5" },
  disk: { totalGB: 1024, freeGB: 614, usedPercent: 40, ssd: true },
  display: { resolution: "1728 × 1117", external: true, externalSize: "27\"", externalConnection: "Thunderbolt (DisplayPort)" },
  os: {
    name: "macOS",
    version: "26.1",
    build: "26A123",
    lastUpdateCheck: "2 hours ago",
    pendingUpdates: 0,
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
  },
  bandwidth: {
    downMbps: 487,
    upMbps: 38,
    ping: 7,
    jitter: 0.4,
    measuredAt: "3 minutes ago",
  },
  vpn: { detected: false, name: null },
  antivirus: {
    products: [{ name: "Microsoft Defender for Endpoint", version: "101.24112.0001", running: true, definitionsAge: "12 hours" }],
  },
  backgroundApps: { browserExtensions: 4, runningApps: ["Slack", "Dropbox"] },
  power: { onBattery: false, batteryLevel: 100, plugged: true },
  audio: {
    output: "Plantronics Blackwire 5220 (USB)",
    input: "Plantronics Blackwire 5220 (USB)",
    isWired: true,
    headsetConnected: true,
    headsetClass: "USB headset",
  },
};

// Live facts are injected by the Electron bootstrap; fall back to the mock.
const FACTS = (typeof window !== "undefined" && window.__WHD_FACTS__) || MOCK_FACTS;

// Shared speed-test controller. Auto-runs once at startup and can be re-run from
// the Network tab. Holds testing/progress so every screen can reflect it, and
// dispatches "speedtest-progress" (re-render) + "facts-updated" (data refresh) events.
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
        <img src="assets/logo/logo-mark.svg" alt="" width={26} height={26} style={{ display: "block" }} />
        <div>
          <div className="brand-name">Workstation Health Dashboard</div>
          <div className="brand-sub">Local diagnostics · v{FACTS.appVersion}</div>
        </div>
      </div>
      <div className="head-right">
        <div>
          <div className="syncline">{FACTS.hostname}</div>
          <div className="syncsub">Last scan {syncedAgo}s ago</div>
        </div>
      </div>
    </div>
  );
}

function Card({ icon, title, children, sub }) {
  return (
    <div className="hcard">
      <div className="hcard-head">
        <div className="hcard-icon"><Icon name={icon} size={16} /></div>
        <div className="hcard-title">
          <div className="t">{title}</div>
          {sub && <div className="s">{sub}</div>}
        </div>
      </div>
      <div className="hcard-body">{children}</div>
    </div>
  );
}

function KV({ k, v }) {
  return (
    <div className="kv">
      <span className="kv-k">{k}</span>
      <span className="kv-v">{v}</span>
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
        <img src="assets/logo/logo-mark.svg" alt="" width={22} height={22} style={{ display: "block" }} />
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
  return (
    <>
      <div className="card-grid card-grid-2">
        <Card icon="cog" title="Quick specs" sub={FACTS.machineType || FACTS.os.name}>
          <KV k="CPU" v={FACTS.cpu.model} />
          <KV k="RAM" v={`${FACTS.ram.totalGB} GB ${FACTS.ram.type}`} />
          <KV k="Storage" v={`${FACTS.disk.totalGB} GB ${FACTS.disk.ssd == null ? "" : FACTS.disk.ssd ? "SSD" : "HDD"}`.trim()} />
          <KV k="OS" v={`${FACTS.os.name} ${FACTS.os.version}`} />
        </Card>

        <Card icon="cloud" title="Session" sub="This scan">
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
      <Card icon="cog" title="Processor" sub={`${FACTS.cpu.cores} cores · ${FACTS.cpu.ghz} GHz · ${FACTS.cpu.arch}`}>
        <KV k="Model" v={FACTS.cpu.model} />
        <KV k="Machine" v={FACTS.machineType} />
        <KV k="Family / series" v={`${FACTS.cpu.family} · ${FACTS.cpu.series}`} />
        <KV k="Cores" v={`${FACTS.cpu.cores} (${FACTS.cpu.perfCores}P + ${FACTS.cpu.effCores}E)`} />
      </Card>

      <Card icon="grip" title="Memory" sub={`${FACTS.ram.totalGB} GB ${FACTS.ram.type}`}>
        <KV k="Total" v={`${FACTS.ram.totalGB} GB ${FACTS.ram.type}`} />
        <KV k="Free" v={`${FACTS.ram.freeGB} GB`} />
        <KV k="Pressure" v={FACTS.ram.pressure} />
      </Card>

      <Card icon="briefcase" title="Hard drive" sub={`${FACTS.disk.ssd == null ? "Checking…" : FACTS.disk.ssd ? "SSD" : "HDD"} · ${FACTS.disk.totalGB} GB total`}>
        <KV k="Total" v={`${FACTS.disk.totalGB} GB`} />
        <KV k="Free" v={`${FACTS.disk.freeGB} GB`} />
        <KV k="Used" v={`${FACTS.disk.usedPercent}%`} />
        <KV k="Drive type" v={FACTS.disk.ssd == null ? "Checking…" : FACTS.disk.ssd ? "SSD" : "HDD"} />
      </Card>

      <Card icon="house" title="Operating system" sub={`${FACTS.os.name} ${FACTS.os.version}`}>
        <KV k="Computer name" v={FACTS.hostname} />
        <KV k="Version" v={`${FACTS.os.version} (${FACTS.os.build})`} />
      </Card>

      <Card icon="circle-info" title="OS updates" sub={`Last checked ${FACTS.os.lastUpdateCheck}`}>
        <KV k="Pending updates" v={FACTS.os.pendingUpdates == null ? "Unknown" : FACTS.os.pendingUpdates === 0 ? "None" : `${FACTS.os.pendingUpdates} pending`} />
        <KV k="Last check" v={FACTS.os.lastUpdateCheck} />
      </Card>

      <Card icon="circle-check" title="Antivirus" sub={`${FACTS.antivirus.products.length} product${FACTS.antivirus.products.length === 1 ? "" : "s"} detected`}>
        {FACTS.antivirus.products.length === 0 && (
          <KV k="Status" v="No antivirus detected" />
        )}
        {FACTS.antivirus.products.map((p, i) => (
          <KV key={i} k={p.name} v={
            [p.version ? `v${p.version}` : null, p.definitionsAge ? `defs ${p.definitionsAge}` : null]
              .filter(Boolean).join(" · ") || (p.running ? "Active" : "Inactive")
          } />
        ))}
      </Card>

      <Card icon="microphone" title="Audio" sub={FACTS.audio.headsetClass}>
        <KV k="Output" v={FACTS.audio.output} />
        <KV k="Input" v={FACTS.audio.input} />
        <KV k="Connection" v={FACTS.audio.isWired ? "Wired" : "Wireless/built-in"} />
      </Card>

      <Card icon="phone" title="Power" sub={`${FACTS.power.batteryLevel}% · ${FACTS.power.plugged ? "Plugged in" : "On battery"}`}>
        <KV k="Battery" v={`${FACTS.power.batteryLevel}%`} />
        <KV k="Power source" v={FACTS.power.plugged ? "AC adapter" : "Battery"} />
      </Card>
    </div>
  );
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
          {b.downMbps == null && <div className="sh-tag">{testing ? "Testing…" : "—"}</div>}
        </div>
        <div className="sh-col">
          <div className="sh-label">Upload</div>
          <div className="sh-value">{b.upMbps == null ? "—" : b.upMbps}<span className="sh-unit">Mbps</span></div>
          {b.upMbps == null && <div className="sh-tag">{testing ? "Testing…" : "—"}</div>}
        </div>
        <div className="sh-col">
          <div className="sh-label">Ping</div>
          <div className="sh-value">{b.ping == null ? "—" : b.ping}<span className="sh-unit">ms</span></div>
        </div>
        <div className="sh-col">
          <div className="sh-label">Jitter</div>
          <div className="sh-value">{b.jitter == null ? "—" : b.jitter}<span className="sh-unit">ms</span></div>
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
        <Card icon="globe" title="Network interface" sub={FACTS.network.type}>
          <KV k="Connection type" v={FACTS.network.isWired ? "Wired Ethernet" : "Wireless"} />
          <KV k="Interface" v={`${FACTS.network.interface} · ${FACTS.network.linkSpeed}`} />
          <KV k="MAC address" v={FACTS.network.mac} />
          <KV k="MTU" v={FACTS.network.mtu} />
        </Card>

        <Card icon="cloud" title="Routing" sub="IPv4, gateway, DNS">
          <KV k="IPv4" v={FACTS.network.ipv4} />
          <KV k="Gateway" v={FACTS.network.gateway} />
          <KV k="DNS" v={FACTS.network.dns.join(", ")} />
          <KV k="IPv6" v={FACTS.network.ipv6Disabled ? "Disabled" : "Enabled"} />
        </Card>

        <Card icon="circle-check" title="VPN" sub="Traditional VPNs may add jitter">
          <KV k="Detected" v={FACTS.vpn.detected ? FACTS.vpn.name || "Unknown VPN" : "None"} />
        </Card>

        <Card icon="users" title="Background apps" sub="Apps that may compete for bandwidth or CPU">
          <KV k="Running" v={FACTS.backgroundApps.runningApps.length === 0 ? "None detected" : FACTS.backgroundApps.runningApps.join(", ")} />
          <KV k="Browser extensions" v={`${FACTS.backgroundApps.browserExtensions} installed`} />
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
// the dashboard renders, so results are never shown half-measured.
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
