// node-server.js — Workstation Scanner for Teams as a plain Node 24 server,
// for the Docker image (and anyone running it without Cloudflare).
//
// Settings, from the environment:
//   PORT          port to listen on (default 8080)
//   FLEET_DB      SQLite database file (default /data/fleet.db)
//   ADMIN_TOKEN   enables the admin routes; without it they're off
//   TRUST_PROXY   "1" to take the client address from X-Forwarded-For, when
//                 a reverse proxy you control sits in front
//   DEMO          "1" for the public demo: made-up computers, read-only
//
// It serves plain HTTP: put it behind HTTPS (the company's reverse proxy or
// load balancer), as the README describes.

import http from "node:http";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { handleRequest } from "./app.js";
import { createStore } from "./store.js";
import { nodeSql } from "./sql.js";
import { ensureDemo } from "./demo.js";

const DAY_MS = 86400000;

// A fixed-window limiter in memory: `limit` calls per key per `windowMs`.
// One server process, so memory is enough.
function memoryRateLimiter({ limit = 30, windowMs = 60000, now = () => Date.now() } = {}) {
  const hits = new Map();
  return async (key) => {
    const t = now();
    const entry = hits.get(key);
    if (!entry || t - entry.start >= windowMs) {
      hits.set(key, { start: t, count: 1 });
      if (hits.size > 10000) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}

// The client's address: the socket's, or, behind a trusted proxy, the first
// address in X-Forwarded-For.
function clientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || "unknown";
}

// Node's request → a Fetch Request, so the shared handler can read it.
function toRequest(req) {
  const url = `http://${req.headers.host || "localhost"}${req.url}`;
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, {
    method: req.method,
    headers: Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]])),
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: hasBody ? "half" : undefined,
  });
}

async function send(res, response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

// Opens the database, creates the tables, and returns an HTTP server (not
// yet listening) plus a close() for tests and shutdown.
async function createServer({ dbPath = ":memory:", adminToken = "", trustProxy = false, rateLimit = memoryRateLimiter(), demo = false } = {}) {
  const db = new DatabaseSync(dbPath);
  const sql = nodeSql(db);
  const store = createStore(sql);
  await store.migrate();
  const server = http.createServer(async (req, res) => {
    try {
      if (demo) await ensureDemo(sql, store, new Date());
      await send(res, await handleRequest(toRequest(req), { store, rateLimit, ip: clientIp(req, trustProxy), adminToken, demo }));
    } catch (_) {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: false, error: "server-error" }));
    }
  });
  const prune = () => store.prune(new Date()).catch(() => {});
  const timer = setInterval(prune, DAY_MS);
  timer.unref();
  return {
    server,
    store,
    close: () => new Promise((resolve) => {
      clearInterval(timer);
      server.close(() => {
        db.close();
        resolve();
      });
    }),
  };
}

// Run directly: `node src/node-server.js`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 8080);
  const { server, store, close } = await createServer({
    dbPath: process.env.FLEET_DB || "/data/fleet.db",
    adminToken: process.env.ADMIN_TOKEN || "",
    trustProxy: process.env.TRUST_PROXY === "1",
    demo: process.env.DEMO === "1",
  });
  await store.prune(new Date());
  server.listen(port, () => console.log(`Workstation Scanner for Teams listening on port ${port}`));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => close().then(() => process.exit(0)));
}

export { createServer, memoryRateLimiter, clientIp };
