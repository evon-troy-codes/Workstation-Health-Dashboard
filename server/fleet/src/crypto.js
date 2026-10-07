// crypto.js — tokens and hashes, with Web Crypto (the same in Workers and
// Node 24).

// A random secret, base64url, 32 bytes (256 bits) by default.
function randomSecret(prefix = "", bytes = 32) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  const text = btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${prefix}${text}`;
}

// SHA-256 of a string, as hex. Tokens and keys are stored only this way, and
// compared by hash, so a lookup never compares the secrets themselves.
async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export { randomSecret, sha256 };
