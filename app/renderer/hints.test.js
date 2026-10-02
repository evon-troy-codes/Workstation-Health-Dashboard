// Unit tests for the "?" explanations (hints.js). Like report-messages.js it
// is a browser ES module inside a CommonJS package, so it is loaded from a
// data: URL.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const load = () =>
  import("data:text/javascript;base64," +
    Buffer.from(fs.readFileSync(path.join(__dirname, "hints.js"), "utf8")).toString("base64"));

test("HINTS", async (t) => {
  const { HINTS } = await load();

  await t.test("each is a short, finished explanation", () => {
    for (const [key, text] of Object.entries(HINTS)) {
      assert.equal(typeof text, "string", key);
      assert.ok(text.length > 20 && text.length <= 200, `${key} is ${text.length} characters`);
      assert.match(text, /\.$/, `${key} should end with a full stop`);
    }
  });

  await t.test("every hint the screens use is defined", () => {
    const source = fs.readFileSync(path.join(__dirname, "helper-app.jsx"), "utf8");
    const used = new Set([...source.matchAll(/HINTS\.(\w+)/g)].map((m) => m[1]));
    for (const m of source.matchAll(/heroLabel\("(\w+)"/g)) used.add(m[1]);
    assert.ok(used.size >= 15, `only ${used.size} hints found in use`);
    for (const key of used) assert.ok(HINTS[key], `HINTS.${key} is used but not defined`);
  });
});
