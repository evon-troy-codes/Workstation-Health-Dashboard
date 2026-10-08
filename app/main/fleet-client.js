// fleet-client.js — Workstation Scanner for Teams: enrolling this computer
// with the company's fleet server and sending it reports. See
// docs/design/fleet-mode.md, "Enrollment and authentication".
//
//   1. Enroll once: POST /v1/enroll { enrollmentKey, deviceId, name } → a
//      device token. The device ID is random, made here, and kept.
//   2. Report: POST /v1/reports with the token, one per launch or Re-scan.
//
// The token is kept in the app's user data folder, encrypted with the OS
// keychain (Electron's safeStorage) where there is one. A Linux desktop with
// no keychain gets a file only this user can read instead: the token can
// only send reports for this computer, and IT can revoke it.
//
// Nothing is queued: a report that couldn't be sent is dropped, and the next
// launch or Re-scan sends a fresh one. The server stamps each report with
// the time it arrives, so an old one sent later would show at the wrong time.
//
// Electron, the network and the disk are passed in, so all of this is tested
// without them.

const STATE_VERSION = 1;
const TIMEOUT_MS = 20000;

// What a send ended as, for the "What's sent" dialog:
//   sent        the server has it
//   removed     IT removed this computer from the dashboard (revoked)
//   key-refused the server refused the enrollment key
//   not-set-up  the fleet server isn't set up yet
//   failed      anything else: offline, a timeout, the server's error
function classify(res, body) {
  const error = body && typeof body.error === "string" ? body.error : null;
  if (error === "revoked") return "removed";
  if (error === "bad-enrollment-key") return "key-refused";
  if (error === "not-set-up") return "not-set-up";
  return "failed";
}

async function readBody(res) {
  try {
    return await res.json();
  } catch (_) {
    return null;
  }
}

// deps: {
//   settings      normalizeSettings's "on" result
//   readState()   → the saved state object, or null
//   writeState(o) saves it (0600)
//   keychain      { available: boolean, encrypt(text) → base64, decrypt(base64) → text }
//   fetchImpl, randomUUID, hostname, now: () → Date
// }
function createFleetClient(deps) {
  const { settings } = deps;
  const now = deps.now || (() => new Date());
  const fetchImpl = deps.fetchImpl || fetch;
  let last = { result: null, at: null, sentAt: null };
  let chain = Promise.resolve();

  const endpoint = (p) => new URL(p, settings.fleetUrl).href;

  // The saved state for this fleet server. A different server (IT moved it)
  // means a new enrollment, under the same device ID.
  function loadState() {
    let s = null;
    try {
      s = deps.readState();
    } catch (_) {
      s = null;
    }
    const deviceId = s && typeof s.deviceId === "string" && /^[A-Za-z0-9-]{8,64}$/.test(s.deviceId) ? s.deviceId : deps.randomUUID();
    const same = s && s.fleetUrl === settings.fleetUrl;
    return {
      version: STATE_VERSION,
      deviceId,
      fleetUrl: settings.fleetUrl,
      token: same && s.token && typeof s.token === "object" ? s.token : null,
      lastSentAt: same && typeof s.lastSentAt === "string" ? s.lastSentAt : null,
    };
  }

  function saveState(state) {
    try {
      deps.writeState(state);
    } catch (_) {
      // Not fatal: the next launch enrolls again, which the server allows.
    }
  }

  function tokenOf(state) {
    const t = state.token;
    if (!t || typeof t.value !== "string") return null;
    if (t.kind === "file") return t.value;
    if (t.kind === "keychain" && deps.keychain.available) {
      try {
        return deps.keychain.decrypt(t.value);
      } catch (_) {
        return null; // the keychain changed; enroll again
      }
    }
    return null;
  }

  function storeToken(state, token) {
    if (deps.keychain.available) {
      try {
        state.token = { kind: "keychain", value: deps.keychain.encrypt(token) };
        return;
      } catch (_) {
        /* fall through to the file */
      }
    }
    state.token = { kind: "file", value: token };
  }

  async function post(p, body, token) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetchImpl(endpoint(p), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    });
    return { res, body: await readBody(res) };
  }

  // → a token, or { result } when enrolling failed.
  async function enroll(state) {
    const { res, body } = await post("v1/enroll", {
      enrollmentKey: settings.enrollmentKey,
      deviceId: state.deviceId,
      name: deps.hostname(),
    });
    if (res.ok && body && typeof body.deviceToken === "string" && body.deviceToken) {
      storeToken(state, body.deviceToken);
      saveState(state);
      return body.deviceToken;
    }
    return { result: classify(res, body) };
  }

  async function sendNow(envelope) {
    const state = loadState();
    let token = tokenOf(state);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!token) {
        const got = await enroll(state);
        if (typeof got !== "string") return got.result;
        token = got;
      }
      const { res, body } = await post("v1/reports", envelope, token);
      if (res.ok) {
        state.lastSentAt = now().toISOString();
        saveState(state);
        return "sent";
      }
      // The server doesn't know the token (its data was reset, or the token
      // was replaced): enroll again, once.
      if (res.status === 401 && body && body.error === "unknown-device" && attempt === 0) {
        state.token = null;
        token = null;
        continue;
      }
      return classify(res, body);
    }
    return "failed";
  }

  return {
    // Sends one report (fleet.js's envelope). Sends run one at a time.
    // Resolves the result; never rejects.
    send(envelope) {
      const run = chain.then(() => sendNow(envelope)).catch(() => "failed").then((result) => {
        last = { result, at: now().toISOString(), sentAt: result === "sent" ? now().toISOString() : last.sentAt };
        return result;
      });
      chain = run;
      return run;
    },

    // For the "What's sent" dialog: the last result this session, and when
    // a report last reached the server (this session or an earlier one).
    status() {
      let saved = null;
      try {
        saved = loadState().lastSentAt;
      } catch (_) {
        saved = null;
      }
      return { result: last.result, lastSentAt: last.sentAt || saved };
    },
  };
}

module.exports = { createFleetClient, classify };
