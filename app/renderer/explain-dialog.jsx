// explain-dialog.jsx — "Explain my results": an AI assessment of the scan.
//
// Nothing is sent until the user clicks Explain, and what is sent is main's
// buildAiScan: readings only, nothing that identifies the machine or the
// person. The dialog says so in plain words rather than showing the JSON,
// which means nothing to the people this is for. The answer is labelled as an
// AI assessment that may be wrong; the fact cards stay the source of truth, so
// the app itself still reports facts rather than grading them.

import { React } from "./react-globals.js";
import { Icon, Spinner } from "./icons.jsx";
import { explainFailure } from "./report-messages.js";

const { useState, useEffect } = React;

const SEVERITY = {
  high: { label: "Fix now", className: "ai-sev-high" },
  medium: { label: "Fix soon", className: "ai-sev-medium" },
  low: { label: "Minor", className: "ai-sev-low" },
  ok: { label: "Looks fine", className: "ai-sev-ok" },
};

// `onExplain()` resolves main's result ({ ok, summary, findings, model } or
// { ok: false, reason, … }).
function ExplainDialog({ onExplain, onClose }) {
  const [state, setState] = useState("intro"); // intro | asking | done | failed
  const [result, setResult] = useState(null);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const explain = async () => {
    setState("asking");
    try {
      const res = await onExplain();
      setResult(res);
      setState(res && res.ok ? "done" : "failed");
    } catch (_) {
      setResult(null);
      setState("failed");
    }
  };

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && state !== "asking") onClose(); }}>
      <div className="dialog dialog-wide" role="dialog" aria-modal="true" aria-labelledby="explain-title">
        <div className="dialog-head">
          <div className="hcard-icon"><Icon name="sparkles" size={16} /></div>
          <div id="explain-title" className="dialog-title">Explain my results</div>
          <span className="ai-tag">AI</span>
        </div>

        {state === "intro" && (
          <>
            <p className="dialog-text">
              An AI (Claude, by Anthropic) reads this scan and explains what matters
              most, with a fix to try for each point. Identifying details (the
              computer&apos;s name, your username, network addresses and device
              names) are removed before anything is sent.
            </p>
            <p className="dialog-note">
              The AI can be wrong. The cards on the dashboard show the actual readings.
            </p>
          </>
        )}

        {state === "asking" && (
          <p className="dialog-text ai-asking" role="status"><Spinner size={14} /> Asking the AI…</p>
        )}

        {state === "failed" && (
          <div className="dialog-error" role="alert">{explainFailure(result)}</div>
        )}

        {state === "done" && result && (
          <div className="ai-result">
            <p className="ai-summary">{result.summary}</p>
            {result.findings.length > 0 && (
              <ol className="ai-findings">
                {result.findings.map((f, i) => {
                  const sev = SEVERITY[f.severity] || SEVERITY.low;
                  return (
                    <li key={i} className="ai-finding">
                      <div className="ai-finding-head">
                        <span className={`ai-sev ${sev.className}`}>{sev.label}</span>
                        <span className="ai-finding-title">{f.title}</span>
                      </div>
                      {f.detail && <div className="ai-finding-detail">{f.detail}</div>}
                      {f.fix && <div className="ai-finding-fix"><strong>Try:</strong> {f.fix}</div>}
                    </li>
                  );
                })}
              </ol>
            )}
            <p className="dialog-note">
              AI assessment{result.model ? ` by ${result.model}` : ""}. It can be wrong;
              the dashboard cards show the actual readings.
            </p>
          </div>
        )}

        <div className="dialog-actions">
          <button type="button" className="foot-btn" onClick={onClose} disabled={state === "asking"}>
            {state === "intro" ? "Cancel" : "Close"}
          </button>
          {(state === "intro" || state === "failed") && (
            <button type="button" className="dialog-primary" onClick={explain}>
              <Icon name="sparkles" size={12} /> {state === "failed" ? "Try again" : "Explain"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export { ExplainDialog };
