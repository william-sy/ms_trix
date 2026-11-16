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

/** "system" follows the OS language when we have it, else English. */
export function setLanguage(choice: string) {
  const system = navigator.language.slice(0, 2).toLowerCase();
  current = choice === "system" ? (locales[system] ? system : "en") : locales[choice] ? choice : "en";
  document.documentElement.lang = current;
}

/** BCP 47 code for Intl date/number formatting. */
export const locale = () => current;

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
