// Half-written messages, per chat and per thread in it: kept when you go to another chat, and
// across restarts (sealed on disk like the chat list). The browser preview keeps them per session.
import { backend, isLive } from "./backend";

let drafts: Record<string, string> = {};
let loaded = !isLive;
let loading: Promise<Record<string, string>> | null = null;

/** Reads the saved drafts (once); edits made before that are kept on top. */
export const loadDrafts = () => (loading ??= backend.drafts().catch(() => ({})).then((saved) => {
  const edited = Object.keys(drafts).length > 0;
  drafts = { ...saved, ...drafts };
  loaded = true;
  if (edited) void backend.saveDrafts(drafts).catch(() => {});
  return drafts;
}));

export const draftKey = (conversation: string, thread?: string | null) => (thread ? `${conversation}#${thread}` : conversation);
export const draftOf = (key: string): string | undefined => drafts[key];

/** Keeps (or with only spaces, drops) a draft; says whether it changed. */
export function keepDraft(key: string, text: string): boolean {
  const next = text.trim() ? text : undefined;
  if (drafts[key] === next) return false;
  drafts = { ...drafts };
  if (next === undefined) delete drafts[key];
  else drafts[key] = next;
  // Before the saved ones are read, writing would replace them.
  if (loaded && isLive) void backend.saveDrafts(drafts).catch(() => {});
  return true;
}
