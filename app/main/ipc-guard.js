// ipc-guard.js — whether an IPC message comes from the app's own page.
//
// Kept out of main.js so it can be tested without Electron. It's the check
// every IPC handler runs first, and it has gone wrong before: comparing URLs
// refused every call from an install path holding % or [ ] (CLAUDE.md).

// IPC is answered only for the top frame of a window this process opened on
// its own page. Nothing else should ever load, but if something did (a bug, an
// injected frame, another window) it gets no system facts and cannot send a
// report.
//
// This goes by which window sent the message, not by comparing its URL with
// the index.html path: Chromium re-encodes the URL it loaded (it leaves [ ]
// alone, for one), so a string comparison refused every call from an install
// path holding such characters and the app could never scan. The window cannot
// navigate away (will-navigate is refused), and the file: check still turns
// away anything else loaded into it.
//
// `appContents` is the set of webContents ids main's windows were given.
function fromApp(event, appContents) {
  const frame = event && event.senderFrame;
  if (!frame || frame.parent) return false;
  return Boolean(event.sender && appContents.has(event.sender.id)) && typeof frame.url === "string" && frame.url.startsWith("file:");
}

module.exports = { fromApp };
