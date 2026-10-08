// managed-settings.js — Workstation Scanner for Teams: the settings IT sets
// to make a computer report to the company's fleet server. See
// docs/design/fleet-mode.md, "The managed settings".
//
// They come from each OS's place for settings only an administrator or the
// company's device management can set, as browsers, Zoom and Slack read
// theirs:
//
//   Windows  HKLM\SOFTWARE\Policies\WorkstationScanner (registry values)
//   macOS    /Library/Managed Preferences/com.evontroy.workstation-scanner.plist
//            (a configuration profile, installed by an MDM)
//   Linux    /etc/workstation-scanner/managed.json
//
// A user can't create or change any of them, so managed mode can't be
// switched on or off without IT. On macOS and Linux the file, and its
// folder, must also be root's and writable by root alone, as sshd checks its
// own files; otherwise it is ignored and the app says so.
//
// The parsing is in small pure functions, tested against sample output, so
// each OS's reader is tested on every OS.

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const REG_KEY = "HKLM\\SOFTWARE\\Policies\\WorkstationScanner";
const MAC_FILE = "/Library/Managed Preferences/com.evontroy.workstation-scanner.plist";
const LINUX_FILE = "/etc/workstation-scanner/managed.json";

const SETTINGS_VERSION = 1;
const MAX_ORGANIZATION = 100;

// What a reader found → the settings the app uses:
//   { status: "off" }                              not managed
//   { status: "invalid", reason }                  managed, but unusable
//   { status: "on", organization, fleetUrl, enrollmentKey, speedTest,
//     explain, scanEveryHours }
// `raw` is null when there are no settings at all. Unknown keys are ignored,
// so settings written for a newer app still work where they can.
function normalizeSettings(raw) {
  if (raw == null) return { status: "off" };
  if (typeof raw !== "object" || Array.isArray(raw)) return { status: "invalid", reason: "not-an-object" };

  const version = raw.version;
  if (version != null && Number(version) !== SETTINGS_VERSION) return { status: "invalid", reason: "unknown-version" };

  const fleetUrl = typeof raw.fleetUrl === "string" ? raw.fleetUrl.trim() : String(raw.fleetUrl || "").trim();
  let url;
  try {
    url = new URL(fleetUrl);
  } catch (_) {
    return { status: "invalid", reason: "no-fleet-url" };
  }
  if (url.protocol !== "https:") return { status: "invalid", reason: "not-https" };
  if (url.username || url.password) return { status: "invalid", reason: "credentials-in-url" };
  // Always a folder, so "v1/reports" resolves under it.
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";

  const enrollmentKey = typeof raw.enrollmentKey === "string" ? raw.enrollmentKey.trim() : "";
  if (!enrollmentKey) return { status: "invalid", reason: "no-enrollment-key" };

  const org = typeof raw.organization === "string" ? raw.organization.trim().slice(0, MAX_ORGANIZATION) : "";
  const hours = Number(raw.scanEveryHours);
  const speedTest = typeof raw.speedTest === "string" ? raw.speedTest.trim().toLowerCase() : raw.speedTest;
  const explain = raw.explain;
  return {
    status: "on",
    // The notice needs a name; the server's host is the honest fallback.
    organization: org || url.hostname,
    fleetUrl: url.href,
    enrollmentKey,
    // "daily" is accepted now and acts as "open" until background scanning
    // (phase 4), so settings IT writes today keep working.
    speedTest: speedTest === "daily" ? "daily" : "open",
    explain: explain !== false && explain !== 0 && explain !== "0",
    scanEveryHours: Number.isInteger(hours) && hours >= 1 && hours <= 168 ? hours : 6,
  };
}

// The text of a JSON file → { raw } or { invalid: "unparseable" }.
function parseJsonSettings(text) {
  try {
    return { raw: JSON.parse(text) };
  } catch (_) {
    return { invalid: "unparseable" };
  }
}

// `reg query <key>` output → { name: value }. REG_DWORD (0x1) becomes a
// number and REG_SZ a string; other types are skipped. Lines look like
//     fleetUrl    REG_SZ    https://fleet.acme.example/
function parseRegQuery(stdout) {
  const out = {};
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const m = /^\s{2,}(\S(?:.*?\S)?)\s{2,}(REG_SZ|REG_EXPAND_SZ|REG_DWORD)\s{2,}(.*?)\s*$/.exec(line);
    if (!m) continue;
    const [, name, type, value] = m;
    out[name] = type === "REG_DWORD" ? parseInt(value, 16) : value;
  }
  return out;
}

// Whether a file (or folder) can be trusted as root's settings: owned by
// root, and not writable by its group or anyone else. `st` is an fs.Stats.
function ownedByRootOnly(st) {
  return Boolean(st) && st.uid === 0 && (st.mode & 0o022) === 0;
}

function run(cmd, args, timeout = 10000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => resolve({ err, stdout: String(stdout || "") }));
  });
}

// macOS and Linux: whether the file is there and only root can change it.
// → { raw: null } (no file), { invalid } or { ok: true }.
function checkRootFile(file, statImpl = fs.statSync) {
  let st;
  try {
    st = statImpl(file);
  } catch (err) {
    return err && err.code === "ENOENT" ? { raw: null } : { invalid: "unreadable" };
  }
  let dir;
  try {
    dir = statImpl(path.dirname(file));
  } catch (_) {
    return { invalid: "unreadable" };
  }
  if (!st.isFile() || !ownedByRootOnly(st) || !ownedByRootOnly(dir)) return { invalid: "not-root-owned" };
  return { ok: true };
}

// → { raw } (null when there are no settings) or { invalid: reason }.
async function readRaw(platform) {
  if (platform === "win32") {
    // /reg:64: the 64-bit view, where Group Policy and Intune write. An
    // error (exit code 1) means the key isn't there: not managed.
    const { err, stdout } = await run("reg", ["query", REG_KEY, "/reg:64"]);
    if (err) return { raw: null };
    const values = parseRegQuery(stdout);
    return { raw: Object.keys(values).length ? values : null };
  }
  if (platform === "darwin") {
    const check = checkRootFile(MAC_FILE);
    if (!check.ok) return check;
    const { err, stdout } = await run("plutil", ["-convert", "json", "-o", "-", MAC_FILE]);
    return err ? { invalid: "unreadable" } : parseJsonSettings(stdout);
  }
  if (platform === "linux") {
    const check = checkRootFile(LINUX_FILE);
    if (!check.ok) return check;
    try {
      return parseJsonSettings(fs.readFileSync(LINUX_FILE, "utf8"));
    } catch (_) {
      return { invalid: "unreadable" };
    }
  }
  return { raw: null };
}

// This computer's managed settings (normalizeSettings's shape). Never throws.
async function readManagedSettings(platform = process.platform) {
  try {
    const found = await readRaw(platform);
    return found.invalid ? { status: "invalid", reason: found.invalid } : normalizeSettings(found.raw);
  } catch (_) {
    return { status: "invalid", reason: "unreadable" };
  }
}

module.exports = {
  normalizeSettings, parseJsonSettings, parseRegQuery, ownedByRootOnly, checkRootFile,
  readManagedSettings, REG_KEY, MAC_FILE, LINUX_FILE,
};
