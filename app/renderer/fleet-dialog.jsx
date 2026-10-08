// fleet-dialog.jsx — "What's sent", for a computer IT manages (Workstation
// Scanner for Teams). In plain words, as the Explain dialog is: what goes to
// the company, where, and when it last went. No JSON: the people reading it
// aren't technical. The list matches buildReport (app/main/report.js).

import { React } from "./react-globals.js";
import { Icon } from "./icons.jsx";
import { fleetResult } from "./report-messages.js";
import { trapTab, keepFocusInside } from "./dialog-focus.js";

const { useEffect, useRef } = React;

const SENT = [
  "This computer's name and your username",
  "Its IP address and network connection (wired or Wi-Fi, speed, VPN)",
  "The operating system and how many updates are waiting",
  "Processor, memory, disk space, battery, sound devices and display",
  "Firewall and antivirus, and whether they're on",
  "Which well-known apps that use the network are running, such as video calls or cloud sync",
  "The latest speed test",
];

const NOT_SENT = "Not sent: the network card's MAC address, the Wi-Fi network's name, and anything in your files, browsing, screen or keystrokes. The app can't collect those.";

// managed: { organization, server }; status: { result, lastSentAt };
// lastSent: how long ago, as a node (the caller's live "ago" label).
function FleetDialog({ managed, status, lastSent, onClose }) {
  const dialog = useRef(null);
  const org = managed.organization;

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      else trapTab(e, dialog.current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    keepFocusInside(dialog.current, dialog.current && dialog.current.querySelector(".foot-btn"));
  }, []);

  const problem = fleetResult(status && status.result, org);

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialog} tabIndex={-1} className="dialog dialog-wide" role="dialog" aria-modal="true" aria-labelledby="fleet-title" aria-describedby="fleet-note">
        <div className="dialog-head">
          <div className="hcard-icon"><Icon name="building" size={16} /></div>
          <div id="fleet-title" className="dialog-title">What&apos;s sent to {org}</div>
        </div>
        <p id="fleet-note" className="dialog-text">
          {org} manages this computer. Each time the app opens, and each time
          you re-scan, these readings go to {org}&apos;s own server, where its
          IT team can see them:
        </p>
        <ul className="dialog-list">
          {SENT.map((s) => <li key={s}>{s}</li>)}
        </ul>
        <p className="dialog-note">{NOT_SENT}</p>
        <dl className="dialog-facts">
          <dt>Sent to</dt><dd>{managed.server}</dd>
          <dt>Last sent</dt><dd>{status && status.lastSentAt ? lastSent : "Not yet"}</dd>
        </dl>
        {problem && <div className="dialog-error" role="status">{problem}</div>}
        <div className="dialog-actions">
          <button type="button" className="foot-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

export { FleetDialog };
