// Every file the main process loads must be in the installers. package.json's
// build.files lists them one by one, so a new module that isn't added there
// works from source and in every test, then crashes the installed app on
// start (as app/main/ipc-guard.js would have, 2026-10-06).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const files = require(path.join(ROOT, "package.json")).build.files;

// Local requires of a file, as repo-relative paths.
function localRequires(file) {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  return [...src.matchAll(/require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)]
    .map((m) => path.relative(ROOT, require.resolve(path.join(ROOT, path.dirname(file), m[1]))))
    .filter((f) => !f.includes("node_modules") && !f.endsWith(".json"));
}

test("every module main.js loads, directly or through another, is packaged", () => {
  const seen = new Set();
  const queue = ["main.js", "app/preload.js"];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    queue.push(...localRequires(f));
  }
  const missing = [...seen].filter((f) => !files.includes(f.split(path.sep).join("/")));
  assert.deepEqual(missing, [], `not in package.json build.files: ${missing.join(", ")}`);
});
