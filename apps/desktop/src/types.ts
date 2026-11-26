// Mirrors trix-core's model. Replaced by Tauri commands once the core is wired up.
import type { RoomEvent } from "./roomEvents";

export type Protocol = "matrix" | "talk" | "ntfy" | "xmpp" | "irc";

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
  /** Why its server can't be reached right now (shown as Offline, with Reconnect). */
  offline?: string;
}

export type ConversationKind = "direct" | "group" | "room" | "channel" | "meeting" | "team";

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
  /** Put away; shown in the Archived section unless it has something unread. */
  archived?: boolean;
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
  /** Someone is in a call in this conversation. */
  callActive?: boolean;
  /** The running call was started silently (Talk). */
  callSilent?: boolean;
  /** Messages can be pinned here (Matrix; Talk 23 and later). */
  canPin?: boolean;
  /** Changes whenever the pinned messages change; null when nothing is pinned. */
  pins?: string | null;
}

export type PresenceState = "available" | "busy" | "away" | "offline";

export interface Message {
  id: string;
  pos?: number;
  sender: string;
  /** Protocol user id, for opening the sender's profile. */
  senderId?: string;
  time: string;
  /** Sent at (ms since the epoch), for day dividers and grouping. */
  ts?: number;
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
  /** Not decrypted: sent from a device its owner hasn't verified. */
  untrusted?: boolean;
  /** Our copy of a message being sent, shown at once until the real one arrives. */
  local?: { txn: string; outgoing: Outgoing; /** The real message's id, once the server has it. */ realId?: string };
  /** For `local`: still sending, or sending failed. */
  status?: "sending" | "failed";
  /** Room event (join, rename, ...) shown as a grey line; `body` holds its description. */
  event?: RoomEvent;
  avatar?: string;
  replyTo?: string;
  threadRoot?: string;
  /** Poll id when this message is a poll (`body` is the question). */
  poll?: string;
  media?: {
    id: string; kind: "image" | "video" | "audio" | "file" | "sticker"; name: string; mime?: string | null; caption?: string | null;
    /** Voice messages: length and 0..1 waveform. */
    voice?: { durationMs: number; waveform: number[] } | null;
  };
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
  /** Ready-made HTML (spoiler, /html, /rainbow); `text` is the plain fallback. */
  html?: string;
  /** Custom message type (chat effects). */
  msgtype?: string;
  /** Custom emoji in `text` (as :shortcode:) with their mxc URLs. */
  emotes?: [string, string][];
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
  /** Object URL for image thumbnails (and the still of a video). */
  preview?: string;
  /** Still of a video, sent along so chats show it before playing. */
  thumb?: import("./backend").VideoThumb;
}

export interface Member {
  userId: string;
  name: string;
  avatar?: string | null;
}

/** A file or folder in Nextcloud Files. */
/** A notification from a Nextcloud itself (a share, a calendar invitation, …), apart from the chats'. */
export interface ServerNotification {
  id: number;
  /** The app it's from ("files_sharing", "spreed", …) and what about. */
  app: string;
  objectType: string;
  at: number;
  /** The subject in pieces: plain text (kind null) and named people, files and the like. */
  subject: { text: string; kind: string | null; id: string | null; link: string | null }[];
  message: string;
  link: string | null;
  icon: string | null;
  /** Buttons; method "WEB" opens the link. */
  actions: ServerAction[];
  /** False for ones the server keeps quiet. */
  alert: boolean;
}

export interface ServerAction {
  label: string;
  link: string;
  method: string;
  primary: boolean;
}

export interface CloudFile {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  mime?: string;
  modified?: string;
  fileId?: string;
}

export interface Calendar {
  id: string;
  name: string;
  color?: string;
  writable: boolean;
  /** Its time zone as the account set it (IANA id); new meetings are written in it. */
  timezone?: string;
}

/** One occurrence; times in iCalendar form: "20261117T090000Z", "20261117T090000" (local) or "20261117" (all day). */
export interface CalendarEvent {
  calendar: string;
  uid: string;
  summary: string;
  start: string;
  end?: string;
  location?: string;
  description?: string;
  organizer?: string;
  /** The calendar object, for editing and deleting. */
  href: string;
  etag?: string;
  /** Part of a repeating series. */
  recurring: boolean;
  /** Which occurrence of a repeating meeting this is. */
  recurrenceId?: string | null;
  attendees: Attendee[];
  /** You organise it, so you may change it. */
  mine: boolean;
  /** Your reply when you're invited: NEEDS-ACTION, ACCEPTED, DECLINED, TENTATIVE. */
  myStatus?: string;
}

export interface Attendee {
  name?: string;
  email: string;
  /** NEEDS-ACTION, ACCEPTED, DECLINED, TENTATIVE */
  status?: string;
  /** User id on the same Nextcloud (for the picture). */
  user?: string;
}

/** Someone's busy times from their Nextcloud; `busy` null when it doesn't know them. */
export interface FreeBusy {
  email: string;
  busy: BusyTime[] | null;
}

export interface BusyTime {
  /** Milliseconds since 1970. */
  start: number;
  end: number;
  /** BUSY, BUSY-TENTATIVE or BUSY-UNAVAILABLE (outside their working hours). */
  kind: string;
}

export interface NewEvent {
  calendar: string;
  summary: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
  attendees: Attendee[];
  /** Repeating meetings: the occurrence changed, and whether the whole series changes. */
  occurrence?: string;
  series?: boolean;
  /** A new repeating meeting: its RRULE, and the time zone its local start and end are in. */
  rrule?: string;
  tzid?: string;
  vtimezone?: string;
}

/** A note in Nextcloud Notes. */
export interface Note {
  id: number;
  title: string;
  /** Its folder ("" for none). */
  category: string;
  /** Seconds since 1970. */
  modified: number;
  favorite: boolean;
  readonly: boolean;
  etag: string;
  /** The Markdown text; only when one note was asked for. */
  content?: string;
}

/** What changes in a note (the editor sends all of it; moving between categories only that). */
export interface NoteChange {
  title?: string;
  content?: string;
  category?: string;
  favorite?: boolean;
}
