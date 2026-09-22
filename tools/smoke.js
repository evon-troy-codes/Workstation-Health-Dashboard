// smoke.js — launches the real app and checks it comes up on this OS.
//
// Loads main.js unchanged (its window, IPC handlers, sandbox and CSP), waits
// for the dashboard to render, and fails on an error screen, a crashed or
// broken renderer, or any console error. The unit tests never start Electron,
// so this is what catches a platform the app does not actually run on.
//
// Cloudflare is blocked, so a CI run does not start a real speed test on every
// push; the speed test simply reports no result.
//
// It also prints what each detector found on this OS, as counts and yes/no
// only: CI logs are public, so the summary carries no device, product or host
// names. Its own FAIL lines are trimmed and have home directory paths removed
// — though Electron's main process writes its own unfiltered stack traces to
// stderr, which no hook here can reach.
//
// Not named *-test.js: `node --test` would pick that up and run it outside
// Electron, where `require("electron")` is only a path.
//
// Run with:  npm run smoke   (on a headless Linux box: xvfb-run npm run smoke)

const { app, session } = require("electron");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { collectFacts, detectDeferred } = require(path.join(ROOT, "app/main/system-facts"));

const RENDER_TIMEOUT_MS = 90000;
const DEFERRED_TIMEOUT_MS = 45000; // shared across the tabs, not per tab
const WATCHDOG_MS = RENDER_TIMEOUT_MS + DEFERRED_TIMEOUT_MS + 30000;
const errors = [];
let failed = false;
let finished = false;

// Nothing here exits 0 unless a run finished and passed.
process.exitCode = 1;

// Whatever reaches a public log stays short, on one line, and without the
// home directory paths that OS errors tend to carry.
const trim = (s) =>
  String(s)
    .replace(/\s+/g, " ")
    .replace(/([A-Za-z]:\\Users\\[^\\\s"']+|\/(?:home|Users)\/[^/\s"']+)/g, "<home>")
    .slice(0, 200);
const fail = (why) => {
  failed = true;
  console.error("FAIL:", trim(why));
};

// A hung launch must still end the run, with a failure.
const watchdog = setTimeout(() => {
  fail(`watchdog: the run did not finish within ${WATCHDOG_MS / 1000} s`);
  app.exit(1);
}, WATCHDOG_MS);

// A rejection nobody handled is a failed run, not a warning in the log.
process.on("unhandledRejection", (e) => fail(`unhandled rejection: ${(e && e.message) || e}`));

// main.js quits on its own if another instance already holds the lock. Exit
// here rather than setting a code: Electron's own quit path would override it.
app.on("will-quit", () => {
  if (!finished) {
    fail("the app quit before the dashboard rendered (is another instance running?)");
    app.exit(1);
  }
});

app.on("web-contents-created", (_e, wc) => {
  wc.on("console-message", (e) => {
    if (e.level === "error") errors.push(e.message);
  });
  wc.on("render-process-gone", (_ev, d) => fail(`renderer gone: ${d.reason}`));
  wc.on("preload-error", (_ev, _p, err) => fail(`preload error: ${err}`));
});

// Registered before main.js is loaded, so this runs before its window opens.
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ["https://speed.cloudflare.com/*"] },
    (_details, cb) => cb({ cancel: true }),
  );
});

app.on("browser-window-created", (_e, win) => {
  win.webContents.once("did-finish-load", () => {
    check(win)
      .catch((e) => fail(`the check itself threw: ${(e && e.message) || e}`))
      .finally(() => {
        finished = true;
        clearTimeout(watchdog);
        app.exit(failed ? 1 : 0);
      });
  });
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function check(win) {
  // Render and detection run side by side; the detector summary is independent
  // of the window, so a UI failure still reports what the OS gave us.
  const detection = summarise().catch((e) => fail(`the detector summary threw: ${(e && e.message) || e}`));

  // Whatever the UI does, the summary and the renderer's console errors are
  // the diagnosis, so they are always reported.
  await inspect(win).catch((e) => fail(`the check itself threw: ${(e && e.message) || e}`));
  await detection;
  // The blocked Cloudflare requests are the only expected errors.
  for (const m of errors.filter((m) => !/ERR_BLOCKED_BY_CLIENT/.test(m))) fail(`console error: ${m}`);
  if (!failed) console.log("smoke test passed");
}

async function inspect(win) {
  const js = (code) => win.webContents.executeJavaScript(code);
  const started = Date.now();

  let state = "loading";
  while (Date.now() - started < RENDER_TIMEOUT_MS) {
    state = await js(`document.querySelector(".helper-shell") ? "dashboard"
      : /Couldn.t scan this workstation/.test(document.body.innerText) ? "error" : "loading"`);
    if (state !== "loading") break;
    await wait(500);
  }
  if (state === "error") return fail("the app showed its scan error screen");
  if (state !== "dashboard") return fail(`no dashboard within ${RENDER_TIMEOUT_MS / 1000} s`);
  console.log(`dashboard rendered in ${((Date.now() - started) / 1000).toFixed(1)} s`);

  // Every tab, not just the first, since each reads different facts.
  const deferredBy = Date.now() + DEFERRED_TIMEOUT_MS;
  for (const i of [1, 2, 0]) {
    const clicked = await js(`(() => { const t = document.querySelectorAll(".sb-item")[${i}];
      if (!t) return false; t.click(); return true; })()`);
    if (!clicked) return fail(`tab ${i} is missing from the sidebar`);
    await wait(400);

    // The slow scans land after first paint and fill in cards on the System
    // and Network tabs, which mark them "Checking…" until then. Waiting here,
    // on the tab itself, is the point: on Overview the marker never appears,
    // so a wait there would pass straight through and race the merge.
    // A soft timeout: a probe that legitimately resolves null leaves the
    // marker up for good, and that is not a failure.
    let pending = true;
    while (Date.now() < deferredBy) {
      pending = await js(`((document.querySelector(".screen-wrap") || {}).innerText || "").includes("Checking…")`);
      if (!pending) break;
      await wait(500);
    }
    // Say so: a pass reached with cards still loading covers less than it
    // looks, and the log is the only place a reader could tell.
    if (pending) console.log(`note: tab ${i} still said "Checking…" when the wait ran out`);

    const text = await js(`(document.querySelector(".screen-wrap") || {}).innerText ?? null`);
    if (text == null) return fail("the screen container is missing");
    if (/undefined|NaN|\[object /.test(text)) fail(`tab ${i} shows undefined/NaN/[object …]`);
  }
}

// What each detector found, without any of the values themselves.
async function summarise() {
  const [facts, deferred] = await Promise.all([
    collectFacts().catch((e) => ({ error: String((e && e.message) || e) })),
    detectDeferred().catch((e) => ({ error: String((e && e.message) || e) })),
  ]);
  if (facts.error) return fail(`collectFacts threw: ${facts.error}`);
  // A failed size probe falls back to 0, which is "no", not a reading.
  const has = (v) => (v == null || v === "" || v === 0 || v === "Unknown" ? "no" : "yes");
  const count = (v) => (Array.isArray(v) ? v.length : "n/a");
  // A number is worth printing as itself: "0 pending updates" is a reading,
  // where "no" would read as a detector that found nothing.
  const num = (v) => (typeof v === "number" ? v : has(v));
  const apps = (deferred && deferred.backgroundApps) || {};
  const rows = {
    platform: `${process.platform} ${process.arch}`,
    "os name": has(facts.os && facts.os.name),
    "cpu model": has(facts.cpu && facts.cpu.model),
    "ram total": has(facts.ram && facts.ram.totalGB),
    "disk total": has(facts.disk && facts.disk.totalGB),
    "network interface": has(facts.network && facts.network.interface),
    "link speed": has(facts.network && facts.network.linkSpeed),
    "audio output": has(facts.audio && facts.audio.output),
    "audio input": has(facts.audio && facts.audio.input),
    "antivirus products": count(facts.antivirus && facts.antivirus.products),
    "on battery": facts.power ? (facts.power.onBattery ? "yes" : "no") : "n/a",
    "pending updates": deferred.error ? "error" : num(deferred.pendingUpdates),
    "last update check": deferred.error ? "error" : has(deferred.lastUpdateCheck),
    // true/false are both readings; only null means the probe found nothing.
    "disk type": deferred.error ? "error" : deferred.ssd == null ? "no" : deferred.ssd ? "ssd" : "hdd",
    "running apps found": count(apps.runningApps),
    "browser extensions": num(apps.browserExtensions),
  };
  console.log("detectors on this OS:");
  for (const [k, v] of Object.entries(rows)) console.log(`  ${k.padEnd(20)} ${v}`);

  // WHD_EXPECT names the rows this machine should be able to answer, so a
  // detector that quietly returns nothing fails the run. CI reads pass/fail,
  // not logs, so an expectation is the only way a green tick means anything
  // about a platform nobody here can run.
  // A count of 0 is a real answer for pending updates, and "found nothing" for
  // the rows that count what is installed — which is the case worth failing.
  const zeroMeansNothing = new Set(["antivirus products", "running apps found", "browser extensions"]);
  for (const want of (process.env.WHD_EXPECT || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!Object.prototype.hasOwnProperty.call(rows, want)) {
      fail(`WHD_EXPECT names "${want}", which is not one of the rows above`);
      continue;
    }
    const got = rows[want];
    if (got === "no" || got === "n/a" || got === "error" || (got === 0 && zeroMeansNothing.has(want))) {
      fail(`expected a reading for "${want}" on this OS, got "${got}"`);
    }
  }
}

require(path.join(ROOT, "main.js")); // real window, real IPC, real CSP
