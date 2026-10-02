// hints.js — the plain-language explanations behind the "?" buttons.
//
// One sentence each, for someone who isn't technical: what the reading is,
// and when it matters. They explain terms; they never judge this machine's
// value (the app reports facts, it doesn't grade them).

export const HINTS = {
  download: "How fast data reaches this computer from the internet, in megabits per second. It matters for streaming, downloads and video calls.",
  upload: "How fast this computer can send data out, in megabits per second. It matters for sending your video on calls and uploading files.",
  ping: "How long a message takes to reach the test server and come back, in milliseconds. Lower feels snappier on calls and in games.",
  jitter: "How much the ping varies from moment to moment. High jitter makes calls choppy even when the speed is fine.",
  connectionType: "Whether this computer reaches the network over a cable, Wi-Fi, or a VPN tunnel. A cable is usually steadier than Wi-Fi.",
  interface: "The network adapter in use, and the speed it connected at. That's the link to your router, not your internet speed.",
  mac: "The network adapter's hardware ID. It stays on this computer and isn't included in reports.",
  mtu: "The largest packet this connection sends at once, in bytes. Almost always 1500; VPNs often use less.",
  ipv4: "This computer's address on your local network, given out by your router.",
  gateway: "The address of your router: the device this computer goes through to reach the internet.",
  dns: "The servers that turn website names into addresses. Usually your router or internet provider.",
  ipv6: "Whether the newer internet address system is switched on for this connection.",
  vpn: "A VPN sends your traffic through another network, often a company's. It can add delay and jitter to calls.",
  backgroundApps: "Apps running now that commonly use a lot of bandwidth or processor time, such as video calls, sync tools and browsers.",
  browserExtensions: "Add-ons installed in Chrome, Edge or Brave. Each can use some memory and processor time.",
  uptime: "How long since this computer last restarted. Restarting now and then finishes updates and clears memory.",
  memoryPressure: "How hard the computer is working to fit open apps into memory. High pressure can make it feel slow.",
  driveType: "SSD drives are much faster than older spinning hard drives (HDD).",
  pendingUpdates: "Operating system updates that are available but not installed yet.",
  refreshRate: "How many times a second the display redraws, in hertz. Higher looks smoother.",
  definitions: "When the antivirus last updated its list of known threats.",
};
