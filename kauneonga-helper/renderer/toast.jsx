/* global React */
// Toast.jsx — tiny global toast listener.
// Any button can dispatch:  window.dispatchEvent(new CustomEvent("liberty-toast", {detail: "..."}))
// and a single floating toast will pop. Self-dismisses after 2.5s.

function Toast() {
  const [msg, setMsg] = React.useState(null);
  React.useEffect(() => {
    const onToast = (e) => {
      setMsg(e.detail);
      window.clearTimeout(window.__toastTimer);
      window.__toastTimer = window.setTimeout(() => setMsg(null), 2500);
    };
    window.addEventListener("liberty-toast", onToast);
    return () => window.removeEventListener("liberty-toast", onToast);
  }, []);
  if (!msg) return null;
  return (
    <div style={{
      position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
      background: "#18222d", color: "#fff",
      padding: "10px 18px", borderRadius: 999,
      fontSize: 13, fontWeight: 600, fontFamily: "var(--font-sans)",
      boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
      zIndex: 9999,
      animation: "liberty-toast-in 200ms ease",
    }}>{msg}</div>
  );
}
window.LibertyToast = Toast;
