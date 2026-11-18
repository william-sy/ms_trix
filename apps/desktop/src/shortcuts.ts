import type { Key } from "./i18n";
import { currentSettings, isMac } from "./settings";

/** ⌘ on macOS, Ctrl elsewhere. */
export const mod = (e: { metaKey: boolean; ctrlKey: boolean }) => (isMac ? e.metaKey : e.ctrlKey);

// A combo is "Mod+Shift+Alt+<KeyboardEvent.code>", e.g. "Mod+KeyE" or "Alt+ArrowUp".
// Codes (not characters) keep shortcuts working when Shift or Alt change the character.

export type ShortcutId =
  | "settings" | "list" | "search" | "newChat"
  | "activity" | "chat" | "teams" | "prevChat" | "nextChat" | "prevUnread" | "nextUnread"
  | "findInChat" | "markUnread";

/** Changeable shortcuts and their defaults. Handlers live with their views and ask `matches`. */
export const defaults: Record<ShortcutId, string> = {
  settings: "Mod+Comma",
  list: "Mod+Slash",
  search: "Mod+KeyE",
  newChat: "Mod+KeyN",
  activity: "Mod+Shift+Digit1",
  chat: "Mod+Shift+Digit2",
  teams: "Mod+Shift+Digit3",
  prevChat: "Alt+ArrowUp",
  nextChat: "Alt+ArrowDown",
  prevUnread: "Alt+Shift+ArrowUp",
  nextUnread: "Alt+Shift+ArrowDown",
  findInChat: "Mod+KeyF",
  markUnread: "Mod+Shift+KeyU",
};

export const comboFor = (id: ShortcutId) => currentSettings().shortcuts[id] ?? defaults[id];

/** The combo a key press makes, or null for a lone modifier. */
export function comboOf(e: KeyboardEvent | React.KeyboardEvent): string | null {
  if (["Meta", "Control", "Shift", "Alt"].includes(e.key)) return null;
  return [mod(e) && "Mod", e.shiftKey && "Shift", e.altKey && "Alt", e.code].filter(Boolean).join("+");
}

export const matches = (e: KeyboardEvent, id: ShortcutId) => comboOf(e) === comboFor(id);

const keyNames: Record<string, string> = {
  Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]",
  Minus: "-", Equal: "=", Backquote: "`", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
  Enter: "Enter", Escape: "Esc", Space: "Space", Backspace: "⌫", Tab: "Tab",
};

/** "Mod+Shift+KeyU" -> "⌘⇧U" on macOS, "Ctrl+Shift+U" elsewhere. */
export function comboLabel(combo: string): string {
  const parts = combo.split("+");
  const code = parts.pop() ?? "";
  const key = keyNames[code] ?? code.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Numpad/, "Num ");
  const mods = parts.map((p) => (isMac ? { Mod: "⌘", Shift: "⇧", Alt: "⌥" } : { Mod: "Ctrl+", Shift: "Shift+", Alt: "Alt+" })[p as "Mod"] ?? "");
  return mods.join("") + key;
}

/** Shows ⌘⌥⇧ keys the way the platform writes them (for the fixed entries below). */
export const keyLabel = (keys: string) => (isMac ? keys : keys.replace("⌘", "Ctrl+").replace("⌥", "Alt+").replace("⇧", "Shift+"));

type Entry = { id: ShortcutId; label: Key } | { keys: string; label: Key };

/** Everything the app responds to, for the list in Settings. Entries with an id can be changed. */
export const shortcuts: { group: Key; items: Entry[] }[] = [
  {
    group: "shortcuts.group.general",
    items: [
      { id: "settings", label: "shortcuts.settings" },
      { id: "list", label: "shortcuts.list" },
      { id: "search", label: "shortcuts.search" },
      { id: "newChat", label: "shortcuts.newChat" },
      { keys: "Esc", label: "shortcuts.close" },
    ],
  },
  {
    group: "shortcuts.group.navigation",
    items: [
      { id: "activity", label: "shortcuts.activity" },
      { id: "chat", label: "shortcuts.chat" },
      { id: "teams", label: "shortcuts.teams" },
      { keys: "⌘0", label: "shortcuts.allOrgs" },
      { keys: "⌘1 – ⌘9", label: "shortcuts.org" },
      { id: "prevChat", label: "shortcuts.prevChat" },
      { id: "nextChat", label: "shortcuts.nextChat" },
      { id: "prevUnread", label: "shortcuts.prevUnread" },
      { id: "nextUnread", label: "shortcuts.nextUnread" },
    ],
  },
  {
    group: "shortcuts.group.chat",
    items: [
      { id: "findInChat", label: "shortcuts.findInChat" },
      { id: "markUnread", label: "shortcuts.markUnread" },
      { keys: "Enter", label: "shortcuts.send" },
      { keys: "⇧Enter", label: "shortcuts.newline" },
      { keys: "⌘Enter", label: "shortcuts.sendFormatted" },
    ],
  },
];
