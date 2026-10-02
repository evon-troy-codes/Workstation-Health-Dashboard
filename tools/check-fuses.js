// check-fuses.js — CI's check that an installed build's Electron fuses are
// the ones tools/after-pack.js flips.
//
//   node tools/check-fuses.js <installed binary or .app> [--integrity]
//
// --integrity also expects embedded asar integrity validation on (the
// Windows and macOS builds). Exits 1 on any fuse in the wrong state.

const { getCurrentFuseWire, FuseV1Options } = require("@electron/fuses");

// The byte each fuse holds in the binary ('0', '1', 'r'). @electron/fuses
// declares these as FuseState but doesn't export it at runtime.
const FuseState = { DISABLE: 48, ENABLE: 49, REMOVED: 114 };

const [target, flag] = process.argv.slice(2);
if (!target) {
  console.error("usage: node tools/check-fuses.js <installed binary or .app> [--integrity]");
  process.exit(2);
}

const expected = {
  RunAsNode: FuseState.DISABLE,
  EnableNodeOptionsEnvironmentVariable: FuseState.DISABLE,
  EnableNodeCliInspectArguments: FuseState.DISABLE,
  OnlyLoadAppFromAsar: FuseState.ENABLE,
};
if (flag === "--integrity") expected.EnableEmbeddedAsarIntegrityValidation = FuseState.ENABLE;

const name = (state) => (state === FuseState.ENABLE ? "on" : state === FuseState.DISABLE ? "off" : `state ${state}`);

getCurrentFuseWire(target).then((wire) => {
  const wrong = [];
  for (const [fuse, want] of Object.entries(expected)) {
    const got = wire[FuseV1Options[fuse]];
    console.log(`  ${fuse}: ${name(got)}`);
    if (got !== want) wrong.push(`${fuse} is ${name(got)}, expected ${name(want)}`);
  }
  if (wrong.length) {
    console.error(`::error::fuses not as after-pack.js sets them: ${wrong.join("; ")}`);
    process.exit(1);
  }
  console.log("fuses as expected");
}, (err) => {
  console.error(`::error::could not read the fuses of ${target}: ${err.message}`);
  process.exit(1);
});
