// make-screenshots.js — captures the README screenshots from the real app.
//
// Runs the actual renderer against real IPC handlers, waits for the scan and
// the speed test to finish, then captures each screen.
//
// Machine identifiers (MAC address, local IP, DNS servers) are replaced with
// documentation-range placeholders before capture. The screenshots go in a
// public repo; the app itself is untouched.
//
// Run with:  npm run screenshots

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "docs", "screenshots");
const { collectFacts, detectDeferred } = require(path.join(ROOT, "app/main/system-facts"));

// Values that should not be published, and what to show instead. RFC 5737 /
// RFC 7042 reserve these ranges for documentation.
function redact(facts) {
  const f = JSON.parse(JSON.stringify(facts));
  f.network.mac = "00:00:5e:00:53:af";
  f.network.ipv4 = "203.0.113.42";
  f.network.gateway = "203.0.113.1";
  f.network.dns = ["203.0.113.1", "198.51.100.1"];
  return f;
}

const SHOTS = [
  { id: "overview", tab: 0 },
  { id: "system", tab: 1 },
  { id: "network", tab: 2 },
];

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // Collect once and serve the same redacted snapshot to every load.
  const facts = redact(await collectFacts());
  const deferred = await detectDeferred();

  ipcMain.handle("whd:get-facts", async () => facts);
  ipcMain.handle("whd:get-deferred", () => deferred);
  ipcMain.handle("whd:send-report", async () => ({ ok: true, skipped: true, reason: "no-endpoint" }));

  const win = new BrowserWindow({
    width: 1100,
    height: 860,
    show: true, // visible: an offscreen window paints stale frames
    webPreferences: {
      preload: path.join(ROOT, "app/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const js = (code) => win.webContents.executeJavaScript(code);
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));

  await win.loadFile(path.join(ROOT, "app/renderer/index.html"));
  // Wait out the scan, then the speed test, so the hero shows real numbers.
  await settle(14000);
  await js(`document.querySelectorAll(".sb-item")[2].click(), true`);
  await settle(46000);

  for (const shot of SHOTS) {
    await js(`document.querySelectorAll(".sb-item")[${shot.tab}].click(), true`);
    await settle(1200); // let the tab paint
    // The compositor idles during the long waits above, and the first grab
    // after that returns the previously painted frame. Throw one away.
    await win.webContents.capturePage();
    await settle(400);
    const image = await win.webContents.capturePage();
    const file = path.join(OUT, `${shot.id}.png`);
    fs.writeFileSync(file, image.toPNG());
    console.log("captured", path.relative(ROOT, file));
  }

  const bg = await js(`getComputedStyle(document.body).backgroundColor`);
  console.log(`  body background: ${bg}`);

  app.quit();
});
