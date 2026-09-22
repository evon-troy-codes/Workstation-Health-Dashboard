// after-pack.js — electron-builder hook: ad-hoc sign the macOS app.
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

exports.default = async function afterPack(context) {
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
