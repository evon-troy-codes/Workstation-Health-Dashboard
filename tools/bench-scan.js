// bench-scan.js — times one scan in one PowerShell mode, for the Windows
// experiment on this branch. Not part of the app.
//
//   node tools/bench-scan.js default      each si call spawns its own PowerShell
//   node tools/bench-scan.js persistent   si.powerShellStart(): one shared session
//
// Prints one JSON line: how long the first scan (collectFacts) and the slow
// scans (detectDeferred) took, the slowest checks, and a fingerprint of what
// was found, so the two modes can be checked for giving the same data. The
// fingerprint holds counts, sizes and yes/no only; nothing identifies the
// machine (CI logs are public).

const si = require("systeminformation");
const { collectFacts, detectDeferred, probeTimings } = require("../app/main/system-facts");

const mode = process.argv[2];
if (mode !== "default" && mode !== "persistent") {
  console.error("usage: node tools/bench-scan.js default|persistent");
  process.exit(2);
}

(async () => {
  const persistent = mode === "persistent" && process.platform === "win32";
  if (persistent) si.powerShellStart();
  const t0 = Date.now();
  const facts = await collectFacts();
  const firstScanMs = Date.now() - t0;
  const t1 = Date.now();
  const deferred = await detectDeferred();
  const deferredMs = Date.now() - t1;
  if (persistent) si.powerShellRelease();

  const found = {
    cpuModel: facts.cpu.model !== "Unknown",
    cores: facts.cpu.cores,
    threads: facts.cpu.threads,
    ramGB: facts.ram.totalGB,
    ramType: facts.ram.type || null,
    diskGB: facts.disk.totalGB,
    machine: Boolean(facts.machineType),
    osName: Boolean(facts.os.name),
    osBuild: Boolean(facts.os.build),
    iface: facts.network.interface !== "Unknown",
    linkSpeed: facts.network.linkSpeed !== "Unknown",
    gateway: Boolean(facts.network.gateway),
    dnsCount: facts.network.dns.length,
    battery: facts.power.hasBattery,
    audioClass: facts.audio.headsetClass,
    antivirus: facts.antivirus.products.length,
    ssd: deferred.ssd,
    display: deferred.display ? deferred.display.resolution !== "Unknown" : null,
    pendingUpdates: deferred.pendingUpdates,
    runningApps: deferred.backgroundApps ? deferred.backgroundApps.runningApps.length : null,
  };
  console.log(JSON.stringify({ mode, firstScanMs, deferredMs, slowest: probeTimings().slice(0, 5), found }));
  process.exit(0);
})().catch((e) => {
  console.error(`bench failed: ${(e && e.message) || e}`);
  process.exit(1);
});
