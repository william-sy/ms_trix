// UI translations. Every user-visible string goes through t(); English is the
// source of truth (and fallback), other languages live next to it as JSON.
//
//   t("chat.title")                         -> "Chat"
//   t("chat.noMatch", { query: "foo" })     -> 'No chats match "foo".'
//   t("browse.members", { count: 3 })       -> uses browse.members_one / _other
//
// Keys are type-checked against en.json, so a typo fails the build.
// `node scripts/check-locales.mjs` verifies every language has every key.

import en from "./locales/en.json";
import nl from "./locales/nl.json";

type Dict = Record<string, string>;
type BaseKey = keyof typeof en;
/** Plural keys are written as `key_one` / `key_other`; callers use `key`. */
type PluralBase<K> = K extends `${infer B}_other` ? B : never;
export type Key = BaseKey | PluralBase<BaseKey>;

const locales: Record<string, Dict> = { en, nl };

export const languages: { code: string; name: string }[] = [
  { code: "en", name: "English" },
  { code: "nl", name: "Nederlands" },
];

let current = "en";
let clock: Clock = "system";

/** Times as 14:20 or 2:20 PM: "system" goes by the OS's language and region, whatever the UI language. */
export type Clock = "system" | "24" | "12";

/** "system" follows the OS language when we have it, else English. */
export function setLanguage(choice: string) {
  const system = navigator.language.slice(0, 2).toLowerCase();
  current = choice === "system" ? (locales[system] ? system : "en") : locales[choice] ? choice : "en";
  document.documentElement.lang = current;
}

/** The "rust.*" texts in the current language (English where missing), for the host. */
export function rustTexts(): Record<string, string> {
  const dict = { ...(en as Dict), ...(locales[current] ?? {}) };
  return Object.fromEntries(Object.entries(dict).filter(([k]) => k.startsWith("rust.")).map(([k, v]) => [k.slice("rust.".length), v]));
}

/** Words a command result in the current language when the host sent a text key. */
export const commandText = (out: { message: string; text: { key: string; args: Record<string, string> } | null }) =>
  out.text ? t(`rust.${out.text.key}` as Key, out.text.args) : out.message;

// Errors from servers and the SDK arrive as English text with a Matrix code or a
// network message; the common ones get a readable sentence in the UI language.
const errorPatterns: [RegExp, Key][] = [
  [/M_FORBIDDEN|\b403 Forbidden/, "error.forbidden"],
  [/M_LIMIT_EXCEEDED|\b429 Too Many Requests/, "error.rateLimited"],
  [/M_UNKNOWN_TOKEN|M_MISSING_TOKEN|\b401 Unauthorized/, "error.signedOut"],
  [/M_NOT_FOUND|\b404 Not Found/, "error.notFound"],
  [/M_ROOM_IN_USE/, "error.addressTaken"],
  [/M_TOO_LARGE|\b413 Payload Too Large/, "error.tooLarge"],
  [/M_USER_IN_USE/, "error.nameTaken"],
  [/M_INVALID_PARAM|M_BAD_JSON/, "error.invalid"],
  // Talk's reasons (the host adds them: "400 Bad Request (consent)").
  [/\b400 Bad Request \(consent\)/, "error.recordingConsent"],
  [/\b400 Bad Request \(config\)/, "error.recordingSetup"],
  [/\b400 Bad Request \(recording\)/, "error.recordingRunning"],
  [/\b400 Bad Request \(call\)/, "error.noCall"],
  [/error sending request|connection (refused|reset|closed)|dns error|operation timed out/i, "error.network"],
];

/** A readable error in the UI language, keeping the original (short) for reference. */
export function friendlyError(raw: string): string {
  const hit = errorPatterns.find(([re]) => re.test(raw));
  if (!hit) return raw;
  const code = /M_[A-Z_]+/.exec(raw)?.[0];
  return code ? `${t(hit[1])} (${code})` : t(hit[1]);
}

/** BCP 47 code for Intl date/number formatting. */
export const locale = () => current;

export function setClock(choice: Clock) {
  clock = choice;
}

/** For dates and times: the UI language with the chosen hour cycle (English in Europe: 14:20). */
export function dateLocale() {
  const cycle = clock === "24" ? "h23" : clock === "12" ? "h12" : new Intl.DateTimeFormat(navigator.language, { hour: "numeric" }).resolvedOptions().hourCycle;
  return cycle ? `${current}-u-hc-${cycle}` : current;
}

export function t(key: Key, vars?: Record<string, string | number>): string {
  const dict = locales[current] ?? en;
  let text: string | undefined;
  if (vars && typeof vars.count === "number") {
    const form = new Intl.PluralRules(current).select(vars.count);
    text = dict[`${key}_${form}`] ?? dict[`${key}_other`] ?? (en as Dict)[`${key}_${form}`] ?? (en as Dict)[`${key}_other`];
  }
  text ??= dict[key] ?? (en as Dict)[key] ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m)) : text;
}
