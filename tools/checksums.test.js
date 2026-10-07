// Unit tests for tools/checksums.js, run by the repo's `npm test`.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { checksumLines, releaseName, INSTALLER } = require("./checksums");

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

test("checksumLines", async (t) => {
  await t.test("sha256sum format: hash, two spaces, name; sorted by name", () => {
    const out = checksumLines([
      { name: "workstation-scanner_1.4.0_amd64.deb", data: Buffer.from("deb") },
      { name: "Workstation Scanner Setup 1.4.0.exe", data: Buffer.from("exe") },
    ]);
    assert.equal(out,
      `${sha("exe")}  Workstation.Scanner.Setup.1.4.0.exe\n` +
      `${sha("deb")}  workstation-scanner_1.4.0_amd64.deb\n`);
  });

  await t.test("names files as a GitHub release does, spaces as dots", () => {
    assert.equal(releaseName("Workstation Scanner-1.4.0-arm64.dmg"), "Workstation.Scanner-1.4.0-arm64.dmg");
    assert.equal(releaseName("workstation-scanner_1.4.0_amd64.deb"), "workstation-scanner_1.4.0_amd64.deb");
  });
});

test("only installers are listed", () => {
  for (const n of ["a.exe", "a.dmg", "a.AppImage", "a.deb"]) assert.ok(INSTALLER.test(n), n);
  for (const n of ["a.blockmap", "latest.yml", "builder-debug.yml", "a.exe.blockmap", "SHA256SUMS.txt"]) assert.ok(!INSTALLER.test(n), n);
});
