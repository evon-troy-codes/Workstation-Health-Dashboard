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
// Cloudflare rate-limits by bytes requested, not just request count, and
// answers 429 once a client has pulled too much too quickly — which a user
// re-running the test will hit. Step down the chunk size rather than reporting
// a failure: a smaller chunk still measures the link, just with more overhead.
const CHUNK_LADDER = [25_000_000, 10_000_000, 5_000_000, 1_000_000];
// Upload gets its own, smaller ladder: its chunks are sent whether or not
// Cloudflare accepts them, so retrying a throttled 2 MB body just burns uplink.
const UP_LADDER = [2_000_000, 1_000_000, 250_000];
const THROTTLE_BACKOFF_MS = 250;
// Once the smallest size is refused too, nothing smaller is left to try, and
// asking four times a second only feeds a limiter that counts bytes requested.
const FLOOR_BACKOFF_MS = 1000;

// Resolves early if the signal aborts, so a backoff never holds a stream past
// the hard cap or a cancelled run.
const sleep = (ms, signal) =>
  new Promise((r) => {
    if (signal && signal.aborted) return r();
    const done = () => {
      clearTimeout(t);
      if (signal) signal.removeEventListener("abort", done);
      r();
    };
    const t = setTimeout(done, ms);
    if (signal) signal.addEventListener("abort", done);
  });

// Release a response whose body is never read (a refusal, or an upload's empty
// reply) rather than leave the connection holding it.
const discard = (res) => {
  if (res.body) res.body.cancel().catch(() => {});
};

// The chunk size one direction's parallel streams share. Streams are throttled
// together, so one throttle arrives as a 429 on each of them: only a stream
// that asked at the current size steps it down, and the rest retry at the size
// it chose. Stepping once per 429 skipped straight past the middle sizes. At
// the smallest size a 429 just waits and retries until the window closes —
// the same policy in both directions, so no stream gives up on a throttle.
function chunkLadder(sizes) {
  let rung = 0;
  return {
    get rung() { return rung; },
    size: (r) => sizes[r],
    // Steps down if this stream's size is still current, then waits: briefly
    // while there is a smaller size to try, longer once there is not.
    throttled(asked, signal) {
      const floor = sizes.length - 1;
      if (rung === asked && rung < floor) rung++;
      return sleep(asked === floor ? FLOOR_BACKOFF_MS : THROTTLE_BACKOFF_MS, signal);
    },
  };
}

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
async function measureDownload(onProgress, signal, durationMs = 12000) {
  const ladder = chunkLadder(CHUNK_LADDER);
  const start = performance.now();
  const deadline = start + durationMs;
  let totalBytes = 0;

  const report = () => {
    if (!onProgress) return;
    const frac = Math.min((performance.now() - start) / durationMs, 1);
    onProgress(15 + Math.round(frac * 50)); // 15 → 65
  };

  async function stream() {
    while (performance.now() < deadline && !signal.aborted) {
      const asked = ladder.rung;
      const res = await fetchWithTimeout(
        "https://speed.cloudflare.com/__down?bytes=" + ladder.size(asked),
        { cache: "no-store" },
        signal,
      );
      if (res.status === 429) {
        discard(res);
        await ladder.throttled(asked, signal);
        report(); // the window is still running; keep the bar moving
        continue;
      }
      if (!res.ok || !res.body) {
        discard(res);
        break;
      }
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
  // No bytes at all means every stream was refused (a rate limit, a blocked
  // endpoint, no route). That is a failed measurement, not a 0 Mbps link, and
  // reporting it as a number would be a lie the UI cannot distinguish.
  if (totalBytes === 0) return null;
  const elapsedSec = (Math.min(performance.now(), deadline) - start) / 1000;
  return elapsedSec > 0 ? (totalBytes * 8) / elapsedSec / 1_000_000 : null;
}

// ── Upload ────────────────────────────────────────────────────────
async function measureUpload(onProgress, signal, durationMs = 10000) {
  // Repeating pattern — crypto.getRandomValues caps at 65 536 bytes/call.
  // One buffer at the largest size; smaller rungs send a slice of it.
  const data = new Uint8Array(UP_LADDER[0]);
  for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
  const blob = new Blob([data], { type: "application/octet-stream" });
  const ladder = chunkLadder(UP_LADDER);

  const start = performance.now();
  const deadline = start + durationMs;
  let totalBytes = 0;

  const report = () => {
    if (!onProgress) return;
    const frac = Math.min((performance.now() - start) / durationMs, 1);
    onProgress(65 + Math.round(frac * 35)); // 65 → 100
  };

  async function stream() {
    while (performance.now() < deadline && !signal.aborted) {
      const asked = ladder.rung;
      const size = ladder.size(asked);
      const res = await fetchWithTimeout(
        "https://speed.cloudflare.com/__up",
        { method: "POST", body: blob.slice(0, size, blob.type), mode: "cors", cache: "no-store" },
        signal,
      );
      discard(res);
      // A refused upload moved nothing that counts. Counting it anyway turned
      // an endpoint answering 503 as fast as it could into a multi-gigabit
      // "upload speed". A 429 is Cloudflare throttling a re-run, not a dead
      // endpoint: step down and keep measuring, as the download does.
      if (res.status === 429) {
        await ladder.throttled(asked, signal);
        report(); // the window is still running; keep the bar moving
        continue;
      }
      if (!res.ok) break;
      totalBytes += size;
      report();
    }
  }

  const streams = Array.from({ length: UP_STREAMS }, () =>
    stream().catch(() => {}),
  );
  await Promise.all(streams);
  if (totalBytes === 0) return null;
  const elapsedSec = (Math.min(performance.now(), deadline) - start) / 1000;
  return elapsedSec > 0 ? (totalBytes * 8) / elapsedSec / 1_000_000 : null;
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
    let down = null;
    let up = null;
    try {
      down = await measureDownload(cb, signal);
    } catch {
      down = null;
    }
    try {
      up = await measureUpload(cb, signal);
    } catch {
      up = null;
    }
    cb(100);
    return {
      // null (not 0) when the measurement failed — the hero renders it as "—".
      downMbps: down == null ? null : Math.round(down),
      upMbps: up == null ? null : Math.round(up),
      ping,
      jitter,
      measuredAt: Date.now(),
      // A run the hard cap cut short still reports what it managed to measure,
      // flagged so the UI can say so rather than quietly showing a low number.
      partial: signal.aborted,
      failed: down == null || up == null,
    };
  } finally {
    clearTimeout(capTimer);
    if (outer) outer.removeEventListener("abort", onOuterAbort);
  }
}

export { run };

// For unit tests: the ladder and each phase, with a shorter window than a real
// run (the duration parameter), so the suite does not take 22 s per case.
export { chunkLadder, measureDownload, measureUpload };
