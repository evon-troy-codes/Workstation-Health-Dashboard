// share-dialog.jsx — "Share report": three ways to pass the report on, none
// of which has the app send anything. Email opens the person's own email app
// with the report filled in and no recipient, so they choose who gets it;
// Save writes a page they can attach anywhere; Copy puts the text on the
// clipboard. The report itself is built in main (share.js).

import { React } from "./react-globals.js";
import { Icon, Spinner } from "./icons.jsx";
import { shareFailure } from "./report-messages.js";
import { trapTab, keepFocusInside } from "./dialog-focus.js";

const { useState, useEffect, useRef } = React;

const OPTIONS = [
  { id: "email", icon: "envelope", title: "Email it", text: "Opens your email app with the report filled in. You choose who it goes to." },
  { id: "save", icon: "download", title: "Save as a file", text: "A page you can attach to an email, a support ticket or a chat." },
  { id: "copy", icon: "copy", title: "Copy to clipboard", text: "Paste the report into a message or a form." },
];

// `share(id)` resolves main's result for that way of sharing; `onDone(text)`
// closes the dialog with a confirmation to show.
function ShareDialog({ share, onClose, onDone }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const dialog = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape" && !busy) onClose();
      else trapTab(e, dialog.current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  useEffect(() => {
    keepFocusInside(dialog.current, dialog.current && dialog.current.querySelector(".share-option"));
  }, [busy]);

  const pick = async (id) => {
    setBusy(id);
    setError(null);
    let res;
    try {
      res = await share(id);
    } catch (_) {
      res = null;
    }
    setBusy(null);
    if (res && res.ok) {
      if (id === "email") onDone(res.shortened ? "Opened your email app with a summary. Save the report as a file to attach the full one." : "Opened your email app with the report");
      else if (id === "save") onDone(`Saved ${res.fileName}`);
      else onDone("Report copied. Paste it wherever you need it.");
      return;
    }
    setError(shareFailure(res));
  };

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div ref={dialog} tabIndex={-1} className="dialog" role="dialog" aria-modal="true" aria-labelledby="share-title" aria-describedby="share-note">
        <div className="dialog-head">
          <div className="hcard-icon"><Icon name="share" size={16} /></div>
          <div id="share-title" className="dialog-title">Share this report</div>
        </div>
        <p id="share-note" className="dialog-text">
          The report includes this computer&apos;s name, your username and its IP
          address. Workstation Scanner doesn&apos;t send it anywhere: you choose how
          to share it.
        </p>
        <div className="share-options">
          {OPTIONS.map((o) => (
            <button key={o.id} type="button" className="share-option" disabled={busy != null} onClick={() => pick(o.id)}>
              <span className="share-option-icon">{busy === o.id ? <Spinner size={14} /> : <Icon name={o.icon} size={16} />}</span>
              <span>
                <span className="share-option-title">{o.title}</span>
                <span className="share-option-text">{o.text}</span>
              </span>
            </button>
          ))}
        </div>
        {error && <div className="dialog-error" role="alert">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="foot-btn" onClick={onClose} disabled={busy != null}>Close</button>
        </div>
      </div>
    </div>
  );
}

export { ShareDialog };
