// Home and End in text fields. The macOS webview doesn't handle them there: it types the key's
// private character (a box) instead. So they move the cursor as on Windows and Linux: to the
// start or end of the line, with ⌘ or Ctrl of the whole text, and with Shift selecting.

type Field = HTMLInputElement | HTMLTextAreaElement;

function moveTo(el: Field, toEnd: boolean, whole: boolean, extend: boolean) {
  const value = el.value;
  const back = el.selectionDirection === "backward";
  // The end of the selection that moves, and the one that stays.
  const focus = (back ? el.selectionStart : el.selectionEnd) ?? 0;
  const anchor = (back ? el.selectionEnd : el.selectionStart) ?? 0;
  let target: number;
  if (whole || el instanceof HTMLInputElement) target = toEnd ? value.length : 0;
  else if (toEnd) target = value.indexOf("\n", focus) < 0 ? value.length : value.indexOf("\n", focus);
  else target = focus === 0 ? 0 : value.lastIndexOf("\n", focus - 1) + 1;
  if (!extend) el.setSelectionRange(target, target);
  else if (target < anchor) el.setSelectionRange(target, anchor, "backward");
  else el.setSelectionRange(anchor, target, "forward");
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Home" && e.key !== "End") return;
  const el = e.target;
  if (!(el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)) return;
  e.preventDefault();
  // Fields without a cursor (number, email, …) only lose the box.
  if (typeof el.selectionStart === "number") moveTo(el, e.key === "End", e.metaKey || e.ctrlKey, e.shiftKey);
}, true);

// The same characters from other function keys (Page Up, F1, …) never belong in text either
// (U+F700–U+F74F only; the Apple logo, U+F8FF, is typed on purpose).
document.addEventListener("beforeinput", (e) => {
  if (e.data && /[\uF700-\uF74F]/.test(e.data)) e.preventDefault();
}, true);
