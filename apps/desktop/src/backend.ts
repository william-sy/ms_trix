// Bridge to the Rust host. In a plain browser (npm run dev) there is no host,
// and the app falls back to mock data.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Conversation, ConversationKind, Member, Message, Org, Outgoing, Protocol } from "./types";
import { locale, t } from "./i18n";
import { describeEvent, type RoomEvent } from "./roomEvents";

export const isLive = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// ---- Wire types (mirror trix-core / trix-matrix serde output) ----

interface AccountWire {
  id: string;
  protocol: string;
  org_name: string;
  user_id: string;
  display_name: string;
  avatar_url: string | null;
}

interface ConversationWire {
  key: string;
  account: string;
  kind: ConversationKind;
  team: string | null;
  name: string;
  favourite: boolean;
  muted: boolean;
  mentionsOnly: boolean;
  encrypted: boolean;
  unread: number;
  mentions: number;
  marked: boolean;
  preview: string;
  lastAt: number;
  avatar: string | null;
  readers: { userId: string; name: string; avatar: string | null; pos: number }[];
  typing: string[];
  presence: Conversation["presence"];
  status: string | null;
  invitedBy: string | null;
  dmUser: string | null;
}

interface MessageWire {
  conversation: string;
  id: string;
  pos: number;
  sender: string;
  senderName: string;
  sentAt: number;
  body: string;
  html: string | null;
  fromMe: boolean;
  senderAvatar: string | null;
  replyTo: string | null;
  threadRoot: string | null;
  media: Message["media"] | null;
  reactions: Message["reactions"];
  edited: boolean;
  deleted: boolean;
  encrypted: boolean;
  event: RoomEvent | null;
}

export interface SecurityStatus {
  deviceVerified: boolean;
  recovery: "unknown" | "enabled" | "incomplete" | "disabled";
}

export interface DirectoryRoom {
  id: string;
  alias: string | null;
  name: string;
  topic: string | null;
  members: number;
  avatar: string | null;
  isSpace: boolean;
  joined: string | null;
}

export interface TeamView {
  key: string;
  account: string;
  name: string;
  topic: string | null;
  avatar: string | null;
  channels: string[];
  spaceId: string;
  notJoined: number;
}

export interface ActivityItem {
  id: string;
  kind: "mention" | "reply" | "reaction";
  conversation: string;
  conversationName: string;
  message: string;
  senderName: string;
  senderAvatar: string | null;
  preview: string;
  reaction: string | null;
  at: number;
}

export interface Profile {
  userId: string;
  name: string;
  avatar: string | null;
  verified: boolean | null;
  shared: string[];
}

export interface RoomDetails {
  name: string;
  topic: string | null;
  avatar: string | null;
  alias: string | null;
  encrypted: boolean;
  isDirect: boolean;
  notifications: "all" | "mentions" | "mute";
  canEdit: boolean;
  canInvite: boolean;
  members: { userId: string; name: string; avatar: string | null; role: "admin" | "moderator" | null }[];
}

export interface SearchHit {
  conversation: string;
  conversationName: string;
  message: string;
  senderName: string;
  snippet: string;
  at: number;
}

export interface LoginMethods {
  homeserver: string;
  password: boolean;
  sso: boolean;
  identity_providers: { id: string; name: string }[];
}

// ---- Mapping to UI types ----

const palette = ["#e4572e", "#0dbd8b", "#7c6fd8", "#2d9cdb", "#d4a017", "#c2185b", "#00897b", "#6d4c41"];

const colorFor = (id: string) => palette[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) % palette.length]!;

const toOrg = (a: AccountWire): Org => ({
  id: a.id,
  name: a.org_name,
  protocol: a.protocol as Protocol,
  userId: a.user_id,
  displayName: a.display_name,
  color: colorFor(a.id),
  avatar: a.avatar_url ?? undefined,
  presence: "available",
});

export function formatTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
  if (now.getTime() - ts < 6 * 864e5) return d.toLocaleDateString(locale(), { weekday: "short" });
  return d.toLocaleDateString(locale(), { day: "2-digit", month: "2-digit" });
}

const toConversation = (c: ConversationWire): Conversation => ({
  id: c.key,
  orgId: c.account,
  kind: c.kind,
  name: c.name,
  team: c.team ?? undefined,
  preview: c.preview,
  time: formatTime(c.lastAt),
  sortKey: c.lastAt,
  favourite: c.favourite,
  muted: c.muted,
  mentionsOnly: c.mentionsOnly,
  encrypted: c.encrypted,
  unread: c.unread,
  mentions: c.mentions,
  marked: c.marked,
  avatar: c.avatar ?? undefined,
  readers: c.readers,
  typing: c.typing,
  presence: c.presence,
  status: c.status,
  invitedBy: c.invitedBy,
  dmUser: c.dmUser,
});

const toMessage = (m: MessageWire): Message => ({
  id: m.id,
  pos: m.pos,
  sender: m.fromMe ? t("message.you") : m.senderName,
  senderId: m.sender,
  time: new Date(m.sentAt).toLocaleString(locale(), { weekday: "long", hour: "2-digit", minute: "2-digit" }),
  body: m.body,
  html: m.html ?? undefined,
  fromMe: m.fromMe,
  avatar: m.senderAvatar ?? undefined,
  replyTo: m.replyTo ?? undefined,
  threadRoot: m.threadRoot ?? undefined,
  media: m.media ?? undefined,
  reactions: m.reactions,
  edited: m.edited,
  deleted: m.deleted,
  encrypted: m.encrypted,
  event: m.event ?? undefined,
  system: !!m.event,
  ...(m.event ? { body: describeEvent(m.event) } : {}),
});

/** URL the webview can load for a media id, via the host's trixmedia:// protocol. */
export const mediaUrl = (account: string, media: string, size?: number, mime?: string | null) => {
  if (!isLive) return undefined;
  const params = [size ? `w=${size}&h=${size}` : "", mime ? `type=${encodeURIComponent(mime)}` : ""].filter(Boolean).join("&");
  return convertFileSrc(`${account}/${media}`, "trixmedia") + (params ? `?${params}` : "");
};

// ---- Commands ----

export const backend = {
  accounts: async () => (await invoke<AccountWire[]>("accounts")).map(toOrg),
  restored: () => invoke<boolean>("restored"),
  conversations: async () => (await invoke<ConversationWire[]>("conversations")).map(toConversation),
  teams: () => invoke<TeamView[]>("teams"),
  activity: () => invoke<ActivityItem[]>("activity"),
  searchMessages: (query: string) => invoke<SearchHit[]>("search_messages", { query }),
  messages: async (key: string) => (await invoke<MessageWire[]>("messages", { key })).map(toMessage),
  loginMethods: (homeserver: string) => invoke<LoginMethods>("login_methods", { homeserver }),
  loginPassword: (homeserver: string, username: string, password: string) =>
    invoke<AccountWire>("login_password", { homeserver, username, password }),
  loginSso: (homeserver: string, identityProvider: string | null) => invoke<AccountWire>("login_sso", { homeserver, identityProvider }),
  signOut: (account: string) => invoke<void>("sign_out", { account }),
  send: (key: string, m: Outgoing) =>
    invoke<void>("send", { key, text: m.text, emote: !!m.emote, replyTo: m.replyTo ?? null, threadRoot: m.threadRoot ?? null, mentions: m.mentions ?? [] }),
  members: (key: string) => invoke<Member[]>("members", { key }),
  runCommand: (key: string, name: string, args: string) => invoke<{ message: string; open: string | null }>("run_command", { key, name, args }),
  pickFiles: () => invoke<{ path: string; name: string; size: number }[]>("pick_files"),
  describeFiles: (paths: string[]) => invoke<{ path: string; name: string; size: number }[]>("describe_files", { paths }),
  filePreview: (path: string) => invoke<number[]>("file_preview", { path }),
  sendFilePaths: (key: string, paths: string[], caption: string | null) => invoke<void>("send_file_paths", { key, paths, caption }),
  sendFileBytes: (key: string, name: string, mime: string | null, data: number[], caption: string | null) =>
    invoke<void>("send_file_bytes", { key, name, mime, data, caption }),
  focus: (key: string | null) => invoke<void>("focus", { key }),
  markUnread: (key: string) => invoke<void>("mark_unread", { key }),
  markRead: (key: string) => invoke<void>("mark_read", { key }),
  setFavourite: (key: string, value: boolean) => invoke<void>("set_favourite", { key, value }),
  loadOlder: (key: string) => invoke<boolean>("load_older", { key }),
  loadThread: (key: string, root: string) => invoke<void>("load_thread", { key, root }),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  setPresence: (account: string, presence: string, status: string | null) => invoke<void>("set_presence", { account, presence, status }),
  acceptInvite: (key: string) => invoke<void>("accept_invite", { key }),
  /** Leave a chat, or decline an invite. */
  leave: (key: string) => invoke<void>("leave", { key }),
  searchUsers: (account: string, term: string) => invoke<Member[]>("search_users", { account, term }),
  createChat: (account: string, users: string[], name: string | null) => invoke<{ message: string; open: string | null }>("create_chat", { account, users, name }),
  joinRoom: (account: string, address: string, via: string | null = null) => invoke<{ message: string; open: string | null }>("join_room", { account, address, via }),
  directory: (account: string, server: string, term: string, spaces: boolean) =>
    invoke<DirectoryRoom[]>("directory", { account, server: server || null, term, spaces }),
  spaceRooms: (account: string, space: string) => invoke<DirectoryRoom[]>("space_rooms", { account, space }),
  homeServer: (account: string) => invoke<string | null>("home_server", { account }),
  toggleReaction: (key: string, target: string, emoji: string) => invoke<void>("toggle_reaction", { key, target, emoji }),
  editMessage: (key: string, target: string, text: string) => invoke<void>("edit_message", { key, target, text }),
  deleteMessage: (key: string, target: string) => invoke<void>("delete_message", { key, target }),
  profile: (account: string, userId: string) => invoke<Profile>("profile", { account, userId }),
  roomDetails: (key: string) => invoke<RoomDetails>("room_details", { key }),
  updateRoom: (key: string, change: { name?: string; topic?: string }) => invoke<void>("update_room", { key, name: change.name ?? null, topic: change.topic ?? null }),
  pickRoomAvatar: (key: string) => invoke<boolean>("pick_room_avatar", { key }),
  setNotificationLevel: (key: string, level: string) => invoke<void>("set_notification_level", { key, level }),
  inviteUser: (key: string, userId: string) => invoke<void>("invite_user", { key, userId }),
  setTyping: (key: string, typing: boolean) => invoke<void>("set_typing", { key, typing }),
  saveMedia: (account: string, media: string, name: string) => invoke<boolean>("save_media", { account, media, name }),
  openMedia: (account: string, media: string, name: string) => invoke<void>("open_media", { account, media, name }),
  securityStatus: (account: string) => invoke<SecurityStatus>("security_status", { account }),
  recover: (account: string, recoveryKey: string) => invoke<SecurityStatus>("recover", { account, recoveryKey }),
};

export interface BackendEvents {
  accounts: (orgs: Org[]) => void;
  conversations: (convs: Conversation[]) => void;
  removed: (keys: string[]) => void;
  messages: (msgs: { key: string; message: Message }[]) => void;
  restored: () => void;
  accountError: (userId: string, error: string) => void;
  teams: (teams: TeamView[]) => void;
  activity: (items: ActivityItem[]) => void;
}

export async function subscribe(on: BackendEvents): Promise<UnlistenFn> {
  const offs = await Promise.all([
    listen<AccountWire[]>("trix://accounts", (e) => on.accounts(e.payload.map(toOrg))),
    listen<ConversationWire[]>("trix://conversations", (e) => on.conversations(e.payload.map(toConversation))),
    listen<string[]>("trix://removed", (e) => on.removed(e.payload)),
    listen<MessageWire[]>("trix://messages", (e) => on.messages(e.payload.map((m) => ({ key: m.conversation, message: toMessage(m) })))),
    listen("trix://restored", () => on.restored()),
    listen<TeamView[]>("trix://teams", (e) => on.teams(e.payload)),
    listen<ActivityItem[]>("trix://activity", (e) => on.activity(e.payload)),
    listen<[string, string]>("trix://account-error", (e) => on.accountError(...e.payload)),
  ]);
  return () => offs.forEach((off) => off());
}
