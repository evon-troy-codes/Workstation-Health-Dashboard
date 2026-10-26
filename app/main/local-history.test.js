const test = require("node:test");
const assert = require("node:assert/strict");
const { createLocalHistory, MAX_AGE_MS, MAX_ENTRIES } = require("./local-history");

const START = new Date("2026-10-26T12:00:00.000Z");

function history(state = null, getNow = () => START) {
  const saved = { value: state };
  const client = createLocalHistory({
    readState: () => saved.value,
    writeState: (value) => { saved.value = structuredClone(value); },
    now: getNow,
  });
  return { client, saved };
}

test("history is off by default and records only when enabled", () => {
  const { client, saved } = history();
  assert.deepEqual(client.get(), { enabled: false, entries: [] });
  assert.deepEqual(client.recordScan({ diskFreeGB: 50, diskUsedPercent: 50, pendingUpdates: 2 }),
    { enabled: false, entries: [] });
  client.setEnabled(true);
  const result = client.recordScan({ diskFreeGB: 50, diskUsedPercent: 50, pendingUpdates: 2 });
  assert.equal(result.entries.length, 1);
  assert.equal(saved.value.enabled, true);
});

test("scan and speed-test records keep only allowlisted, valid metric values", () => {
  const { client } = history({ version: 1, enabled: true, entries: [] });
  client.recordScan({
    diskFreeGB: 18.5,
    diskUsedPercent: 82,
    pendingUpdates: -1,
    hostname: "must not persist",
  });
  client.recordSpeedTest({ downloadMbps: 120, uploadMbps: null, ping: 8, jitter: 2, partial: true, ip: "private" });
  const { entries } = client.get();
  assert.deepEqual(entries[0], {
    type: "scan",
    recordedAt: START.toISOString(),
    diskFreeGB: 18.5,
    diskUsedPercent: 82,
    pendingUpdates: null,
  });
  assert.deepEqual(entries[1], {
    type: "speed-test",
    recordedAt: START.toISOString(),
    downloadMbps: 120,
    uploadMbps: null,
    pingMs: 8,
    jitterMs: 2,
    partial: true,
  });
  assert.equal(JSON.stringify(entries).includes("hostname"), false);
  assert.equal(JSON.stringify(entries).includes("private"), false);
});

test("history expires entries after 30 days and rejects future entries", () => {
  let now = START;
  const { client } = history({
    version: 1,
    enabled: true,
    entries: [
      { type: "scan", recordedAt: new Date(START.getTime() - MAX_AGE_MS - 1).toISOString() },
      { type: "scan", recordedAt: new Date(START.getTime() + 1).toISOString() },
      { type: "scan", recordedAt: new Date(START.getTime() - MAX_AGE_MS).toISOString(), diskFreeGB: 10 },
    ],
  }, () => now);
  assert.equal(client.get().entries.length, 1);
  now = new Date(START.getTime() + MAX_AGE_MS + 10);
  assert.equal(client.get().entries.length, 0);
});

test("history is capped at the newest 100 entries", () => {
  const entries = Array.from({ length: MAX_ENTRIES + 5 }, (_, index) => ({
    type: "speed-test",
    recordedAt: new Date(START.getTime() - index * 1000).toISOString(),
    downloadMbps: index,
  }));
  const { client } = history({ version: 1, enabled: true, entries });
  const result = client.get().entries;
  assert.equal(result.length, MAX_ENTRIES);
  assert.equal(result.at(-1).downloadMbps, 0);
});

test("turning history off stops new records but clearing preserves the setting", () => {
  const { client } = history({ version: 1, enabled: true, entries: [] });
  client.recordScan({ diskFreeGB: 12, diskUsedPercent: 80, pendingUpdates: 1 });
  client.setEnabled(false);
  assert.equal(client.recordScan({ diskFreeGB: 11 }).entries.length, 1);
  assert.deepEqual(client.clear(), { enabled: false, entries: [] });
});

test("malformed entries are ignored and invalid enable values are rejected", () => {
  const { client } = history({
    version: 1,
    enabled: true,
    entries: [
      null,
      { type: "other" },
      { type: "scan", recordedAt: "bad" },
      { type: "scan", recordedAt: START.toISOString() },
    ],
  });
  assert.deepEqual(client.get(), { enabled: true, entries: [] });
  assert.throws(() => client.setEnabled("yes"), /boolean/);
});
