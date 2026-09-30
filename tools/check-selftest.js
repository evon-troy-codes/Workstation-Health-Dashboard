// check-selftest.js — CI's check of an installed build's self-test file.
//
//   node tools/check-selftest.js <file> <seconds> <check,check,...>
//
// Waits up to <seconds> for the file an installed app writes when started
// with WHD_SELFTEST_FILE (see main.js), then fails unless it came from a
// packaged build and every named check is true. Prints the file either way.

const fs = require("fs");

const [file, seconds = "60", wanted = ""] = process.argv.slice(2);
if (!file) {
  console.error("usage: node tools/check-selftest.js <file> <seconds> <check,check,...>");
  process.exit(2);
}

const deadline = Date.now() + Number(seconds) * 1000;

function check() {
  let result;
  try {
    result = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    if (Date.now() < deadline) return setTimeout(check, 1000);
    console.error(`::error::no self-test result in ${file} after ${seconds} s: the installed app didn't render and scan`);
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
  const failed = [];
  if (result.packaged !== true) failed.push("packaged");
  for (const name of wanted.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!result.checks || result.checks[name] !== true) failed.push(name);
  }
  if (failed.length) {
    console.error(`::error::the installed app's self-test failed: ${failed.join(", ")}`);
    process.exit(1);
  }
  console.log(`self-test passed (${result.version})`);
}

check();
