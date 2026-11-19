// Bridge to the Rust host. In a plain browser (npm run dev) there is no host,
// and the app falls back to mock data.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Attendee, Calendar, CalendarEvent, CloudFile, Conversation, ConversationKind, Member, Message, NewEvent, Org, Outgoing, Protocol } from "./types";
import { locale, t } from "./i18n";
import { describeEvent, type RoomEvent } from "./roomEvents";
import type { NotifyPrefs, Sounds } from "./settings";

export interface DeviceInfo {
  id: string;
  name: string | null;
  lastSeenIp: string | null;
  lastSeenTs: number | null;
  current: boolean;
  verified: boolean | null;
}
export type DeviceAuth = { kind: "none" } | { kind: "password"; password: string } | { kind: "browser"; session: string };
export type VerificationState =
  | { kind: "requested" }
  | { kind: "waiting" }
  | { kind: "ready"; qr: string | null; scan: boolean }
  | { kind: "qrScanned" }
  | { kind: "emojis"; emojis: [string, string][]; decimals: [number, number, number] }
  | { kind: "confirmed" }
  | { kind: "done" }
  | { kind: "cancelled"; reason: string; byUs: boolean };
export interface Verification {
  account: string;
  flowId: string;
  userId: string;
  deviceId: string | null;
  deviceName: string | null;
  weStarted: boolean;
  state: VerificationState;
}
export type VerificationAction = "accept" | "startSas" | "confirm" | "mismatch" | "cancel";
export type SignOutDevice = { kind: "done" } | { kind: "needsPassword" } | { kind: "needsBrowser"; url: string; session: string };

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
  archived: boolean;
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
  callActive: boolean;
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
  poll: string | null;
  reactions: Message["reactions"];
  edited: boolean;
  deleted: boolean;
  encrypted: boolean;
  untrusted: boolean;
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
  /** How to get in (inside teams): public, restricted (team members), knock (ask), invite. */
  joinRule: "public" | "restricted" | "knock" | "invite" | null;
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
  /** Key of the team this one sits in. */
  parent: string | null;
  /** Sort key shared with Element (MSC3230). */
  order: string | null;
}

export interface ActivityItem {
  id: string;
  kind: "mention" | "reply" | "reaction" | "keyword";
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
  ignored: boolean;
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
  members: RoomMember[];
  joinRule: "public" | "invite" | "knock" | "restricted";
  /** In a team, so "members of the team" can be chosen. */
  inTeam: boolean;
  canSetJoinRule: boolean;
  canEncrypt: boolean;
  canSetAlias: boolean;
  canKick: boolean;
  canBan: boolean;
  canSetRoles: boolean;
  myLevel: number;
  banned: RoomMember[];
  historyVisibility: "world_readable" | "shared" | "invited" | "joined";
  canSetHistory: boolean;
  /** [action, level] pairs, e.g. ["events_default", 0] = everyone may send messages. */
  permissions: [string, number][];
  /** [allow, deny] server lists, or null without an ACL. */
  serverAcl: [string[], string[]] | null;
  canSetAcl: boolean;
}

export interface RoomMember {
  userId: string;
  name: string;
  avatar: string | null;
  role: "admin" | "moderator" | null;
  level: number;
}

export interface SearchHit {
  conversation: string;
  conversationName: string;
  message: string;
  senderName: string;
  snippet: string;
  at: number;
}

export interface PickedFile {
  path: string;
  name: string;
  size: number;
  /** Readable by the webview as trixmedia "picked/<token>" (video stills). */
  token: string;
}

/** A still from a video being sent, with the video's size and length. */
export interface VideoThumb {
  data: number[];
  width: number;
  height: number;
  videoWidth: number;
  videoHeight: number;
  durationMs: number;
}

/** Address of a picked file for <video>/<img> in the webview. */
export const pickedUrl = (token: string) => (isLive ? convertFileSrc(`picked/${token}`, "trixmedia") : "");

/** A still about a second into the video, at most 800 px wide, as JPEG. */
export function videoThumb(src: string): Promise<VideoThumb> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.playsInline = true;
    const timer = window.setTimeout(() => { video.src = ""; reject(new Error("no still")); }, 15_000);
    video.onerror = () => { window.clearTimeout(timer); reject(new Error("unreadable video")); };
    video.onloadedmetadata = () => { video.currentTime = Math.min(1, (video.duration || 0) / 10); };
    video.onseeked = () => {
      const scale = Math.min(1, 800 / (video.videoWidth || 800));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(async (blob) => {
        window.clearTimeout(timer);
        if (!blob) return reject(new Error("no still"));
        resolve({
          data: Array.from(new Uint8Array(await blob.arrayBuffer())),
          width: canvas.width,
          height: canvas.height,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          durationMs: Math.round((video.duration || 0) * 1000),
        });
        video.src = "";
      }, "image/jpeg", 0.8);
    };
    video.src = src;
  });
}

export interface LoginMethods {
  homeserver: string;
  password: boolean;
  sso: boolean;
  /** OAuth 2.0 (Matrix Authentication Service): sign in on the server's page. */
  oauth: boolean;
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

/** A message waiting to be sent later. */
export interface ScheduledMessage {
  id: string;
  conversation: string;
  at: number;
  text: string;
  html?: string;
  /** Why the last attempt failed (it's tried again a minute later). */
  error?: string;
}

/** A web page's title, description and picture, for a link's preview card. */
export interface LinkPreviewData {
  /** Where the link ended up after redirects. */
  finalUrl: string;
  siteName?: string;
  title?: string;
  description?: string;
  /** A data: URL. */
  image?: string;
}

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
  archived: c.archived,
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
  callActive: c.callActive,
});

const toMessage = (m: MessageWire): Message => ({
  id: m.id,
  pos: m.pos,
  sender: m.fromMe ? t("message.you") : m.senderName,
  senderId: m.sender,
  time: new Date(m.sentAt).toLocaleString(locale(), { weekday: "long", hour: "2-digit", minute: "2-digit" }),
  ts: m.sentAt,
  body: m.body,
  html: m.html ?? undefined,
  fromMe: m.fromMe,
  avatar: m.senderAvatar ?? undefined,
  replyTo: m.replyTo ?? undefined,
  threadRoot: m.threadRoot ?? undefined,
  media: m.media ?? undefined,
  poll: m.poll ?? undefined,
  reactions: m.reactions,
  edited: m.edited,
  deleted: m.deleted,
  encrypted: m.encrypted,
  untrusted: m.untrusted,
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

/** A thread in a conversation (the list of threads). */
export interface ThreadInfo {
  root: string;
  senderName: string;
  senderAvatar: string | null;
  preview: string;
  sentAt: number;
  replies: number;
  latestName: string | null;
  latestAt: number | null;
  mine: boolean;
}

/** Someone whose encryption identity changed (invisible crypto). */
export interface IdentityWarning {
  userId: string;
  name: string;
  /** You had verified them; sending stops until you verify again or withdraw it. */
  wasVerified: boolean;
}

/** Fired (on window) after a calendar change made in the app; meeting reminders look again. */
export const CALENDAR_CHANGED = "trix:calendar-changed";
const calendarChanged = <T,>(done: Promise<T>) => done.then((v) => { window.dispatchEvent(new Event(CALENDAR_CHANGED)); return v; });

export const backend = {
  accounts: async () => (await invoke<AccountWire[]>("accounts")).map(toOrg),
  restored: () => invoke<boolean>("restored"),
  /** Accounts and chat list saved by the previous run, to show while reconnecting. */
  cachedChatList: async () => {
    const cached = await invoke<[AccountWire[], ConversationWire[]] | null>("cached_chat_list");
    return cached ? { orgs: cached[0].map(toOrg), convs: cached[1].map(toConversation) } : null;
  },
  conversations: async () => (await invoke<ConversationWire[]>("conversations")).map(toConversation),
  teams: () => invoke<TeamView[]>("teams"),
  activity: () => invoke<ActivityItem[]>("activity"),
  /** Full history (local encrypted index) plus loaded messages; optionally one conversation. */
  searchMessages: (query: string, conversation: string | null = null) => invoke<SearchHit[]>("search_messages", { query, conversation }),
  /** Translations for texts made in Rust ("rust.*" keys without the prefix). */
  imagePacks: (key: string) => invoke<ImagePack[]>("image_packs", { key }),
  ownPack: (account: string) => invoke<ImagePack>("own_pack", { account }),
  saveOwnPack: (account: string, pack: ImagePack) => invoke<void>("save_own_pack", { account, pack }),
  uploadImage: (account: string, mime: string, data: string) => invoke<string>("upload_image", { account, mime, data }),
  poll: (key: string, poll: string) => invoke<PollView>("poll", { key, poll }),
  vote: (key: string, poll: string, answers: string[]) => invoke<void>("vote", { key, poll, answers }),
  endPoll: (key: string, poll: string) => invoke<void>("end_poll", { key, poll }),
  createPoll: (key: string, question: string, answers: string[], maxSelections: number, disclosed: boolean) =>
    invoke<void>("create_poll", { key, question, answers, maxSelections, disclosed }),
  sendSticker: (key: string, url: string, body: string) => invoke<void>("send_sticker", { key, url, body }),
  sendVoice: (key: string, v: { mime: string; data: string; durationMs: number; waveform: number[] }) =>
    invoke<void>("send_voice", { key, mime: v.mime, data: v.data, durationMs: v.durationMs, waveform: v.waveform }),
  /** Talk call engine: Talk's call/signalling REST API; returns [JSON data, server URL]. */
  callApi: (account: string, method: string, path: string, form: [string, string][], timeout = 30) =>
    invoke<[string, string]>("call_api", { account, method, path, form, timeout }),
  logUi: (message: string) => invoke<void>("log_ui", { message }),
  sendCallEvent: (key: string, eventType: string, content: string) => invoke<void>("send_call_event", { key, eventType, content }),
  turnServers: (account: string) => invoke<{ uris: string[]; username: string; password: string } | null>("turn_servers", { account }),
  setTexts: (texts: Record<string, string>) => invoke<void>("set_texts", { texts }),
  cloudFiles: (account: string, path: string) => invoke<CloudFile[]>("cloud_files", { account, path }),
  /** Shares a Nextcloud file into the chat; returns a public link instead when the chat is on another account. */
  attachCloudFile: (account: string, path: string, key: string, caption: string | null) =>
    invoke<string | null>("attach_cloud_file", { account, path, key, caption }),
  calendars: (account: string) => invoke<Calendar[]>("calendars", { account }),
  calendarEvents: (account: string, from: string, to: string) => invoke<CalendarEvent[]>("calendar_events", { account, from, to }),
  createEvent: (account: string, event: NewEvent) => calendarChanged(invoke<void>("create_event", { account, event })),
  updateEvent: (account: string, href: string, etag: string | null, event: NewEvent) => calendarChanged(invoke<void>("update_event", { account, href, etag, event })),
  deleteEvent: (account: string, href: string, etag: string | null, occurrence: string | null = null) => calendarChanged(invoke<void>("delete_event", { account, href, etag, occurrence })),
  respondEvent: (account: string, href: string, etag: string | null, status: "ACCEPTED" | "TENTATIVE" | "DECLINED") =>
    calendarChanged(invoke<void>("respond_event", { account, href, etag, status })),
  /** A silent system notification (the app plays the sound itself), e.g. a meeting reminder. */
  notify: (title: string, body: string) => invoke<void>("notify", { title, body }),
  /** Do not disturb until this time (ms), or off: the core then shows no system notifications. */
  setDnd: (until: number | null) => invoke<void>("set_dnd", { until }),
  /** An incoming Matrix call's notification (none during do not disturb; also to ntfy). */
  notifyCall: (title: string, body: string) => invoke<void>("notify_call", { title, body }),
  /** ntfy add-on: its settings (null: off); the access token goes into the keychain. */
  setNtfy: (prefs: { server: string; topic: string; onlyAway: boolean; awayAfterSecs: number; includeText: boolean } | null) => invoke<void>("set_ntfy", { prefs }),
  setNtfyToken: (token: string | null) => invoke<void>("set_ntfy_token", { token }),
  hasNtfyToken: () => invoke<boolean>("has_ntfy_token"),
  testNtfy: () => invoke<void>("test_ntfy"),
  /** Send later: the message goes out at `at` (ms), sent by this app. */
  scheduleMessage: (key: string, m: Outgoing, at: number) =>
    invoke<string>("schedule_message", { key, at, text: m.text, emote: !!m.emote, replyTo: m.replyTo ?? null, threadRoot: m.threadRoot ?? null, mentions: m.mentions ?? [], html: m.html ?? null, msgtype: m.msgtype ?? null, emotes: m.emotes ?? null }),
  scheduledMessages: () => invoke<ScheduledMessage[]>("scheduled_messages"),
  /** Takes a scheduled message off the list; returns it (to edit it again). */
  cancelScheduled: (id: string) => invoke<ScheduledMessage | null>("cancel_scheduled", { id }),
  sendScheduledNow: (id: string) => invoke<void>("send_scheduled_now", { id }),
  /** A link's preview, fetched by the app itself (not via the homeserver); null when there's none. */
  linkPreview: (url: string) => invoke<LinkPreviewData | null>("link_preview", { url }),
  /** Your own ringtone: saved in the app's data folder / read back. */
  saveRingtone: (data: Uint8Array) => invoke<void>("save_ringtone", data),
  ringtone: () => invoke<ArrayBuffer>("ringtone"),
  /** Your own moving camera background (video or GIF): saved in the app's data folder / read back. */
  saveBackgroundVideo: (data: Uint8Array) => invoke<void>("save_background_video", data),
  backgroundVideo: () => invoke<ArrayBuffer>("background_video"),
  /** Meeting reminders (JSON list, `count` rows) in a small window on top of everything. */
  openReminder: (reminders: string, count: number) => invoke<void>("open_reminder", { reminders, count }),
  closeReminder: () => invoke<void>("close_reminder"),
  /** A button in the reminder window, for the app to act on (it keeps the list). */
  reminderAction: (action: string, key: string) => invoke<void>("reminder_action", { action, key }),
  /** Red border (whole screen shared) and Stop sharing bar; width/height of the capture find the screen. */
  shareOverlay: (border: boolean, width: number, height: number) => invoke<void>("share_overlay", { border, width, height }),
  hideShareOverlay: () => invoke<void>("hide_share_overlay"),
  stopSharing: () => invoke<void>("stop_sharing"),
  callApiUpload: (account: string, path: string, field: string, fileName: string, mime: string, data: number[]) =>
    invoke<string>("call_api_upload", { account, path, field, fileName, mime, data }),
  cloudFileBytes: (account: string, path: string) => invoke<number[]>("cloud_file_bytes", { account, path }),
  openCallWindow: (params: string, title: string, docked: boolean) => invoke<void>("open_call_window", { params, title, docked }),
  popOutCall: () => invoke<void>("pop_out_call"),
  popInCall: () => invoke<void>("pop_in_call"),
  dockCallWindow: (minimized: boolean, height: number) => invoke<void>("dock_call_window", { minimized, height }),
  callPageSize: (width: number, height: number) => invoke<void>("call_page_size", { width, height }),
  focusCallWindow: () => invoke<void>("focus_call_window"),
  closeCallWindow: () => invoke<void>("close_call_window"),
  callWindowState: (conversation: string | null) => invoke<void>("call_window_state", { conversation }),
  audioOutputs: () => invoke<{ id: number; name: string; current: boolean }[]>("audio_outputs"),
  setAudioOutput: (id: number) => invoke<void>("set_audio_output", { id }),
  forwardMessage: (key: string, message: string, target: string, note: string | null) => invoke<void>("forward_message", { key, message, target, note }),
  calendarPeople: (account: string, term: string) => invoke<Attendee[]>("calendar_people", { account, term }),
  conversationLink: (key: string) => invoke<string>("conversation_link", { key }),
  shared: (key: string, kind: "media" | "files" | "links", before: number | null) => invoke<SharedItem[]>("shared", { key, kind, before }),
  /** Messages in the local index, or null when there's no index (keychain unavailable). */
  searchStatus: () => invoke<number | null>("search_status"),
  messages: async (key: string) => (await invoke<MessageWire[]>("messages", { key })).map(toMessage),
  loginMethods: (homeserver: string) => invoke<LoginMethods>("login_methods", { homeserver }),
  loginPassword: (homeserver: string, username: string, password: string) =>
    invoke<AccountWire>("login_password", { homeserver, username, password }),
  loginSso: (homeserver: string, identityProvider: string | null) => invoke<AccountWire>("login_sso", { homeserver, identityProvider }),
  loginOauth: (homeserver: string) => invoke<AccountWire>("login_oauth", { homeserver }),
  loginTalk: (server: string) => invoke<AccountWire>("login_talk", { server }),
  signOut: (account: string) => invoke<void>("sign_out", { account }),
  /** Resolves to the new message's id. */
  send: (key: string, m: Outgoing) =>
    invoke<string>("send", { key, text: m.text, emote: !!m.emote, replyTo: m.replyTo ?? null, threadRoot: m.threadRoot ?? null, mentions: m.mentions ?? [], html: m.html ?? null, msgtype: m.msgtype ?? null, emotes: m.emotes ?? null }),
  members: (key: string) => invoke<Member[]>("members", { key }),
  runCommand: (key: string, name: string, args: string) => invoke<CommandOutput>("run_command", { key, name, args }),
  pickFiles: () => invoke<PickedFile[]>("pick_files"),
  describeFiles: (paths: string[]) => invoke<PickedFile[]>("describe_files", { paths }),
  filePreview: (path: string) => invoke<number[]>("file_preview", { path }),
  sendFilePaths: (key: string, paths: string[], caption: string | null, thumb: VideoThumb | null = null) => invoke<void>("send_file_paths", { key, paths, caption, thumb }),
  sendFileBytes: (key: string, name: string, mime: string | null, data: number[], caption: string | null, thumb: VideoThumb | null = null) =>
    invoke<void>("send_file_bytes", { key, name, mime, data, caption, thumb }),
  focus: (key: string | null) => invoke<void>("focus", { key }),
  markUnread: (key: string) => invoke<void>("mark_unread", { key }),
  markRead: (key: string) => invoke<void>("mark_read", { key }),
  setFavourite: (key: string, value: boolean) => invoke<void>("set_favourite", { key, value }),
  setHistoryVisibility: (key: string, visibility: string) => invoke<void>("set_history_visibility", { key, visibility }),
  setPermission: (key: string, permission: string, level: number) => invoke<void>("set_permission", { key, permission, level }),
  setServerAcl: (key: string, allow: string[], deny: string[]) => invoke<void>("set_server_acl", { key, allow, deny }),
  setTeamRoom: (team: string, room: string, add: boolean) => invoke<void>("set_team_room", { team, room, add }),
  setTeamOrder: (team: string, order: string | null) => invoke<void>("set_team_order", { team, order }),
  enableEncryption: (key: string) => invoke<void>("enable_encryption", { key }),
  /** "restricted": members of the team(s) the room is in can join. */
  setJoinRule: (key: string, rule: "public" | "invite" | "restricted") => invoke<void>("set_join_rule", { key, rule }),
  setRoomAlias: (key: string, name: string) => invoke<string>("set_room_alias", { key, name }),
  setArchived: (key: string, value: boolean) => invoke<void>("set_archived", { key, value }),
  loadOlder: (key: string, limit: number | null = null) => invoke<boolean>("load_older", { key, limit }),
  /** First loaded message at/after `ts` (ms) and the oldest loaded time, for /jumptodate. */
  messageContext: async (key: string, message: string) => (await invoke<MessageWire[]>("message_context", { key, message })).map(toMessage),
  messageAt: (key: string, ts: number) => invoke<[string | null, number | null]>("message_at", { key, ts }),
  loadThread: (key: string, root: string) => invoke<void>("load_thread", { key, root }),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  openCall: (key: string, title: string) => invoke<void>("open_call", { key, title }),
  setPresence: (account: string, presence: string, status: string | null) => invoke<void>("set_presence", { account, presence, status }),
  acceptInvite: (key: string) => invoke<void>("accept_invite", { key }),
  /** Leave a chat, or decline an invite. */
  leave: (key: string) => invoke<void>("leave", { key }),
  searchUsers: (account: string, term: string) => invoke<Member[]>("search_users", { account, term }),
  /** A room; `space`: a team; `team`: a channel in that team (its room id). */
  createRoom: (account: string, room: { name: string; topic: string | null; public: boolean; encrypted: boolean; alias: string | null; invite: string[]; space?: boolean; team?: string | null }) =>
    invoke<CommandOutput>("create_room", { account, room }),
  /** macOS: the system spell checker's correction for the last word of `text`. */
  spellSuggestion: (text: string) => invoke<string | null>("spell_suggestion", { text }),
  threads: (key: string, mine: boolean) => invoke<ThreadInfo[]>("threads", { key, mine }),
  identityWarnings: (key: string) => invoke<IdentityWarning[]>("identity_warnings", { key }),
  acceptIdentity: (account: string, userId: string) => invoke<void>("accept_identity", { account, userId }),
  createChat: (account: string, users: string[], name: string | null) => invoke<CommandOutput>("create_chat", { account, users, name }),
  roomPreview: (account: string, address: string, via: string[]) => invoke<DirectoryRoom>("room_preview", { account, address, via }),
  knock: (account: string, address: string, via: string | null = null) => invoke<void>("knock", { account, address, via }),
  joinRoom: (account: string, address: string, via: string | null = null) => invoke<CommandOutput>("join_room", { account, address, via }),
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
  pickImageFile: () => invoke<string | null>("pick_image_file"),
  setRoomMemberAvatar: (key: string, png: string) => invoke<void>("set_room_member_avatar", { key, png }),
  setRoomAvatar: (key: string, png: string) => invoke<void>("set_room_avatar", { key, png }),
  setNotificationLevel: (key: string, level: string) => invoke<void>("set_notification_level", { key, level }),
  inviteUser: (key: string, userId: string) => invoke<void>("invite_user", { key, userId }),
  setTyping: (key: string, typing: boolean) => invoke<void>("set_typing", { key, typing }),
  saveMedia: (account: string, media: string, name: string) => invoke<boolean>("save_media", { account, media, name }),
  openMedia: (account: string, media: string, name: string) => invoke<void>("open_media", { account, media, name }),
  setNotifyPrefs: (prefs: NotifyPrefs, sounds: Sounds) => invoke<void>("set_notify_prefs", { prefs, sounds }),
  testNotification: (kind: "message" | "mention" | "call", title: string, body: string) => invoke<void>("test_notification", { kind, title, body }),
  setCloseToTray: (enabled: boolean, openLabel: string, quitLabel: string) => invoke<void>("set_close_to_tray", { enabled, openLabel, quitLabel }),
  autostart: () => invoke<boolean>("autostart"),
  setAutostart: (enabled: boolean) => invoke<void>("set_autostart", { enabled }),
  idleSeconds: () => invoke<number | null>("idle_seconds"),
  setTrayUnread: (count: number, tooltip: string) => invoke<void>("set_tray_unread", { count, tooltip }),
  setPrivacy: (shareReceipts: boolean, shareTyping: boolean) => invoke<void>("set_privacy", { shareReceipts, shareTyping }),
  setDisplayName: (account: string, name: string) => invoke<void>("set_display_name", { account, name }),
  setAvatar: (account: string, png: string) => invoke<void>("set_avatar", { account, png }),
  devices: (account: string) => invoke<DeviceInfo[]>("devices", { account }),
  renameDevice: (account: string, deviceId: string, name: string) => invoke<void>("rename_device", { account, deviceId, name }),
  contactInfos: (account: string) => invoke<{ medium: string; address: string }[]>("contact_infos", { account }),
  removeContactInfo: (account: string, medium: string, address: string) => invoke<void>("remove_contact_info", { account, medium, address }),
  addEmailStart: (account: string, email: string) => invoke<string>("add_email_start", { account, email }),
  addEmailFinish: (account: string, token: string, auth: DeviceAuth) => invoke<SignOutDevice>("add_email_finish", { account, token, auth }),
  signOutDevice: (account: string, deviceId: string, auth: DeviceAuth) => invoke<SignOutDevice>("sign_out_device", { account, deviceId, auth }),
  serverKeywords: () => invoke<string[]>("server_keywords"),
  syncKeywords: (keywords: string[]) => invoke<void>("sync_keywords", { keywords }),
  userDevices: (account: string, userId: string) => invoke<DeviceInfo[]>("user_devices", { account, userId }),
  setIgnored: (account: string, userId: string, ignored: boolean) => invoke<void>("set_ignored", { account, userId, ignored }),
  startVerification: (account: string, userId: string, deviceId: string | null = null) => invoke<void>("start_verification", { account, userId, deviceId }),
  scanVerificationQr: (v: Verification, data: number[]) => invoke<void>("scan_verification_qr", { account: v.account, userId: v.userId, flowId: v.flowId, data }),
  verificationAction: (v: Verification, action: VerificationAction) => invoke<void>("verification_action", { account: v.account, userId: v.userId, flowId: v.flowId, action }),
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
  verification: (v: Verification) => void;
  upload: (p: UploadProgress) => void;
}

/** Result of a command; `text` is set when the UI should word it in its own language. */
export interface CommandOutput {
  message: string;
  open: string | null;
  text: { key: string; args: Record<string, string> } | null;
}

/** Custom emoji / sticker pack (MSC2545). */
export interface ImagePack {
  name: string;
  images: { shortcode: string; url: string; body: string | null; emoticon: boolean; sticker: boolean }[];
}
export type PackImage = ImagePack["images"][number];

export interface SharedItem {
  message: string;
  senderName: string;
  fromMe: boolean;
  at: number;
  media: { id: string; kind: "image" | "video" | "audio" | "file" | "sticker"; name: string; mime: string | null } | null;
  links: string[];
  text: string;
}

export interface UploadProgress {
  conversation: string;
  name: string;
  sent: number;
  total: number;
}

export interface CallSignal {
  conversation: string;
  eventType: string;
  /** JSON text of the event content. */
  content: string;
  sender: string;
  fromMe: boolean;
  ageMs: number;
}

export interface PollView {
  question: string;
  /** [answer id, text, votes] */
  answers: [string, string, number][];
  maxSelections: number;
  disclosed: boolean;
  ended: boolean;
  mine: string[];
  voters: number;
  ours: boolean;
}

/** Fires with (conversation, poll id) when someone votes in or ends a poll. */
export const onPollChanged = (cb: (conversation: string, poll: string) => void) => listen<[string, string]>("trix://poll", (e) => cb(...e.payload));

/** 1:1 call events (m.call.*) for the call engine in calls.ts. */
export const onCallSignal = (cb: (sig: CallSignal) => void) => listen<CallSignal>("trix://call", (e) => cb(e.payload));

/** Fired on window when the signed-in accounts change, e.g. so failed pictures retry. */
export const ACCOUNTS_CHANGED = "ms_trix:accounts";

export async function subscribe(on: BackendEvents): Promise<UnlistenFn> {
  const offs = await Promise.all([
    listen<AccountWire[]>("trix://accounts", (e) => { on.accounts(e.payload.map(toOrg)); window.dispatchEvent(new Event(ACCOUNTS_CHANGED)); }),
    listen<ConversationWire[]>("trix://conversations", (e) => on.conversations(e.payload.map(toConversation))),
    listen<string[]>("trix://removed", (e) => on.removed(e.payload)),
    listen<MessageWire[]>("trix://messages", (e) => on.messages(e.payload.map((m) => ({ key: m.conversation, message: toMessage(m) })))),
    listen("trix://restored", () => on.restored()),
    listen<TeamView[]>("trix://teams", (e) => on.teams(e.payload)),
    listen<ActivityItem[]>("trix://activity", (e) => on.activity(e.payload)),
    listen<Verification>("trix://verification", (e) => on.verification(e.payload)),
    listen<UploadProgress>("trix://upload", (e) => on.upload(e.payload)),
    listen<[string, string]>("trix://account-error", (e) => on.accountError(...e.payload)),
  ]);
  return () => offs.forEach((off) => off());
}
