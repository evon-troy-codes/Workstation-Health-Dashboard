// store.js — the fleet server's data, written once against sql.js's
// interface, so the Cloudflare (D1) and Docker (node:sqlite) servers share it.

import { SCHEMA } from "./schema.js";
import { randomSecret, sha256 } from "./crypto.js";

const DEFAULT_RETENTION_DAYS = 90;

function createStore(sql) {
  const setting = async (key) => {
    const row = await sql.first("SELECT value FROM settings WHERE key = ?", [key]);
    return row ? row.value : null;
  };
  const setSetting = (key, value) =>
    sql.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, String(value)]);

  return {
    // Creates the tables if they aren't there.
    async migrate() {
      for (const statement of SCHEMA) await sql.run(statement);
    },

    // First-time setup: the organization's name and a new enrollment key.
    // The key is returned once, in the clear, and only its hash is kept.
    // Refused if already set up, so it can't silently replace a key computers
    // are using; rotateEnrollmentKey does that on purpose.
    async setUp({ organization }) {
      if (await setting("enrollment_key_hash")) return { error: "already-set-up" };
      const name = String(organization || "").trim().slice(0, 100);
      if (!name) return { error: "organization-required" };
      const enrollmentKey = randomSecret("ek_");
      await setSetting("organization", name);
      await setSetting("enrollment_key_hash", await sha256(enrollmentKey));
      await setSetting("retention_days", DEFAULT_RETENTION_DAYS);
      return { enrollmentKey };
    },

    // A new enrollment key; the old one stops working for new enrollments.
    // Computers already enrolled keep their tokens.
    async rotateEnrollmentKey() {
      if (!(await setting("enrollment_key_hash"))) return { error: "not-set-up" };
      const enrollmentKey = randomSecret("ek_");
      await setSetting("enrollment_key_hash", await sha256(enrollmentKey));
      return { enrollmentKey };
    },

    async organization() {
      return setting("organization");
    },

    // Whether this is the current enrollment key. Compared by hash.
    async isEnrollmentKey(key) {
      const stored = await setting("enrollment_key_hash");
      return Boolean(stored && typeof key === "string" && key && (await sha256(key)) === stored);
    },

    // Enrolls a computer, or re-enrolls it (a reinstall), with a new token.
    // A revoked computer stays revoked: IT removed it, and the enrollment key
    // alone mustn't bring it back. → { deviceToken } or { error: "revoked" }.
    async enroll({ deviceId, name, now }) {
      const existing = await sql.first("SELECT revoked FROM devices WHERE id = ?", [deviceId]);
      if (existing && existing.revoked) return { error: "revoked" };
      const deviceToken = randomSecret("dt_");
      const tokenHash = await sha256(deviceToken);
      if (existing) {
        await sql.run("UPDATE devices SET token_hash = ?, name = ? WHERE id = ?", [tokenHash, name, deviceId]);
      } else {
        await sql.run("INSERT INTO devices (id, token_hash, name, grp, enrolled_at) VALUES (?, ?, ?, '', ?)",
          [deviceId, tokenHash, name, now.toISOString()]);
      }
      return { deviceToken };
    },

    // The computer a token belongs to, or null.
    async deviceForToken(token) {
      if (typeof token !== "string" || !token) return null;
      return sql.first("SELECT id, name, revoked FROM devices WHERE token_hash = ?", [await sha256(token)]);
    },

    // Keeps a report, and updates the computer's name, version and last seen.
    async addReport({ deviceId, schema, appVersion, name, body, now }) {
      const at = now.toISOString();
      await sql.run("INSERT INTO reports (device_id, received_at, schema, app_version, body) VALUES (?, ?, ?, ?, ?)",
        [deviceId, at, schema, appVersion, body]);
      await sql.run("UPDATE devices SET last_seen = ?, app_version = ?, name = COALESCE(?, name) WHERE id = ?",
        [at, appVersion, name, deviceId]);
    },
  };
}

export { createStore, DEFAULT_RETENTION_DAYS };
