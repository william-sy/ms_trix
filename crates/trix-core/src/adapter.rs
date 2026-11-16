use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use futures::stream::BoxStream;
use serde::{Deserialize, Serialize};

use crate::model::*;

#[derive(Debug, thiserror::Error)]
pub enum AdapterError {
    #[error("not supported by this protocol: {0}")]
    Unsupported(&'static str),
    #[error("authentication failed: {0}")]
    Auth(String),
    #[error("network error: {0}")]
    Network(String),
    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, AdapterError>;

/// What a protocol can do. The UI hides features a protocol lacks instead
/// of every adapter having to fake them.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Capabilities {
    pub e2ee: bool,
    pub threads: bool,
    pub reactions: bool,
    pub edits: bool,
    pub read_receipts: bool,
    /// Whether the manual "marked unread" flag can be synced across devices.
    pub synced_marked_unread: bool,
    /// Teams/channels hierarchy (Matrix spaces).
    pub teams: bool,
    pub presence: bool,
    pub typing: bool,
    /// Voice/video calls (MatrixRTC for Matrix).
    pub calls: bool,
}

/// Encryption trust state of this device, for protocols with E2EE.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityStatus {
    /// Other people's clients trust messages from this device.
    pub device_verified: bool,
    pub recovery: RecoveryStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecoveryStatus {
    /// Still syncing; ask again later.
    Unknown,
    /// Recovery is set up and this device has all secrets.
    Enabled,
    /// Recovery is set up on the account but this device lacks the secrets:
    /// the user should enter their recovery key.
    Incomplete,
    /// The account has no recovery set up.
    Disabled,
}

/// Older events fetched on demand (scrollback, full threads): messages plus
/// the reactions, edits and deletions that came with them.
#[derive(Debug, Clone, Default)]
pub struct History {
    pub events: Vec<AdapterEvent>,
    /// False once the start of the conversation is reached.
    pub has_more: bool,
}

/// Everything an adapter pushes to the core.
#[derive(Debug, Clone)]
pub enum AdapterEvent {
    ConversationUpserted(Conversation),
    ConversationRemoved(ConversationId),
    TeamUpserted(Team),
    Message(Message),
    /// A message or a reaction was deleted.
    MessageRedacted { conversation: ConversationId, id: MessageId },
    /// An emoji reaction (`id` is the reaction itself, `target` the message).
    Reaction { conversation: ConversationId, target: MessageId, id: MessageId, key: String, sender: String, sender_name: String, from_me: bool, at: Timestamp },
    /// A new version of `target`'s content. Only valid from the original sender.
    Edited { conversation: ConversationId, target: MessageId, sender: String, body: MessageBody, at: Timestamp },
    /// Our own read receipt arrived from another device/session.
    /// `all_threads`: an unthreaded receipt, which per the spec also covers every thread.
    OwnReadReceipt { conversation: ConversationId, thread_root: Option<MessageId>, pos: TimelinePos, at: Timestamp, all_threads: bool },
    /// Someone else's read receipt: they have seen everything up to `pos`.
    ReadBy { conversation: ConversationId, user_id: String, name: String, avatar: Option<String>, pos: TimelinePos },
    /// Who is typing right now (replaces the previous list; excludes us).
    Typing { conversation: ConversationId, names: Vec<String> },
    /// The synced marked-unread flag changed (possibly from another device).
    MarkedUnread { conversation: ConversationId, value: bool, at: Timestamp },
    PresenceChanged { user_id: String, presence: Presence, status: Option<String> },
    ConnectionLost { reason: String },
    ConnectionRestored,
}

/// One instance per signed-in account.
#[async_trait]
pub trait ProtocolAdapter: Send + Sync {
    fn account(&self) -> Account;
    /// Re-reads display name and avatar from the server.
    async fn refresh_profile(&self) -> Result<Account> {
        Ok(self.account())
    }
    fn capabilities(&self) -> Capabilities;

    /// Starts syncing. The stream ends when the adapter shuts down.
    async fn start(&self) -> Result<BoxStream<'static, AdapterEvent>>;
    async fn stop(&self) -> Result<()>;

    async fn send(&self, conversation: &ConversationId, message: Outgoing) -> Result<MessageId>;
    /// The page of messages before the oldest one loaded so far.
    async fn load_older(&self, _conversation: &ConversationId, _limit: u32) -> Result<History> {
        Ok(History::default())
    }
    /// A thread's root message and all its replies.
    async fn load_thread(&self, _conversation: &ConversationId, _root: &MessageId) -> Result<History> {
        Ok(History::default())
    }
    async fn react(&self, _conversation: &ConversationId, _target: &MessageId, _key: &str) -> Result<()> {
        Err(AdapterError::Unsupported("reactions"))
    }
    async fn edit(&self, _conversation: &ConversationId, _target: &MessageId, _text: &str) -> Result<()> {
        Err(AdapterError::Unsupported("edits"))
    }
    /// Deletes a message or removes a reaction.
    async fn redact(&self, _conversation: &ConversationId, _id: &MessageId) -> Result<()> {
        Err(AdapterError::Unsupported("deleting"))
    }
    /// `caption` (markdown) is shown with the file, like a message text.
    async fn send_file(&self, _conversation: &ConversationId, _name: &str, _mime: Option<&str>, _data: Vec<u8>, _caption: Option<&str>) -> Result<()> {
        Err(AdapterError::Unsupported("sending files"))
    }
    async fn members(&self, _conversation: &ConversationId) -> Result<Vec<Member>> {
        Ok(vec![])
    }
    /// Protocol-level slash commands (`/join`, `/invite`, ...).
    async fn command(&self, _conversation: &ConversationId, _name: &str, _args: &str) -> Result<CommandOutput> {
        Err(AdapterError::Unsupported("this command"))
    }
    async fn accept_invite(&self, _conversation: &ConversationId) -> Result<()> {
        Err(AdapterError::Unsupported("invites"))
    }
    /// Leaves a conversation; also declines a pending invite.
    async fn leave(&self, _conversation: &ConversationId) -> Result<()> {
        Err(AdapterError::Unsupported("leaving"))
    }
    /// People on this server/network matching `term`, for starting chats.
    async fn search_users(&self, _term: &str) -> Result<Vec<Member>> {
        Ok(vec![])
    }
    /// Opens the existing 1:1 chat or creates a new (group) chat.
    async fn create_chat(&self, _users: &[String], _name: Option<&str>) -> Result<CommandOutput> {
        Err(AdapterError::Unsupported("creating chats"))
    }
    /// Public rooms (or spaces) on `server` (None = our own server).
    async fn directory(&self, _server: Option<&str>, _term: &str, _spaces: bool) -> Result<Vec<DirectoryRoom>> {
        Ok(vec![])
    }
    /// The rooms inside a space.
    async fn space_rooms(&self, _space: &str) -> Result<Vec<DirectoryRoom>> {
        Ok(vec![])
    }
    /// Joins by id or address; `via` helps the server find rooms by id.
    async fn join_room(&self, _address: &str, _via: Option<&str>) -> Result<CommandOutput> {
        Err(AdapterError::Unsupported("joining rooms"))
    }
    /// Our own server, the default for directory searches.
    fn home_server(&self) -> Option<String> {
        None
    }
    async fn profile(&self, _user_id: &str) -> Result<Profile> {
        Err(AdapterError::Unsupported("profiles"))
    }
    async fn room_details(&self, _conversation: &ConversationId) -> Result<RoomDetails> {
        Err(AdapterError::Unsupported("room details"))
    }
    async fn set_room_name(&self, _conversation: &ConversationId, _name: &str) -> Result<()> {
        Err(AdapterError::Unsupported("renaming rooms"))
    }
    async fn set_room_topic(&self, _conversation: &ConversationId, _topic: &str) -> Result<()> {
        Err(AdapterError::Unsupported("room topics"))
    }
    async fn set_room_avatar(&self, _conversation: &ConversationId, _mime: Option<&str>, _data: Vec<u8>) -> Result<()> {
        Err(AdapterError::Unsupported("room pictures"))
    }
    /// "all", "mentions" or "mute".
    async fn set_notification_level(&self, _conversation: &ConversationId, _level: &str) -> Result<()> {
        Err(AdapterError::Unsupported("notification settings"))
    }
    async fn invite(&self, _conversation: &ConversationId, _user_id: &str) -> Result<()> {
        Err(AdapterError::Unsupported("invites"))
    }
    async fn set_typing(&self, _conversation: &ConversationId, _typing: bool) -> Result<()> {
        Ok(())
    }
    async fn send_read_receipt(&self, conversation: &ConversationId, thread_root: Option<&MessageId>, up_to: &MessageId) -> Result<()>;

    async fn set_marked_unread(&self, _conversation: &ConversationId, _value: bool) -> Result<()> {
        Err(AdapterError::Unsupported("marked unread sync"))
    }
    async fn set_favourite(&self, _conversation: &ConversationId, _value: bool) -> Result<()> {
        Err(AdapterError::Unsupported("favourites"))
    }
    async fn set_presence(&self, _presence: Presence, _status_message: Option<String>) -> Result<()> {
        Err(AdapterError::Unsupported("presence"))
    }
    /// Downloads (and decrypts) media by the opaque id the adapter handed out,
    /// optionally as a server-side thumbnail of roughly `(width, height)`.
    async fn fetch_media(&self, _media: &str, _thumbnail: Option<(u32, u32)>) -> Result<Vec<u8>> {
        Err(AdapterError::Unsupported("media"))
    }
    async fn security_status(&self) -> Result<SecurityStatus> {
        Err(AdapterError::Unsupported("encryption"))
    }
    /// Verifies this device and unlocks history using the account's recovery key.
    async fn recover(&self, _recovery_key: &str) -> Result<()> {
        Err(AdapterError::Unsupported("encryption"))
    }
}

/// Builds adapters for a protocol. Register one factory per protocol plugin.
#[async_trait]
pub trait AdapterFactory: Send + Sync {
    fn protocol(&self) -> ProtocolId;
    /// Human readable name for the "Add account" dialog.
    fn display_name(&self) -> &'static str;
    /// Restores a previously signed-in account from its persisted session.
    async fn restore(&self, account: Account, session: Vec<u8>) -> Result<Arc<dyn ProtocolAdapter>>;
}

#[derive(Default)]
pub struct AdapterRegistry {
    factories: HashMap<ProtocolId, Arc<dyn AdapterFactory>>,
}

impl AdapterRegistry {
    pub fn register(&mut self, factory: Arc<dyn AdapterFactory>) {
        self.factories.insert(factory.protocol(), factory);
    }

    pub fn get(&self, protocol: &ProtocolId) -> Option<Arc<dyn AdapterFactory>> {
        self.factories.get(protocol).cloned()
    }

    pub fn protocols(&self) -> impl Iterator<Item = &ProtocolId> {
        self.factories.keys()
    }
}
