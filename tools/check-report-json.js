// check-report-json.js — CI's check of `--report-json` in an installed app.
//
// Runs the app with --report-json=<file> (the form that works on every OS,
// including Windows, where a windowed app's stdout isn't a console), then
// checks the file is the report envelope: schema 1, the basic readings, and
// no MAC address or Wi-Fi name. Prints only true/false per check, never the
// values, since CI logs are public.
//
// Usage: node tools/check-report-json.js <app executable> <output file>

const { spawnSync } = require("child_process");
const fs = require("fs");

const [app, out] = process.argv.slice(2);
if (!app || !out) {
  console.error("usage: node tools/check-report-json.js <app executable> <output file>");
  process.exit(2);
}

fs.rmSync(out, { force: true });
const started = Date.now();
const run = spawnSync(app, [`--report-json=${out}`], { timeout: 120000, encoding: "utf8" });
const seconds = ((Date.now() - started) / 1000).toFixed(1);
if (run.error || run.status !== 0) {
  console.error(`--report-json failed after ${seconds} s: ${run.error ? run.error.message : `exit ${run.status}`}`);
  if (run.stderr) console.error(run.stderr.slice(0, 2000));
  process.exit(1);
}

let env;
try {
  env = JSON.parse(fs.readFileSync(out, "utf8"));
} catch (err) {
  console.error(`--report-json wrote no valid JSON: ${err.message}`);
  process.exit(1);
}
const r = (env && env.report) || {};
const net = r.network || {};
const checks = {
  schema1: env.schema === 1,
  triggerCli: env.trigger === "cli",
  appVersion: typeof env.appVersion === "string" && env.appVersion.length > 0,
  hostname: typeof r.hostname === "string" && r.hostname.length > 0,
  osName: !!(r.os && typeof r.os.name === "string" && r.os.name),
  cpuModel: !!(r.cpu && typeof r.cpu.model === "string" && r.cpu.model),
  noMac: !("mac" in net),
  noWifiName: !("ssid" in net),
};
console.log(`--report-json exited 0 in ${seconds} s`);
for (const [k, v] of Object.entries(checks)) console.log(`  ${k.padEnd(12)} ${v}`);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
