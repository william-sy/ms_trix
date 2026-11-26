import { backend, mediaUrl } from "./backend";
import { parseRoomLink } from "./roomLinks";
import type { Conversation, Org } from "./types";

// Links to chats: what a #chat picked in the message box becomes when sent, and which links in
// messages point at a chat you know (shown as a pill with its name and picture).

const escapeMarkdown = (s: string) => s.replace(/[[\]()\\]/g, "\\$&");

/**
 * The text a picked chat is sent as. Matrix: a matrix.to link to the room id with its name as
 * the text (Element and Element X show a room pill; others are offered to join). Talk: the
 * conversation's own link (Talk shows a card for it). Null where chats can't be linked.
 */
export async function chatLinkText(chat: Conversation, org: Org): Promise<string | null> {
  if (org.protocol === "matrix") {
    const room = chat.id.slice(chat.id.indexOf("|") + 1);
    const server = (id: string) => id.slice(id.indexOf(":") + 1);
    // Servers that know the room: ours (we're in it) and the one that made it.
    const via = [...new Set([server(org.userId), server(room)])].filter(Boolean).map((s) => `via=${encodeURIComponent(s)}`).join("&");
    return `[${escapeMarkdown(chat.name)}](https://matrix.to/#/${encodeURIComponent(room)}${via ? `?${via}` : ""})`;
  }
  if (org.protocol === "talk") return backend.conversationLink(chat.id);
  return null;
}

let known: Conversation[] = [];
/** The chats links are recognised against (the app keeps this current). */
export const rememberChats = (convs: Conversation[]) => { known = convs; };

/** The chat a link points at (the chat itself, not a message in it), if it's one you know. */
export function chatAt(href: string): Conversation | undefined {
  const room = parseRoomLink(href);
  if (room) return room.event || !room.address.startsWith("!") ? undefined : known.find((c) => c.id.endsWith(`|${room.address}`));
  const talk = /^https?:\/\/[^/\s]+(?:\/index\.php)?\/call\/([a-z0-9]{4,})\/?(?:#(?!message_)[^\s]*)?$/i.exec(href);
  return talk ? known.find((c) => c.id.endsWith(`|${talk[1]}`)) : undefined;
}

/** A known chat's link shown as a pill when its text is the address itself or the chat's name. */
export function pillFor(href: string, text: string): Conversation | undefined {
  const chat = chatAt(href);
  const shown = text.trim();
  return chat && (shown === href || shown === chat.name || /^[#!]/.test(shown)) ? chat : undefined;
}

/** The chat's picture for a pill, or null. */
export const pillPicture = (chat: Conversation) => (chat.avatar ? mediaUrl(chat.orgId, chat.avatar, 32) ?? null : null);
