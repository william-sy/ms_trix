import { createContext, useContext } from "react";
import { isLive } from "./backend";
import { conversations, messagesFor, orgs } from "./mock";
import type { Conversation, Message, Org, Outgoing, Reaction } from "./types";

// In live mode the Rust engine owns unread state and this store only mirrors
// what it emits. In mock mode the reducer applies the same rules locally
// (see crates/trix-core/src/unread.rs).

export type OrgFilter = "all" | string;

export interface State {
  orgs: Org[];
  orgFilter: OrgFilter;
  convs: Conversation[];
  selectedId: string | null;
  /** Per conversation: false while the view that marked it unread is still open (mock only). */
  armed: Record<string, boolean>;
  messages: Record<string, Message[]>;
}

export type Action =
  | { type: "selectOrg"; org: OrgFilter }
  | { type: "select"; id: string }
  | { type: "markUnread"; id: string }
  | { type: "markRead"; id: string }
  | { type: "toggleFavourite"; id: string }
  | { type: "toggleArchive"; id: string }
  | { type: "toggleMute"; id: string }
  | { type: "send"; id: string; message: Outgoing }
  | { type: "react"; id: string; target: string; emoji: string }
  | { type: "edit"; id: string; target: string; text: string }
  | { type: "delete"; id: string; target: string }
  // Live-mode updates pushed by the backend.
  | { type: "setSelected"; id: string | null }
  | { type: "setOrgs"; orgs: Org[] }
  | { type: "upsertConvs"; convs: Conversation[] }
  | { type: "removeConvs"; keys: string[] }
  | { type: "setMessages"; key: string; messages: Message[] }
  | { type: "appendMessages"; items: { key: string; message: Message }[] }
  // Sending: our copy shows at once (⏱), gets the real id (✓) and is replaced by the real message.
  | { type: "localSend"; key: string; message: Message }
  | { type: "localSent"; key: string; txn: string; realId: string }
  | { type: "localStatus"; key: string; txn: string; status: "sending" | "failed" }
  | { type: "retrySend"; id: string; txn: string }
  | { type: "discardLocal"; id: string; txn: string };

export const initialState: State = isLive
  ? { orgs: [], orgFilter: "all", convs: [], selectedId: null, armed: {}, messages: {} }
  : { orgs, orgFilter: "all", convs: conversations, selectedId: "lab-webinar", armed: {}, messages: {} };

const update = (convs: Conversation[], id: string, f: (c: Conversation) => Partial<Conversation>) =>
  convs.map((c) => (c.id === id ? { ...c, ...f(c) } : c));

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "selectOrg": {
      const stillVisible = state.convs.some((c) => c.id === state.selectedId && (action.org === "all" || c.orgId === action.org));
      return { ...state, orgFilter: action.org, selectedId: stillVisible ? state.selectedId : null };
    }
    case "select": {
      if (action.id === state.selectedId) return state;
      const armed = { ...state.armed };
      if (state.selectedId) armed[state.selectedId] = true; // blur
      const isArmed = armed[action.id] ?? true;
      const convs = update(state.convs, action.id, (c) => ({ unread: 0, mentions: 0, marked: c.marked && !isArmed }));
      return { ...state, convs, armed, selectedId: action.id };
    }
    case "markUnread":
      return {
        ...state,
        convs: update(state.convs, action.id, () => ({ marked: true })),
        armed: { ...state.armed, [action.id]: action.id !== state.selectedId },
      };
    case "markRead":
      return { ...state, convs: update(state.convs, action.id, () => ({ marked: false, unread: 0, mentions: 0 })) };
    case "toggleFavourite":
      return { ...state, convs: update(state.convs, action.id, (c) => ({ favourite: !c.favourite })) };
    case "toggleArchive":
      return { ...state, convs: update(state.convs, action.id, (c) => ({ archived: !c.archived })) };
    case "toggleMute":
      return { ...state, convs: update(state.convs, action.id, (c) => ({ muted: !c.muted })) };
    case "send": {
      const { text, emote, replyTo, threadRoot } = action.message;
      const body = emote ? `* You ${text}` : text;
      const msg: Message = { id: crypto.randomUUID(), sender: "You", time: "Now", body, fromMe: true, replyTo, threadRoot };
      const sortKey = Math.max(...state.convs.map((c) => c.sortKey)) + 1;
      const conv = state.convs.find((c) => c.id === action.id);
      const current = state.messages[action.id] ?? (conv ? messagesFor(conv) : []);
      return {
        ...state,
        convs: update(state.convs, action.id, () => ({ preview: `You: ${body}`, time: "Now", sortKey, marked: false, unread: 0, mentions: 0, draft: undefined })),
        messages: { ...state.messages, [action.id]: [...current, msg] },
      };
    }
    case "setSelected":
      return { ...state, selectedId: action.id };
    case "setOrgs": {
      const orgFilter = state.orgFilter === "all" || action.orgs.some((o) => o.id === state.orgFilter) ? state.orgFilter : "all";
      return { ...state, orgs: action.orgs, orgFilter };
    }
    case "upsertConvs": {
      const byId = new Map(state.convs.map((c) => [c.id, c]));
      // Keep UI-only fields (drafts) when the backend sends a fresh view.
      for (const c of action.convs) byId.set(c.id, { ...byId.get(c.id), ...c });
      return { ...state, convs: [...byId.values()] };
    }
    case "removeConvs": {
      const gone = new Set(action.keys);
      return { ...state, convs: state.convs.filter((c) => !gone.has(c.id)), selectedId: state.selectedId && gone.has(state.selectedId) ? null : state.selectedId };
    }
    case "setMessages": {
      // Messages still being sent stay until their real version is in the list (a sent one
      // whose real version never shows up goes after a while, so it can't linger as a double).
      const locals = (state.messages[action.key] ?? []).filter((m) => m.local && !action.messages.some((x) => x.id === m.local!.realId)
        && (!m.local.realId || Date.now() - (m.ts ?? 0) < 15_000));
      return { ...state, messages: { ...state.messages, [action.key]: [...action.messages, ...locals] } };
    }
    case "localSend":
      return { ...state, messages: { ...state.messages, [action.key]: [...(state.messages[action.key] ?? []), action.message] } };
    case "localSent": {
      const list = state.messages[action.key] ?? [];
      // The real message may have arrived first (then our copy just goes).
      const arrived = list.some((m) => m.id === action.realId);
      const next = arrived
        ? list.filter((m) => m.local?.txn !== action.txn)
        : list.map((m) => (m.local?.txn === action.txn ? { ...m, status: undefined, local: { ...m.local, realId: action.realId } } : m));
      return { ...state, messages: { ...state.messages, [action.key]: next } };
    }
    case "localStatus":
      return { ...state, messages: { ...state.messages, [action.key]: (state.messages[action.key] ?? []).map((m) => (m.local?.txn === action.txn ? { ...m, status: action.status } : m)) } };
    // Resending happens in the app (live mode); nothing to change here.
    case "retrySend":
      return state;
    case "discardLocal":
      return { ...state, messages: { ...state.messages, [action.id]: (state.messages[action.id] ?? []).filter((m) => m.local?.txn !== action.txn) } };
    case "appendMessages": {
      // New messages are appended; reacted/edited/deleted ones are replaced in place.
      const messages = { ...state.messages };
      for (const { key, message } of action.items) {
        const list = messages[key];
        if (!list) continue; // not loaded yet: fetched on open
        // Our sent message replaces its "sending" copy where it stood.
        if (list.some((m) => m.local?.realId === message.id)) messages[key] = list.map((m) => (m.local?.realId === message.id ? message : m));
        else messages[key] = list.some((m) => m.id === message.id) ? list.map((m) => (m.id === message.id ? message : m)) : [...list, message];
      }
      return { ...state, messages };
    }
    // Mock-mode versions of what the backend does in live mode.
    case "react":
      return mapMessage(state, action.id, action.target, (m) => ({ reactions: toggleReaction(m.reactions ?? [], action.emoji) }));
    case "edit":
      return mapMessage(state, action.id, action.target, () => ({ body: action.text, html: undefined, edited: true }));
    case "delete":
      return mapMessage(state, action.id, action.target, () => ({ body: "", html: undefined, deleted: true, reactions: [] }));
  }
}

function mapMessage(state: State, convId: string, target: string, f: (m: Message) => Partial<Message>): State {
  const conv = state.convs.find((c) => c.id === convId);
  const list = state.messages[convId] ?? (conv ? messagesFor(conv) : []);
  return { ...state, messages: { ...state.messages, [convId]: list.map((m) => (m.id === target ? { ...m, ...f(m) } : m)) } };
}

function toggleReaction(reactions: Reaction[], emoji: string): Reaction[] {
  const existing = reactions.find((r) => r.key === emoji);
  if (!existing) return [...reactions, { key: emoji, count: 1, mine: true, senders: ["You"] }];
  if (!existing.mine) return reactions.map((r) => (r === existing ? { ...r, count: r.count + 1, mine: true, senders: [...r.senders, "You"] } : r));
  return reactions
    .map((r) => (r === existing ? { ...r, count: r.count - 1, mine: false, senders: r.senders.filter((s) => s !== "You") } : r))
    .filter((r) => r.count > 0);
}

/** Pending invites count as unread so they get noticed. */
export const isUnread = (c: Conversation) => c.marked || c.unread > 0 || !!c.invitedBy;

export const timeline = (state: State, conv: Conversation) => state.messages[conv.id] ?? (isLive ? [] : messagesFor(conv));

/** Unread conversations per org, ignoring muted ones (like Teams). */
export const unreadByOrg = (convs: Conversation[]) => {
  const out: Record<string, number> = {};
  for (const c of convs) if (isUnread(c) && !c.muted) out[c.orgId] = (out[c.orgId] ?? 0) + 1;
  return out;
};

const unknownOrg: Org = { id: "?", name: "?", protocol: "matrix", userId: "", displayName: "", color: "#888", presence: "offline" };

export const OrgsContext = createContext<Org[]>([]);
export const useOrgs = () => useContext(OrgsContext);
export const useOrg = (id: string) => useOrgs().find((o) => o.id === id) ?? unknownOrg;
