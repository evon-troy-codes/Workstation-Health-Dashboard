// selftest.js — the result an installed build writes for CI's check when
// started with WHD_SELFTEST_FILE (see main.js and tools/check-selftest.js).
//
// It says which readings came back as true/false only: no values, so nothing
// about the machine is ever written. `rendered` is whether the dashboard was
// on screen, asked of the page itself, not assumed.

const known = (v) => typeof v === "string" && v !== "" && v !== "Unknown";

function selfTestResult({ facts, deferred, rendered, version, packaged }) {
  const f = facts || {};
  const os = f.os || {}, cpu = f.cpu || {}, ram = f.ram || {}, disk = f.disk || {}, net = f.network || {};
  const d = deferred || {};
  return {
    version,
    packaged: Boolean(packaged),
    checks: {
      rendered: rendered === true,
      osName: known(os.name),
      cpuModel: known(cpu.model),
      ramTotal: ram.totalGB > 0,
      diskTotal: disk.totalGB > 0,
      networkInterface: known(net.interface),
      lastUpdateCheck: known(d.lastUpdateCheck),
      display: Boolean(d.display && d.display.count > 0),
    },
  };
}

// Run in the page: true once the dashboard (.helper-shell) is on screen,
// false if the render-error screen is up or nothing appears within 5 s.
const RENDERED_CHECK = `new Promise((resolve) => {
  const start = Date.now();
  (function poll() {
    if (document.querySelector(".helper-shell")) return resolve(true);
    if (document.querySelector("[data-render-error]") || Date.now() - start > 5000) return resolve(false);
    setTimeout(poll, 100);
  })();
})`;

module.exports = { selfTestResult, RENDERED_CHECK };
