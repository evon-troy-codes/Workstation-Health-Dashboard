// Unit tests for the Worker's routing (index.js), run by the repo's
// `npm test`. /explain itself is tested in explain.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest, MAX_BODY_BYTES } from "./index.js";

const post = (path, body, headers = {}) =>
  new Request(`https://mailer.example.workers.dev${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.7", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const answer = async (res) => ({ status: res.status, body: await res.json() });

// A fetch that fails the test if anything tries to reach the network.
const noNetwork = async (url) => {
  throw new Error(`unexpected request to ${url}`);
};

test("handleRequest", async (t) => {
  await t.test("the old email route is gone, and sends nothing", async () => {
    const res = await answer(await handleRequest(post("/", { email: "sam@example.com", report: { hostname: "x" } }), { RESEND_API_KEY: "re_test", FROM_ADDRESS: "a@b.co" }, noNetwork));
    assert.deepEqual(res, { status: 410, body: { ok: false, error: "email-removed" } });
  });

  await t.test("refuses anything but POST", async () => {
    const res = await handleRequest(new Request("https://m.example/explain", { method: "GET" }), {}, noNetwork);
    assert.equal(res.status, 405);
  });

  await t.test("answers 404 for any other path", async () => {
    assert.equal((await handleRequest(post("/send", {}), {}, noNetwork)).status, 404);
  });

  await t.test("refuses a body over the size limit before parsing it", async () => {
    const big = "x".repeat(MAX_BODY_BYTES + 1);
    assert.equal((await handleRequest(post("/explain", big), {}, noNetwork)).status, 413);
    const declared = post("/explain", "{}", { "Content-Length": String(MAX_BODY_BYTES + 1) });
    assert.equal((await handleRequest(declared, {}, noNetwork)).status, 413);
  });

  await t.test("refuses broken JSON and a missing scan", async () => {
    assert.deepEqual(await answer(await handleRequest(post("/explain", "{not json"), {}, noNetwork)), { status: 400, body: { ok: false, error: "bad-request" } });
    assert.deepEqual(await answer(await handleRequest(post("/explain", { scan: [] }), {}, noNetwork)), { status: 400, body: { ok: false, error: "invalid-scan" } });
  });
});
