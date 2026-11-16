// Mirrors trix-core's model. Replaced by Tauri commands once the core is wired up.
import type { RoomEvent } from "./roomEvents";

export type Protocol = "matrix" | "xmpp" | "irc";

/** Subset of trix-core's Capabilities that drives the UI chrome. */
export interface Capabilities {
  teams: boolean;
  calls: boolean;
}

export interface Org {
  id: string;
  name: string;
  protocol: Protocol;
  userId: string;
  displayName: string;
  color: string;
  avatar?: string;
  presence: "available" | "busy" | "away" | "offline";
  status?: string;
}

export type ConversationKind = "direct" | "group" | "channel" | "meeting";

export interface Conversation {
  id: string;
  orgId: string;
  kind: ConversationKind;
  name: string;
  team?: string;
  preview: string;
  time: string;
  sortKey: number;
  favourite: boolean;
  muted: boolean;
  mentionsOnly?: boolean;
  encrypted: boolean;
  unread: number;
  mentions: number;
  marked: boolean;
  draft?: string;
  avatar?: string;
  readers?: { userId: string; name: string; avatar?: string | null; pos: number }[];
  typing?: string[];
  /** 1:1 chats only, when the server shares presence. */
  presence?: PresenceState | null;
  status?: string | null;
  /** Pending invite: who invited us. */
  invitedBy?: string | null;
  /** The other person in a 1:1 chat. */
  dmUser?: string | null;
}

export type PresenceState = "available" | "busy" | "away" | "offline";

export interface Message {
  id: string;
  pos?: number;
  sender: string;
  /** Protocol user id, for opening the sender's profile. */
  senderId?: string;
  time: string;
  body: string;
  /** Sanitized before display; see RichText. */
  html?: string;
  fromMe?: boolean;
  system?: boolean;
  reactions?: Reaction[];
  edited?: boolean;
  deleted?: boolean;
  /** Waiting for its decryption key. */
  encrypted?: boolean;
  /** Room event (join, rename, ...) shown as a grey line; `body` holds its description. */
  event?: RoomEvent;
  avatar?: string;
  replyTo?: string;
  threadRoot?: string;
  media?: { id: string; kind: "image" | "video" | "audio" | "file" | "sticker"; name: string; mime?: string | null };
}

export interface Reaction {
  key: string;
  count: number;
  mine: boolean;
  senders: string[];
}

/** What the composer hands to the app when sending. */
export interface Outgoing {
  text: string;
  emote?: boolean;
  replyTo?: string;
  threadRoot?: string;
  /** User ids mentioned in the text. */
  mentions?: string[];
  /** Files sent with `text` as their caption. */
  attachments?: Attachment[];
}

/** A file waiting in the composer until the user presses Send. */
export interface Attachment {
  id: string;
  name: string;
  size: number;
  /** Picked or dropped file on disk. */
  path?: string;
  /** Pasted file (clipboard has no path). */
  file?: File;
  /** Object URL for image thumbnails. */
  preview?: string;
}

export interface Member {
  userId: string;
  name: string;
  avatar?: string | null;
}
