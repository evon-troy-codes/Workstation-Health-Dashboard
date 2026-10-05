// Renderer entry. Pulls real workstation facts over the preload bridge, then
// renders the dashboard. Slow scans and the network speed test fill themselves
// in afterwards — the dashboard never waits on them.

import { React, ReactDOM } from "./react-globals.js";
import { Icon, Spinner } from "./icons.jsx";
import { Toast } from "./toast.jsx";
import * as speedtest from "./speedtest.js";
import { ShareDialog } from "./share-dialog.jsx";
import { ExplainDialog } from "./explain-dialog.jsx";
import { HINTS } from "./hints.js";

const {
  useState, useEffect, useRef, useCallback, useContext, createContext, useId,
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

// A label and its value. With `hint`, a small "?" after the label opens a
// one-sentence explanation under the row (hints.js). It opens in place rather
// than as a floating tooltip: cards clip what spills over their edges, and a
// click works with a keyboard and on a touch screen alike.
function KV({ k, v, hint }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="kv">
      <span className="kv-k">
        {k}
        {hint && (
          <button type="button" className="hint-btn" aria-expanded={open} aria-controls={id}
            aria-label={`What is ${k}?`} title={`What is ${k}?`} onClick={() => setOpen((o) => !o)}>?</button>
        )}
      </span>
      <span className="kv-v">{v}</span>
      {hint && open && <div id={id} className="kv-hint">{hint}</div>}
    </div>
  );
}

// The same "?" for the speed test's labels. Their columns are too narrow to
// hold an explanation, so the screen shows the open one in a full-width line
// under the speed panel (one at a time); `openId` names that line.
function HintLabel({ label, open, onToggle, openId }) {
  return (
    <div className="sh-label">
      {label}
      <button type="button" className="hint-btn" aria-expanded={open} aria-controls={openId}
        aria-label={`What is ${label}?`} title={`What is ${label}?`} onClick={onToggle}>?</button>
    </div>
  );
}

// When a dialog closes, focus goes back to the button that opened it, for
// keyboard users. After the render, not in the close handler: the button is
// disabled while its dialog is open, and a disabled button can't take focus,
// so focusing it there left focus on the page body.
function useFocusOnClose(open, button) {
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open && button.current) button.current.focus();
    wasOpen.current = open;
  }, [open, button]);
}

function HelperApp() {
  const [screen, setScreen] = useState("overview"); // overview | system | network
  const { facts, rescan, rescanning } = useApp();
  // "Share report": the person picks how (share-dialog.jsx); main builds the
  // report from its own scan and takes only the speed test from here.
  const [shareOpen, setShareOpen] = useState(false);
  const shareButton = useRef(null);
  const closeShare = useCallback(() => setShareOpen(false), []);
  useFocusOnClose(shareOpen, shareButton);
  const share = useCallback((how) => {
    if (how === "email") return window.whd.shareEmail(facts);
    if (how === "save") return window.whd.shareSave(facts);
    return window.whd.shareCopy(facts);
  }, [facts]);
  const onShared = useCallback((text) => {
    closeShare();
    toast(text);
  }, [closeShare]);

  // "Explain my results": shown only in builds with the report service, which
  // runs the AI assessment.
  const [explainEnabled, setExplainEnabled] = useState(false);
  const [explainOpen, setExplainOpen] = useState(false);
  const explainButton = useRef(null);
  useEffect(() => {
    window.whd.explainEnabled().then(setExplainEnabled, () => setExplainEnabled(false));
  }, []);
  const closeExplain = useCallback(() => setExplainOpen(false), []);
  useFocusOnClose(explainOpen, explainButton);
  const explain = useCallback(() => window.whd.explain(facts), [facts]);

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
              unless you share a report or ask for an AI explanation.
            </div>
          </div>
          <div className="foot-actions">
            {explainEnabled && (
              <button ref={explainButton} className="foot-btn foot-btn-primary" onClick={() => setExplainOpen(true)} disabled={explainOpen}>
                <Icon name="sparkles" size={12} /> Explain my results
              </button>
            )}
            <button ref={shareButton} className="foot-btn" onClick={() => setShareOpen(true)} disabled={shareOpen}>
              <Icon name="share" size={12} /> Share report
            </button>
            <button className="foot-btn" onClick={rescan} disabled={rescanning}>
              {rescanning
                ? <><Spinner size={12} /> Re-scanning…</>
                : <><Icon name="arrow-rotate-right" size={12} /> Re-scan now</>}
            </button>
          </div>
        </div>
      </div>
      {shareOpen && (
        <ShareDialog share={share} onClose={closeShare} onDone={onShared} />
      )}
      {explainOpen && (
        <ExplainDialog onExplain={explain} onClose={closeExplain} />
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
// The readings people look for first, each a button to the screen with the
// details. Facts only: no colours or verdicts on them.
function GlanceTile({ icon, label, value, sub, onClick, progress }) {
  return (
    <button type="button" className="glance" onClick={onClick}>
      <div className="glance-head"><Icon name={icon} size={13} /> {label}</div>
      <div className="glance-value">{value}</div>
      {progress != null && (
        <div className="glance-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
          <div style={{ width: `${progress}%` }} />
        </div>
      )}
      {sub && <div className="glance-sub">{sub}</div>}
    </button>
  );
}

function AtAGlance({ onJump }) {
  const { facts, speed, deferredFailed } = useApp();
  const b = facts.bandwidth;
  const os = facts.os;
  const power = facts.power;
  const measured = b.downMbps != null || b.upMbps != null;

  const internet = speed.testing
    ? { value: `Testing… ${speed.progress}%`, sub: "Measuring your connection", progress: speed.progress }
    : measured
      ? { value: `${b.downMbps ?? "—"} Mbps down`, sub: <>{b.upMbps ?? "—"} Mbps up · measured <Ago ts={b.measuredAt} /></> }
      : { value: b.measuredAt == null ? "Not measured yet" : "No result", sub: "Run it on the Network screen" };

  const updates = os.pendingUpdates == null
    ? (deferredFailed || os.lastUpdateCheck === "Unknown" ? "Unknown" : "Checking…")
    : os.pendingUpdates === 0 ? "None pending" : `${os.pendingUpdates} pending`;
  const updatesSub = os.lastUpdateCheck && !["Checking…", "Unknown"].includes(os.lastUpdateCheck)
    ? `${os.lastUpdateKind === "installed" ? "Last installed" : "Last checked"} ${os.lastUpdateCheck}`
    : null;

  return (
    <div className="glance-grid">
      <GlanceTile icon="globe" label="Internet" {...internet} onClick={() => onJump("network")} />
      <GlanceTile icon="briefcase" label="Storage" value={`${facts.disk.freeGB} GB free`}
        sub={`of ${facts.disk.totalGB} GB · ${facts.disk.usedPercent}% used`} onClick={() => onJump("system")} />
      <GlanceTile icon="circle-info" label="OS updates" value={updates} sub={updatesSub} onClick={() => onJump("system")} />
      {/* A desktop has no battery to show; its firewall takes the slot. */}
      {power.hasBattery
        ? <GlanceTile icon="phone" label="Power" value={batteryPercent(power.batteryLevel, " battery")}
            sub={power.plugged ? "Plugged in" : "On battery"} onClick={() => onJump("system")} />
        : <GlanceTile icon="shield" label="Firewall" value={firewallSummary(facts.firewall, deferredFailed ? "Unknown" : "Checking…")}
            onClick={() => onJump("system")} />}
    </div>
  );
}

function OverviewScreen({ onJump }) {
  const { facts } = useApp();
  return (
    <>
      <AtAGlance onJump={onJump} />
      <div className="card-grid card-grid-2">
        <Card icon="cog" title="Quick specs" sub={facts.machineType || facts.os.name}>
          <KV k="CPU" v={facts.cpu.model} />
          <KV k="RAM" v={[`${facts.ram.totalGB} GB`, facts.ram.type].filter(Boolean).join(" ")} />
          <KV k="Storage" v={`${facts.disk.totalGB} GB ${facts.disk.ssd == null ? "" : facts.disk.ssd ? "SSD" : "HDD"}`.trim()} />
          <KV k="OS" v={`${facts.os.name} ${facts.os.version}`} />
        </Card>

        <Card icon="cloud" title="Session" sub="This scan">
          <KV k="Hostname" v={facts.hostname} />
          <KV k="User" v={facts.user} />
          <KV k="Uptime" v={facts.uptime} hint={HINTS.uptime} />
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
// "up to 4.7 GHz" when the scan found the maximum boost clock. Otherwise no
// speed at all: the base clock alone is easily misread, and "0 GHz" is not a
// reading.
// The battery level, or "Unknown" when it couldn't be read: never a guess.
function batteryPercent(level, suffix = "") {
  return typeof level === "number" && Number.isFinite(level) ? `${level}%${suffix}` : "Unknown";
}

// How the selected output is connected, from the same classification as the
// card's subtitle. "Built-in" is the computer's own sound, which is also what
// headphones in its headphone jack play through.
const AUDIO_CONNECTION = {
  Bluetooth: "Bluetooth (wireless)",
  "USB headset": "USB (wired)",
  "Display audio": "HDMI or DisplayPort",
  "Built-in": "Speakers or headphone jack",
  None: "None",
};

function cpuSpeedLabel(cpu) {
  return cpu.ghzKind === "max" ? `up to ${cpu.ghz} GHz` : null;
}

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
      <Card icon="cog" title="Processor" sub={[`${cpu.cores} cores`, cpuSpeedLabel(cpu), cpu.arch].filter(Boolean).join(" · ")}>
        <KV k="Model" v={facts.cpu.model} />
        <KV k="Machine" v={facts.machineType} />
        <KV k="Family / series" v={`${facts.cpu.family} · ${facts.cpu.series}`} />
        <KV k="Cores" v={`${cpu.cores}${coreSplit}`} />
        <KV k="Threads" v={cpu.threads} />
      </Card>

      <Card icon="grip" title="Memory" sub={`${facts.ram.totalGB} GB · ${facts.ram.freeGB} GB free`}>
        <KV k="Total" v={`${facts.ram.totalGB} GB`} />
        {/* Reading it needs root on Linux: unknown there, not blank. */}
        <KV k="Type" v={facts.ram.type || "Unknown"} />
        <KV k="Free" v={`${facts.ram.freeGB} GB`} />
        <KV k="Pressure" v={facts.ram.pressure} hint={HINTS.memoryPressure} />
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

      {/* null on Linux when no known product is installed: nothing to report. */}
      {facts.antivirus && (
        <Card icon="circle-check" title="Antivirus" sub={facts.antivirus.checked === false
          ? "Couldn't check"
          : `${facts.antivirus.products.length} product${facts.antivirus.products.length === 1 ? "" : "s"} detected`}>
          {/* checked: false is a check that failed, not "none installed". */}
          {facts.antivirus.checked === false && <KV k="Status" v="Unknown" />}
          {facts.antivirus.checked !== false && facts.antivirus.products.length === 0 && (
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
      )}

      <FirewallCard firewall={facts.firewall} pending={deferredFailed ? "Unknown" : "Checking…"} />

      <Card icon="microphone" title="Audio" sub={facts.audio.headsetClass}>
        <KV k="Output" v={facts.audio.output} />
        <KV k="Input" v={facts.audio.input} />
        <KV k="Connection" v={AUDIO_CONNECTION[facts.audio.headsetClass] || "Unknown"} />
      </Card>

      {/* A desktop has no battery: nothing for this card to say. */}
      {power.hasBattery && (
        <Card icon="phone" title="Power" sub={`${batteryPercent(power.batteryLevel)} · ${power.plugged ? "Plugged in" : "On battery"}`}>
          <KV k="Battery" v={batteryPercent(power.batteryLevel)} />
          <KV k="Power source" v={power.plugged ? "AC adapter" : "Battery"} />
        </Card>
      )}

      <DisplayCard display={facts.display} pending={deferredFailed ? "Unknown" : "Checking…"} />
    </div>
  );
}

// The Display card: one row per monitor, each with its own resolution and
// refresh rate, the main one first. Its facts arrive with the slow scans, so
// until then it says "Checking…" (or "Unknown" if those scans failed).
// Every product found, with what's known of it. An empty list is "No firewall
// service found": only services can be seen without admin rights, so the
// wording doesn't claim there are no rules at all. Neutral, never graded.
// null until the deferred scan lands: `pending` says "Checking…" or "Unknown".
// One line for the card's subtitle and the Overview tile.
function firewallSummary(fw, pending) {
  if (!fw) return pending;
  const active = fw.products.find((p) => p.active === true);
  return fw.checked === false && !fw.products.length ? "Couldn't check"
    : !fw.products.length ? "No firewall service found"
    : active ? `${active.name} active`
    : fw.products.some((p) => p.active == null) ? "Installed" : "Not active";
}

function FirewallCard({ firewall, pending }) {
  if (!firewall) {
    return (
      <Card icon="shield" title="Firewall" sub={pending}>
        <KV k="Status" v={pending} hint={HINTS.firewall} />
      </Card>
    );
  }
  const fw = firewall;
  const state = (p) => [p.active == null ? "Installed" : p.active ? "Active" : "Inactive", p.detail].filter(Boolean).join(" · ");
  return (
    <Card icon="shield" title="Firewall" sub={firewallSummary(fw, pending)}>
      {fw.checked === false && !fw.products.length && <KV k="Status" v="Unknown" hint={HINTS.firewall} />}
      {fw.checked !== false && !fw.products.length && <KV k="Status" v="No firewall service found" hint={HINTS.firewallNone} />}
      {fw.products.map((p, i) => <KV key={i} k={p.name} v={state(p)} hint={i === 0 ? HINTS.firewall : undefined} />)}
    </Card>
  );
}

function DisplayCard({ display: d, pending }) {
  // Reports from before per-monitor detection carry no list.
  const monitors = d && Array.isArray(d.monitors) ? d.monitors : null;
  return (
    <Card icon="display" title="Display" sub={!d ? pending : `${d.count} display${d.count === 1 ? "" : "s"}`}>
      {!d && <KV k="Displays" v={pending} />}
      {d && monitors && monitors.length === 0 && <KV k="Displays" v="None found" />}
      {monitors && monitors.map((m, i) => (
        <KV key={i} k={m.main && monitors.length > 1 ? `${m.name} (main)` : m.name}
          v={[m.resolution, m.refreshRate, m.size].filter(Boolean).join(" · ")} />
      ))}
      {d && !monitors && <KV k="Resolution" v={[d.resolution, d.refreshRate].filter(Boolean).join(" · ")} />}
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
  // Which speed label's explanation is open, if any.
  const [heroHint, setHeroHint] = useState(null);
  const heroHintId = useId();
  const heroLabel = (key, label) => (
    <HintLabel label={label} open={heroHint === key} openId={heroHintId}
      onToggle={() => setHeroHint((h) => (h === key ? null : key))} />
  );
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
          {heroLabel("ping", "Ping")}
          <div className="sh-value">{value(b.ping)}<span className="sh-unit">ms</span></div>
        </div>
        <div className="sh-col">
          {heroLabel("jitter", "Jitter")}
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

      {heroHint && <div id={heroHintId} className="sh-hint">{HINTS[heroHint]}</div>}

      <div className="card-grid card-grid-2">
        <Card icon="globe" title="Network interface" sub={facts.network.type}>
          <KV k="Connection type" v={facts.network.isVirtual ? "Virtual (VPN or tunnel)" : facts.network.isWired ? "Wired Ethernet" : "Wireless"} />
          <KV k="Interface" v={`${facts.network.interface} · ${facts.network.linkSpeed}`} hint={HINTS.interface} />
          <KV k="MAC address" v={facts.network.mac} />
          <KV k="MTU" v={facts.network.mtu || "Unknown"} hint={HINTS.mtu} />
        </Card>

        <Card icon="cloud" title="Routing" sub="IPv4, gateway, DNS">
          <KV k="IPv4" v={facts.network.ipv4} />
          <KV k="Gateway" v={facts.network.gateway} hint={HINTS.gateway} />
          <KV k="DNS" v={facts.network.dns.join(", ")} hint={HINTS.dns} />
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

function ErrorScreen({ message, onRetry, title = "Couldn't scan this workstation.", marker }) {
  return (
    <div data-render-error={marker} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 40, textAlign: "center" }}>
      <Icon name="triangle-exclamation" size={38} color="var(--danger)" />
      <div style={{ fontWeight: 700, color: "var(--danger)", marginTop: 14, fontSize: 16 }}>
        {title}
      </div>
      <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 8, maxWidth: 460 }}>{message}</div>
      <button className="send-btn" style={{ marginTop: 20 }} onClick={onRetry}>
        <Icon name="arrow-rotate-right" size={14} /> Try again
      </button>
    </div>
  );
}

// Catches an error thrown while drawing the dashboard. Without it, one
// reading the cards don't expect left an empty window with no way out. It
// shows what happened and a Try again that re-scans; the speed test and the
// rest of the app's state are kept. The data-render-error marker is what the
// installed-build self-test looks for (app/main/selftest.js).
class RenderGuard extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    console.error("the dashboard failed to render:", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const retry = () => {
      this.setState({ error: null });
      this.props.onRetry();
    };
    return (
      <ErrorScreen
        title="Couldn't show the results."
        // React's own message is a minified code and a link, which means
        // nothing to the people using this; the details go to the console.
        message="Something in this scan couldn't be displayed. Try again re-scans this workstation."
        onRetry={retry}
        marker="1"
      />
    );
  }
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
        firewall: d.firewall || f.firewall,
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
      <Frame><RenderGuard onRetry={rescan}><HelperApp /></RenderGuard></Frame>
    </AppContext.Provider>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<><App /><Toast /></>);
