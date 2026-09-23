// report-dialog.jsx — asks where to email the report, then sends it.
//
// Opened by the footer's Send report button. The address is checked here for
// a quick answer, and again in main, which is what actually sends it. A failed
// send keeps the dialog open with the reason, so the address can be fixed
// without typing it again.

import { React } from "./react-globals.js";
import { Icon, Spinner } from "./icons.jsx";
import { isEmail, reportFailure } from "./report-messages.js";

const { useState, useEffect, useRef } = React;

// The last address used, so a second report doesn't need it typed again. A
// convenience only: the dialog works the same if storage is unavailable.
const STORAGE_KEY = "whd.reportEmail";
const readSaved = () => {
  try {
    return window.localStorage.getItem(STORAGE_KEY) || "";
  } catch (_) {
    return "";
  }
};
const save = (email) => {
  try {
    window.localStorage.setItem(STORAGE_KEY, email);
  } catch (_) {
    /* not remembered, which is fine */
  }
};

// `enabled`: whether this build has a report endpoint (null while asking).
// `onSend(email)` resolves to main's result; `onSent(email)` runs on success.
function ReportDialog({ enabled, onClose, onSend, onSent }) {
  const [email, setEmail] = useState(readSaved);
  const [error, setError] = useState(null);
  const [sending, setSending] = useState(false);
  const input = useRef(null);

  useEffect(() => {
    if (input.current) input.current.focus();
    const onKey = (e) => {
      if (e.key === "Escape" && !sending) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, sending]);

  const submit = async (e) => {
    e.preventDefault();
    if (!isEmail(email)) {
      setError("Enter a valid email address, like name@example.com.");
      return;
    }
    setError(null);
    setSending(true);
    try {
      const res = await onSend(email.trim());
      if (res && res.ok && !res.skipped) {
        save(email.trim());
        onSent(email.trim());
        return;
      }
      setError(res && res.skipped ? "Emailing reports isn't set up in this build." : reportFailure(res));
    } catch (_) {
      setError("Report failed");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !sending) onClose(); }}>
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="report-dialog-title" onSubmit={submit} noValidate>
        <div className="dialog-head">
          <div className="hcard-icon"><Icon name="envelope" size={16} /></div>
          <div id="report-dialog-title" className="dialog-title">Email this report</div>
        </div>

        {enabled === false ? (
          <p className="dialog-text">
            Emailing reports isn&apos;t set up in this build: it has no report
            service configured. See the README&apos;s &ldquo;Emailing
            reports&rdquo; section.
          </p>
        ) : (
          <>
            <label className="dialog-label" htmlFor="report-email">Email address</label>
            <input
              id="report-email"
              ref={input}
              className="dialog-input"
              type="email"
              inputMode="email"
              autoComplete="email"
              spellCheck={false}
              placeholder="name@example.com"
              value={email}
              disabled={sending}
              aria-invalid={error ? "true" : undefined}
              aria-describedby="report-dialog-note"
              onChange={(e) => { setEmail(e.target.value); setError(null); }}
            />
            {error && <div className="dialog-error" role="alert">{error}</div>}
            <p id="report-dialog-note" className="dialog-note">
              The report includes this computer&apos;s name, your username, and its
              IP and MAC addresses. It is sent to the report service, which
              emails it to this address.
            </p>
          </>
        )}

        <div className="dialog-actions">
          <button type="button" className="foot-btn" onClick={onClose} disabled={sending}>
            {enabled === false ? "Close" : "Cancel"}
          </button>
          {enabled !== false && (
            <button type="submit" className="dialog-primary" disabled={sending || enabled == null}>
              {sending ? <><Spinner size={12} /> Sending…</> : <><Icon name="envelope" size={12} /> Send report</>}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

export { ReportDialog };
