// build.js — prepares the renderer for offline, CSP-clean execution.
//
// Two jobs:
//   1. Copy React's production UMD builds into app/renderer/dist/vendor, so the
//      app never reaches out to a CDN at launch (it has to work on the very
//      machines whose network is suspect).
//   2. Bundle the JSX sources into one plain-JS file, so no in-browser Babel
//      transform runs at startup and the page needs no 'unsafe-eval'.
//
// Output lives in app/renderer/dist (git-ignored). Run via `npm run build`;
// `npm start` and `npm run dist` do it for you.

const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

const ROOT = __dirname;
const RENDERER = path.join(ROOT, "app", "renderer");
const OUT = path.join(RENDERER, "dist");
const VENDOR = path.join(OUT, "vendor");

const VENDOR_FILES = [
  ["react", "umd/react.production.min.js", "react.js"],
  ["react-dom", "umd/react-dom.production.min.js", "react-dom.js"],
];

function vendorReact() {
  fs.mkdirSync(VENDOR, { recursive: true });
  for (const [pkg, rel, outName] of VENDOR_FILES) {
    const src = path.join(ROOT, "node_modules", pkg, rel);
    if (!fs.existsSync(src)) {
      throw new Error(`Missing ${src} — run \`npm install\` first.`);
    }
    fs.copyFileSync(src, path.join(VENDOR, outName));
    console.log(`vendored  ${outName}`);
  }
}

async function bundleApp() {
  const result = await esbuild.build({
    entryPoints: [path.join(RENDERER, "helper-app.jsx")],
    bundle: true,
    format: "iife",
    target: "chrome120", // Electron 42 ships a much newer Chromium
    jsx: "transform", // classic runtime — React comes from the UMD global
    outfile: path.join(OUT, "app.js"),
    minify: true,
    sourcemap: true,
    logLevel: "warning",
    loader: { ".js": "jsx" },
  });
  if (result.errors.length) throw new Error("bundle failed");
  const bytes = fs.statSync(path.join(OUT, "app.js")).size;
  console.log(`bundled   app.js (${Math.round(bytes / 1024)} KB)`);
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  vendorReact();
  await bundleApp();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
