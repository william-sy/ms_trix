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
    pub muted: bool,
    /// Notify only when mentioned (Matrix "mentions and keywords").
    pub mentions_only: bool,
    /// The other person in a 1:1 chat, for presence.
    pub dm_user: Option<String>,
    /// Set while we are invited but haven't joined: who invited us.
    pub invited_by: Option<String>,
    /// Remote id of the team (Matrix space) this channel belongs to.
    pub team_id: Option<String>,
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomMemberInfo {
    pub user_id: String,
    pub name: String,
    pub avatar: Option<String>,
    /// "admin" / "moderator", or None for regular members.
    pub role: Option<String>,
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
}

/// Result of a protocol command like `/join`.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutput {
    pub message: String,
    /// Conversation to switch to (e.g. after /join or /query), once it has synced.
    pub open: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum MessageBody {
    Text { plain: String, html: Option<String> },
    Notice { plain: String },
    /// `media` is an opaque id the adapter resolves in `fetch_media`.
    File { name: String, media: String, kind: FileKind, mime: Option<String>, size: Option<u64> },
    /// Deleted by its sender or a moderator.
    Redacted,
    /// Couldn't be decrypted yet; replaced by the real message once the key arrives.
    Encrypted,
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
}

impl MessageBody {
    pub fn plain_text(&self) -> String {
        match self {
            MessageBody::Text { plain, .. } | MessageBody::Notice { plain } => plain.clone(),
            MessageBody::File { name, .. } => name.clone(),
            MessageBody::Redacted | MessageBody::Event { .. } => String::new(),
            MessageBody::Encrypted => "🔒".to_owned(),
        }
    }
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
