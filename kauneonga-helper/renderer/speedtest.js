// speedtest.js — real network measurement for the Network screen.
// Plain (non-JSX) script; loaded before the Babel app scripts and exposed as
// window.ascSpeedTest. Ported from the original ASC Cloudflare speed test, with
// added ping/jitter sampling.
//
// run(onProgress) → Promise<{ downMbps, upMbps, ping, jitter, measuredAt,
//                             approvedDown, approvedUp }>
// onProgress(percent 0–100) is called throughout.

(function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const DOWN_THRESHOLD = 100; // Mbps
  const UP_THRESHOLD = 10; // Mbps

  // ── Latency / jitter: a handful of tiny requests ──────────────────
  async function measureLatency(onProgress) {
    const samples = [];
    const N = 6;
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      try {
        await fetch("https://speed.cloudflare.com/__down?bytes=1000", {
          cache: "no-store",
        });
        samples.push(performance.now() - t0);
      } catch {
        /* skip failed sample */
      }
      if (onProgress) onProgress(Math.round(((i + 1) / N) * 15));
      await sleep(60);
    }
    if (!samples.length) return { ping: null, jitter: null };
    samples.sort((a, b) => a - b);
    const ping = samples[Math.floor(samples.length / 2)]; // median
    let jitterSum = 0;
    for (let i = 1; i < samples.length; i++) {
      jitterSum += Math.abs(samples[i] - samples[i - 1]);
    }
    const jitter = samples.length > 1 ? jitterSum / (samples.length - 1) : 0;
    return { ping: Math.round(ping), jitter: Math.round(jitter * 10) / 10 };
  }

  // ── Download ──────────────────────────────────────────────────────
  async function measureDownload(onProgress) {
    const DURATION_MS = 15000;
    const CHUNK_BYTES = 25_000_000; // large chunk = fewer requests = less rate-limit
    const start = performance.now();
    const deadline = start + DURATION_MS;
    let totalBits = 0;
    let totalSec = 0;
    while (performance.now() < deadline) {
      const t0 = performance.now();
      const res = await fetch(
        "https://speed.cloudflare.com/__down?bytes=" + CHUNK_BYTES,
        { cache: "no-store" },
      );
      if (!res.ok) break;
      await res.arrayBuffer();
      totalSec += (performance.now() - t0) / 1000;
      totalBits += CHUNK_BYTES * 8;
      if (onProgress) {
        const frac = Math.min((performance.now() - start) / DURATION_MS, 1);
        onProgress(15 + Math.round(frac * 50)); // 15 → 65
      }
      await sleep(400); // brief pause to avoid rate-limiting
    }
    return totalSec > 0 ? totalBits / totalSec / 1_000_000 : 0;
  }

  // ── Upload ────────────────────────────────────────────────────────
  async function measureUpload(onProgress) {
    const DURATION_MS = 12000;
    const CHUNK_BYTES = 2_000_000;
    // Repeating pattern — crypto.getRandomValues caps at 65 536 bytes/call.
    const data = new Uint8Array(CHUNK_BYTES).map((_, i) => i & 0xff);
    const blob = new Blob([data], { type: "text/plain" });
    const start = performance.now();
    const deadline = start + DURATION_MS;
    let totalBits = 0;
    let totalSec = 0;
    let iterations = 0;
    while (performance.now() < deadline || iterations === 0) {
      const t0 = performance.now();
      await fetch("https://speed.cloudflare.com/__up", {
        method: "POST",
        body: blob,
        mode: "cors",
        cache: "no-store",
      });
      totalSec += (performance.now() - t0) / 1000;
      totalBits += CHUNK_BYTES * 8;
      iterations++;
      if (onProgress) {
        const frac = Math.min((performance.now() - start) / DURATION_MS, 1);
        onProgress(65 + Math.round(frac * 35)); // 65 → 100
      }
      await sleep(400);
    }
    return totalSec > 0 ? totalBits / totalSec / 1_000_000 : 0;
  }

  async function run(onProgress) {
    const cb = typeof onProgress === "function" ? onProgress : () => {};
    cb(0);
    const { ping, jitter } = await measureLatency(cb);
    let down = 0;
    let up = 0;
    try {
      down = await measureDownload(cb);
    } catch {
      down = 0;
    }
    try {
      up = await measureUpload(cb);
    } catch {
      up = 0;
    }
    cb(100);
    return {
      downMbps: Math.round(down),
      upMbps: Math.round(up),
      ping,
      jitter,
      measuredAt: "just now",
      approvedDown: down >= DOWN_THRESHOLD,
      approvedUp: up >= UP_THRESHOLD,
    };
  }

  window.ascSpeedTest = { run };
})();
