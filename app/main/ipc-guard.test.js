// Unit tests for the IPC sender check (ipc-guard.js), run by `npm test`.
const test = require("node:test");
const assert = require("node:assert/strict");
const { fromApp } = require("./ipc-guard");

const app = new Set([7]);
const event = (id, url, parent = null) => ({ sender: { id }, senderFrame: { url, parent } });

test("fromApp", async (t) => {
  await t.test("the app window's top frame on its own file: page is accepted", () => {
    assert.equal(fromApp(event(7, "file:///opt/Workstation%20Scanner/resources/app.asar/app/renderer/index.html"), app), true);
  });

  // The decision CLAUDE.md records: Chromium re-encodes file URLs, and a URL
  // comparison refused every call from such an install path.
  await t.test("an install path with %, [ ] or spaces is still accepted", () => {
    for (const url of ["file:///C:/Users/sam/100%25%20done/app/index.html", "file:///home/sam/apps[1]/index.html", "file:///C:/Program Files/x/index.html"]) {
      assert.equal(fromApp(event(7, url), app), true, url);
    }
  });

  await t.test("a frame inside the page is refused", () => {
    assert.equal(fromApp(event(7, "file:///opt/x/index.html", { url: "file:///opt/x/index.html" }), app), false);
  });

  await t.test("a window the app didn't open is refused", () => {
    assert.equal(fromApp(event(8, "file:///opt/x/index.html"), app), false);
  });

  await t.test("the app window showing anything but a file: page is refused", () => {
    for (const url of ["https://evil.example/", "data:text/html,<p>x", "about:blank", "javascript:alert(1)"]) {
      assert.equal(fromApp(event(7, url), app), false, url);
    }
  });

  await t.test("a missing sender or frame is refused, never a crash", () => {
    assert.equal(fromApp({ sender: { id: 7 } }, app), false);
    assert.equal(fromApp({ sender: { id: 7 }, senderFrame: { url: null, parent: null } }, app), false);
    assert.equal(fromApp({}, app), false);
    assert.equal(fromApp(null, app), false);
  });
});
