// speedtest.js — real network measurement for the Network screen.
// Uses Cloudflare's speed-test endpoints, with added ping/jitter sampling.
//
// run(onProgress, { signal }) → Promise<{ downMbps, upMbps, ping, jitter, measuredAt }>
// onProgress(percent 0–100) is called throughout.
//
// Every request is bounded by an AbortController and the whole run is capped by
// HARD_CAP_MS. Without that a stalled socket leaves the promise pending forever,
// which is a bad failure for a tool people open *because* the network is sick.

const HARD_CAP_MS = 75000; // absolute ceiling for a full run
const REQUEST_TIMEOUT_MS = 20000; // ceiling for any single request
const DOWN_STREAMS = 4; // one stream cannot saturate a fast link
const UP_STREAMS = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch + a deadline. Chains an outer signal so a cancelled run tears down
// every in-flight request rather than leaving them to finish in the background.
async function fetchWithTimeout(url, opts = {}, outerSignal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  if (outerSignal) {
    if (outerSignal.aborted) ctrl.abort();
    outerSignal.addEventListener("abort", onAbort);
  }
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    if (outerSignal) outerSignal.removeEventListener("abort", onAbort);
  }
}

// ── Latency / jitter: a handful of tiny requests ──────────────────
async function measureLatency(onProgress, signal) {
  const samples = [];
  const N = 6;
  // One unmeasured request first: the connection it opens costs a DNS lookup
  // and a TLS handshake, and counting that as a latency sample inflates the
  // median and badly inflates jitter (which is a deviation between samples).
  try {
    const warm = await fetchWithTimeout(
      "https://speed.cloudflare.com/__down?bytes=1000",
      { cache: "no-store" },
      signal,
    );
    await warm.arrayBuffer();
  } catch {
    /* the measured samples below will report the failure */
  }
  for (let i = 0; i < N; i++) {
    if (signal.aborted) break;
    const t0 = performance.now();
    try {
      const res = await fetchWithTimeout(
        "https://speed.cloudflare.com/__down?bytes=1000",
        { cache: "no-store" },
        signal,
      );
      await res.arrayBuffer();
      samples.push(performance.now() - t0);
    } catch {
      /* skip failed sample */
    }
    if (onProgress) onProgress(Math.round(((i + 1) / N) * 15));
    await sleep(60);
  }
  if (!samples.length) return { ping: null, jitter: null };
  const ordered = [...samples].sort((a, b) => a - b);
  const ping = ordered[Math.floor(ordered.length / 2)]; // median
  // Jitter is the mean deviation between *consecutive* samples, so walk the
  // arrival order rather than the sorted copy.
  let jitterSum = 0;
  for (let i = 1; i < samples.length; i++) {
    jitterSum += Math.abs(samples[i] - samples[i - 1]);
  }
  const jitter = samples.length > 1 ? jitterSum / (samples.length - 1) : 0;
  return { ping: Math.round(ping), jitter: Math.round(jitter * 10) / 10 };
}

// ── Download ──────────────────────────────────────────────────────
// Throughput is bytes moved divided by the wall time of the measurement
// window, across parallel streams. Timing each request separately and summing
// counts DNS/TCP/TLS setup and TTFB as transfer time, which under-reports the
// link badly when latency is high.
async function measureDownload(onProgress, signal) {
  const DURATION_MS = 12000;
  const CHUNK_BYTES = 25_000_000;
  const start = performance.now();
  const deadline = start + DURATION_MS;
  let totalBytes = 0;

  const report = () => {
    if (!onProgress) return;
    const frac = Math.min((performance.now() - start) / DURATION_MS, 1);
    onProgress(15 + Math.round(frac * 50)); // 15 → 65
  };

  async function stream() {
    while (performance.now() < deadline && !signal.aborted) {
      const res = await fetchWithTimeout(
        "https://speed.cloudflare.com/__down?bytes=" + CHUNK_BYTES,
        { cache: "no-store" },
        signal,
      );
      if (!res.ok || !res.body) break;
      // Read incrementally so bytes still count when the deadline cuts a
      // chunk short — an abandoned chunk was still real traffic.
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.length;
        report();
        if (performance.now() >= deadline || signal.aborted) {
          await reader.cancel().catch(() => {});
          return;
        }
      }
    }
  }

  const streams = Array.from({ length: DOWN_STREAMS }, () =>
    stream().catch(() => {}),
  );
  await Promise.all(streams);
  const elapsedSec = (Math.min(performance.now(), deadline) - start) / 1000;
  return elapsedSec > 0 ? (totalBytes * 8) / elapsedSec / 1_000_000 : 0;
}

// ── Upload ────────────────────────────────────────────────────────
async function measureUpload(onProgress, signal) {
  const DURATION_MS = 10000;
  const CHUNK_BYTES = 2_000_000;
  // Repeating pattern — crypto.getRandomValues caps at 65 536 bytes/call.
  const data = new Uint8Array(CHUNK_BYTES);
  for (let i = 0; i < CHUNK_BYTES; i++) data[i] = i & 0xff;
  const blob = new Blob([data], { type: "application/octet-stream" });

  const start = performance.now();
  const deadline = start + DURATION_MS;
  let totalBytes = 0;

  async function stream() {
    while (performance.now() < deadline && !signal.aborted) {
      await fetchWithTimeout(
        "https://speed.cloudflare.com/__up",
        { method: "POST", body: blob, mode: "cors", cache: "no-store" },
        signal,
      );
      totalBytes += CHUNK_BYTES;
      if (onProgress) {
        const frac = Math.min((performance.now() - start) / DURATION_MS, 1);
        onProgress(65 + Math.round(frac * 35)); // 65 → 100
      }
    }
  }

  const streams = Array.from({ length: UP_STREAMS }, () =>
    stream().catch(() => {}),
  );
  await Promise.all(streams);
  const elapsedSec = (Math.min(performance.now(), deadline) - start) / 1000;
  return elapsedSec > 0 ? (totalBytes * 8) / elapsedSec / 1_000_000 : 0;
}

async function run(onProgress, opts = {}) {
  const cb = typeof onProgress === "function" ? onProgress : () => {};
  // One controller for the whole run: the hard cap, or a caller-supplied
  // signal, aborts every request still in flight.
  const ctrl = new AbortController();
  const capTimer = setTimeout(() => ctrl.abort(), HARD_CAP_MS);
  const outer = opts.signal;
  const onOuterAbort = () => ctrl.abort();
  if (outer) {
    if (outer.aborted) ctrl.abort();
    outer.addEventListener("abort", onOuterAbort);
  }
  const signal = ctrl.signal;

  try {
    cb(0);
    const { ping, jitter } = await measureLatency(cb, signal);
    let down = 0;
    let up = 0;
    try {
      down = await measureDownload(cb, signal);
    } catch {
      down = 0;
    }
    try {
      up = await measureUpload(cb, signal);
    } catch {
      up = 0;
    }
    cb(100);
    return {
      downMbps: Math.round(down),
      upMbps: Math.round(up),
      ping,
      jitter,
      measuredAt: Date.now(),
      // A run the hard cap cut short still reports what it managed to measure,
      // flagged so the UI can say so rather than quietly showing a low number.
      partial: signal.aborted,
    };
  } finally {
    clearTimeout(capTimer);
    if (outer) outer.removeEventListener("abort", onOuterAbort);
  }
}

export { run };
