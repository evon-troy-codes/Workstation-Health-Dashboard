// app.js — Workstation Scanner for Teams: the routes computers use.
// See docs/design/fleet-mode.md.
//
//   GET  /v1/health   → { ok, organization? }   (for Docker's health check)
//   POST /v1/enroll   { enrollmentKey, deviceId, name } → { ok, deviceToken }
//   POST /v1/reports  Authorization: Bearer <deviceToken>,
//                     { schema, appVersion, sentAt, trigger, report } → 202
//
// The same handler runs in the Cloudflare Worker and in the Docker server;
// each passes in its own store (store.js over D1 or node:sqlite) and rate
// limiter. The dashboard's routes come in a later step.

import { json, readJsonObject, bearer } from "./http.js";

const SCHEMA = 1; // the report envelope version this server reads (app/main/fleet.js)
const DEVICE_ID = /^[A-Za-z0-9-]{8,64}$/; // the app sends a random UUID
const MAX_NAME = 100;
const MAX_VERSION = 32;

const text = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

// deps: { store, now: () => Date, rateLimit: async (key) => boolean, ip }
async function handleRequest(request, deps) {
  const { store } = deps;
  const now = deps.now ? deps.now() : new Date();
  const allow = deps.rateLimit || (async () => true);
  const path = new URL(request.url).pathname;

  if (path === "/v1/health") {
    if (request.method !== "GET") return json(405, { ok: false, error: "method-not-allowed" });
    const organization = await store.organization();
    return json(200, organization ? { ok: true, organization } : { ok: true, setUp: false });
  }

  if (path !== "/v1/enroll" && path !== "/v1/reports") return json(404, { ok: false, error: "not-found" });
  if (request.method !== "POST") return json(405, { ok: false, error: "method-not-allowed" });

  if (path === "/v1/enroll") {
    // Per address, so the enrollment key can't be guessed at speed.
    if (!(await allow(`enroll:${deps.ip || "unknown"}`))) return json(429, { ok: false, error: "rate-limited" });
    const { body, error } = await readJsonObject(request);
    if (error) return error;
    if (!(await store.organization())) return json(503, { ok: false, error: "not-set-up" });
    if (!(await store.isEnrollmentKey(body.enrollmentKey))) return json(403, { ok: false, error: "bad-enrollment-key" });
    if (typeof body.deviceId !== "string" || !DEVICE_ID.test(body.deviceId)) return json(400, { ok: false, error: "bad-device-id" });
    const result = await store.enroll({ deviceId: body.deviceId, name: text(body.name, MAX_NAME), now });
    if (result.error === "revoked") return json(403, { ok: false, error: "revoked" });
    return json(200, { ok: true, deviceToken: result.deviceToken });
  }

  // POST /v1/reports. The token is checked before the body is read.
  const device = await store.deviceForToken(bearer(request));
  if (!device) return json(401, { ok: false, error: "unknown-device" });
  if (device.revoked) return json(401, { ok: false, error: "revoked" });
  if (!(await allow(`report:${device.id}`))) return json(429, { ok: false, error: "rate-limited" });
  const { body, error } = await readJsonObject(request);
  if (error) return error;
  if (body.schema !== SCHEMA) return json(422, { ok: false, error: "unsupported-schema" });
  const report = body.report;
  if (!report || typeof report !== "object" || Array.isArray(report)) return json(400, { ok: false, error: "invalid-report" });
  await store.addReport({
    deviceId: device.id,
    schema: SCHEMA,
    appVersion: text(body.appVersion, MAX_VERSION),
    name: text(report.hostname, MAX_NAME),
    // Stored as the server re-serialized it, never the raw text it received.
    body: JSON.stringify(report),
    now,
  });
  return json(202, { ok: true });
}

export { handleRequest, SCHEMA };
