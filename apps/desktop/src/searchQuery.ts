// The search syntax in the UI, matching the core's (trix_core::query): plain words start a word,
// "exact phrases", *wildcards* within a word, #hashtags; optionally matching case.

/** A #hashtag, by the core's rule (trix_core::hashtags): not inside a word or link, at least two
 *  characters with a letter among them, and not a room address (#room:server). */
export const HASHTAG = String.raw`(?<![\p{L}\p{N}_#&/])#((?=[\p{N}_-]*\p{L})[\p{L}\p{N}_][\p{L}\p{N}_-]*[\p{L}\p{N}_])(?!-*[\p{L}\p{N}_]|:[\p{L}\p{N}])`;

export interface ParsedQuery {
  words: string[];
  phrases: string[];
  globs: RegExp[];
  tags: string[];
  matchCase: boolean;
}

const WORD = /[\p{L}\p{N}]+/gu;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function parseQuery(input: string, matchCase = false): ParsedQuery {
  const norm = (s: string) => (matchCase ? s : s.toLowerCase());
  const q: ParsedQuery = { words: [], phrases: [], globs: [], tags: [...input.matchAll(new RegExp(HASHTAG, "gu"))].map((m) => m[1]!.toLowerCase()), matchCase };
  input.replace(/[“”„]/g, '"').split('"').forEach((part, i) => {
    if (i % 2 === 1) {
      const phrase = part.trim().split(/\s+/).join(" ");
      if (phrase) q.phrases.push(norm(phrase));
      return;
    }
    for (const token of part.split(/\s+/).filter(Boolean)) {
      if (token.includes("*")) {
        const pattern = norm([...token].filter((c) => c === "*" || /[\p{L}\p{N}]/u.test(c)).join(""));
        if (/[\p{L}\p{N}]/u.test(pattern)) q.globs.push(new RegExp(`^${pattern.split("*").map(escape).join("[\\p{L}\\p{N}]*")}$`, "u"));
      } else {
        q.words.push(...(norm(token).match(WORD) ?? []));
      }
    }
  });
  return q;
}

export function queryMatches(q: ParsedQuery, text: string): boolean {
  const norm = q.matchCase ? text : text.toLowerCase();
  const words = norm.match(WORD) ?? [];
  const tags = q.tags.length ? [...text.matchAll(new RegExp(HASHTAG, "gu"))].map((m) => m[1]!.toLowerCase()) : [];
  return q.phrases.every((p) => norm.includes(p))
    && q.globs.every((g) => words.some((w) => g.test(w)))
    && q.words.every((t) => words.some((w) => ([...t].length <= 2 ? w === t : w.startsWith(t))))
    && q.tags.every((t) => tags.includes(t));
}

/** What to mark in a result: the first phrase, or else the longest plain part of the first word. */
export function markTerm(input: string): string {
  const phrase = /["“]([^"”]+)["”]/.exec(input)?.[1]?.trim();
  if (phrase) return phrase;
  const first = input.trim().split(/\s+/)[0] ?? "";
  return first.split("*").sort((a, b) => b.length - a.length)[0] ?? "";
}
