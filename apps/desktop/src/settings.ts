import { setLanguage, type Key } from "./i18n";

// Appearance settings, kept per device in localStorage until accounts sync settings.

export type ThemeChoice = "system" | "light" | "dark";
export type FontSize = "small" | "normal" | "large";

export interface Settings {
  theme: ThemeChoice;
  /** null = the theme's default accent. */
  accent: string | null;
  fontSize: FontSize;
  /** "system" or a language code from i18n.languages. */
  language: string;
}

export const accents: { name: Key; color: string }[] = [
  { name: "accent.indigo", color: "#5b5fc7" },
  { name: "accent.blue", color: "#2b6cdf" },
  { name: "accent.teal", color: "#0e8a7e" },
  { name: "accent.green", color: "#3c8a2e" },
  { name: "accent.orange", color: "#d4661b" },
  { name: "accent.pink", color: "#c2185b" },
  { name: "accent.red", color: "#c4314b" },
  { name: "accent.graphite", color: "#5f6b7a" },
];

const KEY = "ms_trix.settings";
const defaults: Settings = { theme: "system", accent: null, fontSize: "normal", language: "system" };

export function loadSettings(): Settings {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return defaults;
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode: settings just won't persist */
  }
}

const dark = window.matchMedia("(prefers-color-scheme: dark)");
const fontSizes: Record<FontSize, string> = { small: "13px", normal: "14px", large: "15.5px" };

/** Applies settings to the document; "system" follows the OS live. */
export function applySettings(s: Settings) {
  const root = document.documentElement;
  const resolve = () => root.setAttribute("data-theme", s.theme === "system" ? (dark.matches ? "dark" : "light") : s.theme);
  resolve();
  dark.onchange = s.theme === "system" ? resolve : null;
  if (s.accent) root.style.setProperty("--accent", s.accent);
  else root.style.removeProperty("--accent");
  root.style.setProperty("--font-size", fontSizes[s.fontSize]);
  setLanguage(s.language);
}
