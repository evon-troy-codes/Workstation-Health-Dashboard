// checksums.js — SHA-256 checksums of the installers, in `sha256sum` format.
//
// The installers aren't signed, so a checksum is the only way someone can
// check that what they downloaded is what CI built. Each line names the file
// as a GitHub release publishes it: GitHub replaces spaces in asset names
// with dots ("Workstation Scanner-1.4.0.dmg" is downloaded as
// "Workstation.Scanner-1.4.0.dmg"), so `sha256sum -c SHA256SUMS.txt` works
// on the downloaded files as they are.
//
// Run with:  node tools/checksums.js dist > dist/SHA256SUMS.txt

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const INSTALLER = /\.(exe|dmg|AppImage|deb)$/;

// The name a GitHub release gives an uploaded file.
const releaseName = (name) => name.replace(/ /g, ".");

// [{ name, data }] → sha256sum lines, sorted by name, ending in a newline.
function checksumLines(files) {
  return files
    .map(({ name, data }) => `${crypto.createHash("sha256").update(data).digest("hex")}  ${releaseName(name)}`)
    // Byte order, as `sort` and `sha256sum` users expect, not locale order.
    .sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : a.slice(66) > b.slice(66) ? 1 : 0))
    .map((line) => `${line}\n`)
    .join("");
}

function main(dir) {
  const names = fs.readdirSync(dir).filter((n) => INSTALLER.test(n));
  if (!names.length) {
    console.error(`checksums: no installers in ${dir}`);
    process.exit(1);
  }
  process.stdout.write(checksumLines(names.map((name) => ({ name, data: fs.readFileSync(path.join(dir, name)) }))));
}

if (require.main === module) main(process.argv[2] || "dist");

module.exports = { checksumLines, releaseName, INSTALLER };
