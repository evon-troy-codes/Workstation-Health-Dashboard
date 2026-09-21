// make-screenshots.js — captures the README screenshots from the real app.
//
// Runs the actual renderer against real IPC handlers, waits for the scan and
// the speed test to finish, then captures each screen.
//
// Identifying values (hostname, username, audio device names, Wi-Fi name, MAC
// address, local IP, gateway, DNS servers) are replaced with placeholders
// before capture. The screenshots go in a public repo; the app itself is
// untouched.
//
// The capture is pinned to 1100x860 at a scale factor of 1, so the images come
// out the same size, showing the same content, on any display.
//
// Run with:  npm run screenshots

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "docs", "screenshots");
const { collectFacts, detectDeferred } = require(path.join(ROOT, "app/main/system-facts"));

// Values that should not be published, and what to show instead. The network
// values use the RFC 5737 / RFC 7042 documentation ranges.
function redact(facts) {
  const f = JSON.parse(JSON.stringify(facts));
  // The header, sidebar and Overview/System cards show these by name.
  f.hostname = "WORKSTATION-01";
  f.user = "demo.user";
  // The System tab's Audio card shows these, and Windows often names audio
  // devices after their owner ("Headphones (Sam's AirPods)").
  if (f.audio.output) f.audio.output = "Headphones";
  if (f.audio.input) f.audio.input = "Microphone";
  // Not shown anywhere yet; a home network name is worth hiding if it ever is.
  // Stays null on a wired connection.
  f.network.ssid = f.network.ssid && "Example-WiFi";
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

// Render at 1:1 whatever the display's scaling. At 150% the images came out
// half as large again and, with Windows shrinking the window to fit the
// scaled screen, showed less of each page.
app.commandLine.appendSwitch("force-device-scale-factor", "1");

const WIDTH = 1100;
const HEIGHT = 860;

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // Collect once and serve the same redacted snapshot to every load.
  const facts = redact(await collectFacts());
  const deferred = await detectDeferred();

  ipcMain.handle("whd:get-facts", async () => facts);
  ipcMain.handle("whd:get-deferred", () => deferred);
  ipcMain.handle("whd:send-report", async () => ({ ok: true, skipped: true, reason: "no-endpoint" }));

  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    useContentSize: true, // the size is the page's, not the outer frame's
    show: true, // visible: an offscreen window paints stale frames
    webPreferences: {
      preload: path.join(ROOT, "app/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // A screen too small for the window makes the OS shrink it, which changes
  // what each capture shows. Say so rather than publish a cropped page.
  const [w, h] = win.getContentSize();
  if (w !== WIDTH || h !== HEIGHT) {
    console.warn(`  warning: content is ${w}x${h}, not ${WIDTH}x${HEIGHT}; the screen is too small`);
  }

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
