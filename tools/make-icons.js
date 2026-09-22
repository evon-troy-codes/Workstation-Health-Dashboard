// make-icons.js — generates the app icon set from the brand mark.
//
// Renders assets/logo/logo-mark.svg onto a rounded brand-violet tile at every
// size Windows, macOS and Linux want, then packs the Windows sizes into a
// multi-resolution .ico. Output goes to build/, which electron-builder picks
// up automatically (it is the default buildResources directory).
//
// Run with:  npm run icons     (needs Electron — it does the rasterizing)

const { app, BrowserWindow, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const BUILD = path.join(ROOT, "build");
const ICONS_DIR = path.join(BUILD, "icons");

const BRAND = "#523ae8"; // --whd-cyan, the primary brand violet, as the tile
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const PNG_SIZES = [16, 32, 48, 64, 128, 256, 512, 1024];

// The mark, recolored white to sit on the brand tile: every fill and stroke
// colour becomes white, so the mark can use either. Returns its viewBox and
// the markup inside the <svg> element.
function markSvg() {
  const svg = fs.readFileSync(
    path.join(ROOT, "app/renderer/assets/logo/logo-mark.svg"),
    "utf8",
  );
  const viewBox = (svg.match(/viewBox='([^']+)'/) || [])[1];
  const inner = (svg.match(/<svg[^>]*>([\s\S]*)<\/svg>/) || [])[1];
  if (!viewBox || !inner) throw new Error("unexpected logo-mark.svg shape");
  return { viewBox, inner: inner.replace(/(fill|stroke)='#[0-9a-fA-F]{3,8}'/g, "$1='#ffffff'") };
}

function iconHtml(size) {
  const { viewBox, inner } = markSvg();
  // Inset the mark so the glyph occupies ~58% of the tile, which keeps it
  // legible once Windows scales it down to 16px.
  const radius = Math.round(size * 0.22);
  const glyph = Math.round(size * 0.58);
  const mark =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${glyph}" height="${glyph}" viewBox="${viewBox}">` +
    `${inner}</svg>`;
  // Painted on a canvas rather than screenshotted: capturePage runs the frame
  // through the display's colour profile, which shifted the brand colour. Canvas pixels are plain sRGB, so what goes in comes out.
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
  <script>
  window.renderIcon = async function () {
    const S = ${size}, R = ${radius}, G = ${glyph};
    const c = document.createElement("canvas");
    c.width = S; c.height = S;
    const ctx = c.getContext("2d");
    ctx.fillStyle = ${JSON.stringify(BRAND)};
    ctx.beginPath();
    ctx.roundRect(0, 0, S, S, R);
    ctx.fill();
    const img = new Image();
    const svg = ${JSON.stringify(mark)};
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    await img.decode();
    ctx.drawImage(img, Math.round((S - G) / 2), Math.round((S - G) / 2), G, G);
    const probe = ctx.getImageData(4, Math.round(S / 2), 1, 1).data;
    return {
      dataUrl: c.toDataURL("image/png"),
      probe: [probe[0], probe[1], probe[2], probe[3]],
    };
  };
  <\/script>
  </body></html>`;
}

// Render the tile once at full size. Tiny offscreen windows fail to load
// reliably, so every smaller size is downscaled from this one master image --
// which also keeps the corner radius proportional across the set.
async function renderMaster(size) {
  const win = new BrowserWindow({ width: 200, height: 200, show: false });
  const tmp = path.join(BUILD, ".icon-master.html");
  fs.writeFileSync(tmp, iconHtml(size), "utf8");
  let dataUrl, probe;
  try {
    await win.loadFile(tmp);
    ({ dataUrl, probe } = await win.webContents.executeJavaScript(
      "window.renderIcon()",
    ));
  } finally {
    // Clean up even when the render fails, so a bad run leaves no scratch
    // file sitting in the build directory.
    win.destroy();
    fs.rmSync(tmp, { force: true });
  }

  const hex =
    "#" + probe.slice(0, 3).map((n) => n.toString(16).padStart(2, "0")).join("");
  if (hex.toLowerCase() !== BRAND.toLowerCase()) {
    throw new Error(`tile painted ${hex}, expected ${BRAND}`);
  }
  console.log(`tile colour ${hex} (verified against the brand value)`);
  return nativeImage.createFromDataURL(dataUrl);
}

function pngAt(master, size) {
  if (master.getSize().width === size) return master.toPNG();
  return master.resize({ width: size, height: size, quality: "best" }).toPNG();
}

// Pack PNG payloads into an .ico. Windows has accepted PNG-compressed icon
// entries since Vista, so each size goes in as-is rather than as a BMP.
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach((entry, i) => {
    const at = i * 16;
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, at + 0); // 0 means 256
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, at + 1);
    dir.writeUInt8(0, at + 2); // palette size
    dir.writeUInt8(0, at + 3); // reserved
    dir.writeUInt16LE(1, at + 4); // colour planes
    dir.writeUInt16LE(32, at + 6); // bits per pixel
    dir.writeUInt32LE(entry.png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += entry.png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

app.whenReady().then(async () => {
  fs.mkdirSync(BUILD, { recursive: true });
  fs.mkdirSync(ICONS_DIR, { recursive: true });

  const MASTER = 1024;
  const master = await renderMaster(MASTER);
  if (master.isEmpty()) throw new Error("icon render produced an empty image");

  const rendered = new Map();
  for (const size of new Set([...ICO_SIZES, ...PNG_SIZES])) {
    rendered.set(size, pngAt(master, size));
  }

  // Linux wants a directory of sizes; electron-builder reads build/icons/*.png.
  for (const size of PNG_SIZES) {
    fs.writeFileSync(path.join(ICONS_DIR, `${size}x${size}.png`), rendered.get(size));
  }

  // macOS takes the large PNG.
  fs.writeFileSync(path.join(BUILD, "icon.png"), rendered.get(1024));

  // The BrowserWindow icon has to live somewhere that ships inside the asar --
  // build/ does not -- so drop a copy next to the renderer's other assets.
  fs.writeFileSync(
    path.join(ROOT, "app/renderer/assets/logo/icon-256.png"),
    rendered.get(256),
  );

  const ico = buildIco(ICO_SIZES.map((size) => ({ size, png: rendered.get(size) })));
  fs.writeFileSync(path.join(BUILD, "icon.ico"), ico);

  console.log(`icon.png    1024x1024 (${Math.round(rendered.get(1024).length / 1024)} KB)`);
  console.log(`icon.ico    ${ICO_SIZES.join(", ")} (${Math.round(ico.length / 1024)} KB)`);
  console.log(`icons/      ${PNG_SIZES.length} PNGs`);
  app.quit();
}).catch((err) => {
  console.error(String((err && err.message) || err));
  process.exit(1);
});
