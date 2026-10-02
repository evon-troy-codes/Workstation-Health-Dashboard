// dialog-focus.js — keeps keyboard focus inside a modal dialog.
//
// The dialogs are modal (aria-modal), but Tab still walked out of them to the
// sidebar and footer buttons behind the backdrop. trapTab, called from a
// dialog's keydown listener, cycles Tab and Shift+Tab through the dialog's
// own enabled controls, and pulls focus back in if it had left.

const FOCUSABLE = 'button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

export function trapTab(e, container) {
  if (e.key !== "Tab" || !container) return;
  const items = [...container.querySelectorAll(FOCUSABLE)].filter((el) => !el.disabled);
  const active = document.activeElement;
  if (!items.length) {
    e.preventDefault();
    container.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (!container.contains(active) || active === container) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  } else if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

// Focus somewhere inside the dialog when focus isn't there, or sits on a
// control that has just been disabled (the Explain button while the AI
// answers): the preferred control if it can take focus, else the dialog.
export function keepFocusInside(container, preferred) {
  if (!container) return;
  const active = document.activeElement;
  if (container.contains(active) && !active.disabled) return;
  if (preferred && !preferred.disabled) preferred.focus();
  else container.focus();
}
