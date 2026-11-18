// Emoji search by name and keyword (emojibase data, loaded on first use).
// Searches the UI language and English, so "duim" and "thumbs" both find 👍.
import { locale } from "./i18n";

interface Entry { hexcode: string; label: string; unicode: string; group?: number; order?: number; tags?: string[] }
type Index = { emoji: string; words: string[]; order: number }[];

const COMPONENTS = 2; // skin tone and hair modifiers on their own
const cache: Record<string, Promise<Entry[]>> = {};
const load = (lang: string) =>
  (cache[lang] ??= (lang === "nl" ? import("emojibase-data/nl/compact.json") : import("emojibase-data/en/compact.json")).then((m) => m.default as Entry[]));

async function buildIndex(): Promise<Index> {
  const langs = locale() === "en" ? ["en"] : [locale(), "en"];
  const byHex = new Map<string, Index[number]>();
  for (const lang of langs.filter((l) => l === "en" || l === "nl")) {
    for (const e of await load(lang)) {
      if (e.group === undefined || e.group === COMPONENTS) continue;
      const words = [...e.label.toLowerCase().split(/[\s:,]+/), ...(e.tags ?? []).map((t) => t.toLowerCase())];
      const hit = byHex.get(e.hexcode);
      if (hit) hit.words.push(...words);
      else byHex.set(e.hexcode, { emoji: e.unicode, words, order: e.order ?? 0 });
    }
  }
  return [...byHex.values()].sort((a, b) => a.order - b.order);
}

let index: { lang: string; data: Promise<Index> } | null = null;

/** Emoji whose name or keywords start with every word of `query`. */
export async function searchEmoji(query: string, limit = 80): Promise<string[]> {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  if (!index || index.lang !== locale()) index = { lang: locale(), data: buildIndex() };
  const data = await index.data;
  return data.filter((e) => terms.every((t) => e.words.some((w) => w.startsWith(t)))).slice(0, limit).map((e) => e.emoji);
}
