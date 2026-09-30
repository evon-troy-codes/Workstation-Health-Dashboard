// after-pack.js — electron-builder hook: flip Electron's fuses on every
// platform, then ad-hoc sign the macOS app.
//
// Fuses are switches in the Electron binary itself, set at build time, for
// features this app never uses and an attacker could: running the binary as
// plain Node (ELECTRON_RUN_AS_NODE), NODE_OPTIONS, and --inspect debugging
// flags. OnlyLoadAppFromAsar makes it load only the packaged app.asar, not a
// folder dropped next to it. They're flipped here rather than with
// electron-builder's `electronFuses` setting because it flips them *after*
// this hook, which would change the macOS binary after it was signed below
// and bring back "is damaged and can't be opened". Asar integrity checking
// is left off: it stops the app starting if the integrity data is missing,
// and CI never starts the Windows or macOS builds to prove it's there.
//
// electron-builder renames the .app and rewrites its Info.plist after Electron
// signed itself, which invalidates that signature. macOS then refuses a
// downloaded copy outright ("is damaged and can't be opened") rather than
// offering the usual override, and Apple Silicon refuses to run unsigned code
// at all. electron-builder 25 only signs with a real identity from the
// keychain, so with no Apple Developer ID the bundle ships broken.
//
// An ad-hoc signature (`codesign --sign -`) has no identity and proves nothing
// about who built the app, but it makes the bundle internally consistent, so
// macOS runs it after the user allows it in Privacy & Security. Replace this
// with real signing and notarisation once there is a Developer ID.
//
// --deep re-signs the nested helpers without their entitlements, which is
// harmless while nothing here asks for the hardened runtime. If a renderer
// ever dies at launch on Apple Silicon, sign inside-out with an entitlements
// plist instead of reaching for the dmg.

const { execFileSync } = require("child_process");
const path = require("path");

const FUSES = {
  runAsNode: false,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  onlyLoadAppFromAsar: true,
};

exports.default = async function afterPack(context) {
  const { packager } = context;
  await packager.addElectronFuses(context, await packager.generateFuseConfig(FUSES));
  console.log("  • electron fuses flipped (no RunAsNode, NODE_OPTIONS or inspect; asar only)");
  if (context.electronPlatformName !== "darwin") return;
  if (process.platform !== "darwin") {
    throw new Error("the macOS app can only be signed on macOS: codesign is not available here");
  }
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit",
  });
  console.log(`  • ad-hoc signed ${path.basename(appPath)} (no Developer ID yet)`);
};
