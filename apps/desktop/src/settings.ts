import type { Ringtone } from "./ringtone";
import { setLanguage, type Key } from "./i18n";

// App settings, kept per device in localStorage until accounts sync settings.
// Notification and privacy choices are pushed to the Rust host (syncToHost).

export type ThemeChoice = "system" | "light" | "dark";
export type FontSize = "small" | "normal" | "large";

export type NotifyLevel = "all" | "mentions" | "off";

export interface NotifyPrefs {
  chats: NotifyLevel;
  channels: NotifyLevel;
  calls: boolean;
  keywords: string[];
}

/** "none", "default" (OS sound) or a macOS system sound name. */
export interface Sounds {
  message: string;
  mention: string;
  call: string;
}

export const isMac = navigator.userAgent.includes("Mac");
/** Sounds that ship with macOS (/System/Library/Sounds). */
export const macSounds = ["Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero", "Morse", "Ping", "Pop", "Purr", "Sosumi", "Submarine", "Tink"];

export interface Settings {
  theme: ThemeChoice;
  /** null = the theme's default accent. */
  accent: string | null;
  fontSize: FontSize;
  /** "system" or a language code from i18n.languages. */
  language: string;
  notify: NotifyPrefs;
  sounds: Sounds;
  /** Let others see when you've read their messages / are typing. */
  shareReceipts: boolean;
  shareTyping: boolean;
  /** Closing the window keeps ms_trix running in the tray. */
  closeToTray: boolean;
  spellCheck: boolean;
  /** Minutes without input before "available" shows as away; 0 = never. */
  awayAfter: number;
  /** Do not disturb until this time (ms; DND_FOREVER: until switched off), or off. */
  dndUntil: number | null;
  /** Changed keyboard shortcuts (id -> combo); missing ids use the defaults. */
  shortcuts: Record<string, string>;
  /** Your own colour per account (org id -> colour) for the org switcher and badges. */
  orgColors: Record<string, string>;
  /** Chosen devices (MediaDeviceInfo.deviceId); null = the system default. */
  micId: string | null;
  speakerId: string | null;
  cameraId: string | null;
  /** Camera background in calls: "none", "blur", "blur-strong", "preset:<id>" or "custom". */
  cameraEffect: string;
  /** Their names, to find the same device again if its id changes. */
  deviceLabels: Record<string, string>;
  /** Enter sends (Shift+Enter = new line); off: Enter = new line, ⌘/Ctrl+Enter sends. */
  enterSends: boolean;
  density: "comfortable" | "compact";
  /** Ringtone for incoming calls and meeting reminders; "custom" = your own file (its name). */
  ringtone: Ringtone;
  ringtoneName: string | null;
  /** The meeting reminder's sound (any ringtone; a short chime by default). */
  reminderSound: Ringtone;
  /** Minutes before a meeting its reminder comes; 0 = no reminders. */
  reminderMinutes: number;
  /** Meeting reminders pop up on top of other windows, or inside ms_trix only. */
  meetingReminder: "window" | "app";
  /** Size of messages that are only emoji (or custom emoji). */
  emojiSize: "small" | "medium" | "large";
  /** Own colours over the theme (CSS variable -> colour), e.g. "--bg-main". */
  colors: Record<string, string>;
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
const defaults: Settings = {
  theme: "system",
  accent: null,
  fontSize: "normal",
  language: "system",
  notify: { chats: "all", channels: "mentions", calls: true, keywords: [] },
  sounds: { message: "default", mention: "default", call: "default" },
  shareReceipts: true,
  shareTyping: true,
  closeToTray: false,
  spellCheck: true,
  awayAfter: 5,
  dndUntil: null,
  shortcuts: {},
  orgColors: {},
  micId: null,
  speakerId: null,
  cameraId: null,
  cameraEffect: "none",
  deviceLabels: {},
  enterSends: true,
  density: "comfortable",
  meetingReminder: "window",
  reminderMinutes: 5,
  ringtone: "tide",
  reminderSound: "chime",
  ringtoneName: null,
  emojiSize: "medium",
  colors: {},
};

let current: Settings = defaults;
/** The settings in effect, for code outside React (e.g. typing notices). */
export const currentSettings = () => current;

export function loadSettings(): Settings {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { ...defaults, ...stored, notify: { ...defaults.notify, ...stored.notify }, sounds: { ...defaults.sounds, ...stored.sounds }, shortcuts: { ...stored.shortcuts }, orgColors: { ...stored.orgColors }, deviceLabels: { ...stored.deviceLabels }, colors: { ...stored.colors } };
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

const listeners = new Set<(s: Settings) => void>();

/**
 * Changes settings from outside the Settings dialog (e.g. a call's background); the app's copy
 * follows. Onto the stored settings, not this page's copy: another page may have changed others.
 */
export function updateSettings(patch: Partial<Settings>) {
  const next = { ...loadSettings(), ...patch };
  saveSettings(next);
  applySettings(next);
  listeners.forEach((l) => l(next));
}

// Settings changed by another page of the app (a call's own webview: its devices, background):
// this page follows, so it won't later save its older copy over them.
window.addEventListener("storage", (e) => {
  if (e.key !== KEY) return;
  const next = loadSettings();
  applySettings(next);
  listeners.forEach((l) => l(next));
});

export function onSettingsChanged(listener: (s: Settings) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Theme colours that can be overridden in Settings. */
export const customColors = ["--bg-main", "--bg-list", "--bg-rail", "--bg-bubble", "--bg-bubble-mine"] as const;

const dark = window.matchMedia("(prefers-color-scheme: dark)");
const fontSizes: Record<FontSize, string> = { small: "13px", normal: "14px", large: "15.5px" };

/** Applies settings to the document; "system" follows the OS live. */
export function applySettings(s: Settings) {
  current = s;
  const root = document.documentElement;
  const resolve = () => root.setAttribute("data-theme", s.theme === "system" ? (dark.matches ? "dark" : "light") : s.theme);
  resolve();
  dark.onchange = s.theme === "system" ? resolve : null;
  if (s.accent) root.style.setProperty("--accent", s.accent);
  else root.style.removeProperty("--accent");
  root.style.setProperty("--font-size", fontSizes[s.fontSize]);
  root.setAttribute("data-density", s.density);
  root.style.setProperty("--jumbo-size", { small: "28px", medium: "40px", large: "64px" }[s.emojiSize]);
  // Own colours: set the chosen ones, clear the rest so the theme shows again.
  for (const name of customColors) {
    if (s.colors[name]) root.style.setProperty(name, s.colors[name]!);
    else root.style.removeProperty(name);
  }
  setLanguage(s.language);
}
