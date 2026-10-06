// limits.js — the request size cap, in its own module so tests can import it.
// The Worker's main module may only export handlers (workerd rejects a plain
// number as an entry point, so `wrangler dev` refused to start).

const MAX_BODY_BYTES = 256 * 1024;

export { MAX_BODY_BYTES };
