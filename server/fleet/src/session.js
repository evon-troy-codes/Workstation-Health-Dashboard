// session.js — the dashboard's sign-in cookie.
//
// The dashboard always needs signing in, with the company's admin token, so
// its data is never public, even if no SSO was put in front. (Cloudflare
// Access or a company SSO proxy in front is still recommended, as a second
// layer.) The cookie holds only an expiry time and an HMAC of it; the HMAC
// key comes from the admin token, so changing the token signs everyone out.

const COOKIE = "wst_session";
const SESSION_MS = 12 * 3600000; // 12 hours

const enc = new TextEncoder();

async function hmacKey(adminToken) {
  return crypto.subtle.importKey("raw", enc.encode(`workstation-scanner-teams-session:${adminToken}`),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

const toHex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (hex) => (/^[0-9a-f]{64}$/.test(hex) ? new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16))) : null);

// A new session cookie's value, valid for SESSION_MS from now.
async function createSession(adminToken, now = new Date()) {
  const expires = String(now.getTime() + SESSION_MS);
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(adminToken), enc.encode(expires));
  return `${expires}.${toHex(sig)}`;
}

// Whether a cookie value is a valid, unexpired session. crypto.subtle.verify
// compares in constant time.
async function isValidSession(value, adminToken, now = new Date()) {
  if (!adminToken || typeof value !== "string") return false;
  const m = /^(\d{13})\.([0-9a-f]{64})$/.exec(value);
  if (!m || Number(m[1]) <= now.getTime()) return false;
  return crypto.subtle.verify("HMAC", await hmacKey(adminToken), fromHex(m[2]), enc.encode(m[1]));
}

// The session cookie from a request's Cookie header, or null.
function sessionFrom(request) {
  const cookies = (request.headers.get("Cookie") || "").split(";").map((c) => c.trim());
  const found = cookies.find((c) => c.startsWith(`${COOKIE}=`));
  return found ? found.slice(COOKIE.length + 1) : null;
}

// Set-Cookie for a session: not readable by scripts, sent only over HTTPS
// (and to localhost), and never on a request from another site.
const sessionCookie = (value) => `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`;
const clearedCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

export { COOKIE, SESSION_MS, createSession, isValidSession, sessionFrom, sessionCookie, clearedCookie };
