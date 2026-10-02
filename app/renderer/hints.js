// hints.js — the plain-language explanations behind the "?" buttons.
//
// One sentence each, for someone who isn't technical: what the reading is,
// and when it matters. Only for terms most people don't know: a "?" on every
// label (download, upload…) was noise, so the owner cut them to these. They explain terms; they never judge this machine's
// value (the app reports facts, it doesn't grade them).

export const HINTS = {
  ping: "How long a message takes to reach the test server and come back, in milliseconds. Lower feels snappier on calls and in games.",
  jitter: "How much the ping varies from moment to moment. High jitter makes calls choppy even when the speed is fine.",
  interface: "The network adapter in use, and the speed it connected at. That's the link to your router, not your internet speed.",
  mtu: "The largest packet this connection sends at once, in bytes. Almost always 1500; VPNs often use less.",
  gateway: "The address of your router: the device this computer goes through to reach the internet.",
  dns: "The servers that turn website names into addresses. Usually your router or internet provider.",
  uptime: "How long since this computer last restarted. Restarting now and then finishes updates and clears memory.",
  memoryPressure: "How hard the computer is working to fit open apps into memory. High pressure can make it feel slow.",
  driveType: "SSD drives are much faster than older spinning hard drives (HDD).",
  pendingUpdates: "Operating system updates that are available but not installed yet.",
};
