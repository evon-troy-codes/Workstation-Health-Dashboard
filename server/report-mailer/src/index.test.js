// Unit tests for the report-mailer Worker, run by the repo's `npm test`.
// Resend is a stubbed fetch and the rate limiter a stand-in, so nothing leaves
// the machine.
import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest, renderEmail, normalizeEmail, recipientAllowed, base64, MAX_BODY_BYTES } from "./index.js";

const report = {
  hostname: "WORKSTATION-01",
  user: "demo.user",
  cpu: { model: "Intel Core Ultra 5 236V", cores: 8, threads: 8 },
  ram: { totalGB: 16, freeGB: 8.1, pressure: "Normal" },
  disk: { totalGB: 262, freeGB: 225, usedPercent: 9 },
  display: { count: 2, resolution: "2560 × 1440", external: true, externalSize: '27"', externalConnection: "DP" },
  os: { name: "Debian GNU/Linux", version: "13", pendingUpdates: 1, lastUpdateCheck: "10 min ago", lastUpdateKind: "checked" },
  network: { type: "Wireless", interface: "wlp0s20f3", linkSpeed: "Unknown", ipv4: "203.0.113.42", gateway: "203.0.113.1", dns: ["203.0.113.1"] },
  bandwidth: { downMbps: 587, upMbps: 40, ping: 58, jitter: 51.7 },
  vpn: { detected: false, name: null },
  antivirus: { products: [{ name: "ClamAV", running: true, definitionsAge: "2 hours" }] },
  power: { hasBattery: true, batteryLevel: 80, plugged: true },
  audio: { output: "Headphones", input: "Microphone", headsetClass: "Built-in" },
  backgroundApps: { runningApps: ["VS Code", "Chrome"], browserExtensions: 6 },
};

const env = (over = {}) => ({
  RESEND_API_KEY: "re_test",
  FROM_ADDRESS: "Workstation Scanner <reports@example.com>",
  ALLOWED_DOMAINS: "",
  ...over,
});

// Resend stand-in: records each send and answers with `status`.
function resend(status = 200) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: "email_1" }), { status });
  };
  fn.calls = calls;
  return fn;
}

// A limiter that allows `n` calls per key.
function limiter(n) {
  const seen = new Map();
  return {
    keys: seen,
    async limit({ key }) {
      seen.set(key, (seen.get(key) || 0) + 1);
      return { success: seen.get(key) <= n };
    },
  };
}

const post = (body, headers = {}) =>
  new Request("https://mailer.example.workers.dev/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.7", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const answer = async (res) => ({ status: res.status, body: await res.json() });

test("handleRequest", async (t) => {
  await t.test("emails the report to the address given, through Resend", async () => {
    const send = resend();
    const res = await answer(await handleRequest(post({ email: " sam@example.com ", report }), env(), send));
    assert.deepEqual(res, { status: 200, body: { ok: true } });
    assert.equal(send.calls.length, 1);
    const { url, init, body } = send.calls[0];
    assert.equal(url, "https://api.resend.com/emails");
    assert.equal(init.headers.Authorization, "Bearer re_test");
    assert.deepEqual(body.to, ["sam@example.com"]);
    assert.equal(body.from, "Workstation Scanner <reports@example.com>");
    assert.equal(body.subject, "Workstation report: WORKSTATION-01");
    assert.match(body.attachments[0].filename, /^workstation-report-WORKSTATION-01-\d{4}-\d{2}-\d{2}\.json$/);
    // The attachment is the full report, intact.
    const attached = JSON.parse(Buffer.from(body.attachments[0].content, "base64").toString("utf8"));
    assert.deepEqual(attached, report);
  });

  await t.test("refuses anything but POST", async () => {
    const res = await handleRequest(new Request("https://m.example/", { method: "GET" }), env(), resend());
    assert.equal(res.status, 405);
  });

  await t.test("refuses a bad address, a missing report and broken JSON without sending", async () => {
    const send = resend();
    for (const [body, error] of [
      [{ email: "not-an-address", report }, "invalid-email"],
      [{ email: "a b@example.com", report }, "invalid-email"],
      [{ email: `${"a".repeat(250)}@example.com`, report }, "invalid-email"],
      [{ report }, "invalid-email"],
      [{ email: "sam@example.com" }, "invalid-report"],
      [{ email: "sam@example.com", report: ["x"] }, "invalid-report"],
      [{ email: "sam@example.com", report: { user: "no hostname" } }, "invalid-report"],
      ["{not json", "bad-request"],
    ]) {
      assert.deepEqual(await answer(await handleRequest(post(body), env(), send)), { status: 400, body: { ok: false, error } });
    }
    assert.equal(send.calls.length, 0);
  });

  await t.test("refuses a body over the size limit before parsing it", async () => {
    const send = resend();
    const big = JSON.stringify({ email: "sam@example.com", report: { hostname: "x", pad: "y".repeat(MAX_BODY_BYTES) } });
    assert.equal((await handleRequest(post(big), env(), send)).status, 413);
    assert.equal(send.calls.length, 0);
  });

  await t.test("sends only to allowed domains when a list is set", async () => {
    const send = resend();
    const e = env({ ALLOWED_DOMAINS: "example.com, Example.org" });
    assert.equal((await handleRequest(post({ email: "sam@example.org", report }), e, send)).status, 200);
    assert.deepEqual(await answer(await handleRequest(post({ email: "sam@evil.test", report }), e, send)),
      { status: 403, body: { ok: false, error: "recipient-not-allowed" } });
    assert.equal(send.calls.length, 1);
  });

  await t.test("rate-limits per client IP", async () => {
    const send = resend();
    const e = env({ RATE_LIMITER: limiter(2) });
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await handleRequest(post({ email: `user${i}@example.com`, report }), e, send)).status);
    }
    assert.deepEqual(statuses, [200, 200, 429]);
    assert.equal(send.calls.length, 2);
  });

  await t.test("rate-limits per recipient across many clients", async () => {
    const send = resend();
    const e = env({ RATE_LIMITER: limiter(2) });
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      const req = post({ email: "Sam@Example.com", report }, { "CF-Connecting-IP": `198.51.100.${i}` });
      statuses.push((await handleRequest(req, e, send)).status);
    }
    assert.deepEqual(statuses, [200, 200, 429]);
    assert.ok(e.RATE_LIMITER.keys.has("to:sam@example.com"));
  });

  await t.test("says so when the Worker is missing its key or sender", async () => {
    const send = resend();
    for (const e of [env({ RESEND_API_KEY: "" }), env({ FROM_ADDRESS: "" })]) {
      assert.deepEqual(await answer(await handleRequest(post({ email: "sam@example.com", report }), e, send)),
        { status: 500, body: { ok: false, error: "not-configured" } });
    }
    assert.equal(send.calls.length, 0);
  });

  await t.test("reports a Resend failure as send-failed", async () => {
    const res = await answer(await handleRequest(post({ email: "sam@example.com", report }), env(), resend(422)));
    assert.deepEqual(res, { status: 502, body: { ok: false, error: "send-failed", status: 422 } });
  });
});

test("renderEmail", async (t) => {
  await t.test("lays out the report's facts in both HTML and text", () => {
    const { subject, html, text } = renderEmail(report, new Date("2026-09-23T18:00:00Z"));
    assert.equal(subject, "Workstation report: WORKSTATION-01");
    // The inch mark is escaped in the HTML, as every report value is.
    assert.ok(text.includes('Display: 2560 × 1440, external 27" DP'));
    assert.ok(html.includes("2560 × 1440, external 27&quot; DP"));
    for (const s of ["Intel Core Ultra 5 236V", "587 Mbps", "ClamAV", "Active · definitions 2 hours", "80% · plugged in", "VS Code, Chrome"]) {
      assert.ok(text.includes(s), `text is missing ${s}`);
      assert.ok(html.includes(s), `html is missing ${s}`);
    }
    assert.ok(text.includes("2026-09-23 18:00 UTC"));
  });

  await t.test("escapes report values, so a hostname can't inject markup", () => {
    const { html, subject } = renderEmail({ hostname: "<img src=x onerror=alert(1)>", user: "a&b" });
    assert.ok(!html.includes("<img"));
    assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
    assert.ok(html.includes("a&amp;b"));
    assert.equal(subject, "Workstation report: <img src=x onerror=alert(1)>"); // subjects are plain text
  });

  await t.test("caps long values and lists, so the email can't carry a payload", () => {
    const { text } = renderEmail({
      hostname: "h".repeat(5000),
      network: { dns: Array.from({ length: 50 }, (_, i) => `10.0.0.${i}`) },
    });
    assert.ok(!text.includes("h".repeat(201)));
    assert.ok(text.includes("10.0.0.19, …"));
    assert.ok(!text.includes("10.0.0.20"));
  });

  await t.test("copes with missing and malformed sections", () => {
    const { text } = renderEmail({ hostname: "x", cpu: "nonsense", antivirus: { products: "no" }, power: {} });
    assert.ok(text.includes("CPU: —"));
    assert.ok(text.includes("Antivirus: None detected"));
    assert.ok(text.includes("Power: No battery"));
  });
});

test("helpers", async (t) => {
  await t.test("normalizeEmail trims and validates", () => {
    assert.equal(normalizeEmail("  sam@example.com "), "sam@example.com");
    for (const bad of ["", "sam", "sam@", "@example.com", "sam@example", "sam @example.com", null, 42]) {
      assert.equal(normalizeEmail(bad), null, String(bad));
    }
  });

  await t.test("recipientAllowed compares domains without case, and allows any when unset", () => {
    assert.equal(recipientAllowed("sam@EXAMPLE.com", { ALLOWED_DOMAINS: "example.com" }), true);
    assert.equal(recipientAllowed("sam@sub.example.com", { ALLOWED_DOMAINS: "example.com" }), false);
    assert.equal(recipientAllowed("sam@anything.test", {}), true);
  });

  await t.test("base64 round-trips UTF-8 and large input", () => {
    const s = "Core™ Ultra — ünï ".repeat(20000);
    assert.equal(Buffer.from(base64(s), "base64").toString("utf8"), s);
  });
});
