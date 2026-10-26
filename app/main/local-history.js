// Local-only, opt-in history for scan and speed-test trends.

const VERSION = 1;
const MAX_ENTRIES = 100;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function numberOrNull(value, min = 0, max = Number.MAX_VALUE) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object" || typeof entry.recordedAt !== "string") return null;
  const at = Date.parse(entry.recordedAt);
  if (!Number.isFinite(at)) return null;
  if (entry.type === "scan") {
    const normalized = {
      type: "scan",
      recordedAt: new Date(at).toISOString(),
      diskFreeGB: numberOrNull(entry.diskFreeGB),
      diskUsedPercent: numberOrNull(entry.diskUsedPercent, 0, 100),
      pendingUpdates: Number.isInteger(entry.pendingUpdates) && entry.pendingUpdates >= 0
        ? entry.pendingUpdates
        : null,
    };
    return [normalized.diskFreeGB, normalized.diskUsedPercent, normalized.pendingUpdates]
      .some((value) => value != null) ? normalized : null;
  }
  if (entry.type === "speed-test") {
    const normalized = {
      type: "speed-test",
      recordedAt: new Date(at).toISOString(),
      downloadMbps: numberOrNull(entry.downloadMbps),
      uploadMbps: numberOrNull(entry.uploadMbps),
      pingMs: numberOrNull(entry.pingMs),
      jitterMs: numberOrNull(entry.jitterMs),
      partial: entry.partial === true,
    };
    return [normalized.downloadMbps, normalized.uploadMbps, normalized.pingMs, normalized.jitterMs]
      .some((value) => value != null) ? normalized : null;
  }
  return null;
}

function createLocalHistory({ readState, writeState, now = () => new Date() }) {
  function load() {
    const saved = readState();
    const currentTime = now().getTime();
    const entries = saved && saved.version === VERSION && Array.isArray(saved.entries)
      ? saved.entries.map(normalizeEntry).filter(Boolean)
        .filter((entry) => {
          const age = currentTime - Date.parse(entry.recordedAt);
          return age >= 0 && age <= MAX_AGE_MS;
        })
        .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt))
        .slice(-MAX_ENTRIES)
      : [];
    const state = { version: VERSION, enabled: Boolean(saved && saved.enabled === true), entries };
    if (saved && JSON.stringify(saved) !== JSON.stringify(state)) writeState(state);
    return state;
  }

  function save(state) {
    writeState(state);
    return { enabled: state.enabled, entries: state.entries };
  }

  function append(entry) {
    const state = load();
    if (!state.enabled || !entry) return { enabled: state.enabled, entries: state.entries };
    state.entries.push(entry);
    state.entries = state.entries.slice(-MAX_ENTRIES);
    return save(state);
  }

  return {
    get() {
      const state = load();
      return { enabled: state.enabled, entries: state.entries };
    },

    setEnabled(enabled) {
      if (typeof enabled !== "boolean") throw new TypeError("enabled must be a boolean");
      const state = load();
      state.enabled = enabled;
      return save(state);
    },

    clear() {
      const state = load();
      state.entries = [];
      return save(state);
    },

    recordScan({ diskFreeGB, diskUsedPercent, pendingUpdates }) {
      const entry = normalizeEntry({
        type: "scan",
        recordedAt: now().toISOString(),
        diskFreeGB,
        diskUsedPercent,
        pendingUpdates,
      });
      return append(entry);
    },

    recordSpeedTest({ downloadMbps, uploadMbps, ping, jitter, partial }) {
      const entry = normalizeEntry({
        type: "speed-test",
        recordedAt: now().toISOString(),
        downloadMbps,
        uploadMbps,
        pingMs: ping,
        jitterMs: jitter,
        partial,
      });
      return append(entry);
    },
  };
}

module.exports = { createLocalHistory, MAX_AGE_MS, MAX_ENTRIES };
