// Unit tests for the speed test's 429 handling and result shape, against a
// stubbed fetch. speedtest.js is a browser ES module inside a CommonJS package,
// so it is loaded from a data: URL rather than required. Each phase runs with a
// short window instead of the real 12 s / 10 s.
//
// A data: module cannot resolve relative imports, so this loader only works
// while speedtest.js imports nothing; stack traces show the data URL, not the
// file path.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const loadModule = (file) =>
  import("data:text/javascript;base64," +
    fs.readFileSync(path.join(__dirname, file)).toString("base64"));

// Replaces global fetch. `respond(path, size)` returns the status to answer
// with; a download's 200 carries a 64 KB body, an upload's is empty as the real
// one is. Every call is recorded with the size asked for (the bytes= query on a
// download, the body size on an upload).
function stubFetch(respond) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const size = u.pathname === "/__up" ? init.body.size : Number(u.searchParams.get("bytes"));
    calls.push({ path: u.pathname, size });
    const status = respond(u.pathname, size);
    const body = status === 200 && u.pathname === "/__down" ? new Uint8Array(65536) : null;
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

  await t.test("waits longer once the smallest size is refused too", async () => {
    const ladder = chunkLadder([2, 1]);
    let t0 = performance.now();
    await ladder.throttled(0, noSignal());
    const stepWait = performance.now() - t0;
    t0 = performance.now();
    await ladder.throttled(1, noSignal());
    const floorWait = performance.now() - t0;
    assert.ok(stepWait >= 200 && stepWait < 900, `step wait ${stepWait} ms`);
    assert.ok(floorWait >= 900, `floor wait ${floorWait} ms`);
  });

  await t.test("never waits past the deadline it is given", async () => {
    const ladder = chunkLadder([2, 1]);
    const t0 = performance.now();
    await ladder.throttled(1, noSignal(), t0 + 50); // a 1000 ms floor wait
    assert.ok(performance.now() - t0 < 500);
  });

  await t.test("an abort cuts the wait short", async () => {
    const ladder = chunkLadder([2, 1]);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    const t0 = performance.now();
    await ladder.throttled(1, ctrl.signal);
    assert.ok(performance.now() - t0 < 900); // the floor wait alone is 1000 ms
  });
});

test("measureDownload", async (t) => {
  const { measureDownload } = await loadModule("speedtest.js");

  await t.test("steps 25 -> 10 -> 5 MB on a throttle and keeps measuring there", async () => {
    const f = stubFetch((_p, size) => (size >= 10_000_000 ? 429 : 200));
    try {
      const mbps = await measureDownload(null, noSignal(), 1000);
      assert.deepEqual(sizesSeen(f.calls, "/__down"), [25_000_000, 10_000_000, 5_000_000]);
      // One throttle, one step: the four streams' 429s at 25 MB move it once.
      assert.equal(countAt(f.calls, "/__down", 25_000_000), 4);
      assert.ok(mbps > 0);
    } finally {
      f.restore();
    }
  });

  await t.test("keeps retrying at 1 MB when every size is refused, and reports null", async () => {
    const f = stubFetch(() => 429);
    try {
      // About 750 ms to reach 1 MB, then one retry per second: every stream
      // asks at 1 MB at least twice in this window, with a second to spare. A
      // stream that gave up on its first refusal there (the old behaviour)
      // would ask only once.
      const mbps = await measureDownload(null, noSignal(), 3000);
      assert.deepEqual(sizesSeen(f.calls, "/__down"), [25_000_000, 10_000_000, 5_000_000, 1_000_000]);
      // ...and no more than about three: a wait that collapsed to nothing
      // would send thousands.
      const atFloor = countAt(f.calls, "/__down", 1_000_000);
      assert.ok(atFloor >= 8 && atFloor < 20, `${atFloor} retries at 1 MB`);
      assert.equal(mbps, null);
    } finally {
      f.restore();
    }
  });

  await t.test("ends when its window closes, even mid-backoff", async () => {
    const f = stubFetch(() => 429);
    try {
      // The streams reach 1 MB at about 750 ms and start a 1 s wait; before
      // the deadline cut that wait short, the phase ran on to about 1750 ms.
      const t0 = performance.now();
      await measureDownload(null, noSignal(), 900);
      const elapsed = performance.now() - t0;
      assert.ok(elapsed < 1400, `download phase took ${Math.round(elapsed)} ms for a 900 ms window`);
    } finally {
      f.restore();
    }
  });

  await t.test("reports null, not 0, when downloads fail outright", async () => {
    const f = stubFetch(() => 503);
    try {
      assert.equal(await measureDownload(null, noSignal(), 500), null);
    } finally {
      f.restore();
    }
  });
});

test("measureUpload", async (t) => {
  const { measureUpload } = await loadModule("speedtest.js");

  await t.test("does not count refused uploads, and ends each stream on an error", async () => {
    const f = stubFetch(() => 503);
    try {
      assert.equal(await measureUpload(null, noSignal(), 500), null);
      assert.equal(f.calls.length, 3); // one per stream
    } finally {
      f.restore();
    }
  });

  await t.test("ends when its window closes, even mid-backoff", async () => {
    const f = stubFetch(() => 429);
    try {
      // 250 KB is reached at about 500 ms, then a 1 s wait would run to 1500.
      const t0 = performance.now();
      await measureUpload(null, noSignal(), 700);
      const elapsed = performance.now() - t0;
      assert.ok(elapsed < 1200, `upload phase took ${Math.round(elapsed)} ms for a 700 ms window`);
    } finally {
      f.restore();
    }
  });

  await t.test("steps 2 MB -> 1 MB on a throttle and counts only accepted chunks", async () => {
    const f = stubFetch((_p, size) => (size > 1_000_000 ? 429 : 200));
    try {
      const mbps = await measureUpload(null, noSignal(), 800);
      assert.deepEqual(sizesSeen(f.calls, "/__up"), [2_000_000, 1_000_000]);
      assert.ok(mbps > 0);
    } finally {
      f.restore();
    }
  });

  await t.test("steps down to 250 KB and keeps retrying there when every upload is refused", async () => {
    const f = stubFetch(() => 429);
    try {
      // About 500 ms to reach 250 KB, then one retry per second: each of the
      // three streams asks there at least twice, as the download does at 1 MB.
      const mbps = await measureUpload(null, noSignal(), 2500);
      assert.deepEqual(sizesSeen(f.calls, "/__up"), [2_000_000, 1_000_000, 250_000]);
      const atFloor = countAt(f.calls, "/__up", 250_000);
      assert.ok(atFloor >= 6 && atFloor < 15, `${atFloor} retries at 250 KB`);
      assert.equal(mbps, null);
    } finally {
      f.restore();
    }
  });
});

test("run with no network reports nulls and flags the failure", async () => {
  const { run } = await loadModule("speedtest.js");
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  try {
    const res = await run(() => {});
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
