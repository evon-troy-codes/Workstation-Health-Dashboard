// http.js — small helpers shared by the fleet server's routes.

// A body over this is refused. A report is a few kilobytes.
const MAX_BODY_BYTES = 256 * 1024;

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

// JSON only: anything else is refused before the body is read.
const isJson = (request) => /^application\/json\s*(;|$)/i.test(request.headers.get("Content-Type") || "");

// The body as text, or null once it passes `max` bytes: counted as it
// arrives, so a body with no Content-Length (or a false one) isn't read whole
// first, and in bytes, not characters. As in server/report-mailer.
async function readCapped(request, max = MAX_BODY_BYTES) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

// A JSON body as an object, or { error } as the response to send.
async function readJsonObject(request) {
  if (!isJson(request)) return { error: json(415, { ok: false, error: "unsupported-media-type" }) };
  const raw = await readCapped(request);
  if (raw === null) return { error: json(413, { ok: false, error: "too-large" }) };
  let body;
  try {
    body = JSON.parse(raw);
  } catch (_) {
    return { error: json(400, { ok: false, error: "bad-request" }) };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: json(400, { ok: false, error: "bad-request" }) };
  return { body };
}

// "Bearer <token>" → the token, or null.
function bearer(request) {
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get("Authorization") || "");
  return m ? m[1] : null;
}

export { MAX_BODY_BYTES, json, readCapped, readJsonObject, bearer };
