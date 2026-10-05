// Unit tests for POST /explain, run by the repo's `npm test`. The Anthropic API
// is a stubbed fetch, so nothing is sent and nothing is billed.
import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "./index.js";
import { sanitizeScan, shapeAnswer, DEFAULT_MODEL } from "./explain.js";
import { budgetBinding } from "./budget.test.js";

// A scan as the app sends it: already stripped of identifying fields. Any it
// did carry (as in `leaky` below) must still never reach the model.
const scan = {
  machineType: "Dell Inc. Dell Pro 14 Plus PB14250",
  uptime: "3 days, 2 hours",
  os: { name: "Debian GNU/Linux", version: "13", pendingUpdates: 2, lastUpdateCheck: "41 min ago", lastUpdateKind: "checked" },
  cpu: { model: "Intel Core Ultra 5 236V", cores: 8, threads: 8, ghz: 4.7 },
  ram: { totalGB: 16, freeGB: 1.2, pressure: "High", type: "LPDDR5" },
  disk: { totalGB: 262, freeGB: 12, usedPercent: 95, ssd: true },
  display: { monitors: [{ builtin: false, main: true, resolution: "5120 × 1440", refreshRate: "120 Hz" }] },
  network: { type: "Wireless", isWired: false, isVirtual: false, linkSpeed: "Unknown" },
  vpn: { detected: false },
  bandwidth: { downMbps: 607, upMbps: 37, ping: 46, jitter: 51.7 },
  antivirus: { products: [] },
  power: { hasBattery: true, batteryLevel: 80, onBattery: false },
  audio: { headsetClass: "USB headset" },
  backgroundApps: { runningApps: ["Zoom", "Chrome"], browserExtensions: 6 },
};

const leaky = {
  ...scan,
  hostname: "EVONS-LAPTOP", user: "evon",
  network: { ...scan.network, mac: "aa:bb:cc:dd:ee:ff", ipv4: "192.168.1.138", gateway: "192.168.1.1",
    dns: ["192.168.1.1"], ssid: "Evon's Wi-Fi", interface: "wlp0s20f3" },
  audio: { ...scan.audio, output: "Evon's AirPods", input: "Evon's AirPods" },
  display: { monitors: [{ ...scan.display.monitors[0], name: "Evon's monitor", connection: "DP-7" }] },
};

const answer = {
  summary: "Mostly healthy, but the disk is nearly full and memory is under pressure.",
  findings: [
    { severity: "high", title: "Disk almost full", detail: "Only 12 GB of 262 GB is free (95% used).", fix: "Empty the trash and remove large files you no longer need." },
    { severity: "medium", title: "Jittery Wi-Fi", detail: "Jitter of 51.7 ms can make video calls choppy.", fix: "Use a wired connection or move closer to the router." },
  ],
};

// The Anthropic Messages API, stubbed: records each request and answers with
// `reply(body)` (a message object), or a status + error body, or (with
// `unreachable`) fails to connect.
function anthropic({ reply = () => message(JSON.stringify(answer)), status = 200, errorType = "api_error", errorMessage = "stub", unreachable = false } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    const headers = Object.fromEntries(new Headers(init.headers));
    calls.push({ url: String(url), body, headers });
    if (unreachable) throw new TypeError("fetch failed");
    if (status !== 200) {
      return new Response(JSON.stringify({ type: "error", error: { type: errorType, message: errorMessage } }),
        { status, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(reply(body)), { status: 200, headers: { "content-type": "application/json" } });
  };
  fn.calls = calls;
  return fn;
}

const message = (text, stop_reason = "end_turn") => ({
  id: "msg_stub", type: "message", role: "assistant", model: DEFAULT_MODEL,
  content: [{ type: "text", text }], stop_reason, stop_sequence: null,
  usage: { input_tokens: 900, output_tokens: 200 },
});

const env = (over = {}) => ({ ANTHROPIC_API_KEY: "sk-ant-test", ...over });

const post = (body, path = "/explain") =>
  new Request(`https://mailer.example.workers.dev${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.7" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const answerOf = async (res) => ({ status: res.status, body: await res.json() });

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

test("POST /explain", async (t) => {
  await t.test("asks Claude with the scan and returns its assessment", async () => {
    const api = anthropic();
    const res = await answerOf(await handleRequest(post({ scan }), env(), api));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, ...answer, model: DEFAULT_MODEL });
    assert.equal(api.calls.length, 1);
    const { url, body, headers } = api.calls[0];
    assert.match(url, /^https:\/\/api\.anthropic\.com\/v1\/messages/);
    assert.equal(headers["x-api-key"], "sk-ant-test");
    assert.equal(body.model, "claude-opus-5-5");
    assert.equal(body.fallbacks, "default");
    assert.match(headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
    assert.equal(body.output_config.effort, "medium");
    assert.equal(body.output_config.format.type, "json_schema");
    assert.ok(body.max_tokens >= 4000);
  });

  await t.test("takes the model and effort from the Worker's settings", async () => {
    const api = anthropic();
    await handleRequest(post({ scan }), env({ AI_MODEL: "claude-haiku-4-5", AI_EFFORT: "low" }), api);
    assert.equal(api.calls[0].body.model, "claude-haiku-4-5");
    assert.equal(api.calls[0].body.output_config.effort, "low");
  });

  await t.test("never sends identifying fields to the model, even if the app did", async () => {
    const api = anthropic();
    await handleRequest(post({ scan: leaky }), env(), api);
    const sent = JSON.stringify(api.calls[0].body.messages);
    for (const secret of ["EVONS-LAPTOP", "evon", "aa:bb:cc", "192.168.1", "Evon's", "wlp0s20f3", "DP-7"]) {
      assert.ok(!sent.includes(secret), `the model saw ${secret}`);
    }
    // ...while the readings it needs are there.
    for (const reading of ["Intel Core Ultra 5 236V", "95", "51.7", "5120 × 1440", "USB headset"]) {
      assert.ok(sent.includes(reading), `the model didn't see ${reading}`);
    }
  });

  await t.test("refuses a missing or malformed scan without calling the model", async () => {
    const api = anthropic();
    for (const body of [{}, { scan: null }, { scan: "text" }, { scan: [1] }]) {
      assert.deepEqual(await answerOf(await handleRequest(post(body), env(), api)),
        { status: 400, body: { ok: false, error: "invalid-scan" } });
    }
    assert.equal(api.calls.length, 0);
  });

  await t.test("says so when the Worker has no API key", async () => {
    const api = anthropic();
    assert.deepEqual(await answerOf(await handleRequest(post({ scan }), env({ ANTHROPIC_API_KEY: "" }), api)),
      { status: 500, body: { ok: false, error: "not-configured" } });
    assert.equal(api.calls.length, 0);
  });

  await t.test("rate-limits per client IP, apart from the email quota", async () => {
    const e = env({ RATE_LIMITER: limiter(2) });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await handleRequest(post({ scan }), e, anthropic())).status);
    assert.deepEqual(statuses, [200, 200, 429]);
    assert.ok(e.RATE_LIMITER.keys.has("ai:198.51.100.7"));
    assert.ok(![...e.RATE_LIMITER.keys.keys()].some((k) => k.startsWith("ip:")));
  });

  await t.test("stops calling Claude once the AI budget is spent", async () => {
    const api = anthropic();
    const e = env({ AI_BUDGET: budgetBinding(), AI_DAILY_LIMIT: "2" });
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await answerOf(await handleRequest(post({ scan }), e, api)));
    assert.deepEqual(results.map((r) => r.status), [200, 200, 429]);
    assert.deepEqual(results[2].body, { ok: false, error: "ai-daily-limit" });
    assert.equal(api.calls.length, 2);
    const monthly = env({ AI_BUDGET: budgetBinding(), AI_MONTHLY_LIMIT: "1" });
    await handleRequest(post({ scan }), monthly, api);
    assert.deepEqual(await answerOf(await handleRequest(post({ scan }), monthly, api)),
      { status: 429, body: { ok: false, error: "ai-monthly-limit" } });
  });

  await t.test("refuses rather than calls Claude when the budget can't be checked", async () => {
    const api = anthropic();
    const AI_BUDGET = { idFromName: (n) => n, get: () => ({ fetch: async () => { throw new Error("overloaded"); } }) };
    assert.deepEqual(await answerOf(await handleRequest(post({ scan }), env({ AI_BUDGET }), api)),
      { status: 503, body: { ok: false, error: "ai-busy" } });
    assert.equal(api.calls.length, 0);
  });

  await t.test("checks the per-IP limit before spending from the budget", async () => {
    const e = env({ RATE_LIMITER: limiter(1), AI_BUDGET: budgetBinding(), AI_DAILY_LIMIT: "5" });
    for (let i = 0; i < 3; i++) await handleRequest(post({ scan }), e, anthropic());
    assert.equal(e.AI_BUDGET.store.get("usage").monthCount, 1);
  });

  await t.test("says the AI is unavailable, not 'try again', when the credit has run out", async () => {
    for (const api of [
      anthropic({ status: 402, errorType: "billing_error", errorMessage: "billing" }),
      anthropic({ status: 400, errorType: "invalid_request_error", errorMessage: "Your credit balance is too low to access the Anthropic API." }),
    ]) {
      assert.deepEqual(await answerOf(await handleRequest(post({ scan }), env(), api)),
        { status: 503, body: { ok: false, error: "ai-unavailable" } });
    }
  });

  await t.test("gives the budget back when Claude was never reached", async () => {
    const cases = [
      [env({ ANTHROPIC_API_KEY: "" }), anthropic(), "not-configured"],
      [env(), anthropic({ unreachable: true }), "ai-unreachable"],
      [env(), anthropic({ status: 402, errorType: "billing_error" }), "ai-unavailable"],
      [env(), anthropic({ status: 429, errorType: "rate_limit_error" }), "ai-busy"],
      [env(), anthropic({ status: 500 }), "ai-failed"],
    ];
    for (const [e, api, error] of cases) {
      const AI_BUDGET = budgetBinding();
      const res = await answerOf(await handleRequest(post({ scan }), { ...e, AI_BUDGET, AI_DAILY_LIMIT: "1" }, api));
      assert.equal(res.body.error, error);
      assert.equal(AI_BUDGET.store.get("usage").dayCount, 0, `${error} should not use up the budget`);
      assert.equal(AI_BUDGET.store.get("usage").monthCount, 0);
    }
  });

  await t.test("keeps the budget spent when Claude answered, even with an unusable answer", async () => {
    for (const reply of [() => message(JSON.stringify(answer)), () => message("", "refusal"), () => message("not json")]) {
      const AI_BUDGET = budgetBinding();
      await handleRequest(post({ scan }), env({ AI_BUDGET }), anthropic({ reply }));
      assert.equal(AI_BUDGET.store.get("usage").dayCount, 1);
    }
  });

  await t.test("makes one attempt, with no retry that could outlast the app's wait", async () => {
    const api = anthropic({ status: 529, errorType: "overloaded_error" });
    await handleRequest(post({ scan }), env(), api);
    assert.equal(api.calls.length, 1);
  });

  await t.test("reports a refusal, a cut-off answer and a malformed answer as errors", async () => {
    const cases = [
      [() => message("", "refusal"), "ai-refused"],
      [() => message('{"summary": "cut', "max_tokens"), "ai-incomplete"],
      [() => message("not json"), "ai-bad-answer"],
      [() => message(JSON.stringify({ summary: "", findings: [] })), "ai-bad-answer"],
    ];
    for (const [reply, error] of cases) {
      assert.deepEqual(await answerOf(await handleRequest(post({ scan }), env(), anthropic({ reply }))),
        { status: 502, body: { ok: false, error } });
    }
  });

  await t.test("turns API errors into plain reasons", async () => {
    assert.deepEqual(await answerOf(await handleRequest(post({ scan }), env(), anthropic({ status: 401 }))),
      { status: 500, body: { ok: false, error: "not-configured" } });
    assert.equal((await answerOf(await handleRequest(post({ scan }), env(), anthropic({ status: 400 })))).body.error, "ai-failed");
  });

  await t.test("the old email route answers 410 and calls no one", async () => {
    const api = anthropic();
    const res = await answerOf(await handleRequest(post({ scan }, "/"), env(), api));
    assert.deepEqual(res, { status: 410, body: { ok: false, error: "email-removed" } });
    assert.equal(api.calls.length, 0);
  });
});

test("sanitizeScan and shapeAnswer", async (t) => {
  await t.test("caps strings and lists, and drops junk values", () => {
    const s = sanitizeScan({ cpu: { model: "x".repeat(500), cores: "8" }, backgroundApps: { runningApps: Array(50).fill("App") } });
    assert.equal(s.cpu.model.length, 120);
    assert.equal(s.cpu.cores, null);
    assert.equal(s.backgroundApps.running.length, 20);
    assert.deepEqual(sanitizeScan(null).displays, []);
  });

  await t.test("passes 'nothing to report' antivirus on as null, and 'none found' as an empty list", () => {
    assert.equal(sanitizeScan({ antivirus: null }).antivirus, null);
    assert.equal(sanitizeScan({}).antivirus, null);
    assert.deepEqual(sanitizeScan({ antivirus: { products: [] } }).antivirus, []);
    assert.equal(sanitizeScan({ antivirus: { products: [], checked: false } }).antivirus, null);
    // A firewall list, empty or not, is a reading; no firewall (an older
    // app) or a failed check is not measured.
    assert.deepEqual(sanitizeScan({ firewall: { products: [{ name: "UFW", active: true, detail: null, path: "/etc/ufw" }] } }).firewall,
      [{ name: "UFW", active: true, detail: null }]);
    assert.deepEqual(sanitizeScan({ firewall: { products: [] } }).firewall, []);
    assert.equal(sanitizeScan({}).firewall, null);
    assert.equal(sanitizeScan({ firewall: { checked: false, products: [] } }).firewall, null);
    assert.equal(sanitizeScan({ firewall: { products: [{ name: "x", active: "yes" }] } }).firewall[0].active, null);
  });

  await t.test("sends the CPU speed with its kind, and no speed rather than 0", () => {
    assert.deepEqual(sanitizeScan({ cpu: { ghz: 4.7, ghzKind: "max" } }).cpu,
      { model: null, cores: null, threads: null, ghz: 4.7, ghzKind: "max" });
    assert.deepEqual(sanitizeScan({ cpu: { ghz: 0, ghzKind: "turbo" } }).cpu,
      { model: null, cores: null, threads: null, ghz: null, ghzKind: null });
  });

  await t.test("keeps at most five well-formed findings", () => {
    const shaped = shapeAnswer({
      summary: "  OK  ",
      findings: [
        ...Array(7).fill({ severity: "low", title: "t", detail: "d", fix: "f" }),
        { severity: "urgent", title: "bad severity", detail: "", fix: "" },
      ],
    });
    assert.equal(shaped.summary, "OK");
    assert.equal(shaped.findings.length, 5);
    assert.ok(shaped.findings.every((f) => f.severity === "low"));
  });
});
