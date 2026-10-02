// zoom.js — Ctrl (Cmd on a Mac) with + / - / 0 zooms the window, and the
// level is remembered between launches, for anyone who finds the text too
// small (or large). Electron's hidden default menu zooms too, but forgets.
//
// The level is Chromium's: 0 is 100%, each step of 0.5 about 10%. It is
// kept between MIN and MAX, and stored in zoom.json in the app's userData.

const fs = require("fs");
const path = require("path");

const STEP = 0.5;
const MIN = -2; // about 70%
const MAX = 3; // about 175%

const clamp = (z) => Math.min(MAX, Math.max(MIN, z));

// A key press → the new zoom level, or null if it isn't a zoom shortcut.
// `input` is Electron's before-input-event input. "=" is the + key without
// Shift; "+" and "-" also come from the number pad.
function zoomFor(input, level) {
  if (!input || input.type !== "keyDown" || !(input.control || input.meta) || input.alt) return null;
  if (input.key === "=" || input.key === "+") return clamp(level + STEP);
  if (input.key === "-" || input.key === "_") return clamp(level - STEP);
  if (input.key === "0") return 0;
  return null;
}

function readZoom(dir, fsImpl = fs) {
  try {
    const z = JSON.parse(fsImpl.readFileSync(path.join(dir, "zoom.json"), "utf8")).level;
    return typeof z === "number" && Number.isFinite(z) ? clamp(z) : 0;
  } catch (_) {
    return 0;
  }
}

function saveZoom(dir, level, fsImpl = fs) {
  try {
    fsImpl.writeFileSync(path.join(dir, "zoom.json"), JSON.stringify({ level }));
  } catch (_) {
    /* not remembered; the zoom still applies now */
  }
}

// Wires it to a window: restore the saved level on each load, and handle
// the shortcuts.
function attachZoom(win, dir) {
  const wc = win.webContents;
  wc.on("did-finish-load", () => wc.setZoomLevel(readZoom(dir)));
  wc.on("before-input-event", (event, input) => {
    const next = zoomFor(input, wc.getZoomLevel());
    if (next == null) return;
    event.preventDefault();
    wc.setZoomLevel(next);
    saveZoom(dir, next);
  });
}

module.exports = { zoomFor, readZoom, saveZoom, attachZoom, STEP, MIN, MAX };
