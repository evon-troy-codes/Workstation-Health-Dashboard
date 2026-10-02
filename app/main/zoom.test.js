// Unit tests for the zoom shortcuts (zoom.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { zoomFor, readZoom, saveZoom, MIN, MAX } = require("./zoom");

const key = (k, mods = {}) => ({ type: "keyDown", key: k, control: true, ...mods });

test("zoomFor", async (t) => {
  await t.test("Ctrl with + (or =), - and 0", () => {
    assert.equal(zoomFor(key("="), 0), 0.5);
    assert.equal(zoomFor(key("+"), 0.5), 1);
    assert.equal(zoomFor(key("-"), 0), -0.5);
    assert.equal(zoomFor(key("0"), 2), 0);
  });
  await t.test("Cmd on a Mac", () => {
    assert.equal(zoomFor({ type: "keyDown", key: "=", meta: true }, 0), 0.5);
  });
  await t.test("stays within its limits", () => {
    assert.equal(zoomFor(key("="), MAX), MAX);
    assert.equal(zoomFor(key("-"), MIN), MIN);
  });
  await t.test("anything else isn't a zoom", () => {
    for (const input of [key("a"), { type: "keyDown", key: "=" }, key("=", { type: "keyUp" }), key("=", { alt: true }), null]) {
      assert.equal(zoomFor(input, 0), null);
    }
  });
});

test("readZoom and saveZoom", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whd-zoom-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await t.test("nothing saved yet reads 100% (0)", () => {
    assert.equal(readZoom(dir), 0);
  });
  await t.test("remembers a level", () => {
    saveZoom(dir, 1.5);
    assert.equal(readZoom(dir), 1.5);
  });
  await t.test("a damaged or out-of-range file reads safely", () => {
    fs.writeFileSync(path.join(dir, "zoom.json"), "{not json");
    assert.equal(readZoom(dir), 0);
    fs.writeFileSync(path.join(dir, "zoom.json"), JSON.stringify({ level: 99 }));
    assert.equal(readZoom(dir), MAX);
  });
});
