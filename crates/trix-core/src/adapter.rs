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

/// Told how far a transfer is: bytes done, of the total.
pub type Progress = Arc<dyn Fn(u64, u64) + Send + Sync>;

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

/// One page of older history for the search index; doesn't touch the timeline.
#[derive(Debug, Clone, Default)]
pub struct CrawlPage {
    pub events: Vec<AdapterEvent>,
    /// Where the next (older) page starts; None at the start of the conversation.
    pub next: Option<String>,
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
    /// Replaces all reactions on `target` with these counts.
    ReactionsReplaced { conversation: ConversationId, target: MessageId, reactions: Vec<ReactionCount> },
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
    /// The server can't be reached (sent again on every failed try while it lasts).
    ConnectionLost { reason: String },
    /// Synced with the server: the first time this run, or again after `ConnectionLost`. The
    /// first one means the conversations have been listed.
    Connected,
    /// An emoji verification started, moved on, or ended.
    Verification(Verification),
    UploadProgress(UploadProgress),
    CallSignal(CallSignal),
    /// Someone voted in (or ended) a poll; the UI refetches it.
    PollChanged { conversation: ConversationId, poll: String },
    /// The stored session changed (refreshed tokens); the host replaces what it keeps.
    SessionChanged { account: AccountId, session: Vec<u8> },
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
    /// The computer woke up (or the app was napped): reconnect now instead of waiting out a
    /// connection that died meanwhile.
    fn wake(&self) {}
    /// The conversation on screen (None: none of this account's), so polling
    /// protocols can watch it closely for new messages.
    fn set_focus(&self, _conversation: Option<&ConversationId>) {}
    /// Revokes this device's credentials on the server (sign out).
    async fn logout(&self) -> Result<()> {
        Ok(())
    }

    async fn send(&self, conversation: &ConversationId, message: Outgoing) -> Result<MessageId>;
    /// The page of messages before the oldest one loaded so far.
    async fn load_older(&self, _conversation: &ConversationId, _limit: u32) -> Result<History> {
        Ok(History::default())
    }
    /// A thread's root message and all its replies.
    /// The messages around `message` (about `size` before and after), for a quick
    /// preview of an old search result without loading everything in between.
    async fn context(&self, _conversation: &ConversationId, _message: &MessageId, _size: u32) -> Result<Vec<Message>> {
        Err(AdapterError::Unsupported("message context"))
    }
    /// The pinned messages, the latest pinned first.
    async fn pinned(&self, _conversation: &ConversationId) -> Result<Vec<Message>> {
        Err(AdapterError::Unsupported("pinned messages"))
    }
    /// Pins a message for everyone in the conversation, or unpins it.
    async fn set_pinned(&self, _conversation: &ConversationId, _message: &MessageId, _pinned: bool) -> Result<()> {
        Err(AdapterError::Unsupported("pinned messages"))
    }
    /// Pages backwards through history from `from` (None = newest) for the search
    /// index. None when the protocol doesn't support it.
    async fn crawl(&self, _conversation: &ConversationId, _from: Option<String>, _limit: u32) -> Result<Option<CrawlPage>> {
        Ok(None)
    }
    /// Fetches these messages again (e.g. ones that couldn't be decrypted before).
    async fn refetch(&self, _conversation: &ConversationId, _ids: &[MessageId]) -> Result<Vec<AdapterEvent>> {
        Ok(vec![])
    }
    /// Makes sure `media` of this message can be fetched (e.g. learn its decryption
    /// key) when it comes from the search index rather than the loaded timeline.
    async fn prepare_media(&self, _conversation: &ConversationId, _message: &MessageId, _media: &str) -> Result<()> {
        Ok(())
    }
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
    /// A video with a still to show before it plays; without support it's sent as a plain file.
    async fn send_video(&self, conversation: &ConversationId, name: &str, mime: Option<&str>, data: Vec<u8>, caption: Option<&str>, _thumb: VideoThumb) -> Result<()> {
        self.send_file(conversation, name, mime, data, caption).await
    }
    /// A file in reply to a message and/or in the thread of `thread_root`; protocols without
    /// replies or threads send it to the chat plainly.
    #[allow(clippy::too_many_arguments)]
    async fn send_file_related(&self, conversation: &ConversationId, _thread_root: Option<&MessageId>, _reply_to: Option<&MessageId>, name: &str, mime: Option<&str>, data: Vec<u8>, caption: Option<&str>, thumb: Option<VideoThumb>) -> Result<()> {
        match thumb {
            Some(thumb) => self.send_video(conversation, name, mime, data, caption, thumb).await,
            None => self.send_file(conversation, name, mime, data, caption).await,
        }
    }
    /// A recorded voice message; `waveform` holds 0..1 levels for drawing it.
    /// Protocols without voice messages get it as an ordinary audio file.
    async fn send_voice(&self, conversation: &ConversationId, mime: &str, data: Vec<u8>, _duration_ms: u64, _waveform: Vec<f32>) -> Result<()> {
        let ext = if mime.contains("ogg") { "ogg" } else if mime.contains("webm") { "webm" } else { "m4a" };
        self.send_file(conversation, &format!("Voice message.{ext}"), Some(mime), data, None).await
    }
    /// Custom emoji and sticker packs: the user's own, from linked rooms, and this room's.
    async fn image_packs(&self, _conversation: Option<&ConversationId>) -> Result<Vec<ImagePack>> {
        Ok(vec![])
    }
    /// The user's own pack (editable), empty when there is none yet.
    async fn own_pack(&self) -> Result<ImagePack> {
        Err(AdapterError::Unsupported("custom emoji"))
    }
    /// Replaces the user's own pack (shared with Element and other clients).
    async fn save_own_pack(&self, _pack: &ImagePack) -> Result<()> {
        Err(AdapterError::Unsupported("custom emoji"))
    }
    /// Uploads a picture for a pack; returns its URL.
    async fn upload_image(&self, _mime: &str, _data: Vec<u8>) -> Result<String> {
        Err(AdapterError::Unsupported("uploads"))
    }
    async fn poll(&self, _conversation: &ConversationId, _poll: &str) -> Result<PollView> {
        Err(AdapterError::Unsupported("polls"))
    }
    async fn vote(&self, _conversation: &ConversationId, _poll: &str, _answers: &[String]) -> Result<()> {
        Err(AdapterError::Unsupported("polls"))
    }
    async fn end_poll(&self, _conversation: &ConversationId, _poll: &str) -> Result<()> {
        Err(AdapterError::Unsupported("polls"))
    }
    async fn create_poll(&self, _conversation: &ConversationId, _question: &str, _answers: &[String], _max_selections: u32, _disclosed: bool) -> Result<()> {
        Err(AdapterError::Unsupported("polls"))
    }
    async fn send_sticker(&self, _conversation: &ConversationId, _url: &str, _body: &str) -> Result<()> {
        Err(AdapterError::Unsupported("stickers"))
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
    /// Creates a named room (not a chat).
    async fn create_room(&self, _room: &NewRoom) -> Result<CommandOutput> {
        Err(AdapterError::Unsupported("creating rooms"))
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
    /// What a room link points at, for "open or join"; `joined` is set when we're in it.
    async fn room_preview(&self, _address: &str, _via: &[String]) -> Result<DirectoryRoom> {
        Err(AdapterError::Unsupported("room links"))
    }
    /// Asks to be let into a room that requires approval.
    async fn knock(&self, _address: &str, _via: Option<&str>) -> Result<()> {
        Err(AdapterError::Unsupported("asking to join"))
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
    /// Our own picture in this room only (Matrix per-room member avatar).
    async fn set_room_member_avatar(&self, _conversation: &ConversationId, _mime: Option<&str>, _data: Vec<u8>) -> Result<()> {
        Err(AdapterError::Unsupported("per-room pictures"))
    }
    /// Own display name and picture.
    async fn set_display_name(&self, _name: &str) -> Result<()> {
        Err(AdapterError::Unsupported("changing your name"))
    }
    async fn set_avatar(&self, _mime: Option<&str>, _data: Vec<u8>) -> Result<()> {
        Err(AdapterError::Unsupported("changing your picture"))
    }
    /// Signed-in sessions of this account.
    /// The server's own page for sessions and app passwords, where `devices` isn't supported.
    fn security_page(&self) -> Option<String> {
        None
    }
    async fn devices(&self) -> Result<Vec<DeviceInfo>> {
        Err(AdapterError::Unsupported("sessions"))
    }
    /// Someone else's sessions as our crypto layer knows them (no IPs or times).
    async fn user_devices(&self, _user_id: &str) -> Result<Vec<DeviceInfo>> {
        Err(AdapterError::Unsupported("sessions"))
    }
    /// Email addresses and phone numbers linked to the account.
    async fn contact_infos(&self) -> Result<Vec<ContactInfo>> {
        Err(AdapterError::Unsupported("linked email addresses"))
    }
    async fn remove_contact_info(&self, _medium: &str, _address: &str) -> Result<()> {
        Err(AdapterError::Unsupported("linked email addresses"))
    }
    /// Sends a confirmation mail; returns a token for [`Self::add_email_finish`].
    async fn add_email_start(&self, _email: &str) -> Result<String> {
        Err(AdapterError::Unsupported("linked email addresses"))
    }
    /// After the link in the mail was clicked; may need the password or a browser step.
    async fn add_email_finish(&self, _token: &str, _auth: DeviceAuth) -> Result<SignOutDevice> {
        Err(AdapterError::Unsupported("linked email addresses"))
    }
    async fn rename_device(&self, _device_id: &str, _name: &str) -> Result<()> {
        Err(AdapterError::Unsupported("sessions"))
    }
    async fn sign_out_device(&self, _device_id: &str, _auth: DeviceAuth) -> Result<SignOutDevice> {
        Err(AdapterError::Unsupported("sessions"))
    }
    /// Hides (or shows again) everything from this user.
    async fn set_ignored(&self, _user_id: &str, _ignored: bool) -> Result<()> {
        Err(AdapterError::Unsupported("ignoring users"))
    }
    /// Starts emoji verification with someone, or (`device_id`) with one of our own sessions.
    /// Progress arrives as [`AdapterEvent::Verification`].
    async fn start_verification(&self, _user_id: &str, _device_id: Option<&str>) -> Result<()> {
        Err(AdapterError::Unsupported("verification"))
    }
    async fn verification_action(&self, _user_id: &str, _flow_id: &str, _action: VerificationAction) -> Result<()> {
        Err(AdapterError::Unsupported("verification"))
    }
    /// The other device's QR code, scanned with the camera (its raw bytes).
    async fn scan_verification_qr(&self, _user_id: &str, _flow_id: &str, _data: Vec<u8>) -> Result<()> {
        Err(AdapterError::Unsupported("verification"))
    }
    /// Privacy: whether others see our read receipts and typing. Protocols
    /// without a server-side switch just stop sending them.
    async fn set_privacy(&self, _share_receipts: bool, _share_typing: bool) -> Result<()> {
        Ok(())
    }
    /// Notification keywords stored on the server (Matrix push rules), if the protocol has them.
    async fn keywords(&self) -> Result<Vec<String>> {
        Ok(vec![])
    }
    /// Makes the server's keywords exactly `keywords`.
    async fn set_keywords(&self, _keywords: &[String]) -> Result<()> {
        Ok(())
    }
    /// "all", "mentions" or "mute".
    async fn set_notification_level(&self, _conversation: &ConversationId, _level: &str) -> Result<()> {
        Err(AdapterError::Unsupported("notification settings"))
    }
    async fn invite(&self, _conversation: &ConversationId, _user_id: &str) -> Result<()> {
        Err(AdapterError::Unsupported("invites"))
    }
    /// Web address of the protocol's own call screen for this conversation.
    async fn call_link(&self, _conversation: &ConversationId) -> Result<String> {
        Err(AdapterError::Unsupported("calls"))
    }
    /// Sends a 1:1 call event (`content` is JSON); encrypted like messages in encrypted rooms.
    async fn send_call_event(&self, _conversation: &ConversationId, _event_type: &str, _content: &str) -> Result<()> {
        Err(AdapterError::Unsupported("calls in Trixcomm"))
    }
    /// The homeserver's TURN relays, if it offers them.
    async fn turn_servers(&self) -> Result<Option<TurnServers>> {
        Ok(None)
    }
    /// A call API request for clients that run the call in the UI (Talk). Only the
    /// protocol's own call/signalling endpoints are allowed. Returns the JSON reply data
    /// and the server address (for signalling auth).
    async fn call_api(&self, _method: &str, _path: &str, _form: &[(String, String)], _timeout_secs: u64) -> Result<(String, String)> {
        Err(AdapterError::Unsupported("calls in Trixcomm"))
    }
    /// Uploads a file to one of the endpoints `call_api` serves (a conversation picture, an
    /// email list), as multipart field `field`; returns the response data as JSON.
    async fn call_api_upload(&self, _path: &str, _field: &str, _file_name: &str, _mime: &str, _data: Vec<u8>) -> Result<String> {
        Err(AdapterError::Unsupported("uploads"))
    }
    /// Whether this account is currently in the conversation's call, so the
    /// host can close the call window once the user has left the call.
    async fn in_call(&self, _conversation: &ConversationId) -> Result<bool> {
        Err(AdapterError::Unsupported("calls"))
    }
    async fn set_typing(&self, _conversation: &ConversationId, _typing: bool) -> Result<()> {
        Ok(())
    }
    /// The people in your address books, by name (not the server's list of all its accounts:
    /// those are found with `search_users`).
    async fn contacts(&self) -> Result<Vec<Contact>> {
        Err(AdapterError::Unsupported("contacts"))
    }
    /// The server's teams you're in (Nextcloud Teams), by name.
    async fn server_teams(&self) -> Result<Vec<ServerTeam>> {
        Err(AdapterError::Unsupported("teams"))
    }
    /// A team's members and what's shared with it.
    async fn server_team(&self, _id: &str) -> Result<ServerTeamDetails> {
        Err(AdapterError::Unsupported("teams"))
    }
    /// The apps the server offers you in its own web pages, in its order.
    async fn server_apps(&self) -> Result<Vec<ServerApp>> {
        Err(AdapterError::Unsupported("server apps"))
    }
    /// The server's own notifications, newest first, with the tag to ask "anything new?" next
    /// time; None when nothing changed since `etag`.
    async fn server_notifications(&self, _etag: Option<&str>) -> Result<Option<(Vec<ServerNotification>, Option<String>)>> {
        Err(AdapterError::Unsupported("server notifications"))
    }
    /// Removes a server notification (`None`: all of them), for the account's other apps too.
    async fn dismiss_server_notification(&self, _id: Option<i64>) -> Result<()> {
        Err(AdapterError::Unsupported("server notifications"))
    }
    /// Does one of a server notification's actions (`link` and `method` as the server gave them).
    async fn server_notification_action(&self, _link: &str, _method: &str, _form: &[(String, String)]) -> Result<()> {
        Err(AdapterError::Unsupported("server notifications"))
    }
    /// Lists a folder of the account's cloud storage ("/" is the root).
    async fn cloud_files(&self, _path: &str) -> Result<Vec<CloudFile>> {
        Err(AdapterError::Unsupported("files"))
    }
    /// Shares a stored file into one of this account's conversations, as a file message.
    async fn share_cloud_file(&self, _conversation: &ConversationId, _path: &str, _caption: Option<&str>) -> Result<()> {
        Err(AdapterError::Unsupported("files"))
    }
    /// The contents of a stored file (e.g. a picture chosen from Files).
    async fn cloud_file_bytes(&self, _path: &str) -> Result<Vec<u8>> {
        Err(AdapterError::Unsupported("files"))
    }
    /// A public link to a stored file, for chats on other accounts.
    async fn cloud_link(&self, _path: &str) -> Result<String> {
        Err(AdapterError::Unsupported("files"))
    }
    /// Files changed recently (the last month), newest first.
    async fn cloud_recent(&self) -> Result<Vec<CloudFile>> {
        Err(AdapterError::Unsupported("files"))
    }
    /// Files and folders anywhere whose name contains `term`, newest first.
    async fn cloud_search(&self, _term: &str) -> Result<Vec<CloudFile>> {
        Err(AdapterError::Unsupported("files"))
    }
    /// Stores `data` as `name` in `folder` without replacing anything ("name (2).ext" when the
    /// name is taken), telling `progress` as it goes; returns the new file's path.
    async fn cloud_upload(&self, _folder: &str, _name: &str, _data: Vec<u8>, _progress: Progress) -> Result<String> {
        Err(AdapterError::Unsupported("files"))
    }
    async fn cloud_mkdir(&self, _path: &str) -> Result<()> {
        Err(AdapterError::Unsupported("files"))
    }
    /// Renames or moves a stored file or folder to `to` (its new full path), never over
    /// something already there.
    async fn cloud_move(&self, _from: &str, _to: &str) -> Result<()> {
        Err(AdapterError::Unsupported("files"))
    }
    /// Deletes a stored file or folder (Nextcloud keeps it in its deleted files for a while).
    async fn cloud_delete(&self, _path: &str) -> Result<()> {
        Err(AdapterError::Unsupported("files"))
    }
    /// Where a link to a file on this account's server is in the user's own files (its path),
    /// for "Show in Files"; None for links elsewhere or to files that aren't theirs.
    async fn cloud_locate(&self, _link: &str) -> Result<Option<String>> {
        Ok(None)
    }
    /// A stored file or folder in the server's web interface (documents open in its office app).
    async fn cloud_web_url(&self, _file_id: &str) -> Result<String> {
        Err(AdapterError::Unsupported("files"))
    }
    async fn calendars(&self) -> Result<Vec<Calendar>> {
        Err(AdapterError::Unsupported("calendar"))
    }
    /// The conversation a web link points to on this account's server (a Talk call link), as a
    /// conversation key; None for any other link.
    fn link_target(&self, _url: &str) -> Option<String> {
        None
    }
    /// The apps this account's server offers us (Nextcloud: the ids in its navigation, such as
    /// "calendar" or "notes").
    async fn cloud_apps(&self) -> Result<Vec<String>> {
        Err(AdapterError::Unsupported("apps"))
    }
    /// Whether this account's server translates text (Nextcloud with a translation provider).
    async fn can_translate(&self) -> Result<bool> {
        Ok(false)
    }
    /// `text` in the language `to` ("en"), the language it was in detected by the server.
    async fn translate(&self, _text: &str, _to: &str) -> Result<Translation> {
        Err(AdapterError::Unsupported("translation"))
    }
    /// Notes (Nextcloud Notes), with their text or (quicker) without; Unsupported where the server
    /// has no Notes app.
    async fn notes(&self, _with_content: bool) -> Result<Vec<Note>> {
        Err(AdapterError::Unsupported("notes"))
    }
    async fn note(&self, _id: u64) -> Result<Note> {
        Err(AdapterError::Unsupported("notes"))
    }
    /// Creates a note (no id) or saves one; with `etag`, a change made elsewhere since isn't
    /// overwritten (the error then says "changed elsewhere").
    async fn save_note(&self, _id: Option<u64>, _etag: Option<&str>, _change: &NoteChange) -> Result<Note> {
        Err(AdapterError::Unsupported("notes"))
    }
    async fn delete_note(&self, _id: u64) -> Result<()> {
        Err(AdapterError::Unsupported("notes"))
    }
    /// Event occurrences between two UTC times (iCalendar form).
    async fn calendar_events(&self, _from: &str, _to: &str) -> Result<Vec<CalendarEvent>> {
        Err(AdapterError::Unsupported("calendar"))
    }
    async fn create_event(&self, _event: &NewEvent) -> Result<()> {
        Err(AdapterError::Unsupported("calendar"))
    }
    /// Changes a (non-repeating) event in place; `href`/`etag` from [`CalendarEvent`].
    async fn update_event(&self, _href: &str, _etag: Option<&str>, _event: &NewEvent) -> Result<()> {
        Err(AdapterError::Unsupported("calendar"))
    }
    /// Deletes a meeting; with `occurrence`, only that occurrence of a repeating one.
    async fn delete_event(&self, _href: &str, _etag: Option<&str>, _occurrence: Option<&str>) -> Result<()> {
        Err(AdapterError::Unsupported("calendar"))
    }
    /// Answers an invitation: ACCEPTED, TENTATIVE or DECLINED (the organizer is told).
    async fn respond_event(&self, _href: &str, _etag: Option<&str>, _status: &str) -> Result<()> {
        Err(AdapterError::Unsupported("calendar"))
    }
    /// People to invite: (name, email address) matching `term`.
    async fn calendar_people(&self, _term: &str) -> Result<Vec<Attendee>> {
        Ok(vec![])
    }
    /// When you and `people` (email addresses) are busy between `from` and `to` (UTC,
    /// "20261124T000000Z"): you first, then the others in the order asked.
    async fn free_busy(&self, _people: &[String], _from: &str, _to: &str) -> Result<Vec<FreeBusy>> {
        Err(AdapterError::Unsupported("free/busy"))
    }
    /// A web address people can use to join a conversation (Talk meeting link).
    async fn conversation_link(&self, _conversation: &ConversationId) -> Result<String> {
        Err(AdapterError::Unsupported("links"))
    }
    async fn send_read_receipt(&self, conversation: &ConversationId, thread_root: Option<&MessageId>, up_to: &MessageId) -> Result<()>;

    async fn set_marked_unread(&self, _conversation: &ConversationId, _value: bool) -> Result<()> {
        Err(AdapterError::Unsupported("marked unread sync"))
    }
    async fn set_favourite(&self, _conversation: &ConversationId, _value: bool) -> Result<()> {
        Err(AdapterError::Unsupported("favourites"))
    }
    /// "shared", "invited", "joined" or "world_readable".
    async fn set_history_visibility(&self, _conversation: &ConversationId, _visibility: &str) -> Result<()> {
        Err(AdapterError::Unsupported("history settings"))
    }
    /// Level needed for one action (keys as in [`RoomDetails::permissions`]).
    async fn set_permission(&self, _conversation: &ConversationId, _key: &str, _level: i64) -> Result<()> {
        Err(AdapterError::Unsupported("permissions"))
    }
    /// Servers allowed / denied (wildcards like *.example.org).
    async fn set_server_acl(&self, _conversation: &ConversationId, _allow: Vec<String>, _deny: Vec<String>) -> Result<()> {
        Err(AdapterError::Unsupported("server access lists"))
    }
    /// The threads in a conversation, newest first; `mine`: only those you're part of.
    async fn threads(&self, _conversation: &ConversationId, _mine: bool) -> Result<Vec<ThreadInfo>> {
        Err(AdapterError::Unsupported("thread lists"))
    }
    /// People in the conversation whose encryption identity changed since you last saw it.
    async fn identity_warnings(&self, _conversation: &ConversationId) -> Result<Vec<IdentityWarning>> {
        Ok(vec![])
    }
    /// Accepts someone's new identity (and withdraws an old verification), clearing the warning.
    async fn accept_identity(&self, _user_id: &str) -> Result<()> {
        Err(AdapterError::Unsupported("identity warnings"))
    }
    /// Adds a room to a team (Matrix: an m.space.child event in the space) or takes it out.
    async fn set_team_room(&self, _team: &ConversationId, _room: &str, _add: bool) -> Result<()> {
        Err(AdapterError::Unsupported("editing teams"))
    }
    /// Our sort key for a top-level team (None clears it), synced with other clients.
    async fn set_team_order(&self, _team: &ConversationId, _order: Option<&str>) -> Result<()> {
        Err(AdapterError::Unsupported("team order"))
    }
    /// Turns on end-to-end encryption (can't be turned off again).
    async fn enable_encryption(&self, _conversation: &ConversationId) -> Result<()> {
        Err(AdapterError::Unsupported("encryption settings"))
    }
    /// "public" or "invite".
    async fn set_join_rule(&self, _conversation: &ConversationId, _rule: &str) -> Result<()> {
        Err(AdapterError::Unsupported("join rules"))
    }
    /// Gives the room an address on our own server (`name` without # and :server).
    async fn set_room_alias(&self, _conversation: &ConversationId, _name: &str) -> Result<String> {
        Err(AdapterError::Unsupported("room addresses"))
    }
    async fn set_archived(&self, _conversation: &ConversationId, _value: bool) -> Result<()> {
        Err(AdapterError::Unsupported("archiving"))
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
