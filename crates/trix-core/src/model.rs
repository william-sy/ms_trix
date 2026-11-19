use serde::{Deserialize, Serialize};

/// Identifies a protocol implementation, e.g. `"matrix"`, `"xmpp"`, `"irc"`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ProtocolId(pub String);

/// Local identifier for a signed-in account. One account == one "org" in the UI.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AccountId(pub String);

/// A conversation is always scoped to the account it lives in, so two orgs
/// can contain the same remote room without colliding.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ConversationId {
    pub account: AccountId,
    /// Protocol-native id (Matrix room id, XMPP JID, IRC channel name, ...).
    pub remote: String,
}

impl ConversationId {
    /// Flat string form used by the UI: `<account>|<remote>`.
    pub fn key(&self) -> String {
        format!("{}|{}", self.account.0, self.remote)
    }

    pub fn from_key(key: &str) -> Option<Self> {
        let (account, remote) = key.split_once('|')?;
        Some(Self { account: AccountId(account.to_owned()), remote: remote.to_owned() })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct MessageId(pub String);

/// Position of an event in the client's local timeline order. Protocols
/// without a global ordering (Matrix) use the order events were received in.
pub type TimelinePos = u64;

/// Milliseconds since the Unix epoch.
pub type Timestamp = u64;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub id: AccountId,
    pub protocol: ProtocolId,
    /// Shown in the org switcher, e.g. "SURF".
    pub org_name: String,
    /// Protocol-native user id, e.g. `@william:surf.nl`.
    pub user_id: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
}

/// Maps onto the Teams concepts the UI renders.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ConversationKind {
    /// 1:1 chat.
    Direct,
    /// Ad-hoc group chat.
    Group,
    /// An invitation to a team (Matrix space); once joined it becomes a [`Team`].
    Team,
    /// A named room that isn't part of a team (Matrix room with a name outside any space).
    Room,
    /// Channel inside a team (Matrix space child, XMPP MUC, IRC channel).
    Channel { team: Option<String> },
    /// Chat attached to a call/meeting.
    Meeting,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: ConversationId,
    pub kind: ConversationKind,
    pub name: String,
    pub avatar_url: Option<String>,
    pub favourite: bool,
    /// Put away by the user (Matrix: our "u.archived" tag or m.lowpriority; Talk: archived).
    pub archived: bool,
    pub muted: bool,
    /// Notify only when mentioned (Matrix "mentions and keywords").
    pub mentions_only: bool,
    /// The other person in a 1:1 chat, for presence.
    pub dm_user: Option<String>,
    /// Set while we are invited but haven't joined: who invited us.
    pub invited_by: Option<String>,
    /// Remote id of the team (Matrix space) this channel belongs to.
    pub team_id: Option<String>,
    /// Someone is in a call in this conversation right now.
    pub call_active: bool,
    pub encrypted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub user_id: String,
    pub name: String,
    pub avatar: Option<String>,
}

/// Someone's public profile, as shown in the profile pop-up.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub user_id: String,
    pub name: String,
    pub avatar: Option<String>,
    /// Whether we verified their identity (None when unknown / not encrypted).
    pub verified: Option<bool>,
    /// Conversation keys of rooms we share with them.
    pub shared: Vec<String>,
    /// We hide their messages and invites (Matrix ignore list).
    pub ignored: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomMemberInfo {
    pub user_id: String,
    pub name: String,
    pub avatar: Option<String>,
    /// "admin" / "moderator", or None for regular members.
    pub role: Option<String>,
    /// Matrix power level (100 = admin, 50 = moderator); i64::MAX for room creators.
    pub level: i64,
}

/// One of the account's signed-in sessions (Matrix devices).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub name: Option<String>,
    pub last_seen_ip: Option<String>,
    pub last_seen_ts: Option<Timestamp>,
    /// The session ms_trix itself runs as.
    pub current: bool,
    /// Cross-signing verified; None when the protocol has no such notion.
    pub verified: Option<bool>,
}

/// How a device sign-out may be authorised.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum DeviceAuth {
    None,
    Password { password: String },
    /// The user finished the browser step for this auth session.
    Browser { session: String },
}

/// Result of a device sign-out attempt; the server may ask for more proof.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum SignOutDevice {
    Done,
    NeedsPassword,
    /// Open `url`, then retry with `DeviceAuth::Browser { session }`.
    NeedsBrowser { url: String, session: String },
}

/// A 1:1 call event (Matrix m.call.*), passed to the UI, which runs the call (WebRTC).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallSignal {
    /// Conversation key.
    pub conversation: String,
    /// e.g. "m.call.invite", "m.call.answer", "m.call.candidates", "m.call.hangup".
    pub event_type: String,
    /// The event content as JSON text.
    pub content: String,
    pub sender: String,
    /// Sent by us (from this or another session; check the content's party_id).
    pub from_me: bool,
    /// How old the event is, so stale invites from history don't ring.
    pub age_ms: u64,
}

/// TURN relay servers the homeserver hands out for calls.
#[derive(Debug, Clone, Serialize)]
pub struct TurnServers {
    pub uris: Vec<String>,
    pub username: String,
    pub password: String,
}

/// How far a file upload has got; `sent == total` when done.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadProgress {
    /// Conversation key.
    pub conversation: String,
    pub name: String,
    pub sent: u64,
    pub total: u64,
}

/// One emoji (SAS) verification, as the UI shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verification {
    pub account: String,
    pub flow_id: String,
    /// The other user; our own id when verifying one of our sessions.
    pub user_id: String,
    pub device_id: Option<String>,
    pub device_name: Option<String>,
    pub we_started: bool,
    pub state: VerificationState,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum VerificationState {
    /// They asked; waiting for us to accept.
    Requested,
    /// Waiting for the other side (to accept, or to start the emoji step).
    Waiting,
    /// Both sides are ready: show this QR code (SVG) for the other device to scan,
    /// scan theirs with the camera (`scan`: they can show one), or compare emoji instead.
    /// `qr` is None when the other side can't scan.
    Ready { qr: Option<String>, scan: bool },
    /// The other device scanned our code; confirm it now says verified.
    QrScanned,
    /// Compare these with the other screen. (symbol, English name) pairs.
    Emojis { emojis: Vec<(String, String)>, decimals: (u16, u16, u16) },
    /// We confirmed; waiting for the other side to confirm too.
    Confirmed,
    Done,
    Cancelled { reason: String, by_us: bool },
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VerificationAction {
    Accept,
    /// Compare emoji (from the Ready step).
    StartSas,
    /// The emojis match.
    Confirm,
    /// The emojis don't match.
    Mismatch,
    Cancel,
}

/// An email address or phone number linked to the account (Matrix 3PID).
#[derive(Debug, Clone, Serialize)]
pub struct ContactInfo {
    /// "email" or "msisdn" (phone).
    pub medium: String,
    pub address: String,
}

/// A set of custom emoji / stickers (Matrix image pack, MSC2545).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImagePack {
    pub name: String,
    pub images: Vec<PackImage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackImage {
    pub shortcode: String,
    /// mxc:// URL.
    pub url: String,
    pub body: Option<String>,
    pub emoticon: bool,
    pub sticker: bool,
}

/// A poll with its current results.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PollView {
    pub question: String,
    /// (answer id, text, votes)
    pub answers: Vec<(String, String, u32)>,
    pub max_selections: u32,
    /// Results visible before the poll ends.
    pub disclosed: bool,
    pub ended: bool,
    /// Answer ids we voted for.
    pub mine: Vec<String>,
    pub voters: u32,
    /// We started it, so we may end it.
    pub ours: bool,
}

/// What the New room form asks for.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewRoom {
    pub name: String,
    pub topic: Option<String>,
    /// Anyone can find and join it (Matrix: public + in the room directory; Talk: open conversation).
    pub public: bool,
    pub encrypted: bool,
    /// Address without # and :server.
    pub alias: Option<String>,
    pub invite: Vec<String>,
    /// A team (Matrix space) rather than a room.
    #[serde(default)]
    pub space: bool,
    /// Created as a channel in this team (its room id); unless public, the team's members can join.
    #[serde(default)]
    pub team: Option<String>,
}

/// A thread in a conversation, for the list of its threads.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadInfo {
    pub root: String,
    pub sender_name: String,
    pub sender_avatar: Option<String>,
    /// The first message's text (a short preview).
    pub preview: String,
    pub sent_at: u64,
    pub replies: u32,
    pub latest_name: Option<String>,
    pub latest_at: Option<u64>,
    /// You wrote in it (or started it).
    pub mine: bool,
}

/// Someone in a conversation whose encryption identity changed (invisible crypto). Their
/// messages still arrive, but you should know: it can mean a new login, or someone in the middle.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityWarning {
    pub user_id: String,
    pub name: String,
    /// You had verified them: more serious, and sending to the conversation stops until you
    /// verify again or withdraw the verification.
    pub was_verified: bool,
}

/// Everything the room info panel shows and may edit.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomDetails {
    pub name: String,
    pub topic: Option<String>,
    pub avatar: Option<String>,
    pub alias: Option<String>,
    pub encrypted: bool,
    pub is_direct: bool,
    /// "all", "mentions" or "mute".
    pub notifications: String,
    pub can_edit: bool,
    pub can_invite: bool,
    pub members: Vec<RoomMemberInfo>,
    /// Who can join: "public", "invite", "knock" or "restricted" (members of a space).
    pub join_rule: String,
    /// The room is in a team, so "members of the team" can be chosen as who can join.
    #[serde(default)]
    pub in_team: bool,
    pub can_set_join_rule: bool,
    /// Allowed to turn encryption on (and it's still off).
    pub can_encrypt: bool,
    pub can_set_alias: bool,
    pub can_kick: bool,
    pub can_ban: bool,
    pub can_set_roles: bool,
    pub my_level: i64,
    pub banned: Vec<RoomMemberInfo>,
    /// Who can read history: "world_readable", "shared", "invited" or "joined".
    pub history_visibility: String,
    pub can_set_history: bool,
    /// Level needed per action ("events_default" = send messages, "kick", "room_name", ...).
    pub permissions: Vec<(String, i64)>,
    /// Which servers may take part (Matrix server ACL); None when the room has no ACL.
    pub server_acl: Option<(Vec<String>, Vec<String>)>,
    pub can_set_acl: bool,
}

/// A team (Matrix space) we are a member of.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Team {
    pub id: ConversationId,
    pub name: String,
    pub topic: Option<String>,
    pub avatar_url: Option<String>,
    /// Remote ids of all rooms in the team, joined or not.
    pub children: Vec<String>,
    /// Our sort key for top-level teams, shared with Element (MSC3230 space order).
    pub order: Option<String>,
}

/// A room or space found in a directory or inside a space.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryRoom {
    pub id: String,
    pub alias: Option<String>,
    pub name: String,
    pub topic: Option<String>,
    pub members: u64,
    pub avatar: Option<String>,
    pub is_space: bool,
    /// Our conversation key if we are already in it.
    pub joined: Option<String>,
    /// How to get in: "public", "restricted" (members of the team), "knock" (ask), "invite".
    pub join_rule: Option<String>,
}

/// Result of a protocol command like `/join`.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutput {
    /// English; the UI shows `text` in its own language when set.
    pub message: String,
    /// Conversation to switch to (e.g. after /join or /query), once it has synced.
    pub open: Option<String>,
    pub text: Option<LocalText>,
}

/// A text the UI translates: a key from [`crate::texts`] plus its placeholder values.
#[derive(Debug, Clone, Default, Serialize)]
pub struct LocalText {
    pub key: String,
    pub args: std::collections::HashMap<String, String>,
}

impl CommandOutput {
    /// A result worded by `key` (see [`crate::texts`]).
    pub fn say(key: &str, vars: &[(&str, &str)], open: Option<String>) -> Self {
        Self {
            message: crate::texts::fill(crate::texts::english(key), vars),
            open,
            text: Some(LocalText { key: key.to_owned(), args: vars.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect() }),
        }
    }

    /// Just switches to `open`, nothing to say.
    pub fn open(key: String) -> Self {
        Self { message: String::new(), open: Some(key), text: None }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum MessageBody {
    Text { plain: String, html: Option<String> },
    Notice { plain: String },
    /// `media` is an opaque id the adapter resolves in `fetch_media`.
    /// `caption`: text sent with the file (Matrix: `body` when `filename` is set).
    File {
        name: String,
        media: String,
        kind: FileKind,
        mime: Option<String>,
        size: Option<u64>,
        caption: Option<String>,
        /// Set for voice messages (recorded audio): length and waveform for the player.
        #[serde(default)]
        voice: Option<VoiceInfo>,
    },
    /// A poll; answers and votes are fetched with `ProtocolAdapter::poll`.
    /// `id` is the protocol's poll id (Matrix: the start event, Talk: the poll id).
    Poll { id: String, question: String },
    /// Deleted by its sender or a moderator.
    Redacted,
    /// Couldn't be decrypted yet; replaced by the real message once the key arrives.
    Encrypted,
    /// Not decrypted because it was sent from a device its owner hasn't verified (invisible
    /// crypto: only cross-signed devices are trusted). Replaced if the device gets verified.
    Untrusted,
    /// Something that happened in the room rather than a message: joins,
    /// renames, ... Names are display names; the UI words and translates it.
    Event { kind: RoomEventKind, actor: String, target: Option<String>, value: Option<String> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RoomEventKind {
    Joined,
    Left,
    Invited,
    InviteDeclined,
    InviteRevoked,
    Kicked,
    Banned,
    Unbanned,
    /// `actor` changed their display name to `value`.
    DisplayName,
    /// `actor` changed their profile picture.
    Avatar,
    RoomName,
    Topic,
    RoomAvatar,
    Encrypted,
    /// `actor` asked to verify by emoji (the dialog handles the request itself).
    VerificationRequest,
    /// A 1:1 call: `value` is "invite_voice", "invite_video", "ended", "missed" or "declined".
    Call,
    /// A protocol that words its own events (e.g. Talk system messages): `value` is the text.
    Other,
}

/// Reactions as counts, for protocols that don't expose who reacted (Talk).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReactionCount {
    pub key: String,
    pub count: usize,
    pub mine: bool,
}

impl MessageBody {
    pub fn plain_text(&self) -> String {
        match self {
            MessageBody::Text { plain, .. } | MessageBody::Notice { plain } => plain.clone(),
            MessageBody::File { name, caption, .. } => caption.clone().unwrap_or_else(|| name.clone()),
            MessageBody::Poll { question, .. } => format!("📊 {question}"),
            MessageBody::Redacted | MessageBody::Event { .. } => String::new(),
            MessageBody::Encrypted | MessageBody::Untrusted => "🔒".to_owned(),
        }
    }

    /// Stands in for a message we can't read (yet).
    pub fn is_placeholder(&self) -> bool {
        matches!(self, MessageBody::Encrypted | MessageBody::Untrusted)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceInfo {
    pub duration_ms: u64,
    /// 0..1 levels.
    pub waveform: Vec<f32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    Image,
    Video,
    Audio,
    File,
    Sticker,
}

/// A message the user is sending.
#[derive(Debug, Clone, Default)]
pub struct Outgoing {
    /// Markdown; adapters that support rich text render it.
    pub text: String,
    /// `/me` style action.
    pub emote: bool,
    pub reply_to: Option<MessageId>,
    pub thread_root: Option<MessageId>,
    /// User ids mentioned in `text`, so their clients notify them.
    pub mentions: Vec<String>,
    /// Ready-made HTML (spoilers, /html, /rainbow); `text` is then the plain fallback.
    pub html: Option<String>,
    /// A custom message type, e.g. Element's chat effects ("nic.custom.confetti").
    pub msgtype: Option<String>,
    /// Custom emoji used in `text` as :shortcode:, with their image URLs.
    pub emotes: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: MessageId,
    pub conversation: ConversationId,
    pub pos: TimelinePos,
    pub sender: String,
    pub sender_name: String,
    pub sent_at: Timestamp,
    pub body: MessageBody,
    /// Root message id when this message is a thread reply.
    pub thread_root: Option<MessageId>,
    /// The message this one quotes/replies to.
    pub reply_to: Option<MessageId>,
    /// Media id (see `MessageBody::File::media`) of the sender's avatar.
    pub sender_avatar: Option<String>,
    pub mentions_me: bool,
    pub from_me: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Presence {
    Available,
    Busy,
    Away,
    Offline,
}

/// A file or folder in the account's cloud storage (Nextcloud Files).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudFile {
    pub name: String,
    /// Path from the storage root, starting with "/".
    pub path: String,
    pub dir: bool,
    pub size: u64,
    pub mime: Option<String>,
    /// As the server sends it (HTTP date).
    pub modified: Option<String>,
    pub file_id: Option<String>,
}

/// A calendar the account can show.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Calendar {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub writable: bool,
}

/// One occurrence of a calendar event (recurring events come expanded).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub calendar: String,
    pub uid: String,
    pub summary: String,
    /// iCalendar form: "20261117T090000Z" (UTC), "20261117T090000" (local) or "20261117" (all day).
    pub start: String,
    pub end: Option<String>,
    pub location: Option<String>,
    pub description: Option<String>,
    pub organizer: Option<String>,
    /// The calendar object this occurrence comes from, for editing and deleting.
    pub href: String,
    pub etag: Option<String>,
    /// Part of a repeating series (only the whole series can be deleted here; edit in Nextcloud).
    pub recurring: bool,
    /// Which occurrence of a repeating meeting this is (RECURRENCE-ID, UTC).
    #[serde(default)]
    pub recurrence_id: Option<String>,
    pub attendees: Vec<Attendee>,
    /// You organise it (or nobody does), so you may change it.
    pub mine: bool,
    /// Your reply when you're invited (NEEDS-ACTION, ACCEPTED, DECLINED, TENTATIVE).
    pub my_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attendee {
    pub name: Option<String>,
    pub email: String,
    /// iCalendar PARTSTAT: NEEDS-ACTION, ACCEPTED, DECLINED, TENTATIVE.
    #[serde(default)]
    pub status: Option<String>,
    /// Their user id on the same server, when known (for the picture).
    #[serde(default)]
    pub user: Option<String>,
}

/// A new event from the calendar's "New meeting" dialog (or the new state of an edited one).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewEvent {
    pub calendar: String,
    pub summary: String,
    /// UTC, iCalendar form ("20261117T090000Z"), or a date for all-day events.
    pub start: String,
    pub end: String,
    pub location: Option<String>,
    pub description: Option<String>,
    /// Invited people; Nextcloud emails them the invitation.
    #[serde(default)]
    pub attendees: Vec<Attendee>,
    /// Repeating meetings: the occurrence being changed (its recurrence id, as listed).
    #[serde(default)]
    pub occurrence: Option<String>,
    /// With `occurrence`: change the whole series instead of just that occurrence.
    #[serde(default)]
    pub series: bool,
    /// A new repeating meeting: its RRULE ("FREQ=WEEKLY;BYDAY=MO").
    #[serde(default)]
    pub rrule: Option<String>,
    /// The time zone `start` and `end` are in (local times, without Z), so a repeating meeting
    /// keeps its local time through summer time; with its VTIMEZONE block.
    #[serde(default)]
    pub tzid: Option<String>,
    #[serde(default)]
    pub vtimezone: Option<String>,
}

/// A note in Nextcloud Notes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: u64,
    pub title: String,
    /// Its folder in Notes ("" for none; "Work/Projects" for a subfolder).
    pub category: String,
    /// Seconds since 1970.
    pub modified: u64,
    pub favorite: bool,
    pub readonly: bool,
    /// Saving with it doesn't overwrite a change made elsewhere in between.
    pub etag: String,
    /// The text (Markdown); only when one note was asked for.
    pub content: Option<String>,
}

/// A note's new state, from the notes editor.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteChange {
    pub title: String,
    pub content: String,
    pub category: String,
    pub favorite: bool,
}

/// A still from a video being sent (made in the UI), with the video's own size and length.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoThumb {
    /// JPEG bytes.
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub video_width: u32,
    pub video_height: u32,
    pub duration_ms: u64,
}

/// The #hashtags in a text, lowercased, without the #. Room addresses (#room:server), the part of
/// a link after # (…/page#part) and numbers alone (#2) aren't tags.
pub fn hashtags(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let tag_char = |c: char| c.is_alphanumeric() || c == '_' || c == '-';
    let mut out: Vec<String> = vec![];
    let mut i = 0;
    while i < chars.len() {
        let starts = chars[i] == '#' && (i == 0 || !(chars[i - 1].is_alphanumeric() || matches!(chars[i - 1], '#' | '&' | '/' | '_')));
        if !starts {
            i += 1;
            continue;
        }
        let start = i + 1;
        let mut end = start;
        while end < chars.len() && tag_char(chars[end]) {
            end += 1;
        }
        let room = chars.get(end) == Some(&':') && chars.get(end + 1).is_some_and(|c| c.is_alphanumeric());
        // A dash at the end is punctuation ("#planning-").
        let mut last = end;
        while last > start && chars[last - 1] == '-' {
            last -= 1;
        }
        let tag: String = chars[start..last].iter().collect::<String>().to_lowercase();
        if !room && tag.chars().count() >= 2 && tag.chars().any(char::is_alphabetic) && !out.contains(&tag) {
            out.push(tag);
        }
        i = end.max(start);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::hashtags;

    #[test]
    fn finds_tags_but_not_rooms_links_or_numbers() {
        assert_eq!(hashtags("Plan for #Q3 and #budget-2027, see #planning."), ["q3", "budget-2027", "planning"]);
        assert_eq!(hashtags("join #team:surf.nl or https://x.nl/page#part"), Vec::<String>::new());
        assert_eq!(hashtags("issue #12, colour#fff, ##double, #a"), Vec::<String>::new());
        assert_eq!(hashtags("#vergadering: morgen #Vergadering"), ["vergadering"]);
    }
}
