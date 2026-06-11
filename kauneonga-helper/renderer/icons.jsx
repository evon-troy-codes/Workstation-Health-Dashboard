/* global React */
// Icon.jsx — minimal inline-SVG icon set (avoids relying on an external icon CDN).
// Path data adapted from Phosphor-style/Heroicons-style 24×24 strokes.

const ICONS = {
  cloud: <path d="M17 18a4 4 0 0 0 .6-7.95A6 6 0 0 0 7.4 8.5 4 4 0 0 0 7 16.5"/>,
  house: <path d="M3 12 12 3l9 9M5 10v10h14V10"/>,
  comment: <path d="M21 12a8 8 0 1 1-3.05-6.29L21 4l-1.06 3.7A8 8 0 0 1 21 12Z"/>,
  envelope: <path d="M3 7l9 6 9-6M3 7v10h18V7M3 7l9 6 9-6"/>,
  bell: <path d="M6 19h12l-1.6-2A8 8 0 0 0 18 11a6 6 0 0 0-12 0c0 2.3-.5 4.4-1.4 6L6 19zm6 2a2 2 0 0 0 2-2H10a2 2 0 0 0 2 2z"/>,
  phone: <path d="M5 4h3l2 5-2 1a11 11 0 0 0 6 6l1-2 5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>,
  "phone-slash": <><path d="M5 4h3l2 5-2 1a11 11 0 0 0 6 6l1-2 5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/><path d="M4 4l16 16"/></>,
  pause: <><path d="M9 5v14M15 5v14"/></>,
  forward: <path d="M5 5l7 7-7 7M13 5l7 7-7 7"/>,
  grip: <><circle cx="6" cy="6" r="1.4"/><circle cx="12" cy="6" r="1.4"/><circle cx="18" cy="6" r="1.4"/><circle cx="6" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18" cy="12" r="1.4"/><circle cx="6" cy="18" r="1.4"/><circle cx="12" cy="18" r="1.4"/><circle cx="18" cy="18" r="1.4"/></>,
  users: <><circle cx="9" cy="9" r="3.5"/><path d="M3 20a6 6 0 0 1 12 0M16 11a3 3 0 1 0 0-6M16 11a3 3 0 0 0 0-6M14 19h7a4 4 0 0 0-3-4"/></>,
  microphone: <><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v4"/></>,
  "microphone-slash": <><path d="M9 9V6a3 3 0 0 1 6 0v6"/><path d="M5 10a7 7 0 0 0 11 5"/><path d="M3 3l18 18"/></>,
  "volume-high": <><path d="M3 9v6h4l5 4V5L7 9H3z"/><path d="M16 8a5 5 0 0 1 0 8M19 5a8 8 0 0 1 0 14"/></>,
  play: <path d="M7 4v16l13-8L7 4z"/>,
  check: <path d="M5 12l5 5L20 7"/>,
  "circle-check": <><circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/></>,
  "circle-xmark": <><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></>,
  "circle-info": <><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 8h.01"/></>,
  "triangle-exclamation": <><path d="M12 4l10 17H2L12 4z"/><path d="M12 10v5M12 18h.01"/></>,
  xmark: <path d="M6 6l12 12M18 6L6 18"/>,
  "angle-down": <path d="M6 9l6 6 6-6"/>,
  "angle-up": <path d="M6 15l6-6 6 6"/>,
  "arrow-right": <path d="M5 12h14M13 5l7 7-7 7"/>,
  "arrow-rotate-right": <><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></>,
  "circle-notch": <path d="M21 12a9 9 0 1 1-9-9"/>,
  "circle-question": <><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.5-2.5 2-2.5 3.5M12 17h.01"/></>,
  "list-check": <><path d="M9 6h12M9 12h12M9 18h12"/><path d="M3 6l1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17"/></>,
  award: <><circle cx="12" cy="9" r="6"/><path d="M8.5 14l-1.5 7 5-3 5 3-1.5-7"/></>,
  briefcase: <><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></>,
  building: <><rect x="4" y="3" width="16" height="18" rx="1"/><path d="M9 7h.01M15 7h.01M9 11h.01M15 11h.01M9 15h.01M15 15h.01M9 19h6"/></>,
  cog: <><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.1l2-1.6-2-3.4-2.4.9a7 7 0 0 0-1.9-1.1L14 3h-4l-.6 2.7a7 7 0 0 0-1.9 1.1L5.1 6 3 9.4l2 1.6a7 7 0 0 0 0 2L3 14.6 5.1 18l2.4-.9a7 7 0 0 0 1.9 1.1L10 21h4l.6-2.7a7 7 0 0 0 1.9-1.1L19 18l2-3.4-2-1.6c.1-.4.1-.7.1-1.1z"/></>,
  radar: <><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 3v18M3 12h18"/></>,
  book: <path d="M4 4h6a4 4 0 0 1 4 4v12M20 4h-6a4 4 0 0 0-4 4M4 4v14h6a4 4 0 0 1 4 4M20 4v14h-6a4 4 0 0 0-4 4"/>,
  "up-right-from-square": <><path d="M15 3h6v6"/><path d="M21 3l-9 9"/><path d="M9 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></>,
  "up-right-and-down-left-from-center": <><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></>,
  "fullscreen": <><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></>,
  "magnifying-glass": <><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></>,
  "paper-plane": <><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></>,
  pen: <><path d="M4 20h4l11-11-4-4L4 16v4z"/><path d="M14 6l4 4"/></>,
  pencil: <><path d="M4 20h4l11-11-4-4L4 16v4z"/></>,
  "right-left": <><path d="M3 8h13l-3-3M3 8l3 3M21 16H8l3-3M21 16l-3 3"/></>,
  "phone-volume": <><path d="M5 4h3l2 5-2 1a11 11 0 0 0 6 6l1-2 5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/><path d="M18 5a3 3 0 0 1 0 6M21 3a6 6 0 0 1 0 12"/></>,
  plus: <path d="M12 5v14M5 12h14"/>,
  tag: <><path d="M3 12V4h8l10 10-8 8L3 12z"/><circle cx="8" cy="8" r="1.4"/></>,
  scroll: <><path d="M6 4h12v14a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7"/><path d="M6 4a3 3 0 0 0-3 3v0h6"/><path d="M9 12h6M9 16h6"/></>,
  circle: <circle cx="12" cy="12" r="9"/>,
  globe: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></>,
};

function Icon({ name, size = 14, color, strokeWidth = 1.8, fill = "none", style, className, title, ...rest }) {
  const content = ICONS[name];
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke={color || "currentColor"}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, verticalAlign: "middle", ...style }}
      className={className}
      aria-hidden={title ? undefined : "true"}
      role={title ? "img" : undefined}
      aria-label={title || undefined}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {content || <circle cx="12" cy="12" r="3"/>}
    </svg>
  );
}

// Tiny "circle-notch" spinner with rotation built in
function Spinner({ size = 14, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" style={{ animation: "spin 0.9s linear infinite", verticalAlign: "middle" }}>
      <path d="M21 12a9 9 0 1 1-9-9" />
    </svg>
  );
}

window.LibertyIcon = { Icon, Spinner, ICONS };
window.Icon = Icon;
window.Spinner = Spinner;
