// Unit tests for the speed test's 429 handling, deadlines and result shape,
// against a stubbed fetch. speedtest.js is a browser ES module inside a
// CommonJS package, so it is loaded from a data: URL rather than required.
//
// A data: module cannot resolve relative imports, so this loader only works
// while speedtest.js imports nothing; stack traces show the data URL, not the
// file path.
//
// Every test runs on a fake clock: setTimeout and Date are mocked and
// performance.now reads Date.now, so windows, backoffs and timeouts are exact
// and a 75 s hard cap costs no real time. Nothing here depends on how busy
// the CI runner is.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const loadModule = (file) =>
  import("data:text/javascript;base64," +
    fs.readFileSync(path.join(__dirname, file)).toString("base64"));

// Every simulated request takes this long, so a stream of instant replies
// still moves the clock rather than spinning at one instant.
const LATENCY_MS = 10;
const STEP_MS = 10;

function useFakeClock(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.mock.method(performance, "now", () => Date.now());
}

// Advances the fake clock until `promise` settles. Between ticks it yields a
// real macrotask (setImmediate is not mocked) so promise chains and stream
// reads run to their next timer. Returns the value and the fake time taken.
async function settle(t, promise, limitMs = 200_000) {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  const t0 = Date.now();
  for (;;) {
    await new Promise(setImmediate);
    if (done) break;
    if (Date.now() - t0 >= limitMs) throw new Error(`did not settle within ${limitMs} ms`);
    t.mock.timers.tick(STEP_MS);
  }
  return { value: await promise, elapsed: Date.now() - t0 };
}

// Replaces global fetch. `respond(path, size)` returns the status to answer
// with; a download's 200 carries a 64 KB body, an upload's is empty as the real
// one is. Every call is recorded with the size asked for (the bytes= query on a
// download, the body size on an upload). With `stall`, a download body sends
// one chunk and then nothing, erroring only when the request is aborted, as a
// real fetch body does. `latency(path, size)` sets how long a request takes, in
// ms (default LATENCY_MS), for simulating a slow link.
function stubFetch(respond, { stall = false, latency = () => LATENCY_MS } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const size = u.pathname === "/__up" ? init.body.size : Number(u.searchParams.get("bytes"));
    calls.push({ path: u.pathname, size });
    // Honours an abort as a real fetch does, so a request that outlasts the
    // 20 s timeout fails here too instead of quietly completing.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, latency(u.pathname, size));
      if (init.signal) {
        if (init.signal.aborted) { clearTimeout(timer); return reject(init.signal.reason); }
        init.signal.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal.reason); }, { once: true });
      }
    });
    const status = respond(u.pathname, size);
    let body = null;
    if (status === 200 && u.pathname === "/__down") {
      body = stall
        ? new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(65536));
            init.signal.addEventListener("abort", () => c.error(init.signal.reason));
          },
        })
        : new Uint8Array(65536);
    }
    return new Response(body, { status });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const sizesSeen = (calls, p) => [...new Set(calls.filter((c) => c.path === p).map((c) => c.size))];
const countAt = (calls, p, size) => calls.filter((c) => c.path === p && c.size === size).length;
const noSignal = () => new AbortController().signal;
const abortedSignal = () => { const c = new AbortController(); c.abort(); return c.signal; };

test("chunkLadder", async (t) => {
  const { chunkLadder } = await loadModule("speedtest.js");

  await t.test("steps down once when every stream is throttled at the same size", async () => {
    const ladder = chunkLadder([4, 3, 2, 1]);
    const asked = [ladder.rung, ladder.rung, ladder.rung, ladder.rung];
    await Promise.all(asked.map((a) => ladder.throttled(a, abortedSignal())));
    assert.equal(ladder.rung, 1);
  });

  await t.test("ignores a 429 for a size that is no longer current", async () => {
    const ladder = chunkLadder([4, 3, 2, 1]);
    await ladder.throttled(0, abortedSignal());
    await ladder.throttled(0, abortedSignal()); // late reply from the old size
    assert.equal(ladder.rung, 1);
  });

  await t.test("stops at the smallest size", async () => {
    const ladder = chunkLadder([4, 3, 2, 1]);
    for (let i = 0; i < 10; i++) await ladder.throttled(ladder.rung, abortedSignal());
    assert.equal(ladder.rung, 3);
    assert.equal(ladder.size(ladder.rung), 1);
  });

  await t.test("waits longer once the smallest size is refused too", async (t) => {
    useFakeClock(t);
    const ladder = chunkLadder([2, 1]);
    const step = await settle(t, ladder.throttled(0, noSignal()));
    const floor = await settle(t, ladder.throttled(1, noSignal()));
    assert.equal(step.elapsed, 250);
    assert.equal(floor.elapsed, 1000);
  });

  await t.test("never waits past the deadline it is given", async (t) => {
    useFakeClock(t);
    const ladder = chunkLadder([2, 1]);
    const { elapsed } = await settle(t, ladder.throttled(1, noSignal(), 50)); // a 1000 ms floor wait
    assert.equal(elapsed, 50);
  });

  await t.test("an abort cuts the wait short", async (t) => {
    useFakeClock(t);
    const ladder = chunkLadder([2, 1]);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    const { elapsed } = await settle(t, ladder.throttled(1, ctrl.signal)); // the floor wait is 1000 ms
    assert.equal(elapsed, 50);
  });
});

test("measureDownload", async (t) => {
  const { measureDownload } = await loadModule("speedtest.js");

  await t.test("steps 25 -> 10 -> 5 MB on a throttle and keeps measuring there", async (t) => {
    useFakeClock(t);
    const f = stubFetch((_p, size) => (size >= 10_000_000 ? 429 : 200));
    try {
      const { value: mbps } = await settle(t, measureDownload(null, noSignal(), 1000));
      assert.deepEqual(sizesSeen(f.calls, "/__down"), [25_000_000, 10_000_000, 5_000_000]);
      // One throttle, one step: the four streams' 429s at 25 MB move it once.
      assert.equal(countAt(f.calls, "/__down", 25_000_000), 4);
      assert.ok(mbps > 0);
    } finally {
      f.restore();
    }
  });

  await t.test("keeps retrying at 1 MB when every size is refused, and reports null", async (t) => {
    useFakeClock(t);
    const f = stubFetch(() => 429);
    try {
      // Each stream reaches 1 MB at 780 ms, then retries once a second: at
      // 780, 1790 and 2800 ms. A stream that gave up on its first refusal
      // there (the old behaviour) would ask only once; a wait that collapsed
      // to nothing would ask thousands of times.
      const { value: mbps } = await settle(t, measureDownload(null, noSignal(), 3000));
      assert.deepEqual(sizesSeen(f.calls, "/__down"), [25_000_000, 10_000_000, 5_000_000, 1_000_000]);
      assert.equal(countAt(f.calls, "/__down", 1_000_000), 3 * 4);
      assert.equal(mbps, null);
    } finally {
      f.restore();
    }
  });

  await t.test("ends when its window closes, even mid-backoff", async (t) => {
    useFakeClock(t);
    const f = stubFetch(() => 429);
    try {
      // The streams start a 1 s wait at 1 MB at 790 ms; before the deadline
      // cut that wait short, the phase ran on to 1790 ms.
      const { elapsed } = await settle(t, measureDownload(null, noSignal(), 900));
      assert.equal(elapsed, 900);
    } finally {
      f.restore();
    }
  });

  await t.test("reports null, not 0, when downloads fail outright", async (t) => {
    useFakeClock(t);
    const f = stubFetch(() => 503);
    try {
      const { value } = await settle(t, measureDownload(null, noSignal(), 500));
      assert.equal(value, null);
    } finally {
      f.restore();
    }
  });

  await t.test("stops at its data cap, well inside the window, and measures up to it", async (t) => {
    useFakeClock(t);
    const f = stubFetch(() => 200);
    try {
      // Each request answers 64 KB after 10 ms, four streams at once: 1 MB is
      // reached at 40 ms of a 12 s window.
      const cap = 1_000_000;
      const { value: mbps, elapsed } = await settle(t, measureDownload(null, noSignal(), 12_000, cap));
      assert.ok(elapsed <= 50, `phase ran ${elapsed} ms past a 40 ms cap`);
      assert.ok(f.calls.length <= 20, `${f.calls.length} requests; the cap should stop new ones`);
      // 16 chunks of 64 KB in 40 ms, about 210 Mbps: the rate up to the cap.
      assert.ok(mbps > 180 && mbps < 240, `measured ${mbps.toFixed(1)} Mbps`);
    } finally {
      f.restore();
    }
  });

  await t.test("measures from the first byte, so connection setup doesn't read as a slow link", async (t) => {
    useFakeClock(t);
    // Each stream's first request waits 150 ms (connecting, TLS, first byte);
    // after that a 64 KB chunk lands every 10 ms per stream, four streams:
    // 4 × 64 KB / 10 ms ≈ 210 Mbps. The 2.5 MB cap is reached about 100 ms
    // after the first byte. Timed from the phase start, the 150 ms of setup
    // would count too and the link would read about 85 Mbps.
    let calls = 0;
    const f = stubFetch(() => 200, { latency: () => (++calls <= 4 ? 150 : 10) });
    try {
      const { value: mbps } = await settle(t, measureDownload(null, noSignal(), 12_000, 2_500_000));
      const trueMbps = (4 * 65536 * 8) / 0.010 / 1_000_000;
      assert.ok(Math.abs(mbps - trueMbps) / trueMbps < 0.03,
        `measured ${mbps.toFixed(1)} Mbps on a ${trueMbps.toFixed(1)} Mbps link`);
    } finally {
      f.restore();
    }
  });

  await t.test("ends at its deadline when a body stalls, keeping the bytes it read", async (t) => {
    useFakeClock(t);
    const f = stubFetch(() => 200, { stall: true });
    try {
      const { value: mbps, elapsed } = await settle(t, measureDownload(null, noSignal(), 1000));
      assert.equal(elapsed, 1000);
      assert.ok(mbps > 0);
    } finally {
      f.restore();
    }
  });

  await t.test("abandons a stalled body after the per-request timeout", async (t) => {
    useFakeClock(t);
    const f = stubFetch(() => 200, { stall: true });
    try {
      // A window longer than the 20 s request timeout: the timeout, not the
      // deadline, has to end the stalled streams.
      const { elapsed } = await settle(t, measureDownload(null, noSignal(), 60_000));
      assert.equal(elapsed, 20_000);
    } finally {
      f.restore();
    }
  });
});

test("measureUpload", async (t) => {
  const { measureUpload } = await loadModule("speedtest.js");

  await t.test("does not count refused uploads, and ends each stream on an error", async (t) => {
    useFakeClock(t);
    const f = stubFetch(() => 503);
    try {
      const { value } = await settle(t, measureUpload(null, noSignal(), 500));
      assert.equal(value, null);
      assert.equal(f.calls.length, 3); // one per stream
    } finally {
      f.restore();
    }
  });

  await t.test("ends when its window closes, even mid-backoff", async (t) => {
    useFakeClock(t);
    const f = stubFetch(() => 429);
    try {
      // 250 KB is refused at 530 ms, then a 1 s wait would run to 1530.
      const { elapsed } = await settle(t, measureUpload(null, noSignal(), 700));
      assert.equal(elapsed, 700);
    } finally {
      f.restore();
    }
  });

  await t.test("grows to 2 MB, and on a throttle steps back to 1 MB and stays", async (t) => {
    useFakeClock(t);
    const f = stubFetch((_p, size) => (size > 1_000_000 ? 429 : 200));
    try {
      const { value: mbps } = await settle(t, measureUpload(null, noSignal(), 800));
      // Fast replies grow each stream 250 KB → 1 MB → 2 MB; 2 MB is refused.
      assert.deepEqual(sizesSeen(f.calls, "/__up"), [250_000, 1_000_000, 2_000_000]);
      // After the throttle, no stream grows back into the refused size.
      assert.equal(countAt(f.calls, "/__up", 2_000_000), 3);
      assert.ok(mbps > 0);
    } finally {
      f.restore();
    }
  });

  await t.test("measures a slow uplink at its real speed, counting late chunks against their real time", async (t) => {
    useFakeClock(t);
    // A 5 Mbps uplink shared by the three streams: a 2 MB chunk takes 9.6 s.
    // Each stream finishes one chunk inside the 10 s window and a second at
    // 19.2 s. Counting both against a 10 s window reported 9.6 Mbps.
    // A fast link has the same late-chunk effect in miniature, and must not be
    // under-reported by the fix.
    for (const LINK_MBPS of [5, 100]) {
      const perStreamBps = (LINK_MBPS * 1_000_000) / 3;
      const f = stubFetch(() => 200, { latency: (_p, size) => (size * 8) / perStreamBps * 1000 });
      try {
        const { value: mbps } = await settle(t, measureUpload(null, noSignal(), 10_000));
        assert.ok(Math.abs(mbps - LINK_MBPS) / LINK_MBPS < 0.05,
          `measured ${mbps.toFixed(2)} Mbps on a ${LINK_MBPS} Mbps link`);
      } finally {
        f.restore();
      }
    }
  });

  await t.test("starts no upload past its data cap, and measures the chunks it sent", async (t) => {
    useFakeClock(t);
    // A 1 Gbps uplink shared by three streams (a 2 MB chunk takes 48 ms) and a
    // 10 MB cap. Each stream grows from 250 KB to 2 MB, and no chunk starts
    // past the cap: what's sent is at most the cap plus one 2 MB chunk per
    // stream in flight, a dozen uploads rather than hundreds.
    const f = stubFetch(() => 200, { latency: (_p, size) => (size * 8) / (1_000_000_000 / 3) * 1000 });
    try {
      const { value: mbps, elapsed } = await settle(t, measureUpload(null, noSignal(), 10_000, 10_000_000));
      const sent = f.calls.reduce((sum, c) => sum + c.size, 0);
      assert.ok(sent <= 10_000_000 + 3 * 2_000_000, `${sent} bytes sent under a 10 MB cap`);
      assert.ok(f.calls.length < 20, `${f.calls.length} uploads`);
      assert.ok(elapsed < 200, `phase ran ${elapsed} ms of a 10 s window`);
      assert.ok(mbps > 900 && mbps <= 1000, `measured ${mbps.toFixed(1)} Mbps on a 1 Gbps link`);
    } finally {
      f.restore();
    }
  });

  await t.test("doesn't count connection setup as upload time when the data cap ends the phase early", async (t) => {
    useFakeClock(t);
    // The download is timed from its first byte because a capped phase is
    // short, and 100–200 ms of connecting then reads as a slow link. The
    // upload's cap makes its phase just as short: at 1 Gbps the default
    // 100 MB is sent in about 0.8 s. Each stream's first request here waits
    // 150 ms for setup before sending. With no setup this stub reads about
    // 924 Mbps (its lone-last-chunk effect, see above); the setup must not
    // take it much lower.
    let calls = 0;
    const f = stubFetch(() => 200, {
      latency: (_p, size) => (size * 8) / (1_000_000_000 / 3) * 1000 + (++calls <= 3 ? 150 : 0),
    });
    try {
      const { value: mbps } = await settle(t, measureUpload(null, noSignal(), 10_000));
      assert.ok(mbps > 900 && mbps <= 1000, `measured ${mbps.toFixed(1)} Mbps on a 1 Gbps uplink`);
    } finally {
      f.restore();
    }
  });

  await t.test("keeps retrying at 250 KB, once a second, when every upload is refused", async (t) => {
    useFakeClock(t);
    const f = stubFetch(() => 429);
    try {
      // Upload starts at 250 KB, the smallest size, so a refusal there waits
      // a second: each stream asks at 0, 1010 and 2020 ms of a 2.5 s window.
      const { value: mbps } = await settle(t, measureUpload(null, noSignal(), 2500));
      assert.deepEqual(sizesSeen(f.calls, "/__up"), [250_000]);
      assert.equal(countAt(f.calls, "/__up", 250_000), 3 * 3);
      assert.equal(mbps, null);
    } finally {
      f.restore();
    }
  });

  await t.test("measures a weak uplink instead of timing out (1 and 2 Mbps)", async (t) => {
    useFakeClock(t);
    // Starting at 2 MB, a chunk on a 2 Mbps uplink (a third of it per stream)
    // took 24 s, past the 20 s request timeout: every stream gave up and the
    // result was "—". Starting at 250 KB, each chunk takes about 3 s.
    for (const LINK_MBPS of [1, 2]) {
      const perStreamBps = (LINK_MBPS * 1_000_000) / 3;
      const f = stubFetch(() => 200, { latency: (_p, size) => (size * 8) / perStreamBps * 1000 });
      try {
        const { value: mbps } = await settle(t, measureUpload(null, noSignal(), 10_000));
        assert.ok(mbps != null && Math.abs(mbps - LINK_MBPS) / LINK_MBPS < 0.05,
          `measured ${mbps} Mbps on a ${LINK_MBPS} Mbps uplink`);
      } finally {
        f.restore();
      }
    }
  });
});

test("run", async (t) => {
  const { run } = await loadModule("speedtest.js");

  await t.test("with no network reports nulls and flags the failure", async (t) => {
    useFakeClock(t);
    const original = globalThis.fetch;
    globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
    try {
      const { value: res } = await settle(t, run(() => {}));
      assert.equal(res.downMbps, null);
      assert.equal(res.upMbps, null);
      assert.equal(res.ping, null);
      assert.equal(res.jitter, null);
      assert.equal(res.failed, true);
      assert.equal(res.partial, false);
      assert.equal(typeof res.measuredAt, "number");
    } finally {
      globalThis.fetch = original;
    }
  });

  await t.test("ends at the hard cap when every response body stalls", async (t) => {
    useFakeClock(t);
    const f = stubFetch(() => 200, { stall: true });
    try {
      // The latency requests stall one after another, 20 s each, until the
      // 75 s cap aborts the run. Before the fix this run never returned.
      const { value: res, elapsed } = await settle(t, run(() => {}));
      assert.equal(elapsed, 75_000);
      assert.equal(res.partial, true);
      assert.equal(res.failed, true);
      assert.equal(res.ping, null);
    } finally {
      f.restore();
    }
  });
});
