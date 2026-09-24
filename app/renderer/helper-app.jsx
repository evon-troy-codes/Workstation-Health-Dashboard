// Renderer entry. Pulls real workstation facts over the preload bridge, then
// renders the dashboard. Slow scans and the network speed test fill themselves
// in afterwards — the dashboard never waits on them.

import { React, ReactDOM } from "./react-globals.js";
import { Icon, Spinner } from "./icons.jsx";
import { Toast } from "./toast.jsx";
import * as speedtest from "./speedtest.js";
import { ReportDialog } from "./report-dialog.jsx";

const {
  useState, useEffect, useRef, useCallback, useContext, createContext,
} = React;

// ---- shared state ----------------------------------------------------------

// Facts are React state, not a mutated module global: every screen reads them
// through this context, so a re-scan or a finished speed test re-renders the
// tree the ordinary way instead of via a forced tick.
const AppContext = createContext(null);
const useApp = () => useContext(AppContext);

const toast = (detail) =>
  window.dispatchEvent(new CustomEvent("whd-toast", { detail }));

// "just now" / "4 min ago" from a millisecond timestamp.
function agoLabel(ts) {
  if (ts == null) return "never";
  const sec = Math.max(0, (Date.now() - ts) / 1000);
  if (sec < 45) return `${Math.round(sec)}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)} hr ago`;
  return `${Math.round(sec / 86400)} days ago`;
}

// A live agoLabel. The label is derived from the real timestamp, so it stays
// honest instead of counting up on its own; the timer only nudges a repaint,
// and only of this text rather than the whole screen around it.
function Ago({ ts }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return agoLabel(ts);
}

// Drives the speed test for the whole app rather than for one screen, so
// switching tabs mid-run neither restarts nor loses it.
function useSpeedTest(onResult) {
  const [testing, setTesting] = useState(false);
  const [progress, setProgress] = useState(0);
  const running = useRef(false);
  const abort = useRef(null);

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    abort.current = new AbortController();
    setTesting(true);
    setProgress(0);
    try {
      const res = await speedtest.run((pct) => setProgress(pct), {
        signal: abort.current.signal,
      });
      onResult(res);
      if (res.partial) toast("Speed test timed out — showing partial results");
      else if (res.failed) toast("Couldn't measure throughput — check the connection");
    } catch (e) {
      toast("Speed test failed");
    } finally {
      running.current = false;
      abort.current = null;
      setTesting(false);
    }
  }, [onResult]);

  // A run still in flight when the app closes should not keep sockets open.
  useEffect(() => () => abort.current && abort.current.abort(), []);

  return { testing, progress, run };
}

// ---- UI --------------------------------------------------------------------

function Logo({ size }) {
  return <img src="assets/logo/logo-mark.svg" alt="" width={size} height={size} style={{ display: "block" }} />;
}

function Header() {
  const { facts, scannedAt } = useApp();
  return (
    <div className="helper-head">
      <div className="brand">
        <Logo size={26} />
        <div>
          <div className="brand-name">Workstation Scanner</div>
        </div>
      </div>
      <div className="head-right">
        <div>
          <div className="syncline">{facts.hostname}</div>
          <div className="syncsub">Last scan <Ago ts={scannedAt} /></div>
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
  const { facts, rescan, rescanning } = useApp();
  // Send report asks where to email it. `reportEnabled` is null until main
  // says whether this build has a report endpoint at all.
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reportEnabled, setReportEnabled] = useState(null);
  const reportButton = useRef(null);

  const openReport = () => {
    setDialogOpen(true);
    window.whd.reportEnabled().then(setReportEnabled, () => setReportEnabled(false));
  };
  const closeReport = useCallback(() => {
    setDialogOpen(false);
    // Back to the button that opened it, for keyboard users.
    if (reportButton.current) reportButton.current.focus();
  }, []);
  const sendReport = useCallback((email) => window.whd.sendReport(facts, email), [facts]);
  const onSent = useCallback((email) => {
    closeReport();
    toast(`Report emailed to ${email}`);
  }, [closeReport]);

  return (
    <div className="helper-shell">
      <Sidebar active={screen} onChange={setScreen} />
      <div className="helper-main">
        <Header />
        <div className="screen-wrap">
          {screen === "overview" && <OverviewScreen onJump={setScreen} />}
          {screen === "system"   && <SystemScreen />}
          {screen === "network"  && <NetworkScreen />}
        </div>
        <div className="helper-foot">
          <div>
            <div style={{ fontWeight: 700, fontSize: 13, color: "var(--text-strong)" }}>Data source</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
              Collected locally via native OS APIs. Nothing leaves this machine
              unless you email a report.
            </div>
          </div>
          <div className="foot-actions">
            <button ref={reportButton} className="foot-btn" onClick={openReport} disabled={dialogOpen}>
              <Icon name="envelope" size={12} /> Send report
            </button>
            <button className="foot-btn" onClick={rescan} disabled={rescanning}>
              {rescanning
                ? <><Spinner size={12} /> Re-scanning…</>
                : <><Icon name="arrow-rotate-right" size={12} /> Re-scan now</>}
            </button>
          </div>
        </div>
      </div>
      {dialogOpen && (
        <ReportDialog enabled={reportEnabled} onClose={closeReport} onSend={sendReport} onSent={onSent} />
      )}
    </div>
  );
}

// ============================================================================
// Sidebar nav
// ============================================================================
function Sidebar({ active, onChange }) {
  const { facts } = useApp();
  const items = [
    { id: "overview", label: "Overview", icon: "house" },
    { id: "system",   label: "System",   icon: "cog" },
    { id: "network",  label: "Network",  icon: "globe" },
  ];
  return (
    <aside className="helper-sidebar">
      <div className="sb-brand">
        <Logo size={22} />
        <div>
          <div className="sb-name">Workstation Scanner</div>
        </div>
      </div>
      <nav className="sb-nav" aria-label="Dashboard sections">
        {items.map((it) => (
          <button
            key={it.id}
            className={`sb-item ${active === it.id ? "active" : ""}`}
            aria-current={active === it.id ? "page" : undefined}
            onClick={() => onChange(it.id)}
          >
            <Icon name={it.icon} size={15} />
            <span className="sb-label">{it.label}</span>
          </button>
        ))}
      </nav>
      <div className="sb-foot">
        <div className="sb-foot-name">{facts.user}</div>
        <div className="sb-foot-sub">{facts.hostname}</div>
      </div>
    </aside>
  );
}

// ============================================================================
// Screen 1 — Overview
// ============================================================================
function OverviewScreen({ onJump }) {
  const { facts } = useApp();
  return (
    <>
      <div className="card-grid card-grid-2">
        <Card icon="cog" title="Quick specs" sub={facts.machineType || facts.os.name}>
          <KV k="CPU" v={facts.cpu.model} />
          <KV k="RAM" v={`${facts.ram.totalGB} GB ${facts.ram.type}`} />
          <KV k="Storage" v={`${facts.disk.totalGB} GB ${facts.disk.ssd == null ? "" : facts.disk.ssd ? "SSD" : "HDD"}`.trim()} />
          <KV k="OS" v={`${facts.os.name} ${facts.os.version}`} />
        </Card>

        <Card icon="cloud" title="Session" sub="This scan">
          <KV k="Hostname" v={facts.hostname} />
          <KV k="User" v={facts.user} />
          <KV k="Uptime" v={facts.uptime} />
          <KV k="App version" v={`v${facts.appVersion}`} />
        </Card>
      </div>

      <div className="quick-jump">
        <button className="qj-btn" onClick={() => onJump("system")}><Icon name="cog" size={13} /> System details</button>
        <button className="qj-btn" onClick={() => onJump("network")}><Icon name="globe" size={13} /> Network &amp; speed</button>
      </div>
    </>
  );
}

// ============================================================================
// Screen 2 — System
// ============================================================================
function SystemScreen() {
  const { facts, deferredFailed } = useApp();
  const driveType = facts.disk.ssd == null ? (deferredFailed ? "Unknown" : "Checking…") : facts.disk.ssd ? "SSD" : "HDD";
  const { cpu, power } = facts;
  // Only a hybrid CPU has a P/E split worth showing.
  const coreSplit = cpu.effCores > 0 ? ` (${cpu.perfCores}P + ${cpu.effCores}E)` : "";
  // Without the Detect registry key, the date is the newest hotfix install.
  const updateInstalled = facts.os.lastUpdateKind === "installed";
  return (
    <div className="card-grid card-grid-2">
      <Card icon="cog" title="Processor" sub={`${cpu.cores} cores · ${cpu.ghz} GHz · ${cpu.arch}`}>
        <KV k="Model" v={facts.cpu.model} />
        <KV k="Machine" v={facts.machineType} />
        <KV k="Family / series" v={`${facts.cpu.family} · ${facts.cpu.series}`} />
        <KV k="Cores" v={`${cpu.cores}${coreSplit}`} />
        <KV k="Threads" v={cpu.threads} />
      </Card>

      <Card icon="grip" title="Memory" sub={`${facts.ram.totalGB} GB · ${facts.ram.freeGB} GB free`}>
        <KV k="Total" v={`${facts.ram.totalGB} GB ${facts.ram.type}`} />
        <KV k="Free" v={`${facts.ram.freeGB} GB`} />
        <KV k="Pressure" v={facts.ram.pressure} />
      </Card>

      <Card icon="briefcase" title="Hard drive" sub={`${driveType} · ${facts.disk.totalGB} GB total`}>
        <KV k="Total" v={`${facts.disk.totalGB} GB`} />
        <KV k="Free" v={`${facts.disk.freeGB} GB`} />
        <KV k="Used" v={`${facts.disk.usedPercent}%`} />
        <KV k="Drive type" v={driveType} />
      </Card>

      <Card icon="house" title="Operating system" sub={`${facts.os.name} ${facts.os.version}`}>
        <KV k="Computer name" v={facts.hostname} />
        <KV k="Version" v={facts.os.build ? `${facts.os.version} (${facts.os.build})` : facts.os.version} />
      </Card>

      <Card icon="circle-info" title="OS updates" sub={`${updateInstalled ? "Last update installed" : "Last checked"} ${facts.os.lastUpdateCheck}`}>
        <KV k="Pending updates" v={facts.os.pendingUpdates == null ? "Unknown" : facts.os.pendingUpdates === 0 ? "None" : `${facts.os.pendingUpdates} pending`} />
        <KV k={updateInstalled ? "Last update installed" : "Last check"} v={facts.os.lastUpdateCheck} />
      </Card>

      <Card icon="circle-check" title="Antivirus" sub={`${facts.antivirus.products.length} product${facts.antivirus.products.length === 1 ? "" : "s"} detected`}>
        {facts.antivirus.products.length === 0 && (
          <KV k="Status" v="No antivirus detected" />
        )}
        {facts.antivirus.products.map((p, i) => (
          <KV key={i} k={p.name} v={
            // Whether it is actually running leads: a product with fresh
            // definitions and a stopped daemon is not protecting anything,
            // and this card is where someone would look to find that out.
            // Unknown means the product was found installed (by its files)
            // with no way to see its process, so say what is known.
            [p.running == null ? "Installed" : p.running ? "Active" : "Inactive",
             p.version ? `v${p.version}` : null,
             p.definitionsAge ? `Virus Definitions ${p.definitionsAge}` : null]
              .filter(Boolean).join(" · ")
          } />
        ))}
      </Card>

      <Card icon="microphone" title="Audio" sub={facts.audio.headsetClass}>
        <KV k="Output" v={facts.audio.output} />
        <KV k="Input" v={facts.audio.input} />
        <KV k="Connection" v={facts.audio.isWired ? "Wired" : "Wireless/built-in"} />
      </Card>

      <Card icon="phone" title="Power" sub={power.hasBattery ? `${power.batteryLevel}% · ${power.plugged ? "Plugged in" : "On battery"}` : "No battery"}>
        <KV k="Battery" v={power.hasBattery ? `${power.batteryLevel}%` : "None"} />
        <KV k="Power source" v={power.plugged ? "AC adapter" : "Battery"} />
      </Card>

      <DisplayCard display={facts.display} pending={deferredFailed ? "Unknown" : "Checking…"} />
    </div>
  );
}

// The Display card. Its facts arrive with the slow scans, so until then every
// row says "Checking…" (or "Unknown" if those scans failed).
function DisplayCard({ display: d, pending }) {
  const external = !d ? pending
    : !d.external ? "None"
    : [d.externalCount > 1 ? `${d.externalCount} monitors` : null, d.externalSize, d.externalConnection]
      .filter(Boolean).join(" · ") || "Connected";
  return (
    <Card icon="display" title="Display" sub={!d ? pending : `${d.count} display${d.count === 1 ? "" : "s"}`}>
      <KV k="Resolution" v={d ? d.resolution : pending} />
      <KV k="Refresh rate" v={d ? d.refreshRate || "Unknown" : pending} />
      <KV k="External monitor" v={external} />
    </Card>
  );
}

// ============================================================================
// Screen 3 — Network
// ============================================================================

// Always rendered, only hidden: a tag that came and went resized the hero, so
// the whole screen, and the button just clicked, jumped when a run started.
function TestingTag({ show }) {
  return (
    <div className="sh-tag" style={{ visibility: show ? "visible" : "hidden" }} aria-hidden={!show}>
      Testing…
    </div>
  );
}

function NetworkScreen() {
  const { facts, speed, deferredFailed } = useApp();
  const pendingText = deferredFailed ? "Unknown" : "Checking…";
  const { testing, progress, run } = speed;
  const b = facts.bandwidth;
  const value = (v) => (v == null ? "—" : v);
  // A run that got nothing back still has a timestamp; saying "Measured" over
  // four dashes would imply a result. One real value is enough, since the
  // dashes already mark whatever is missing.
  const measured = [b.downMbps, b.upMbps, b.ping, b.jitter].some((v) => v != null);
  return (
    <>
      {/* Big speed card */}
      <div className="speed-hero">
        <div className="sh-col">
          <div className="sh-label">Download</div>
          <div className="sh-value">{value(b.downMbps)}<span className="sh-unit">Mbps</span></div>
          <TestingTag show={b.downMbps == null && testing} />
        </div>
        <div className="sh-col">
          <div className="sh-label">Upload</div>
          <div className="sh-value">{value(b.upMbps)}<span className="sh-unit">Mbps</span></div>
          <TestingTag show={b.upMbps == null && testing} />
        </div>
        <div className="sh-col">
          <div className="sh-label">Ping</div>
          <div className="sh-value">{value(b.ping)}<span className="sh-unit">ms</span></div>
        </div>
        <div className="sh-col">
          <div className="sh-label">Jitter</div>
          <div className="sh-value">{value(b.jitter)}<span className="sh-unit">ms</span></div>
        </div>
        <div className="sh-action">
          <button className="send-btn" onClick={run} disabled={testing}>
            {testing ? <Spinner size={14} color="var(--accent-contrast)" /> : <Icon name="arrow-rotate-right" />}
            {testing ? ` Testing… ${progress}%` : " Run speed test"}
          </button>
          <div className="sh-meta">
            {testing ? "Measured now…"
              : b.measuredAt == null ? "Measured not yet run"
              : measured ? <>Measured <Ago ts={b.measuredAt} /></>
              : <>No result · <Ago ts={b.measuredAt} /></>}
          </div>
        </div>
      </div>

      <div className="card-grid card-grid-2">
        <Card icon="globe" title="Network interface" sub={facts.network.type}>
          <KV k="Connection type" v={facts.network.isVirtual ? "Virtual (VPN or tunnel)" : facts.network.isWired ? "Wired Ethernet" : "Wireless"} />
          <KV k="Interface" v={`${facts.network.interface} · ${facts.network.linkSpeed}`} />
          <KV k="MAC address" v={facts.network.mac} />
          <KV k="MTU" v={facts.network.mtu || "Unknown"} />
        </Card>

        <Card icon="cloud" title="Routing" sub="IPv4, gateway, DNS">
          <KV k="IPv4" v={facts.network.ipv4} />
          <KV k="Gateway" v={facts.network.gateway} />
          <KV k="DNS" v={facts.network.dns.join(", ")} />
          <KV k="IPv6" v={facts.network.ipv6Disabled ? "Disabled" : "Enabled"} />
        </Card>

        <Card icon="circle-check" title="VPN" sub="Traditional VPNs may add jitter">
          <KV k="Detected" v={facts.vpn.detected ? facts.vpn.name || "Unknown VPN" : "None"} />
        </Card>

        <Card icon="users" title="Background apps" sub="Apps that may compete for bandwidth or CPU">
          <KV k="Running" v={
            facts.backgroundApps == null ? pendingText
              : facts.backgroundApps.runningApps.length === 0 ? "None detected"
              : facts.backgroundApps.runningApps.join(", ")
          } />
          <KV k="Browser extensions" v={
            facts.backgroundApps == null ? pendingText : `${facts.backgroundApps.browserExtensions} installed`
          } />
        </Card>
      </div>
    </>
  );
}

// Full-height page wrapper. Holds whatever is showing — the startup screen
// during the first scan, then the dashboard. The window's own title bar is the
// native one from BrowserWindow.
function Frame({ children }) {
  return (
    <div style={{ minHeight: "100vh", background: "var(--surface-page)", display: "flex", flexDirection: "column" }}>
      {children}
    </div>
  );
}

// Shown only while the first scan is in flight (about a second). The speed test
// no longer gates this — the dashboard renders as soon as the facts land and
// fills the measurements in when they arrive.
function LoadingScreen({ status }) {
  return (
    <div style={{ flex: 1, background: "var(--surface-page)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 40, textAlign: "center" }}>
      <Icon name="cloud" size={42} color="var(--accent)" />
      <div style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 600, color: "var(--text-strong)", marginTop: 16 }}>Checking your workstation…</div>
      <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 10, display: "inline-flex", alignItems: "center", gap: 8 }}>
        <Spinner size={14} color="var(--accent)" /> {status}
      </div>
    </div>
  );
}

function ErrorScreen({ message, onRetry }) {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 40, textAlign: "center" }}>
      <Icon name="triangle-exclamation" size={38} color="var(--danger)" />
      <div style={{ fontWeight: 700, color: "var(--danger)", marginTop: 14, fontSize: 16 }}>
        Couldn&apos;t scan this workstation.
      </div>
      <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 8, maxWidth: 460 }}>{message}</div>
      <button className="send-btn" style={{ marginTop: 20 }} onClick={onRetry}>
        <Icon name="arrow-rotate-right" size={14} /> Try again
      </button>
    </div>
  );
}

// Owns the facts, the deferred scans and the speed test, and hands them to the
// tree through AppContext.
function App() {
  const [facts, setFacts] = useState(null);
  const [scannedAt, setScannedAt] = useState(null);
  const [error, setError] = useState(null);
  const [rescanning, setRescanning] = useState(false);
  const [status, setStatus] = useState("Reading system facts…");
  const [deferredFailed, setDeferredFailed] = useState(false);
  // Numbers each deferred load. A re-scan can start a second load while the
  // first is still running; only the latest may write, or an older result
  // landing last would overwrite a newer one.
  const deferredSeq = useRef(0);

  const onSpeedResult = useCallback((res) => {
    setFacts((f) => (f ? { ...f, bandwidth: { ...f.bandwidth, ...res } } : f));
  }, []);
  const speed = useSpeedTest(onSpeedResult);

  // Slow scans (OS updates, SSD flag, process list) land after first paint.
  const loadDeferred = useCallback(() => {
    const seq = ++deferredSeq.current;
    setDeferredFailed(false);
    window.whd.getDeferred().then((d) => {
      if (seq !== deferredSeq.current) return;
      if (!d) return setDeferredFailed(true);
      setFacts((f) => f && ({
        ...f,
        os: { ...f.os, pendingUpdates: d.pendingUpdates, lastUpdateCheck: d.lastUpdateCheck, lastUpdateKind: d.lastUpdateKind },
        disk: { ...f.disk, ssd: d.ssd },
        backgroundApps: d.backgroundApps || f.backgroundApps,
        display: d.display || f.display,
      }));
    }).catch(() => {
      // Left alone, the cards would say "Checking…" forever.
      if (seq !== deferredSeq.current) return;
      setDeferredFailed(true);
      setFacts((f) => f && ({ ...f, os: { ...f.os, lastUpdateCheck: "Unknown" } }));
    });
  }, []);

  const scan = useCallback(async () => {
    setError(null);
    try {
      const f = await window.whd.getFacts();
      setFacts(f);
      setScannedAt(Date.now());
      loadDeferred();
      return true;
    } catch (e) {
      // ipcRenderer.invoke wraps the main-process error in plumbing the user
      // has no use for: "Error invoking remote method 'whd:get-facts': Error: …".
      const msg = String((e && e.message) || e);
      // Fall back to the raw text: an empty error would read as "no error" and
      // leave the app on the loading screen with no way to retry.
      setError(msg.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, "") || msg);
      return false;
    }
  }, [loadDeferred]);

  // Re-scan in place. Reloading the window instead would throw away the speed
  // test and re-run the whole startup sequence.
  const rescan = useCallback(async () => {
    setRescanning(true);
    toast("Re-scanning workstation…");
    try {
      const f = await window.whd.rescan();
      setFacts((prev) => ({ ...f, bandwidth: prev ? prev.bandwidth : f.bandwidth }));
      setScannedAt(Date.now());
      loadDeferred();
      toast("Scan complete");
    } catch (e) {
      toast("Re-scan failed");
    } finally {
      setRescanning(false);
    }
  }, [loadDeferred]);

  // The startup sequence: scan, then measure. "Try again" on the error screen
  // runs the same sequence, so a recovered scan gets its speed test too.
  const speedRun = speed.run;
  const startup = useCallback(() => {
    scan().then((ok) => {
      if (ok) {
        setStatus("Running network speed test…");
        speedRun();
      }
    });
  }, [scan, speedRun]);

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return; // guard against a double effect invocation
    started.current = true;
    startup();
  }, [startup]);

  if (error) return <Frame><ErrorScreen message={error} onRetry={startup} /></Frame>;
  if (!facts) return <Frame><LoadingScreen status={status} /></Frame>;

  return (
    <AppContext.Provider value={{ facts, scannedAt, rescan, rescanning, speed, deferredFailed }}>
      <Frame><HelperApp /></Frame>
    </AppContext.Provider>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<><App /><Toast /></>);
