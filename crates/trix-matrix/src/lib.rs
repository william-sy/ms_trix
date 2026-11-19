//! Matrix adapter built on matrix-rust-sdk (E2EE via its Rust crypto store).
//!
//! Mapping:
//! * Space            -> Team, child rooms -> `ConversationKind::Channel`
//! * DM (m.direct)    -> `ConversationKind::Direct`
//! * `m.favourite`    -> `Conversation::favourite`
//! * `m.marked_unread` room account data <-> `AdapterEvent::MarkedUnread`
//! * threaded receipts (`m.thread`) -> per-thread `AdapterEvent::OwnReadReceipt`
//!
//! Receipts and the marked-unread flag are sent as raw requests on purpose:
//! the SDK's `send_single_receipt` also clears the marked-unread flag, and
//! `set_unread_flag` skips the write when its cached value matches. Both
//! decisions belong to `trix_core::UnreadState`, not to the SDK.

// matrix-sdk futures nest deeply; the default limit is too low for the Send checks.
#![recursion_limit = "256"]

mod verification;

/// Global account data with the user's own emoji/sticker pack (MSC2545).
const USER_EMOTES: &str = "im.ponies.user_emotes";

/// Room account data with a space's sort key, as Element uses it (MSC3230).
const SPACE_ORDER: &str = "org.matrix.msc3230.space_order";

/// Our room tag for archived chats ("u." = user-defined, per the spec).
const ARCHIVED_TAG: &str = "u.archived";

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use futures::stream::{BoxStream, StreamExt};
use matrix_sdk::config::SyncSettings;
use matrix_sdk::authentication::matrix::MatrixSession;
use matrix_sdk::authentication::oauth::{ClientId, OAuthSession, UserSession};
use matrix_sdk::{AuthApi, SessionChange};
use matrix_sdk::ruma::api::client::config::set_room_account_data;
use matrix_sdk::ruma::api::client::receipt::create_receipt;
use matrix_sdk::ruma::events::marked_unread::{MarkedUnreadEventContent, UnstableMarkedUnreadEventContent};
use matrix_sdk::ruma::events::receipt::{ReceiptEventContent, ReceiptThread, ReceiptType};
use matrix_sdk::ruma::events::relation::Thread;
use matrix_sdk::ruma::events::room::message::{
    MessageType, OriginalSyncRoomMessageEvent, Relation, RoomMessageEventContent,
};
use matrix_sdk::ruma::events::room::MediaSource;
use matrix_sdk::ruma::events::sticker::StickerEventContent;
use matrix_sdk::ruma::events::typing::TypingEventContent;
use matrix_sdk::ruma::events::reaction::OriginalSyncReactionEvent;
use matrix_sdk::ruma::events::room::encrypted::OriginalSyncRoomEncryptedEvent;
use matrix_sdk::ruma::events::room::redaction::{OriginalSyncRoomRedactionEvent, SyncRoomRedactionEvent};
use matrix_sdk::ruma::events::tag::TagName;
use matrix_sdk::ruma::events::{AnySyncTimelineEvent, OriginalSyncMessageLikeEvent, RoomAccountDataEvent, SyncEphemeralRoomEvent};
use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId, OwnedUserId, RoomId, UserId};
use matrix_sdk::notification_settings::RoomNotificationMode;
use matrix_sdk::{Client, LoopCtrl, Room};
use rand::distr::{Alphanumeric, SampleString};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_stream_shim::UnboundedReceiverStream;
use trix_core::adapter::{AdapterError, AdapterFactory, CrawlPage, History, RecoveryStatus, Result, SecurityStatus};
use trix_core::*;

mod oauth;

pub const PROTOCOL: &str = "matrix";

/// Markdown as HTML, rendered as messages are (None when it's plain text); e.g. a note's preview.
pub fn markdown_html(text: &str) -> Option<String> {
    matrix_sdk::ruma::events::room::message::FormattedBody::markdown(text).map(|f| f.body)
}

/// Everything needed to bring an account back after a restart. The host must
/// keep this in the OS keychain: it contains the access token and the
/// passphrase of the encrypted local store.
#[derive(Serialize, Deserialize)]
struct StoredSession {
    homeserver: String,
    /// Password / SSO sign-in.
    #[serde(default)]
    session: Option<MatrixSession>,
    /// OAuth 2.0 sign-in (Matrix Authentication Service): the registered client id and the session.
    #[serde(default)]
    oauth: Option<(String, UserSession)>,
    store_passphrase: String,
}

impl StoredSession {
    /// The client's current session (tokens change when they're refreshed).
    fn of(client: &Client, store_passphrase: &str) -> Result<Vec<u8>> {
        let (session, oauth) = match client.auth_api() {
            Some(AuthApi::Matrix(auth)) => (auth.session(), None),
            Some(AuthApi::OAuth(auth)) => (None, auth.full_session().map(|s| (s.client_id.as_str().to_owned(), s.user))),
            _ => (None, None),
        };
        if session.is_none() && oauth.is_none() {
            return Err(AdapterError::Auth("no session after login".into()));
        }
        serde_json::to_vec(&StoredSession { homeserver: client.homeserver().to_string(), session, oauth, store_passphrase: store_passphrase.to_owned() }).map_err(err)
    }
}

fn err(e: impl std::fmt::Display) -> AdapterError {
    AdapterError::Other(e.to_string())
}

/// Sending failed: with invisible crypto, say what to do when it's about verification.
fn send_err(e: impl std::fmt::Display) -> AdapterError {
    let text = e.to_string();
    if text.contains("your device is not verified") {
        AdapterError::Other("Verify this device first: encrypted messages can only be sent from a verified device (Settings → Accounts, with your recovery key or another device).".into())
    } else if text.contains("cross-signing is not set up") {
        AdapterError::Other("Set up recovery for this account first (Settings → Accounts): encrypted messages need it.".into())
    } else if text.contains("verified have changed their identity") {
        AdapterError::Other("Someone you verified has a new identity; see the warning above the messages before sending again.".into())
    } else {
        AdapterError::Other(text)
    }
}

fn now() -> Timestamp {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Assigns timeline index and remembers them so receipts (which
/// reference event ids) can be translated. Index follow the server
/// timestamp, so history loaded later still sorts before live events; the
/// low bits break ties between events in the same millisecond.
#[derive(Default)]
struct Index {
    next: TimelinePos,
    by_event: HashMap<OwnedEventId, TimelinePos>,
    /// Encrypted media needs its key material to download; plain media is
    /// fetched straight from its mxc URI.
    encrypted_media: HashMap<String, MediaSource>,
    /// Pagination token for scrolling back per room; `Some(None)` = start reached.
    back_tokens: HashMap<OwnedRoomId, Option<String>>,
    /// Messages we couldn't decrypt yet, retried until their key shows up.
    pending: HashMap<OwnedEventId, PendingDecryption>,
    /// Rooms whose history and read state were loaded this session.
    loaded: std::collections::HashSet<OwnedRoomId>,
}

struct PendingDecryption {
    room: OwnedRoomId,
    raw: matrix_sdk::ruma::serde::Raw<OriginalSyncRoomEncryptedEvent>,
    session: Option<String>,
    /// Asked key backup for this session already.
    tried_backup: bool,
    /// Shown as "sent from an unverified device" already.
    untrusted: bool,
}

impl Index {
    fn assign(&mut self, id: &OwnedEventId, sent_at: Timestamp) -> TimelinePos {
        if let Some(p) = self.by_event.get(id) {
            return *p;
        }
        self.next += 1;
        let pos = (sent_at << 10) | (self.next & 0x3ff);
        self.by_event.insert(id.clone(), pos);
        pos
    }
}

impl Drop for MatrixAdapter {
    fn drop(&mut self) {
        if let Some(task) = self.session_task.lock().unwrap().take() {
            task.abort();
        }
    }
}

#[derive(Default)]
struct SessionOut {
    tx: Option<mpsc::UnboundedSender<AdapterEvent>>,
    pending: Option<Vec<u8>>,
}

pub struct MatrixAdapter {
    account: Mutex<Account>,
    client: Client,
    index: Arc<Mutex<Index>>,
    sync_task: Mutex<Option<JoinHandle<()>>>,
    /// Lets us push updates outside a sync (e.g. after changing notification level).
    events: Mutex<Option<mpsc::UnboundedSender<AdapterEvent>>>,
    retry_task: Mutex<Option<JoinHandle<()>>>,
    /// Privacy setting: send m.read.private instead of public read receipts.
    private_receipts: AtomicBool,
    /// Email additions waiting for their confirmation mail: client secret -> session id.
    pending_emails: Mutex<HashMap<String, String>>,
    /// Where refreshed sessions go (see `new`).
    session_out: Arc<Mutex<SessionOut>>,
    /// The running sliding sync, for subscribing to the chat on screen.
    sliding: Arc<Mutex<Option<matrix_sdk::sliding_sync::SlidingSync>>>,
    /// The rooms sliding sync follows closely (see `RoomSubscriptions`).
    rooms: Arc<RoomSubscriptions>,
    session_task: Mutex<Option<JoinHandle<()>>>,
    /// The account's store folder (see `store_dir`).
    store: PathBuf,
}

/// What a homeserver accepts, so the login screen only offers what works.
#[derive(Debug, Clone, Serialize)]
pub struct LoginMethods {
    pub homeserver: String,
    pub password: bool,
    pub sso: bool,
    /// Signs in through the server's OAuth 2.0 login page (MAS); preferred when offered.
    pub oauth: bool,
    pub identity_providers: Vec<IdentityProvider>,
}

#[derive(Debug, Clone, Serialize)]
pub struct IdentityProvider {
    pub id: String,
    pub name: String,
}

/// Resolves a server name (`surf.nl`) or URL and asks it how to log in.
pub async fn login_methods(homeserver: &str) -> Result<LoginMethods> {
    use matrix_sdk::ruma::api::client::session::get_login_types::v3::LoginType;

    let client = Client::builder().server_name_or_homeserver_url(homeserver).build().await.map_err(|e| {
        AdapterError::Network(format!(
            "Couldn't find a Matrix server at \"{homeserver}\". Check the address, or enter the server's full URL (https://…). Details: {e}"
        ))
    })?;
    let oauth = oauth::supported(&client).await;
    let mut methods = LoginMethods { homeserver: client.homeserver().to_string(), password: false, sso: false, oauth, identity_providers: vec![] };
    // With OAuth the old login types may be gone (or only kept for older apps).
    let types = match client.matrix_auth().get_login_types().await {
        Ok(types) => types,
        Err(_) if oauth => return Ok(methods),
        Err(e) => return Err(AdapterError::Network(e.to_string())),
    };
    for flow in types.flows {
        match flow {
            LoginType::Password(_) => methods.password = true,
            LoginType::Sso(sso) => {
                methods.sso = true;
                methods.identity_providers.extend(sso.identity_providers.into_iter().map(|p| IdentityProvider { id: p.id, name: p.name }));
            }
            _ => {}
        }
    }
    Ok(methods)
}

pub enum Credentials<'a> {
    Password { username: &'a str, password: &'a str },
    /// Opens the SSO page in the user's browser via `open_url`; a local
    /// server catches the redirect.
    Sso { identity_provider: Option<String>, open_url: Box<dyn FnOnce(String) -> Result<()> + Send> },
    /// The server's OAuth 2.0 login page in the browser; a loopback address catches the redirect.
    OAuth { open_url: Box<dyn FnOnce(String) -> Result<()> + Send> },
}

impl MatrixAdapter {
    #[allow(clippy::too_many_arguments)]
    fn directory_room(&self, id: OwnedRoomId, alias: Option<String>, name: Option<String>, topic: Option<String>, members: u64, avatar: Option<String>, is_space: bool) -> DirectoryRoom {
        let joined = self
            .client
            .get_room(&id)
            .filter(|r| r.state() == matrix_sdk::RoomState::Joined)
            .map(|r| ConversationId { account: self.account().id, remote: r.room_id().to_string() }.key());
        DirectoryRoom {
            name: name.or_else(|| alias.clone()).unwrap_or_else(|| id.to_string()),
            id: id.to_string(),
            alias,
            topic,
            members,
            avatar,
            is_space,
            joined,
            join_rule: None,
        }
    }

    /// Signs in and returns the adapter plus the session blob the host must
    /// persist (see [`StoredSession`]).
    pub async fn login(data_dir: &Path, homeserver: &str, credentials: Credentials<'_>) -> Result<(Arc<Self>, Vec<u8>)> {
        let account_id = AccountId(Alphanumeric.sample_string(&mut rand::rng(), 12));
        let store = store_dir(data_dir, &account_id);
        let result = Self::login_into(&store, account_id, homeserver, credentials).await;
        if result.is_err() {
            let _ = std::fs::remove_dir_all(&store);
        }
        result
    }

    async fn login_into(store: &Path, account_id: AccountId, homeserver: &str, credentials: Credentials<'_>) -> Result<(Arc<Self>, Vec<u8>)> {
        let store_passphrase = Alphanumeric.sample_string(&mut rand::rng(), 32);
        let client = build_client(store, homeserver, &store_passphrase).await?;
        let auth = client.matrix_auth();
        let result = match credentials {
            Credentials::OAuth { open_url } => oauth::login(&client, open_url).await.map_err(|e| matrix_sdk::Error::UnknownError(e.to_string().into())),
            Credentials::Password { username, password } => {
                auth.login_username(username, password).initial_device_display_name("ms_trix").await.map(drop)
            }
            Credentials::Sso { identity_provider, open_url } => {
                let builder = auth
                    .login_sso(|url| async move { open_url(url).map_err(|e| matrix_sdk::Error::UnknownError(e.to_string().into())) })
                    .initial_device_display_name("ms_trix");
                match identity_provider {
                    Some(idp) => builder.identity_provider_id(&idp).await.map(drop),
                    None => builder.await.map(drop),
                }
            }
        };
        result.map_err(|e| AdapterError::Auth(e.to_string()))?;

        let blob = StoredSession::of(&client, &store_passphrase)?;
        let account = account_for(&client, account_id).await?;
        Ok((Arc::new(Self::new(account, client, store_passphrase, store.to_owned())), blob))
    }

    pub async fn restore(data_dir: &Path, account: Account, blob: &[u8]) -> Result<Arc<Self>> {
        let stored: StoredSession = serde_json::from_slice(blob).map_err(err)?;
        let client = build_client(&store_dir(data_dir, &account.id), &stored.homeserver, &stored.store_passphrase).await?;
        let restored = match (stored.oauth, stored.session) {
            (Some((client_id, user)), _) => client.restore_session(OAuthSession { client_id: ClientId::new(client_id), user }).await,
            (None, Some(session)) => client.restore_session(session).await,
            (None, None) => return Err(AdapterError::Auth("stored session is empty; sign in again".into())),
        };
        restored.map_err(|e| AdapterError::Auth(e.to_string()))?;
        let store = store_dir(data_dir, &account.id);
        Ok(Arc::new(Self::new(account, client, stored.store_passphrase, store)))
    }

    fn new(account: Account, client: Client, store_passphrase: String, store: PathBuf) -> Self {
        let session_out: Arc<Mutex<SessionOut>> = Default::default();
        let sliding: Arc<Mutex<Option<matrix_sdk::sliding_sync::SlidingSync>>> = Default::default();
        // Refreshed tokens must be stored right away: the old refresh token stops working.
        // Before the host listens (during start-up) the newest one waits in `pending`.
        let mut changes = client.subscribe_to_session_changes();
        let (watch_client, out, id) = (client.clone(), session_out.clone(), account.id.clone());
        let session_task = tokio::spawn(async move {
            loop {
                match changes.recv().await {
                    Ok(SessionChange::TokensRefreshed) => {
                        let Ok(blob) = StoredSession::of(&watch_client, &store_passphrase) else { continue };
                        let mut out = out.lock().unwrap();
                        match &out.tx {
                            Some(tx) => drop(tx.send(AdapterEvent::SessionChanged { account: id.clone(), session: blob })),
                            None => out.pending = Some(blob),
                        }
                    }
                    Ok(SessionChange::UnknownToken(_)) => tracing::warn!("session token rejected by the server"),
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(_) => break,
                }
            }
        });
        Self {
            account: Mutex::new(account),
            client,
            index: Default::default(),
            sync_task: Mutex::new(None),
            events: Mutex::new(None),
            retry_task: Mutex::new(None),
            private_receipts: AtomicBool::new(false),
            pending_emails: Default::default(),
            session_out,
            session_task: Mutex::new(Some(session_task)),
            rooms: Arc::new(RoomSubscriptions { sliding: sliding.clone(), focus: Mutex::default(), verifying: Mutex::default() }),
            sliding,
            store,
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn send_attachment(&self, conversation: &ConversationId, name: &str, mime: Option<&str>, data: Vec<u8>, caption: Option<&str>, thumb: Option<VideoThumb>, thread: Option<&MessageId>) -> Result<()> {
        use matrix_sdk::attachment::{AttachmentConfig, AttachmentInfo, BaseVideoInfo, Thumbnail};
        use matrix_sdk::room::reply::{EnforceThread, Reply};
        use matrix_sdk::ruma::events::room::message::{AddMentions, ReplyWithinThread, TextMessageEventContent};
        use matrix_sdk::ruma::UInt;

        let mime: mime::Mime = mime.and_then(|m| m.parse().ok()).unwrap_or_else(|| mime_guess::from_path(name).first_or_octet_stream());
        // The SDK encrypts the upload (and the thumbnail) in encrypted rooms.
        let mut config = AttachmentConfig::new().caption(caption.filter(|c| !c.trim().is_empty()).map(TextMessageEventContent::markdown));
        // In a thread: a thread message under its root (not a reply to the root itself).
        if let Some(root) = thread {
            let event_id = OwnedEventId::try_from(root.0.as_str()).map_err(err)?;
            config = config.reply(Some(Reply { event_id, enforce_thread: EnforceThread::Threaded(ReplyWithinThread::No), add_mentions: AddMentions::No }));
        }
        if let Some(t) = thumb.filter(|_| mime.type_() == mime::VIDEO) {
            config = config.info(AttachmentInfo::Video(BaseVideoInfo {
                duration: Some(Duration::from_millis(t.duration_ms)),
                height: Some(UInt::from(t.video_height)),
                width: Some(UInt::from(t.video_width)),
                size: UInt::new(data.len() as u64),
                blurhash: None,
            }));
            let size = UInt::new(t.data.len() as u64).unwrap_or_default();
            config = config.thumbnail(Some(Thumbnail { data: t.data, content_type: mime::IMAGE_JPEG, height: UInt::from(t.height), width: UInt::from(t.width), size }));
        }
        // Report progress to the UI while the upload runs.
        let progress = eyeball::SharedObservable::new(matrix_sdk::TransmissionProgress::default());
        let watcher = self.events.lock().unwrap().clone().map(|tx| {
            let mut updates = progress.subscribe();
            let (key, name) = (conversation.key(), name.to_owned());
            tokio::spawn(async move {
                while let Some(p) = updates.next().await {
                    let _ = tx.send(AdapterEvent::UploadProgress(UploadProgress { conversation: key.clone(), name: name.clone(), sent: p.current as u64, total: p.total as u64 }));
                }
            })
        });
        let result = self.room(conversation)?.send_attachment(name, &mime, data, config).with_send_progress_observable(progress).await;
        if let Some(watcher) = watcher {
            watcher.abort();
        }
        result.map_err(send_err)?;
        Ok(())
    }

    /// The teams (spaces) a room is in: its own m.space.parent links, or spaces we're in that
    /// list it as a child.
    async fn teams_of(&self, room: &Room) -> Vec<OwnedRoomId> {
        use matrix_sdk::ruma::events::StateEventType;
        let state_key = |raw: &str| serde_json::from_str::<serde_json::Value>(raw).ok().and_then(|v| v["state_key"].as_str().map(ToOwned::to_owned));
        let has_via = |raw: &str| serde_json::from_str::<serde_json::Value>(raw).ok().is_some_and(|v| v["content"]["via"].as_array().is_some_and(|a| !a.is_empty()));
        let mut teams: Vec<OwnedRoomId> = vec![];
        for raw in room.get_state_events(StateEventType::SpaceParent).await.unwrap_or_default() {
            let json = match &raw {
                matrix_sdk::deserialized_responses::RawAnySyncOrStrippedState::Sync(r) => r.json().get().to_owned(),
                matrix_sdk::deserialized_responses::RawAnySyncOrStrippedState::Stripped(r) => r.json().get().to_owned(),
            };
            if has_via(&json) {
                if let Some(id) = state_key(&json).and_then(|k| OwnedRoomId::try_from(k).ok()) {
                    teams.push(id);
                }
            }
        }
        if teams.is_empty() {
            for space in self.client.joined_rooms().into_iter().filter(|r| r.is_space()) {
                if let Ok(Some(raw)) = space.get_state_event(StateEventType::SpaceChild, room.room_id().as_str()).await {
                    let json = match &raw {
                        matrix_sdk::deserialized_responses::RawAnySyncOrStrippedState::Sync(r) => r.json().get().to_owned(),
                        matrix_sdk::deserialized_responses::RawAnySyncOrStrippedState::Stripped(r) => r.json().get().to_owned(),
                    };
                    if has_via(&json) {
                        teams.push(space.room_id().to_owned());
                    }
                }
            }
        }
        teams
    }

    fn room(&self, conversation: &ConversationId) -> Result<Room> {
        let id = RoomId::parse(&conversation.remote).map_err(err)?;
        self.client.get_room(&id).ok_or_else(|| err(format!("unknown room {id}")))
    }

    fn register_handlers(&self, tx: mpsc::UnboundedSender<AdapterEvent>) {
        let me: OwnedUserId = self.client.user_id().expect("logged in").to_owned();
        let account = self.account().id;

        // Receipts often point at non-message events (reactions, joins), so
        // every timeline event gets a position, not just messages.
        // Also turns room events in the timeline (joins, renames, ...) into grey lines.
        // Timeline only: the sync's separate state block would replay years of joins.
        self.client.add_event_handler({
            let (tx, me, account, index) = (tx.clone(), me.clone(), account.clone(), self.index.clone());
            move |ev: AnySyncTimelineEvent, room: Room| {
                index.lock().unwrap().assign(&ev.event_id().to_owned(), u64::from(ev.origin_server_ts().0));
                let (tx, me, account, index) = (tx.clone(), me.clone(), account.clone(), index.clone());
                async move {
                    if let AnySyncTimelineEvent::State(state) = ev {
                        if let Some(event) = room_event_from(&room, &state, &me, &account, &index).await {
                            let _ = tx.send(event);
                        }
                    }
                }
            }
        });

        self.client.add_event_handler({
            let (tx, me, account, index) = (tx.clone(), me.clone(), account.clone(), self.index.clone());
            move |ev: OriginalSyncRoomMessageEvent, room: Room| {
                let (tx, me, account, index) = (tx.clone(), me.clone(), account.clone(), index.clone());
                async move {
                    if let Some(event) = message_from(&room, &ev, &me, &account, &index).await {
                        let _ = tx.send(event);
                    }
                }
            }
        });

        self.client.add_event_handler({
            let (tx, me, account, index) = (tx.clone(), me.clone(), account.clone(), self.index.clone());
            move |ev: SyncEphemeralRoomEvent<ReceiptEventContent>, room: Room| {
                let (tx, me, account, index) = (tx.clone(), me.clone(), account.clone(), index.clone());
                async move {
                    for (event_id, receipts) in ev.content.0 {
                        for (kind, users) in receipts {
                            if !matches!(kind, ReceiptType::Read | ReceiptType::ReadPrivate) {
                                continue;
                            }
                            let conversation = ConversationId { account: account.clone(), remote: room.room_id().to_string() };
                            for (user, receipt) in users {
                                let Some(pos) = receipt_pos(&index, &event_id, &receipt) else { continue };
                                if user != me {
                                    let _ = tx.send(read_by(&room, conversation.clone(), &user, pos).await);
                                    continue;
                                }
                                let thread_root = match &receipt.thread {
                                    ReceiptThread::Thread(root) => Some(MessageId(root.to_string())),
                                    _ => None,
                                };
                                let _ = tx.send(AdapterEvent::OwnReadReceipt {
                                    conversation: conversation.clone(),
                                    all_threads: receipt.thread == ReceiptThread::Unthreaded,
                                    thread_root,
                                    pos,
                                    at: receipt.ts.map(|t| u64::from(t.0)).unwrap_or_else(now),
                                });
                            }
                        }
                    }
                }
            }
        });

        self.client.add_event_handler({
            let (tx, me, account) = (tx.clone(), me.clone(), account.clone());
            move |ev: SyncEphemeralRoomEvent<TypingEventContent>, room: Room| {
                let (tx, me, account) = (tx.clone(), me.clone(), account.clone());
                async move {
                    let mut names = vec![];
                    for user in ev.content.user_ids.iter().filter(|u| **u != me) {
                        names.push(member_profile(&room, user).await.0);
                    }
                    let _ = tx.send(AdapterEvent::Typing { conversation: ConversationId { account, remote: room.room_id().to_string() }, names });
                }
            }
        });

        self.client.add_event_handler({
            let (tx, me, account, index) = (tx.clone(), me.clone(), account.clone(), self.index.clone());
            move |ev: OriginalSyncMessageLikeEvent<StickerEventContent>, room: Room| {
                let (tx, me, account, index) = (tx.clone(), me.clone(), account.clone(), index.clone());
                async move {
                    if let Some(m) = sticker_from(&room, &ev, &me, &account, &index).await {
                        let _ = tx.send(AdapterEvent::Message(m));
                    }
                }
            }
        });

        self.client.add_event_handler({
            let (tx, me, account) = (tx.clone(), me.clone(), account.clone());
            move |ev: OriginalSyncReactionEvent, room: Room| {
                let (tx, me, account) = (tx.clone(), me.clone(), account.clone());
                async move {
                    let _ = tx.send(reaction_from(&room, &ev, &me, &account).await);
                }
            }
        });

        self.client.add_event_handler({
            let (tx, account) = (tx.clone(), account.clone());
            move |ev: OriginalSyncRoomRedactionEvent, room: Room| {
                let (tx, account) = (tx.clone(), account.clone());
                async move {
                    if let Some(event) = redaction_from(&room, &ev, &account) {
                        let _ = tx.send(event);
                    }
                }
            }
        });

        self.client.add_event_handler({
            let tx = tx.clone();
            move |ev: matrix_sdk::ruma::events::presence::PresenceEvent| {
                use matrix_sdk::ruma::presence::PresenceState;
                let presence = match ev.content.presence {
                    PresenceState::Online => Presence::Available,
                    PresenceState::Unavailable => Presence::Away,
                    _ => Presence::Offline,
                };
                let status = ev.content.status_msg.filter(|s| !s.trim().is_empty());
                let _ = tx.send(AdapterEvent::PresenceChanged { user_id: ev.sender.to_string(), presence, status });
                async {}
            }
        });

        // Messages that failed to decrypt arrive as m.room.encrypted: show a placeholder
        // and keep the raw event so the retry loop can decrypt it once the key arrives.
        self.client.add_event_handler({
            let (tx, me, account, index) = (tx.clone(), me.clone(), account.clone(), self.index.clone());
            move |_: OriginalSyncRoomEncryptedEvent, room: Room, raw: matrix_sdk::event_handler::RawEvent| {
                let (tx, me, account, index) = (tx.clone(), me.clone(), account.clone(), index.clone());
                async move {
                    let raw = matrix_sdk::ruma::serde::Raw::<OriginalSyncRoomEncryptedEvent>::from_json(raw.0.clone());
                    if let Some(event) = encrypted_placeholder(&room, raw, &me, &account, &index, false).await {
                        let _ = tx.send(event);
                    }
                }
            }
        });

        // Both the stable and the older unstable (com.famedly) flag are in use.
        let marked = |tx: mpsc::UnboundedSender<AdapterEvent>, account: AccountId, room: &Room, value: bool| {
            let _ = tx.send(AdapterEvent::MarkedUnread {
                conversation: ConversationId { account, remote: room.room_id().to_string() },
                value,
                at: now(),
            });
        };
        self.client.add_event_handler({
            let (tx, account) = (tx.clone(), account.clone());
            move |ev: RoomAccountDataEvent<MarkedUnreadEventContent>, room: Room| {
                marked(tx.clone(), account.clone(), &room, ev.content.unread);
                async {}
            }
        });
        self.client.add_event_handler({
            let (tx, account) = (tx.clone(), account.clone());
            move |ev: RoomAccountDataEvent<UnstableMarkedUnreadEventContent>, room: Room| {
                marked(tx.clone(), account.clone(), &room, ev.content.0.unread);
                async {}
            }
        });
    }
}

#[async_trait]
impl ProtocolAdapter for MatrixAdapter {
    fn account(&self) -> Account {
        self.account.lock().unwrap().clone()
    }

    async fn refresh_profile(&self) -> Result<Account> {
        let fresh = account_for(&self.client, self.account().id).await?;
        let mut account = self.account.lock().unwrap();
        account.display_name = fresh.display_name;
        account.avatar_url = fresh.avatar_url;
        Ok(account.clone())
    }

    async fn load_older(&self, conversation: &ConversationId, limit: u32) -> Result<History> {
        let room = self.room(conversation)?;
        let me = self.client.user_id().ok_or_else(|| AdapterError::Auth("not logged in".into()))?.to_owned();
        let account = self.account().id;
        // Rooms first seen via live sync have no token yet: the first page from
        // the newest event mostly repeats what we have, so take one more.
        let mut messages = vec![];
        for _ in 0..2 {
            let token = self.index.lock().unwrap().back_tokens.get(room.room_id()).cloned();
            let from = match token {
                Some(None) => return Ok(History { events: messages, has_more: false }),
                Some(Some(t)) => Some(t),
                None => None,
            };
            let had_token = from.is_some();
            let (page, end) = fetch_page(&self.client, &room, from, limit, &me, &account, &self.index).await.ok_or_else(|| err("could not load older messages"))?;
            self.index.lock().unwrap().back_tokens.insert(room.room_id().to_owned(), end.clone());
            messages.extend(page);
            if had_token || end.is_none() {
                return Ok(History { events: messages, has_more: end.is_some() });
            }
        }
        Ok(History { events: messages, has_more: true })
    }

    async fn refetch(&self, conversation: &ConversationId, ids: &[MessageId]) -> Result<Vec<AdapterEvent>> {
        let room = self.room(conversation)?;
        let me = self.client.user_id().ok_or_else(|| AdapterError::Auth("not logged in".into()))?.to_owned();
        let mut out = vec![];
        for id in ids {
            let Ok(id) = OwnedEventId::try_from(id.0.as_str()) else { continue };
            // From the server, so it's decrypted with whatever keys we have now.
            if let Ok(event) = room.event(&id, None).await {
                out.extend(convert(&room, &event, &me, &self.account().id, &self.index).await);
            }
        }
        Ok(out)
    }

    async fn prepare_media(&self, conversation: &ConversationId, message: &MessageId, media: &str) -> Result<()> {
        if self.index.lock().unwrap().encrypted_media.contains_key(media) {
            return Ok(());
        }
        let room = self.room(conversation)?;
        if !room.latest_encryption_state().await.map(|s| s.is_encrypted()).unwrap_or(false) {
            return Ok(());
        }
        // Converting the event records its encrypted media source.
        let me = self.client.user_id().ok_or_else(|| AdapterError::Auth("not logged in".into()))?.to_owned();
        let id = OwnedEventId::try_from(message.0.as_str()).map_err(err)?;
        let event = room.load_or_fetch_event(&id, None).await.map_err(err)?;
        convert(&room, &event, &me, &self.account().id, &self.index).await;
        Ok(())
    }

    async fn context(&self, conversation: &ConversationId, message: &MessageId, size: u32) -> Result<Vec<Message>> {
        let room = self.room(conversation)?;
        let me = self.client.user_id().ok_or_else(|| AdapterError::Auth("not logged in".into()))?.to_owned();
        let id = OwnedEventId::try_from(message.0.as_str()).map_err(err)?;
        let ctx = room.event_with_context(&id, true, size.into(), None).await.map_err(err)?;
        // events_before comes newest first.
        let events = ctx.events_before.into_iter().rev().chain(ctx.event).chain(ctx.events_after);
        let mut out = vec![];
        for event in events {
            if let Some(AdapterEvent::Message(m)) = convert(&room, &event, &me, &self.account().id, &self.index).await {
                out.push(m);
            }
        }
        Ok(out)
    }

    async fn crawl(&self, conversation: &ConversationId, from: Option<String>, limit: u32) -> Result<Option<CrawlPage>> {
        let room = self.room(conversation)?;
        let me = self.client.user_id().ok_or_else(|| AdapterError::Auth("not logged in".into()))?.to_owned();
        let (events, next) = fetch_page(&self.client, &room, from, limit, &me, &self.account().id, &self.index).await.ok_or_else(|| err("could not load history"))?;
        Ok(Some(CrawlPage { events, next }))
    }

    async fn load_thread(&self, conversation: &ConversationId, root: &MessageId) -> Result<History> {
        use matrix_sdk::room::{IncludeRelations, RelationsOptions};
        use matrix_sdk::ruma::api::Direction;
        use matrix_sdk::ruma::events::relation::RelationType;

        let room = self.room(conversation)?;
        let me = self.client.user_id().ok_or_else(|| AdapterError::Auth("not logged in".into()))?.to_owned();
        let account = self.account().id;
        let root_id = OwnedEventId::try_from(root.0.as_str()).map_err(err)?;

        let mut messages = vec![];
        if let Ok(event) = room.load_or_fetch_event(&root_id, None).await {
            messages.extend(convert(&room, &event, &me, &account, &self.index).await);
        }
        let mut from = None;
        // Threads are usually short; cap at a few pages to stay responsive.
        for _ in 0..5 {
            let options = RelationsOptions {
                from: from.clone(),
                dir: Direction::Backward,
                limit: Some(100u32.into()),
                include_relations: IncludeRelations::RelationsOfType(RelationType::Thread),
                ..Default::default()
            };
            let page = room.relations(root_id.clone(), options).await.map_err(err)?;
            for event in &page.chunk {
                messages.extend(convert(&room, event, &me, &account, &self.index).await);
            }
            from = page.next_batch_token;
            if from.is_none() {
                break;
            }
        }
        Ok(History { events: messages, has_more: from.is_some() })
    }

    async fn react(&self, conversation: &ConversationId, target: &MessageId, key: &str) -> Result<()> {
        use matrix_sdk::ruma::events::reaction::ReactionEventContent;
        use matrix_sdk::ruma::events::relation::Annotation;

        let target = OwnedEventId::try_from(target.0.as_str()).map_err(err)?;
        self.room(conversation)?.send(ReactionEventContent::new(Annotation::new(target, key.to_owned()))).await.map_err(err)?;
        Ok(())
    }

    async fn edit(&self, conversation: &ConversationId, target: &MessageId, text: &str) -> Result<()> {
        use matrix_sdk::ruma::events::room::message::ReplacementMetadata;

        let target = OwnedEventId::try_from(target.0.as_str()).map_err(err)?;
        let content = RoomMessageEventContent::text_markdown(text).make_replacement(ReplacementMetadata::new(target, None));
        self.room(conversation)?.send(content).await.map_err(err)?;
        Ok(())
    }

    async fn redact(&self, conversation: &ConversationId, id: &MessageId) -> Result<()> {
        let id = OwnedEventId::try_from(id.0.as_str()).map_err(err)?;
        self.room(conversation)?.redact(&id, None, None).await.map_err(err)?;
        Ok(())
    }

    async fn send_file(&self, conversation: &ConversationId, name: &str, mime: Option<&str>, data: Vec<u8>, caption: Option<&str>) -> Result<()> {
        self.send_attachment(conversation, name, mime, data, caption, None, None).await
    }

    /// With a still (thumbnail), size and length, like Element sends videos.
    async fn send_video(&self, conversation: &ConversationId, name: &str, mime: Option<&str>, data: Vec<u8>, caption: Option<&str>, thumb: VideoThumb) -> Result<()> {
        self.send_attachment(conversation, name, mime, data, caption, Some(thumb), None).await
    }

    async fn send_file_in_thread(&self, conversation: &ConversationId, root: &MessageId, name: &str, mime: Option<&str>, data: Vec<u8>, caption: Option<&str>, thumb: Option<VideoThumb>) -> Result<()> {
        self.send_attachment(conversation, name, mime, data, caption, thumb, Some(root)).await
    }

    /// Sent like Element's voice messages (m.audio + the voice and waveform blocks).
    async fn send_voice(&self, conversation: &ConversationId, mime: &str, data: Vec<u8>, duration_ms: u64, waveform: Vec<f32>) -> Result<()> {
        use matrix_sdk::attachment::{AttachmentConfig, AttachmentInfo, BaseAudioInfo};

        let parsed: mime::Mime = mime.parse().unwrap_or(mime::APPLICATION_OCTET_STREAM);
        let ext = if mime.contains("ogg") { "ogg" } else if mime.contains("webm") { "webm" } else { "m4a" };
        let info = BaseAudioInfo {
            duration: Some(Duration::from_millis(duration_ms)),
            size: matrix_sdk::ruma::UInt::new(data.len() as u64),
            waveform: Some(waveform.into_iter().map(|v| v.clamp(0.0, 1.0)).collect()),
        };
        let config = AttachmentConfig::new().info(AttachmentInfo::Voice(info));
        self.room(conversation)?.send_attachment(format!("Voice message.{ext}"), &parsed, data, config).await.map_err(send_err)?;
        Ok(())
    }

    async fn image_packs(&self, conversation: Option<&ConversationId>) -> Result<Vec<ImagePack>> {
        use matrix_sdk::deserialized_responses::RawAnySyncOrStrippedState;
        use matrix_sdk::ruma::events::{GlobalAccountDataEventType, StateEventType};

        let json = |raw: &str| serde_json::from_str::<serde_json::Value>(raw).ok();
        let state_content = |s: &RawAnySyncOrStrippedState| match s {
            RawAnySyncOrStrippedState::Sync(raw) => json(raw.json().get()).map(|v| v["content"].clone()),
            RawAnySyncOrStrippedState::Stripped(raw) => json(raw.json().get()).map(|v| v["content"].clone()),
        };
        let mut packs = vec![];
        let account = self.client.account();
        if let Ok(Some(raw)) = account.account_data_raw(GlobalAccountDataEventType::from(USER_EMOTES)).await {
            packs.extend(json(raw.json().get()).and_then(|v| parse_pack(&v, "Your emoji")));
        }
        // Packs in other rooms the user chose to use everywhere.
        let linked = account.account_data_raw(GlobalAccountDataEventType::from("im.ponies.emote_rooms")).await.ok().flatten().and_then(|raw| json(raw.json().get()));
        let mut seen = std::collections::HashSet::new();
        if let Some(rooms) = linked.as_ref().and_then(|v| v["rooms"].as_object()) {
            for (room_id, keys) in rooms {
                let Some(room) = OwnedRoomId::try_from(room_id.as_str()).ok().and_then(|id| self.client.get_room(&id)) else { continue };
                for key in keys.as_object().into_iter().flat_map(|k| k.keys()) {
                    seen.insert((room_id.clone(), key.clone()));
                    if let Ok(Some(state)) = room.get_state_event(StateEventType::from("im.ponies.room_emotes"), key).await {
                        packs.extend(state_content(&state).and_then(|v| parse_pack(&v, &room.name().unwrap_or_default())));
                    }
                }
            }
        }
        // And this room's own packs.
        if let Some(room) = conversation.and_then(|c| self.room(c).ok()) {
            for state in room.get_state_events(StateEventType::from("im.ponies.room_emotes")).await.unwrap_or_default() {
                let event = match &state {
                    RawAnySyncOrStrippedState::Sync(raw) => json(raw.json().get()),
                    RawAnySyncOrStrippedState::Stripped(raw) => json(raw.json().get()),
                };
                let key = event.as_ref().and_then(|v| v["state_key"].as_str().map(ToOwned::to_owned)).unwrap_or_default();
                if seen.contains(&(room.room_id().to_string(), key)) {
                    continue; // already listed as a linked pack
                }
                packs.extend(state_content(&state).and_then(|v| parse_pack(&v, &room.name().unwrap_or_default())));
            }
        }
        Ok(packs)
    }

    async fn own_pack(&self) -> Result<ImagePack> {
        use matrix_sdk::ruma::events::GlobalAccountDataEventType;
        let raw = self.client.account().account_data_raw(GlobalAccountDataEventType::from(USER_EMOTES)).await.map_err(err)?;
        let pack = raw.and_then(|r| serde_json::from_str::<serde_json::Value>(r.json().get()).ok()).and_then(|v| parse_pack(&v, ""));
        Ok(pack.unwrap_or(ImagePack { name: String::new(), images: vec![] }))
    }

    async fn save_own_pack(&self, pack: &ImagePack) -> Result<()> {
        use matrix_sdk::ruma::events::GlobalAccountDataEventType;
        use matrix_sdk::ruma::serde::Raw;
        let images: serde_json::Map<String, serde_json::Value> = pack
            .images
            .iter()
            .map(|i| {
                let usage: Vec<&str> = [(i.emoticon, "emoticon"), (i.sticker, "sticker")].into_iter().filter(|(on, _)| *on).map(|(_, u)| u).collect();
                let mut image = serde_json::json!({ "url": i.url, "usage": usage });
                if let Some(body) = &i.body {
                    image["body"] = body.clone().into();
                }
                (i.shortcode.clone(), image)
            })
            .collect();
        let mut content = serde_json::json!({ "images": images });
        if !pack.name.trim().is_empty() {
            content["pack"] = serde_json::json!({ "display_name": pack.name.trim() });
        }
        let raw = Raw::from_json(serde_json::value::to_raw_value(&content).map_err(err)?);
        self.client.account().set_account_data_raw(GlobalAccountDataEventType::from(USER_EMOTES), raw).await.map_err(err)?;
        Ok(())
    }

    async fn upload_image(&self, mime: &str, data: Vec<u8>) -> Result<String> {
        let mime: mime::Mime = mime.parse().unwrap_or(mime::IMAGE_PNG);
        Ok(self.client.media().upload(&mime, data, None).await.map_err(err)?.content_uri.to_string())
    }

    /// Answers from the start event, votes from its m.reference relations: each
    /// person's latest vote before the poll ended counts (MSC3381).
    async fn poll(&self, conversation: &ConversationId, poll: &str) -> Result<PollView> {
        use matrix_sdk::room::{IncludeRelations, RelationsOptions};
        use matrix_sdk::ruma::api::Direction;
        use matrix_sdk::ruma::events::relation::RelationType;

        let room = self.room(conversation)?;
        let me = self.client.user_id().ok_or_else(|| AdapterError::Auth("not logged in".into()))?.to_string();
        let id = OwnedEventId::try_from(poll).map_err(err)?;
        let start = room.load_or_fetch_event(&id, None).await.map_err(err)?;
        let start: serde_json::Value = serde_json::from_str(start.raw().json().get()).map_err(err)?;
        let content = &start["content"];
        let creator = start["sender"].as_str().unwrap_or_default().to_owned();
        let (question, answers, max_selections, disclosed) = parse_poll(content).ok_or_else(|| AdapterError::Other("not a poll".into()))?;

        let mut votes: HashMap<String, (u64, Vec<String>)> = HashMap::new();
        let mut ended_at: Option<u64> = None;
        let mut from = None;
        for _ in 0..20 {
            let options = RelationsOptions { from: from.clone(), dir: Direction::Backward, limit: Some(100u32.into()), include_relations: IncludeRelations::RelationsOfType(RelationType::Reference), ..Default::default() };
            let page = room.relations(id.clone(), options).await.map_err(err)?;
            for event in &page.chunk {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(event.raw().json().get()) else { continue };
                let (kind, sender, ts) = (v["type"].as_str().unwrap_or_default(), v["sender"].as_str().unwrap_or_default(), v["origin_server_ts"].as_u64().unwrap_or(0));
                if kind.ends_with("poll.end") && sender == creator {
                    ended_at = Some(ended_at.map_or(ts, |e: u64| e.min(ts)));
                } else if kind.ends_with("poll.response") {
                    let picked = v["content"]["org.matrix.msc3381.poll.response"]["answers"].as_array().or_else(|| v["content"]["m.selections"].as_array())
                        .map(|a| a.iter().filter_map(|x| x.as_str().map(ToOwned::to_owned)).collect::<Vec<_>>()).unwrap_or_default();
                    let entry = votes.entry(sender.to_owned()).or_insert((0, vec![]));
                    if ts >= entry.0 {
                        *entry = (ts, picked);
                    }
                }
            }
            from = page.next_batch_token;
            if from.is_none() {
                break;
            }
        }
        // Votes after the end don't count; invalid answers or too many choices are spoilt.
        let valid: std::collections::HashSet<&str> = answers.iter().map(|(id, _)| id.as_str()).collect();
        let counted: Vec<(&String, &Vec<String>)> = votes.iter().filter(|(_, (ts, picked))| ended_at.is_none_or(|e| *ts <= e) && !picked.is_empty() && picked.len() <= max_selections as usize && picked.iter().all(|p| valid.contains(p.as_str()))).map(|(u, (_, p))| (u, p)).collect();
        let count = |answer: &str| counted.iter().filter(|(_, p)| p.iter().any(|x| x == answer)).count() as u32;
        Ok(PollView {
            answers: answers.iter().map(|(id, text)| (id.clone(), text.clone(), count(id))).collect(),
            question,
            max_selections,
            disclosed,
            ended: ended_at.is_some(),
            mine: votes.get(&me).map(|(_, p)| p.clone()).unwrap_or_default(),
            voters: counted.len() as u32,
            ours: creator == me,
        })
    }

    async fn vote(&self, conversation: &ConversationId, poll: &str, answers: &[String]) -> Result<()> {
        let content = serde_json::json!({
            "m.relates_to": { "rel_type": "m.reference", "event_id": poll },
            "org.matrix.msc3381.poll.response": { "answers": answers },
        });
        self.room(conversation)?.send_raw("org.matrix.msc3381.poll.response", content).await.map_err(err)?;
        Ok(())
    }

    async fn end_poll(&self, conversation: &ConversationId, poll: &str) -> Result<()> {
        let content = serde_json::json!({
            "m.relates_to": { "rel_type": "m.reference", "event_id": poll },
            "org.matrix.msc3381.poll.end": {},
            "org.matrix.msc1767.text": "Ended poll",
        });
        self.room(conversation)?.send_raw("org.matrix.msc3381.poll.end", content).await.map_err(err)?;
        Ok(())
    }

    async fn create_poll(&self, conversation: &ConversationId, question: &str, answers: &[String], max_selections: u32, disclosed: bool) -> Result<()> {
        let fallback = std::iter::once(question.to_owned()).chain(answers.iter().enumerate().map(|(i, a)| format!("{}. {a}", i + 1))).collect::<Vec<_>>().join("\n");
        let content = serde_json::json!({
            "org.matrix.msc3381.poll.start": {
                "kind": if disclosed { "org.matrix.msc3381.poll.disclosed" } else { "org.matrix.msc3381.poll.undisclosed" },
                "max_selections": max_selections.max(1),
                "question": { "org.matrix.msc1767.text": question },
                "answers": answers.iter().enumerate().map(|(i, a)| serde_json::json!({ "id": format!("a{i}"), "org.matrix.msc1767.text": a })).collect::<Vec<_>>(),
            },
            "org.matrix.msc1767.text": fallback,
        });
        self.room(conversation)?.send_raw("org.matrix.msc3381.poll.start", content).await.map_err(send_err)?;
        Ok(())
    }

    async fn send_sticker(&self, conversation: &ConversationId, url: &str, body: &str) -> Result<()> {
        let content = serde_json::json!({ "body": body, "url": url, "info": {} });
        self.room(conversation)?.send_raw("m.sticker", content).await.map_err(send_err)?;
        Ok(())
    }

    async fn members(&self, conversation: &ConversationId) -> Result<Vec<Member>> {
        use matrix_sdk::RoomMemberships;

        let members = self.room(conversation)?.members(RoomMemberships::JOIN).await.map_err(err)?;
        Ok(members
            .iter()
            .map(|m| Member { user_id: m.user_id().to_string(), name: m.name().to_owned(), avatar: m.avatar_url().map(|u| u.to_string()) })
            .collect())
    }

    async fn command(&self, conversation: &ConversationId, name: &str, args: &str) -> Result<CommandOutput> {
        use matrix_sdk::ruma::RoomOrAliasId;

        let account = self.account().id;
        let key = |room_id: &RoomId| ConversationId { account: account.clone(), remote: room_id.to_string() }.key();
        let user_arg = || {
            let first = args.split_whitespace().next().unwrap_or_default();
            UserId::parse(first).map_err(|_| AdapterError::Other(format!("\"{first}\" is not a user id; use the full form, e.g. @name:server.org")))
        };
        let say = |key: &str, vars: &[(&str, &str)]| Ok(CommandOutput::say(key, vars, None));

        match name {
            "join" | "goto" => {
                let target = RoomOrAliasId::parse(args.trim()).map_err(|_| AdapterError::Other("Use a room address like #room:server.org".into()))?;
                let room = self.client.join_room_by_id_or_alias(&target, &[]).await.map_err(err)?;
                Ok(CommandOutput::say("cmd.joined", &[("room", args.trim())], Some(key(room.room_id()))))
            }
            "part" | "leave" => {
                self.room(conversation)?.leave().await.map_err(err)?;
                say("cmd.left", &[])
            }
            "invite" => {
                let user = user_arg()?;
                self.room(conversation)?.invite_user_by_id(&user).await.map_err(err)?;
                say("cmd.invited", &[("user", user.as_str())])
            }
            "topic" => {
                let room = self.room(conversation)?;
                if args.trim().is_empty() {
                    return match room.topic() {
                        Some(topic) => say("cmd.topic", &[("topic", &topic)]),
                        None => say("cmd.noTopic", &[]),
                    };
                }
                room.set_room_topic(args.trim()).await.map_err(err)?;
                say("cmd.topicSet", &[])
            }
            "roomname" => {
                self.room(conversation)?.set_name(args.trim().to_owned()).await.map_err(err)?;
                say("cmd.roomNameSet", &[])
            }
            "nick" => {
                self.client.account().set_display_name(Some(args.trim())).await.map_err(err)?;
                say("cmd.nickSet", &[("name", args.trim())])
            }
            "query" | "msg" => {
                let user = user_arg()?;
                let room = match self.client.get_dm_room(&user) {
                    Some(room) => room,
                    None => self.client.create_dm(&user).await.map_err(err)?,
                };
                let text = args.trim().splitn(2, char::is_whitespace).nth(1).unwrap_or_default().trim();
                if name == "msg" && !text.is_empty() {
                    room.send(RoomMessageEventContent::text_markdown(text)).await.map_err(err)?;
                }
                Ok(CommandOutput::say("cmd.chatWith", &[("user", user.as_str())], Some(key(room.room_id()))))
            }
            "whois" => {
                let user = user_arg()?;
                let room = self.room(conversation)?;
                let (display, _) = member_profile(&room, &user).await;
                let level = room.get_user_power_level(&user).await.map(|l| format!(", power level {l:?}")).unwrap_or_default();
                Ok(CommandOutput { message: format!("{display} ({user}){level}"), open: None, text: None })
            }
            "remove" | "kick" | "ban" | "unban" => {
                let user = user_arg()?;
                let reason = args.trim().splitn(2, char::is_whitespace).nth(1).map(str::trim).filter(|r| !r.is_empty());
                let room = self.room(conversation)?;
                match name {
                    "ban" => room.ban_user(&user, reason).await,
                    "unban" => room.unban_user(&user, reason).await,
                    _ => room.kick_user(&user, reason).await,
                }
                .map_err(err)?;
                say(match name { "ban" => "cmd.banned", "unban" => "cmd.unbanned", _ => "cmd.removed" }, &[("user", user.as_str())])
            }
            "op" | "deop" => {
                use matrix_sdk::ruma::Int;
                let user = user_arg()?;
                let level: i64 = match (name, args.split_whitespace().nth(1)) {
                    ("deop", _) => 0,
                    (_, Some(l)) => l.parse().map_err(|_| AdapterError::Other(format!("\"{l}\" is not a power level; use a number like 50 or 100")))?,
                    (_, None) => 50,
                };
                self.room(conversation)?.update_power_levels(vec![(&user, Int::from(level as i32))]).await.map_err(err)?;
                say("cmd.powerLevel", &[("user", user.as_str()), ("level", &level.to_string())])
            }
            "ignore" | "unignore" => {
                let user = user_arg()?;
                self.set_ignored(user.as_str(), name == "ignore").await?;
                say(if name == "ignore" { "cmd.ignored" } else { "cmd.unignored" }, &[("user", user.as_str())])
            }
            "converttodm" | "converttoroom" => {
                self.room(conversation)?.set_is_direct(name == "converttodm").await.map_err(err)?;
                say(if name == "converttodm" { "cmd.convertedToDm" } else { "cmd.convertedToRoom" }, &[])
            }
            "upgraderoom" => {
                use matrix_sdk::ruma::api::client::room::upgrade_room::v3::Request;
                use matrix_sdk::ruma::RoomVersionId;
                let version = args.trim();
                let version = RoomVersionId::try_from(version).map_err(|_| AdapterError::Other("Use a room version, e.g. /upgraderoom 11".into()))?;
                let room = self.room(conversation)?;
                let response = self.client.send(Request::new(room.room_id().to_owned(), version.clone())).await.map_err(err)?;
                Ok(CommandOutput::say("cmd.upgraded", &[("version", version.as_str())], Some(key(&response.replacement_room))))
            }
            "discardsession" => {
                self.room(conversation)?.discard_room_key().await.map_err(err)?;
                say("cmd.discarded", &[])
            }
            "verify" => {
                // /verify <user> <device> <fingerprint>: manual check of a session's key.
                let mut parts = args.split_whitespace();
                let (Some(user), Some(device), Some(fingerprint)) = (parts.next(), parts.next(), parts.next()) else {
                    return Err(AdapterError::Other("Use /verify <@user:server> <session id> <fingerprint>".into()));
                };
                let user = UserId::parse(user).map_err(err)?;
                let device = self.client.encryption().get_device(&user, device.into()).await.map_err(err)?.ok_or_else(|| AdapterError::Other("Unknown session".into()))?;
                let actual = device.ed25519_key().map(|k| k.to_base64()).unwrap_or_default();
                let given: String = fingerprint.chars().filter(|c| !c.is_whitespace()).collect();
                if actual != given {
                    return Err(AdapterError::Other(format!("The fingerprint doesn't match! That session's key is {actual}. Someone may be intercepting messages.")));
                }
                device.verify().await.map_err(err)?;
                say("cmd.verified", &[("user", user.as_str()), ("device", device.device_id().as_str())])
            }
            "myroomnick" => {
                let nick = args.trim();
                self.room(conversation)?.set_own_member_display_name((!nick.is_empty()).then(|| nick.to_owned())).await.map_err(err)?;
                if nick.is_empty() { say("cmd.roomNickReset", &[]) } else { say("cmd.roomNickSet", &[("name", nick)]) }
            }
            _ => Err(AdapterError::Unsupported("this command")),
        }
    }

    /// Also becomes the default for future syncs, so it isn't reset to online.
    async fn set_presence(&self, presence: Presence, status_message: Option<String>) -> Result<()> {
        use matrix_sdk::ruma::presence::PresenceState;
        let state = match presence {
            Presence::Available | Presence::Busy => PresenceState::Online,
            Presence::Away => PresenceState::Unavailable,
            Presence::Offline => PresenceState::Offline,
        };
        self.client.set_presence(state, status_message, true).await.map_err(err)
    }

    async fn accept_invite(&self, conversation: &ConversationId) -> Result<()> {
        self.room(conversation)?.join().await.map_err(err)
    }

    /// Leaves and forgets the room, so it doesn't linger in "historical" lists (Element's Forget).
    async fn leave(&self, conversation: &ConversationId) -> Result<()> {
        let room = self.room(conversation)?;
        room.leave().await.map_err(err)?;
        if let Some(left) = self.client.get_room(room.room_id()) {
            if let Err(e) = left.forget().await {
                tracing::warn!("left {} but could not forget it: {e}", room.room_id());
            }
        }
        Ok(())
    }

    async fn search_users(&self, term: &str) -> Result<Vec<Member>> {
        let response = self.client.search_users(term, 20).await.map_err(err)?;
        Ok(response
            .results
            .into_iter()
            .map(|u| Member {
                name: u.display_name.unwrap_or_else(|| u.user_id.localpart().to_owned()),
                avatar: u.avatar_url.map(|a| a.to_string()),
                user_id: u.user_id.to_string(),
            })
            .collect())
    }

    async fn create_chat(&self, users: &[String], name: Option<&str>) -> Result<CommandOutput> {
        use matrix_sdk::ruma::api::client::room::create_room::v3::{Request, RoomPreset};
        use matrix_sdk::ruma::events::room::encryption::RoomEncryptionEventContent;
        use matrix_sdk::ruma::events::InitialStateEvent;

        let ids = users.iter().map(|u| UserId::parse(u).map_err(|_| AdapterError::Other(format!("\"{u}\" is not a valid user id")))).collect::<Result<Vec<_>>>()?;
        let key = |room: &Room| ConversationId { account: self.account().id, remote: room.room_id().to_string() }.key();
        let name = name.map(str::trim).filter(|n| !n.is_empty());

        // One person, no name: reuse the existing DM like Teams does.
        if let ([user], None) = (ids.as_slice(), name) {
            let room = match self.client.get_dm_room(user) {
                Some(room) => room,
                None => self.client.create_dm(user).await.map_err(err)?,
            };
            return Ok(CommandOutput::open(key(&room)));
        }

        let mut request = Request::new();
        request.invite = ids;
        request.name = name.map(ToOwned::to_owned);
        request.preset = Some(RoomPreset::PrivateChat);
        // New group chats are end-to-end encrypted, like Element's default.
        request.initial_state = vec![InitialStateEvent::with_empty_state_key(RoomEncryptionEventContent::with_recommended_defaults()).to_raw_any()];
        let room = self.client.create_room(request).await.map_err(err)?;
        Ok(CommandOutput::open(key(&room)))
    }

    async fn create_room(&self, spec: &NewRoom) -> Result<CommandOutput> {
        use matrix_sdk::ruma::api::client::room::create_room::v3::{Request, RoomPreset};
        use matrix_sdk::ruma::api::client::room::Visibility;
        use matrix_sdk::ruma::events::room::encryption::RoomEncryptionEventContent;
        use matrix_sdk::ruma::events::InitialStateEvent;

        let mut request = Request::new();
        request.name = Some(spec.name.trim().to_owned());
        request.topic = spec.topic.as_deref().map(str::trim).filter(|t| !t.is_empty()).map(ToOwned::to_owned);
        request.preset = Some(if spec.public { RoomPreset::PublicChat } else { RoomPreset::PrivateChat });
        if spec.public {
            request.visibility = Visibility::Public;
        }
        request.room_alias_name = spec.alias.as_deref().map(|a| a.trim().trim_start_matches('#')).filter(|a| !a.is_empty()).map(|a| a.split(':').next().unwrap_or(a).to_owned());
        request.invite = spec.invite.iter().filter_map(|u| UserId::parse(u).ok()).collect();
        let server = self.client.user_id().ok_or_else(|| AdapterError::Auth("not logged in".into()))?.server_name().to_string();
        // Spaces hold no messages, so they're never encrypted.
        if spec.encrypted && !spec.space {
            request.initial_state = vec![InitialStateEvent::with_empty_state_key(RoomEncryptionEventContent::with_recommended_defaults()).to_raw_any()];
        }
        if spec.space {
            let creation = serde_json::json!({ "type": "m.space" });
            request.creation_content = Some(matrix_sdk::ruma::serde::Raw::from_json(serde_json::value::to_raw_value(&creation).map_err(err)?));
        }
        // A channel in a team: linked to it, and (unless public) open to the team's members.
        let team = spec.team.as_deref().map(OwnedRoomId::try_from).transpose().map_err(err)?;
        if let Some(team) = &team {
            let raw = |v: serde_json::Value| serde_json::value::to_raw_value(&v).map(matrix_sdk::ruma::serde::Raw::from_json);
            request.initial_state.push(raw(serde_json::json!({ "type": "m.space.parent", "state_key": team, "content": { "via": [server], "canonical": true } })).map_err(err)?);
            if !spec.public {
                request.initial_state.push(raw(serde_json::json!({ "type": "m.room.join_rules", "state_key": "", "content": { "join_rule": "restricted", "allow": [{ "type": "m.room_membership", "room_id": team }] } })).map_err(err)?);
            }
        }
        let room = self.client.create_room(request).await.map_err(err)?;
        if let Some(team) = &team {
            let space = self.client.get_room(team).ok_or_else(|| err("unknown team"))?;
            space.send_state_event_raw("m.space.child", room.room_id().as_str(), serde_json::json!({ "via": [server] })).await.map_err(err)?;
        }
        Ok(CommandOutput::open(ConversationId { account: self.account().id, remote: room.room_id().to_string() }.key()))
    }

    fn home_server(&self) -> Option<String> {
        self.client.user_id().map(|u| u.server_name().to_string())
    }

    async fn directory(&self, server: Option<&str>, term: &str, spaces: bool) -> Result<Vec<DirectoryRoom>> {
        use matrix_sdk::ruma::api::client::directory::get_public_rooms_filtered::v3::Request;
        use matrix_sdk::ruma::directory::{Filter, RoomTypeFilter};
        use matrix_sdk::ruma::ServerName;

        let mut request = Request::new();
        request.server = server.map(str::trim).filter(|s| !s.is_empty()).map(ServerName::parse).transpose().map_err(|_| err("not a valid server name"))?;
        request.limit = Some(50u32.into());
        let mut filter = Filter::new();
        filter.generic_search_term = Some(term.trim().to_owned()).filter(|t| !t.is_empty());
        filter.room_types = vec![if spaces { RoomTypeFilter::Space } else { RoomTypeFilter::Default }];
        request.filter = filter;
        let response = self.client.public_rooms_filtered(request).await.map_err(err)?;
        Ok(response
            .chunk
            .into_iter()
            .map(|r| self.directory_room(r.room_id, r.canonical_alias.map(|a| a.to_string()), r.name, r.topic, r.num_joined_members.into(), r.avatar_url.map(|u| u.to_string()), spaces))
            .collect())
    }

    async fn space_rooms(&self, space: &str) -> Result<Vec<DirectoryRoom>> {
        use matrix_sdk::ruma::api::client::space::get_hierarchy::v1::Request;
        use matrix_sdk::ruma::room::RoomType;

        use matrix_sdk::ruma::room::JoinRuleSummary;

        let space_id = OwnedRoomId::try_from(space).map_err(err)?;
        // The server lists what we may see: public rooms and those open to the team's members.
        let mut out = vec![];
        let mut from = None;
        for _ in 0..10 {
            let mut request = Request::new(space_id.clone());
            request.max_depth = Some(1u32.into());
            request.limit = Some(100u32.into());
            request.from = from.take();
            let response = self.client.send(request).await.map_err(err)?;
            for r in response.rooms.into_iter().filter(|r| r.summary.room_id != space_id) {
                let s = r.summary;
                let is_space = s.room_type == Some(RoomType::Space);
                let join_rule = match &s.join_rule {
                    JoinRuleSummary::Public => "public",
                    JoinRuleSummary::Restricted(_) => "restricted",
                    JoinRuleSummary::Knock | JoinRuleSummary::KnockRestricted(_) => "knock",
                    _ => "invite",
                };
                let mut room = self.directory_room(s.room_id, s.canonical_alias.map(|a| a.to_string()), s.name, s.topic, s.num_joined_members.into(), s.avatar_url.map(|u| u.to_string()), is_space);
                room.join_rule = Some(join_rule.to_owned());
                out.push(room);
            }
            match response.next_batch {
                Some(next) => from = Some(next),
                None => break,
            }
        }
        Ok(out)
    }

    async fn join_room(&self, address: &str, via: Option<&str>) -> Result<CommandOutput> {
        use matrix_sdk::ruma::{OwnedServerName, RoomOrAliasId};

        let target = RoomOrAliasId::parse(address.trim()).map_err(|_| AdapterError::Other("Use a room address like #room:server.org".into()))?;
        let via: Vec<OwnedServerName> = via.and_then(|s| OwnedServerName::try_from(s).ok()).into_iter().collect();
        let room = self.client.join_room_by_id_or_alias(&target, &via).await.map_err(err)?;
        let key = ConversationId { account: self.account().id, remote: room.room_id().to_string() }.key();
        let name = room.cached_display_name().map(|n| n.to_string()).unwrap_or_else(|| address.to_owned());
        Ok(CommandOutput::say("cmd.joined", &[("room", &name)], Some(key)))
    }

    async fn knock(&self, address: &str, via: Option<&str>) -> Result<()> {
        use matrix_sdk::ruma::{OwnedRoomOrAliasId, OwnedServerName};
        let target = OwnedRoomOrAliasId::try_from(address.trim()).map_err(|_| AdapterError::Other("Use a room address like #room:server.org".into()))?;
        let via: Vec<OwnedServerName> = via.and_then(|s| OwnedServerName::try_from(s).ok()).into_iter().collect();
        self.client.knock(target, None, via).await.map_err(err)?;
        Ok(())
    }

    async fn keywords(&self) -> Result<Vec<String>> {
        Ok(self.client.notification_settings().await.enabled_keywords().await.into_iter().collect())
    }

    async fn set_keywords(&self, keywords: &[String]) -> Result<()> {
        let settings = self.client.notification_settings().await;
        let current = settings.enabled_keywords().await;
        for k in keywords.iter().filter(|k| !current.contains(*k)) {
            settings.add_keyword(k.clone()).await.map_err(err)?;
        }
        for k in current.iter().filter(|k| !keywords.contains(k)) {
            settings.remove_keyword(k).await.map_err(err)?;
        }
        Ok(())
    }

    async fn user_devices(&self, user_id: &str) -> Result<Vec<DeviceInfo>> {
        let user = UserId::parse(user_id).map_err(err)?;
        let devices = self.client.encryption().get_user_devices(&user).await.map_err(err)?;
        let mut out: Vec<DeviceInfo> = devices
            .devices()
            .map(|d| DeviceInfo {
                id: d.device_id().to_string(),
                name: d.display_name().map(ToOwned::to_owned),
                last_seen_ip: None,
                last_seen_ts: None,
                current: false,
                // Signed by their own identity = one of their real sessions.
                verified: Some(d.is_cross_signed_by_owner()),
            })
            .collect();
        out.sort_by_key(|d| (d.verified != Some(true), d.name.clone().unwrap_or_default().to_lowercase()));
        Ok(out)
    }

    async fn set_ignored(&self, user_id: &str, ignored: bool) -> Result<()> {
        let user = UserId::parse(user_id).map_err(err)?;
        let account = self.client.account();
        if ignored { account.ignore_user(&user).await } else { account.unignore_user(&user).await }.map_err(err)
    }

    async fn start_verification(&self, user_id: &str, device_id: Option<&str>) -> Result<()> {
        let tx = self.events.lock().unwrap().clone().ok_or_else(|| AdapterError::Other("not connected".into()))?;
        verification::start(&self.client, tx, self.account().id.0, self.rooms.clone(), user_id, device_id).await
    }

    async fn verification_action(&self, user_id: &str, flow_id: &str, action: VerificationAction) -> Result<()> {
        verification::act(&self.client, user_id, flow_id, action).await
    }

    async fn scan_verification_qr(&self, user_id: &str, flow_id: &str, data: Vec<u8>) -> Result<()> {
        verification::scan(&self.client, user_id, flow_id, data).await
    }

    async fn room_preview(&self, address: &str, via: &[String]) -> Result<DirectoryRoom> {
        use matrix_sdk::ruma::{OwnedServerName, RoomOrAliasId};

        let target = RoomOrAliasId::parse(address.trim()).map_err(|_| AdapterError::Other(format!("Not a room address: {address}")))?;
        let via: Vec<OwnedServerName> = via.iter().filter_map(|s| OwnedServerName::try_from(s.as_str()).ok()).collect();
        let p = self.client.get_room_preview(&target, via).await.map_err(err)?;
        let is_space = p.room_type.as_ref().is_some_and(|t| *t == matrix_sdk::ruma::room::RoomType::Space);
        Ok(self.directory_room(p.room_id, p.canonical_alias.map(|a| a.to_string()), p.name, p.topic, p.num_joined_members, p.avatar_url.map(|u| u.to_string()), is_space))
    }

    async fn profile(&self, user_id: &str) -> Result<Profile> {
        let user = UserId::parse(user_id).map_err(err)?;
        let profile = self.client.account().fetch_user_profile_of(&user).await.ok();
        let field = |name: &str| profile.as_ref().and_then(|p| p.get(name)).and_then(|v| v.as_str()).map(ToOwned::to_owned);
        let verified = match self.client.encryption().get_user_identity(&user).await {
            Ok(Some(identity)) => Some(identity.is_verified()),
            _ => None,
        };
        let mut shared = vec![];
        for room in self.client.joined_rooms() {
            if room.is_space() {
                continue;
            }
            if let Ok(Some(member)) = room.get_member_no_sync(&user).await {
                if *member.membership() == matrix_sdk::ruma::events::room::member::MembershipState::Join {
                    shared.push(ConversationId { account: self.account().id, remote: room.room_id().to_string() }.key());
                }
            }
        }
        Ok(Profile {
            name: field("displayname").unwrap_or_else(|| user.localpart().to_owned()),
            avatar: field("avatar_url"),
            ignored: self.client.is_user_ignored(&user).await,
            user_id: user.to_string(),
            verified,
            shared,
        })
    }

    async fn room_details(&self, conversation: &ConversationId) -> Result<RoomDetails> {
        use matrix_sdk::ruma::events::room::power_levels::UserPowerLevel;
        use matrix_sdk::ruma::events::StateEventType;
        use matrix_sdk::RoomMemberships;

        let room = self.room(conversation)?;
        let me = self.client.user_id().ok_or_else(|| AdapterError::Auth("not logged in".into()))?.to_owned();
        let power = room.power_levels().await.ok();
        let can = |state: StateEventType| power.as_ref().is_some_and(|p| p.user_can_send_state(&me, state));
        let members = room.members(RoomMemberships::JOIN).await.map_err(err)?;
        let notifications = match room.notification_mode().await {
            Some(RoomNotificationMode::Mute) => "mute",
            Some(RoomNotificationMode::MentionsAndKeywordsOnly) => "mentions",
            _ => "all",
        };
        let level_of = |level: UserPowerLevel| match level {
            UserPowerLevel::Infinite => i64::MAX,
            UserPowerLevel::Int(n) => i64::from(n),
            _ => 0,
        };
        let role = |level: UserPowerLevel| match level {
            UserPowerLevel::Infinite => Some("admin".to_owned()),
            UserPowerLevel::Int(n) if i64::from(n) >= 100 => Some("admin".to_owned()),
            UserPowerLevel::Int(n) if i64::from(n) >= 50 => Some("moderator".to_owned()),
            _ => None,
        };
        let mut members: Vec<RoomMemberInfo> = members
            .iter()
            .map(|m| RoomMemberInfo {
                user_id: m.user_id().to_string(),
                name: m.name().to_owned(),
                avatar: m.avatar_url().map(|u| u.to_string()),
                role: role(m.power_level()),
                level: level_of(m.power_level()),
            })
            .collect();
        let banned = room
            .members(RoomMemberships::BAN)
            .await
            .map_err(err)?
            .iter()
            .map(|m| RoomMemberInfo { user_id: m.user_id().to_string(), name: m.name().to_owned(), avatar: m.avatar_url().map(|u| u.to_string()), role: None, level: 0 })
            .collect();
        let permissions = match power.clone() {
            Some(p) => {
                let c = matrix_sdk::room::power_levels::RoomPowerLevelChanges::from(p);
                [
                    ("events_default", c.events_default), ("invite", c.invite), ("kick", c.kick), ("ban", c.ban), ("redact", c.redact),
                    ("room_name", c.room_name), ("room_topic", c.room_topic), ("room_avatar", c.room_avatar), ("state_default", c.state_default),
                    ("users_default", c.users_default),
                ]
                .into_iter()
                .filter_map(|(k, v)| v.map(|v| (k.to_owned(), v)))
                .collect()
            }
            None => vec![],
        };
        let server_acl = match room.get_state_event(StateEventType::RoomServerAcl, "").await {
            Ok(Some(matrix_sdk::deserialized_responses::RawAnySyncOrStrippedState::Sync(raw))) => serde_json::from_str::<serde_json::Value>(raw.json().get()).ok().map(|v| {
                let list = |k: &str| v["content"][k].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(ToOwned::to_owned)).collect()).unwrap_or_default();
                (list("allow"), list("deny"))
            }),
            _ => None,
        };
        let encrypted = room.encryption_state().is_encrypted();
        let join_rule = match room.join_rule() {
            Some(matrix_sdk::ruma::room::JoinRule::Public) => "public",
            Some(matrix_sdk::ruma::room::JoinRule::Knock) => "knock",
            Some(matrix_sdk::ruma::room::JoinRule::Restricted(_) | matrix_sdk::ruma::room::JoinRule::KnockRestricted(_)) => "restricted",
            _ => "invite",
        };
        // Admins first, then moderators, then alphabetical.
        members.sort_by_key(|m| (m.role.as_deref().map(|r| if r == "admin" { 0 } else { 1 }).unwrap_or(2), m.name.to_lowercase()));
        Ok(RoomDetails {
            name: room.cached_display_name().map(|n| n.to_string()).or_else(|| room.name()).unwrap_or_else(|| room.room_id().to_string()),
            topic: room.topic(),
            avatar: room.avatar_url().map(|u| u.to_string()),
            alias: room.canonical_alias().map(|a| a.to_string()),
            encrypted,
            is_direct: room.is_direct().await.unwrap_or(false),
            notifications: notifications.to_owned(),
            can_edit: can(StateEventType::RoomName),
            can_invite: power.as_ref().is_some_and(|p| p.user_can_invite(&me)),
            members,
            join_rule: join_rule.to_owned(),
            in_team: !self.teams_of(&room).await.is_empty(),
            can_set_join_rule: can(StateEventType::RoomJoinRules),
            can_encrypt: !encrypted && can(StateEventType::RoomEncryption),
            can_set_alias: can(StateEventType::RoomCanonicalAlias),
            can_kick: power.as_ref().is_some_and(|p| p.user_can_kick(&me)),
            can_ban: power.as_ref().is_some_and(|p| p.user_can_ban(&me)),
            can_set_roles: can(StateEventType::RoomPowerLevels),
            my_level: power.as_ref().map(|p| level_of(p.for_user(&me))).unwrap_or(0),
            banned,
            history_visibility: room.history_visibility().map(|h| h.to_string()).unwrap_or_else(|| "shared".into()),
            can_set_history: can(StateEventType::RoomHistoryVisibility),
            permissions,
            server_acl,
            can_set_acl: can(StateEventType::RoomServerAcl),
        })
    }

    async fn set_history_visibility(&self, conversation: &ConversationId, visibility: &str) -> Result<()> {
        use matrix_sdk::ruma::events::room::history_visibility::HistoryVisibility;
        let v = match visibility {
            "world_readable" => HistoryVisibility::WorldReadable,
            "invited" => HistoryVisibility::Invited,
            "joined" => HistoryVisibility::Joined,
            _ => HistoryVisibility::Shared,
        };
        self.room(conversation)?.privacy_settings().update_room_history_visibility(v).await.map_err(err)
    }

    async fn set_permission(&self, conversation: &ConversationId, key: &str, level: i64) -> Result<()> {
        let mut c = matrix_sdk::room::power_levels::RoomPowerLevelChanges::new();
        let slot = match key {
            "events_default" => &mut c.events_default,
            "invite" => &mut c.invite,
            "kick" => &mut c.kick,
            "ban" => &mut c.ban,
            "redact" => &mut c.redact,
            "room_name" => &mut c.room_name,
            "room_topic" => &mut c.room_topic,
            "room_avatar" => &mut c.room_avatar,
            "state_default" => &mut c.state_default,
            "users_default" => &mut c.users_default,
            other => return Err(AdapterError::Other(format!("unknown permission {other}"))),
        };
        *slot = Some(level);
        self.room(conversation)?.apply_power_level_changes(c).await.map_err(err)
    }

    async fn set_server_acl(&self, conversation: &ConversationId, allow: Vec<String>, deny: Vec<String>) -> Result<()> {
        use matrix_sdk::ruma::events::room::server_acl::RoomServerAclEventContent;
        let me = self.client.user_id().ok_or_else(|| AdapterError::Auth("not logged in".into()))?.server_name().to_string();
        // Never lock our own server out of the room.
        if !allow.iter().any(|a| a == "*" || a == &me) && !allow.is_empty() {
            return Err(AdapterError::Other(format!("The allow list must include your own server ({me}) or *")));
        }
        if deny.iter().any(|d| d == &me) {
            return Err(AdapterError::Other(format!("You can't deny your own server ({me})")));
        }
        let allow = if allow.is_empty() { vec!["*".to_owned()] } else { allow };
        self.room(conversation)?.send_state_event(RoomServerAclEventContent::new(false, allow, deny)).await.map_err(err)?;
        Ok(())
    }

    async fn set_team_room(&self, team: &ConversationId, room: &str, add: bool) -> Result<()> {
        let space = self.room(team)?;
        let server = self.client.user_id().ok_or_else(|| AdapterError::Auth("not logged in".into()))?.server_name().to_string();
        // An m.space.child with an empty body removes the room from the space.
        let content = if add { serde_json::json!({ "via": [server] }) } else { serde_json::json!({}) };
        space.send_state_event_raw("m.space.child", room, content.clone()).await.map_err(err)?;
        // The room's link back to the team makes it a channel in other clients' lists too;
        // it needs permission in the room itself, so a failure here is fine.
        if let Some(child) = OwnedRoomId::try_from(room).ok().and_then(|id| self.client.get_room(&id)) {
            if let Err(e) = child.send_state_event_raw("m.space.parent", space.room_id().as_str(), content).await {
                tracing::info!("could not set the team link in {room}: {e}");
            }
        }
        Ok(())
    }

    async fn threads(&self, conversation: &ConversationId, mine: bool) -> Result<Vec<ThreadInfo>> {
        use matrix_sdk::room::ListThreadsOptions;
        use matrix_sdk::ruma::api::client::threads::get_threads::v1::IncludeThreads;

        let room = self.room(conversation)?;
        let me = self.client.user_id().ok_or_else(|| AdapterError::Auth("not logged in".into()))?.to_owned();
        let include_threads = if mine { IncludeThreads::Participated } else { IncludeThreads::All };
        let page = room.list_threads(ListThreadsOptions { include_threads, limit: Some(50u32.into()), ..Default::default() }).await.map_err(err)?;
        let mut out = vec![];
        for event in &page.chunk {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(event.raw().json().get()) else { continue };
            let (Some(id), Some(sender)) = (v["event_id"].as_str(), v["sender"].as_str()) else { continue };
            let Ok(sender_id) = UserId::parse(sender) else { continue };
            let (sender_name, sender_avatar) = member_profile(&room, &sender_id).await;
            // The server's summary of the thread (replies, the latest one, whether we're in it).
            let summary = &v["unsigned"]["m.relations"]["m.thread"];
            let latest = &summary["latest_event"];
            let latest_name = match latest["sender"].as_str().and_then(|s| UserId::parse(s).ok()) {
                Some(id) => Some(member_profile(&room, &id).await.0),
                None => None,
            };
            let preview = v["content"]["body"].as_str().unwrap_or_default().lines().next().unwrap_or_default().chars().take(140).collect();
            out.push(ThreadInfo {
                root: id.to_owned(),
                sender_name,
                sender_avatar,
                preview,
                sent_at: v["origin_server_ts"].as_u64().unwrap_or(0),
                replies: summary["count"].as_u64().unwrap_or(0) as u32,
                latest_name,
                latest_at: latest["origin_server_ts"].as_u64(),
                mine: sender_id == me || summary["current_user_participated"].as_bool().unwrap_or(false),
            });
        }
        out.sort_by_key(|t| std::cmp::Reverse(t.latest_at.unwrap_or(t.sent_at)));
        Ok(out)
    }

    async fn identity_warnings(&self, conversation: &ConversationId) -> Result<Vec<IdentityWarning>> {
        use futures::StreamExt;
        use matrix_sdk_base::crypto::IdentityState;

        let room = self.room(conversation)?;
        if !room.encryption_state().is_encrypted() {
            return Ok(vec![]);
        }
        // The stream starts with everyone in the room who isn't pinned or verified.
        let changes = room.subscribe_to_identity_status_changes().await.map_err(err)?;
        let mut changes = std::pin::pin!(changes);
        let now = tokio::time::timeout(Duration::from_secs(5), changes.next()).await.ok().flatten().unwrap_or_default();
        let mut out = vec![];
        for change in now {
            let was_verified = match change.changed_to {
                IdentityState::PinViolation => false,
                IdentityState::VerificationViolation => true,
                _ => continue,
            };
            let name = member_profile(&room, &change.user_id).await.0;
            out.push(IdentityWarning { user_id: change.user_id.to_string(), name, was_verified });
        }
        Ok(out)
    }

    async fn accept_identity(&self, user_id: &str) -> Result<()> {
        let user = UserId::parse(user_id).map_err(err)?;
        let identity = self.client.encryption().get_user_identity(&user).await.map_err(err)?.ok_or_else(|| err("no identity for this person"))?;
        if identity.has_verification_violation() {
            identity.withdraw_verification().await.map_err(err)?;
        }
        identity.pin().await.map_err(err)
    }

    async fn set_team_order(&self, team: &ConversationId, order: Option<&str>) -> Result<()> {
        use matrix_sdk::ruma::serde::Raw;
        let content = match order {
            Some(o) => serde_json::json!({ "order": o }),
            None => serde_json::json!({}),
        };
        let raw = Raw::from_json(serde_json::value::to_raw_value(&content).map_err(err)?);
        self.room(team)?.set_account_data_raw(SPACE_ORDER.into(), raw).await.map_err(err)?;
        Ok(())
    }

    async fn enable_encryption(&self, conversation: &ConversationId) -> Result<()> {
        self.room(conversation)?.enable_encryption().await.map_err(err)
    }

    async fn set_join_rule(&self, conversation: &ConversationId, rule: &str) -> Result<()> {
        use matrix_sdk::ruma::room::JoinRule;
        use matrix_sdk::ruma::room::{AllowRule, Restricted};
        let room = self.room(conversation)?;
        let rule = match rule {
            "public" => JoinRule::Public,
            "invite" => JoinRule::Invite,
            // Members of the team(s) the room is in can join without an invite.
            "restricted" => {
                let teams = self.teams_of(&room).await;
                if teams.is_empty() {
                    return Err(AdapterError::Other("This room isn't in a team yet.".into()));
                }
                JoinRule::Restricted(Restricted::new(teams.into_iter().map(AllowRule::room_membership).collect()))
            }
            other => return Err(AdapterError::Other(format!("unknown join rule {other}"))),
        };
        room.privacy_settings().update_join_rule(rule).await.map_err(err)
    }

    async fn set_room_alias(&self, conversation: &ConversationId, name: &str) -> Result<String> {
        use matrix_sdk::ruma::OwnedRoomAliasId;
        let room = self.room(conversation)?;
        let server = self.client.user_id().ok_or_else(|| AdapterError::Auth("not logged in".into()))?.server_name().to_owned();
        let name = name.trim().trim_start_matches('#');
        let name = name.split(':').next().unwrap_or(name);
        let alias = OwnedRoomAliasId::try_from(format!("#{name}:{server}")).map_err(|_| AdapterError::Other(format!("\"{name}\" can't be used in an address")))?;
        self.client.create_room_alias(&alias, room.room_id()).await.map_err(err)?;
        room.privacy_settings().update_canonical_alias(Some(alias.clone()), vec![]).await.map_err(err)?;
        Ok(alias.to_string())
    }

    async fn set_room_name(&self, conversation: &ConversationId, name: &str) -> Result<()> {
        self.room(conversation)?.set_name(name.trim().to_owned()).await.map_err(err)?;
        Ok(())
    }

    async fn set_room_topic(&self, conversation: &ConversationId, topic: &str) -> Result<()> {
        self.room(conversation)?.set_room_topic(topic.trim()).await.map_err(err)?;
        Ok(())
    }

    async fn set_room_avatar(&self, conversation: &ConversationId, mime: Option<&str>, data: Vec<u8>) -> Result<()> {
        let mime: mime::Mime = mime.and_then(|m| m.parse().ok()).unwrap_or(mime::IMAGE_PNG);
        self.room(conversation)?.upload_avatar(&mime, data, None).await.map_err(err)?;
        Ok(())
    }

    async fn send_call_event(&self, conversation: &ConversationId, event_type: &str, content: &str) -> Result<()> {
        let content: serde_json::Value = serde_json::from_str(content).map_err(err)?;
        self.room(conversation)?.send_raw(event_type, content).await.map_err(err)?;
        Ok(())
    }

    async fn turn_servers(&self) -> Result<Option<TurnServers>> {
        use matrix_sdk::ruma::api::client::voip::get_turn_server_info::v3::Request;
        match self.client.send(Request::new()).await {
            Ok(r) if !r.uris.is_empty() => Ok(Some(TurnServers { uris: r.uris, username: r.username, password: r.password })),
            Ok(_) => Ok(None),
            // Servers without TURN answer 404; calls then try direct connections only.
            Err(e) => {
                tracing::info!("no TURN servers: {e}");
                Ok(None)
            }
        }
    }

    async fn set_room_member_avatar(&self, conversation: &ConversationId, mime: Option<&str>, data: Vec<u8>) -> Result<()> {
        use matrix_sdk::ruma::events::room::member::{MembershipState, RoomMemberEventContent};

        let mime: mime::Mime = mime.and_then(|m| m.parse().ok()).unwrap_or(mime::IMAGE_PNG);
        let room = self.room(conversation)?;
        let me = self.client.user_id().ok_or_else(|| AdapterError::Other("not signed in".into()))?.to_owned();
        let url = self.client.media().upload(&mime, data, None).await.map_err(err)?.content_uri;
        // Keep the room-specific name, if any; only the picture changes.
        let member = room.get_member_no_sync(&me).await.map_err(err)?;
        let mut content = RoomMemberEventContent::new(MembershipState::Join);
        content.displayname = member.as_ref().and_then(|m| m.display_name()).map(ToOwned::to_owned);
        content.avatar_url = Some(url);
        room.send_state_event_for_key(&me, content).await.map_err(err)?;
        Ok(())
    }

    async fn set_display_name(&self, name: &str) -> Result<()> {
        self.client.account().set_display_name(Some(name.trim())).await.map_err(err)?;
        self.account.lock().unwrap().display_name = name.trim().to_owned();
        Ok(())
    }

    async fn set_avatar(&self, mime: Option<&str>, data: Vec<u8>) -> Result<()> {
        let mime: mime::Mime = mime.and_then(|m| m.parse().ok()).unwrap_or(mime::IMAGE_PNG);
        let url = self.client.account().upload_avatar(&mime, data).await.map_err(err)?;
        self.account.lock().unwrap().avatar_url = Some(url.to_string());
        Ok(())
    }

    async fn devices(&self) -> Result<Vec<DeviceInfo>> {
        let own = self.client.device_id().map(ToOwned::to_owned);
        let user = self.client.user_id().map(ToOwned::to_owned);
        let mut out = vec![];
        for d in self.client.devices().await.map_err(err)?.devices {
            let verified = match &user {
                Some(u) => self.client.encryption().get_device(u, &d.device_id).await.ok().flatten().map(|dev| dev.is_verified()),
                None => None,
            };
            out.push(DeviceInfo {
                current: own.as_deref() == Some(&*d.device_id),
                id: d.device_id.to_string(),
                name: d.display_name,
                last_seen_ip: d.last_seen_ip,
                last_seen_ts: d.last_seen_ts.map(|t| u64::from(t.get())),
                verified,
            });
        }
        // This session first, then most recently active.
        out.sort_by_key(|d| (!d.current, std::cmp::Reverse(d.last_seen_ts)));
        Ok(out)
    }

    async fn rename_device(&self, device_id: &str, name: &str) -> Result<()> {
        self.client.rename_device(device_id.into(), name.trim()).await.map_err(err)?;
        Ok(())
    }

    async fn sign_out_device(&self, device_id: &str, auth: DeviceAuth) -> Result<SignOutDevice> {
        use matrix_sdk::ruma::api::client::uiaa::{AuthData, AuthType, FallbackAcknowledgement, MatrixUserIdentifier, Password, UserIdentifier};

        let devices = [device_id.into()];
        let user = self.client.user_id().ok_or_else(|| AdapterError::Auth("not logged in".into()))?.to_string();
        // The first try carries no proof; the server answers with the flows it
        // accepts and a session to continue in.
        let session = match self.client.delete_devices(&devices, None).await {
            Ok(_) => return Ok(SignOutDevice::Done),
            Err(e) => match e.as_uiaa_response() {
                Some(info) => (info.session.clone(), info.flows.clone()),
                None => return Err(err(e)),
            },
        };
        let (session, flows) = session;
        let has = |t: &AuthType| flows.iter().any(|f| f.stages.first() == Some(t));
        let data = match auth {
            DeviceAuth::Password { password } => {
                let mut p = Password::new(UserIdentifier::Matrix(MatrixUserIdentifier::new(user)), password);
                p.session = session;
                AuthData::Password(p)
            }
            DeviceAuth::Browser { session } => AuthData::FallbackAcknowledgement(FallbackAcknowledgement::new(session)),
            DeviceAuth::None if has(&AuthType::Password) => return Ok(SignOutDevice::NeedsPassword),
            DeviceAuth::None => {
                // SSO-only accounts confirm in the browser (UIAA fallback page).
                let stage = flows.iter().find_map(|f| f.stages.first().cloned()).ok_or_else(|| AdapterError::Other("the server offers no way to confirm this".into()))?;
                let session = session.ok_or_else(|| AdapterError::Other("the server did not start a confirmation".into()))?;
                let url = format!("{}/_matrix/client/v3/auth/{}/fallback/web?session={}", self.client.homeserver().as_str().trim_end_matches('/'), stage.as_str(), session);
                return Ok(SignOutDevice::NeedsBrowser { url, session });
            }
        };
        self.client.delete_devices(&devices, Some(data)).await.map_err(|e| match e.as_uiaa_response() {
            Some(_) => AdapterError::Auth("not confirmed; check the password or finish the browser step".into()),
            None => err(e),
        })?;
        Ok(SignOutDevice::Done)
    }

    async fn contact_infos(&self) -> Result<Vec<ContactInfo>> {
        let response = self.client.account().get_3pids().await.map_err(err)?;
        Ok(response.threepids.into_iter().map(|t| ContactInfo { medium: t.medium.to_string(), address: t.address }).collect())
    }

    async fn remove_contact_info(&self, medium: &str, address: &str) -> Result<()> {
        use matrix_sdk::ruma::thirdparty::Medium;
        self.client.account().delete_3pid(address, Medium::from(medium), None).await.map_err(err)?;
        Ok(())
    }

    async fn add_email_start(&self, email: &str) -> Result<String> {
        use matrix_sdk::ruma::ClientSecret;
        let secret = ClientSecret::new();
        let response = self.client.account().request_3pid_email_token(&secret, email.trim(), 1u32.into()).await.map_err(err)?;
        self.pending_emails.lock().unwrap().insert(secret.to_string(), response.sid.to_string());
        Ok(secret.to_string())
    }

    async fn add_email_finish(&self, token: &str, auth: DeviceAuth) -> Result<SignOutDevice> {
        use matrix_sdk::ruma::api::client::uiaa::{AuthData, AuthType, FallbackAcknowledgement, MatrixUserIdentifier, Password, UserIdentifier};
        use matrix_sdk::ruma::{OwnedClientSecret, OwnedSessionId};

        let sid = self.pending_emails.lock().unwrap().get(token).cloned().ok_or_else(|| AdapterError::Other("Start adding the address again".into()))?;
        let secret = OwnedClientSecret::try_from(token).map_err(err)?;
        let sid = OwnedSessionId::try_from(sid.as_str()).map_err(err)?;
        let account = self.client.account();
        let user = self.client.user_id().ok_or_else(|| AdapterError::Auth("not logged in".into()))?.to_string();
        // Same confirmation dance as signing out a session (UIAA): try, then password or browser.
        let (session, flows) = match account.add_3pid(&secret, &sid, None).await {
            Ok(_) => {
                self.pending_emails.lock().unwrap().remove(token);
                return Ok(SignOutDevice::Done);
            }
            Err(e) => match e.as_uiaa_response() {
                Some(info) => (info.session.clone(), info.flows.clone()),
                None => return Err(AdapterError::Other(format!("Not confirmed yet; click the link in the email first ({e})"))),
            },
        };
        let has = |t: &AuthType| flows.iter().any(|f| f.stages.first() == Some(t));
        let data = match auth {
            DeviceAuth::Password { password } => {
                let mut p = Password::new(UserIdentifier::Matrix(MatrixUserIdentifier::new(user)), password);
                p.session = session;
                AuthData::Password(p)
            }
            DeviceAuth::Browser { session } => AuthData::FallbackAcknowledgement(FallbackAcknowledgement::new(session)),
            DeviceAuth::None if has(&AuthType::Password) => return Ok(SignOutDevice::NeedsPassword),
            DeviceAuth::None => {
                let stage = flows.iter().find_map(|f| f.stages.first().cloned()).ok_or_else(|| AdapterError::Other("the server offers no way to confirm this".into()))?;
                let session = session.ok_or_else(|| AdapterError::Other("the server did not start a confirmation".into()))?;
                let url = format!("{}/_matrix/client/v3/auth/{}/fallback/web?session={}", self.client.homeserver().as_str().trim_end_matches('/'), stage.as_str(), session);
                return Ok(SignOutDevice::NeedsBrowser { url, session });
            }
        };
        account.add_3pid(&secret, &sid, Some(data)).await.map_err(err)?;
        self.pending_emails.lock().unwrap().remove(token);
        Ok(SignOutDevice::Done)
    }

    async fn set_privacy(&self, share_receipts: bool, _share_typing: bool) -> Result<()> {
        self.private_receipts.store(!share_receipts, Ordering::Relaxed);
        Ok(())
    }

    async fn set_notification_level(&self, conversation: &ConversationId, level: &str) -> Result<()> {
        let mode = match level {
            "mute" => RoomNotificationMode::Mute,
            "mentions" => RoomNotificationMode::MentionsAndKeywordsOnly,
            _ => RoomNotificationMode::AllMessages,
        };
        let room = self.room(conversation)?;
        self.client.notification_settings().await.set_room_notification_mode(room.room_id(), mode).await.map_err(err)?;
        // Push the new mute state now instead of waiting for a sync to mention this room.
        if let (Some(conv), Some(tx)) = (conversation_for(&self.client, &self.account().id, room.room_id()).await, self.events.lock().unwrap().clone()) {
            let _ = tx.send(AdapterEvent::ConversationUpserted(conv));
        }
        Ok(())
    }

    async fn invite(&self, conversation: &ConversationId, user_id: &str) -> Result<()> {
        let user = UserId::parse(user_id).map_err(err)?;
        self.room(conversation)?.invite_user_by_id(&user).await.map_err(err)
    }

    async fn set_typing(&self, conversation: &ConversationId, typing: bool) -> Result<()> {
        self.room(conversation)?.typing_notice(typing).await.map_err(err)
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            e2ee: true,
            threads: true,
            reactions: true,
            edits: true,
            read_receipts: true,
            synced_marked_unread: true,
            teams: true,
            presence: true,
            typing: true,
            calls: false,
        }
    }

    async fn start(&self) -> Result<BoxStream<'static, AdapterEvent>> {
        let (tx, rx) = mpsc::unbounded_channel();
        *self.events.lock().unwrap() = Some(tx.clone());
        {
            let mut out = self.session_out.lock().unwrap();
            if let Some(session) = out.pending.take() {
                let _ = tx.send(AdapterEvent::SessionChanged { account: self.account().id, session });
            }
            out.tx = Some(tx.clone());
        }
        self.register_handlers(tx.clone());
        verification::register(&self.client, tx.clone(), self.account().id.0, self.rooms.clone());
        register_call_events(&self.client, tx.clone(), self.account().id, self.index.clone());

        let client = self.client.clone();
        let account = self.account().id;
        let index = self.index.clone();
        let sliding = self.sliding.clone();
        let store = self.store.clone();
        tokio::spawn(initial_load(client.clone(), tx.clone(), account.clone(), index.clone()));
        *self.retry_task.lock().unwrap() = Some(tokio::spawn(retry_decryption(client.clone(), tx.clone(), account.clone(), index.clone())));
        let task = tokio::spawn(async move {
            // Sliding sync (what Element X uses) starts fast on big accounts; fall back
            // to classic /sync when the server doesn't offer it or it fails to start.
            let classic_forced = std::env::var_os("MS_TRIX_CLASSIC_SYNC").is_some();
            if !classic_forced && !matches!(client.sliding_sync_version(), matrix_sdk::sliding_sync::Version::None) {
                let mut result = sliding_sync(client.clone(), tx.clone(), account.clone(), index.clone(), sliding.clone()).await;
                if matches!(&result, Err(e) if e.to_string().contains("to_device.since")) && forget_to_device_token(&store) {
                    result = sliding_sync(client.clone(), tx.clone(), account.clone(), index.clone(), sliding).await;
                }
                match result {
                    Ok(()) => return,
                    Err(e) => tracing::warn!("sliding sync unavailable, using classic sync: {e}"),
                }
            }
            classic_sync(client, tx, account, index).await;
        });
        *self.sync_task.lock().unwrap() = Some(task);
        Ok(UnboundedReceiverStream::new(rx).boxed())
    }

    async fn stop(&self) -> Result<()> {
        if let Some(task) = self.sync_task.lock().unwrap().take() {
            task.abort();
        }
        if let Some(task) = self.retry_task.lock().unwrap().take() {
            task.abort();
        }
        Ok(())
    }

    /// With sliding sync the chat on screen gets its own subscription with more history.
    fn set_focus(&self, conversation: Option<&ConversationId>) {
        *self.rooms.focus.lock().unwrap() = conversation.and_then(|c| RoomId::parse(&c.remote).ok());
        self.rooms.apply();
    }

    async fn logout(&self) -> Result<()> {
        // Removes this device from the account, like "sign out" in Element.
        self.client.logout().await.map_err(err)
    }

    async fn send(&self, conversation: &ConversationId, message: Outgoing) -> Result<MessageId> {
        use matrix_sdk::ruma::events::relation::{InReplyTo, Reply};

        let room = self.room(conversation)?;
        let mut content = match (message.html, message.emote) {
            _ if message.msgtype.is_some() => {
                let msgtype = MessageType::new(message.msgtype.as_deref().unwrap_or_default(), message.text, Default::default()).map_err(err)?;
                RoomMessageEventContent::new(msgtype)
            }
            (Some(html), true) => RoomMessageEventContent::emote_html(message.text, html),
            (Some(html), false) => RoomMessageEventContent::text_html(message.text, html),
            (None, true) => RoomMessageEventContent::emote_markdown(message.text),
            (None, false) => RoomMessageEventContent::text_markdown(message.text),
        };
        // Custom emoji: swap :shortcode: for inline images in the formatted body (MSC2545).
        if !message.emotes.is_empty() {
            if let MessageType::Text(t) = &mut content.msgtype {
                let mut html = t.formatted.as_ref().map(|f| f.body.clone()).unwrap_or_else(|| html_escape(&t.body).replace('\n', "<br>"));
                for (code, url) in &message.emotes {
                    let tag = format!("<img data-mx-emoticon src=\"{}\" alt=\":{code}:\" title=\":{code}:\" height=\"32\" />", html_escape(url));
                    html = html.replace(&format!(":{code}:"), &tag);
                }
                t.formatted = Some(matrix_sdk::ruma::events::room::message::FormattedBody::html(html));
            }
        }
        let event_id = |id: &MessageId| OwnedEventId::try_from(id.0.as_str()).map_err(err);
        if !message.mentions.is_empty() {
            use matrix_sdk::ruma::events::Mentions;
            let ids = message.mentions.iter().filter_map(|u| OwnedUserId::try_from(u.as_str()).ok());
            content = content.add_mentions(Mentions::with_user_ids(ids));
        }
        content.relates_to = match (&message.thread_root, &message.reply_to) {
            (Some(root), Some(reply)) => Some(Relation::Thread(Thread::reply(event_id(root)?, event_id(reply)?))),
            (Some(root), None) => Some(Relation::Thread(Thread::without_fallback(event_id(root)?))),
            (None, Some(reply)) => Some(Relation::Reply(Reply::new(InReplyTo::new(event_id(reply)?)))),
            (None, None) => None,
        };
        let sent = room.send(content).await.map_err(send_err)?;
        Ok(MessageId(sent.response.event_id.to_string()))
    }

    async fn fetch_media(&self, media: &str, thumbnail: Option<(u32, u32)>) -> Result<Vec<u8>> {
        use matrix_sdk::media::{MediaFormat, MediaRequestParameters, MediaThumbnailSettings};

        let encrypted = self.index.lock().unwrap().encrypted_media.get(media).cloned();
        let (source, format) = match (encrypted, thumbnail) {
            // The server can't thumbnail what it can't read.
            (Some(source), _) => (source, MediaFormat::File),
            (None, Some((w, h))) => (MediaSource::Plain(media.into()), MediaFormat::Thumbnail(MediaThumbnailSettings::new(w.into(), h.into()))),
            (None, None) => (MediaSource::Plain(media.into()), MediaFormat::File),
        };
        self.client.media().get_media_content(&MediaRequestParameters { source, format }, true).await.map_err(err)
    }

    async fn send_read_receipt(&self, conversation: &ConversationId, thread_root: Option<&MessageId>, up_to: &MessageId) -> Result<()> {
        let room_id = OwnedRoomId::try_from(conversation.remote.as_str()).map_err(err)?;
        let event_id = OwnedEventId::try_from(up_to.0.as_str()).map_err(err)?;
        let kind = if self.private_receipts.load(Ordering::Relaxed) { create_receipt::v3::ReceiptType::ReadPrivate } else { create_receipt::v3::ReceiptType::Read };
        let mut request = create_receipt::v3::Request::new(room_id, kind, event_id);
        request.thread = match thread_root {
            Some(root) => ReceiptThread::Thread(OwnedEventId::try_from(root.0.as_str()).map_err(err)?),
            None => ReceiptThread::Main,
        };
        self.client.send(request).await.map_err(err)?;
        Ok(())
    }

    async fn set_marked_unread(&self, conversation: &ConversationId, value: bool) -> Result<()> {
        let user_id = self.client.user_id().ok_or_else(|| AdapterError::Auth("not logged in".into()))?;
        let room_id = RoomId::parse(&conversation.remote).map_err(err)?;
        let request = set_room_account_data::v3::Request::new(user_id.to_owned(), room_id, &MarkedUnreadEventContent::new(value)).map_err(err)?;
        self.client.send(request).await.map_err(err)?;
        Ok(())
    }

    async fn set_favourite(&self, conversation: &ConversationId, value: bool) -> Result<()> {
        self.room(conversation)?.set_is_favourite(value, None).await.map_err(err)
    }

    /// Sets (or clears) both our own tag and m.lowpriority, so other clients
    /// (Element, mobile) also tuck the chat away.
    async fn set_archived(&self, conversation: &ConversationId, value: bool) -> Result<()> {
        use matrix_sdk::ruma::events::tag::TagInfo;
        let room = self.room(conversation)?;
        if value {
            room.set_tag(TagName::from(ARCHIVED_TAG), TagInfo::new()).await.map_err(err)?;
        } else {
            room.remove_tag(TagName::from(ARCHIVED_TAG)).await.map_err(err)?;
        }
        room.set_is_low_priority(value, None).await.map_err(err)
    }

    async fn security_status(&self) -> Result<SecurityStatus> {
        use matrix_sdk::encryption::recovery::RecoveryState;

        let encryption = self.client.encryption();
        encryption.wait_for_e2ee_initialization_tasks().await;
        let device_verified = encryption.get_own_device().await.map_err(err)?.is_some_and(|d| d.is_cross_signed_by_owner());
        let recovery = match encryption.recovery().state() {
            RecoveryState::Unknown => RecoveryStatus::Unknown,
            RecoveryState::Enabled => RecoveryStatus::Enabled,
            RecoveryState::Incomplete => RecoveryStatus::Incomplete,
            RecoveryState::Disabled => RecoveryStatus::Disabled,
        };
        Ok(SecurityStatus { device_verified, recovery })
    }

    /// Imports the cross-signing keys from secret storage, which also signs
    /// (verifies) this device, and enables key backup for message history.
    async fn recover(&self, recovery_key: &str) -> Result<()> {
        self.client.encryption().recovery().recover(recovery_key.trim()).await.map_err(|e| {
            AdapterError::Auth(format!("That recovery key didn't work. Check it and try again. Details: {e}"))
        })
    }
}

pub struct MatrixFactory {
    pub data_dir: PathBuf,
}

#[async_trait]
impl AdapterFactory for MatrixFactory {
    fn protocol(&self) -> ProtocolId {
        ProtocolId(PROTOCOL.into())
    }

    fn display_name(&self) -> &'static str {
        "Matrix"
    }

    async fn restore(&self, account: Account, session: Vec<u8>) -> Result<Arc<dyn ProtocolAdapter>> {
        Ok(MatrixAdapter::restore(&self.data_dir, account, &session).await?)
    }
}

fn store_dir(data_dir: &Path, account: &AccountId) -> PathBuf {
    data_dir.join("accounts").join(&account.0)
}

/// The crypto store keeps one to-device position for classic and sliding sync. After a classic
/// /sync it holds a classic token ("s123_456_..."), which Synapse's sliding sync rejects, so every
/// later start fell back to the slow classic sync. Only sliding sync reads this value; without it
/// the server starts the to-device stream afresh (messages not yet acknowledged come again).
fn forget_to_device_token(store: &Path) -> bool {
    let result = rusqlite::Connection::open(store.join("matrix-sdk-crypto.sqlite3"))
        .and_then(|db| db.execute("DELETE FROM kv WHERE key = 'next_batch_token'", []));
    match result {
        Ok(_) => {
            tracing::info!("cleared a classic sync token from the crypto store; retrying sliding sync");
            true
        }
        Err(e) => {
            tracing::warn!("could not clear the crypto store's sync token: {e}");
            false
        }
    }
}

async fn build_client(store: &Path, homeserver: &str, passphrase: &str) -> Result<Client> {
    use matrix_sdk_base::crypto::CollectStrategy;
    Client::builder()
        .server_name_or_homeserver_url(homeserver)
        .sqlite_store(store, Some(passphrase))
        // Invisible crypto (MSC4153, like Element X): room keys only go to devices their owner
        // signed. Incoming messages are still decrypted whatever device sent them, as Element X
        // does: a stricter rule also locks out history from devices that have since been removed.
        .with_room_key_recipient_strategy(CollectStrategy::IdentityBasedStrategy)
        // OAuth access tokens expire after minutes; refreshed sessions are stored (see `MatrixAdapter::new`).
        .handle_refresh_tokens()
        .build()
        .await
        .map_err(|e| AdapterError::Network(e.to_string()))
}

async fn account_for(client: &Client, id: AccountId) -> Result<Account> {
    let user_id = client.user_id().ok_or_else(|| AdapterError::Auth("not logged in".into()))?;
    let display_name = client.account().get_display_name().await.ok().flatten().unwrap_or_else(|| user_id.localpart().to_owned());
    Ok(Account {
        id,
        protocol: ProtocolId(PROTOCOL.into()),
        // Default org name is the server; the user can rename it in the switcher.
        org_name: user_id.server_name().to_string(),
        user_id: user_id.to_string(),
        display_name,
        avatar_url: client.account().get_avatar_url().await.ok().flatten().map(|u| u.to_string()),
    })
}

async fn conversation_for(client: &Client, account: &AccountId, room_id: &RoomId) -> Option<Conversation> {
    let room = client.get_room(room_id)?;
    // Spaces are Teams, not conversations.
    // Joined spaces are teams, not conversations; an invitation to one is listed like any invite.
    let team_invite = room.is_space() && room.state() == matrix_sdk::RoomState::Invited;
    if room.is_space() && !team_invite {
        return None;
    }
    let mut team_id = None;
    let kind = if team_invite {
        ConversationKind::Team
    } else if room.is_direct().await.unwrap_or(false) {
        ConversationKind::Direct
    } else {
        match room.parent_spaces().await {
            Ok(mut parents) => match parents.next().await {
                Some(Ok(parent)) => {
                    team_id = space_id(&parent);
                    ConversationKind::Channel { team: space_name(parent) }
                }
                // A room someone gave a name is a room; an unnamed one is a group chat.
                _ if room.name().is_some() => ConversationKind::Room,
                _ => ConversationKind::Group,
            },
            Err(_) => ConversationKind::Group,
        }
    };
    let notify = room.notification_mode().await;
    let invited_by = if room.state() == matrix_sdk::RoomState::Invited {
        match room.invite_details().await {
            Ok(invite) => Some(invite.inviter.map(|m| m.name().to_owned()).unwrap_or_else(|| invite.inviter_id.to_string())),
            Err(_) => Some(String::from("someone")),
        }
    } else {
        None
    };
    let name = room
        .cached_display_name()
        .map(|n| n.to_string())
        .or_else(|| room.name())
        .unwrap_or_else(|| room_id.to_string());
    Some(Conversation {
        id: ConversationId { account: account.clone(), remote: room_id.to_string() },
        kind: kind.clone(),
        name,
        avatar_url: match room.avatar_url() {
            Some(url) => Some(url.to_string()),
            // DMs usually have no room avatar; show the other person's.
            None if kind == ConversationKind::Direct => dm_avatar(&room).await,
            None => None,
        },
        favourite: room.is_favourite(),
        // Element's "Low priority" counts too, so archiving looks the same everywhere.
        archived: room.is_low_priority() || room.tags().await.ok().flatten().is_some_and(|t| t.contains_key(&TagName::from(ARCHIVED_TAG))),
        muted: notify == Some(RoomNotificationMode::Mute),
        mentions_only: notify == Some(RoomNotificationMode::MentionsAndKeywordsOnly),
        invited_by,
        team_id,
        call_active: false,
        dm_user: if kind == ConversationKind::Direct { room.direct_targets().into_iter().find_map(|t| t.into_user_id()).map(|u| u.to_string()) } else { None },
        encrypted: room.encryption_state().is_encrypted(),
    })
}

async fn member_profile(room: &Room, user: &UserId) -> (String, Option<String>) {
    match room.get_member_no_sync(user).await {
        Ok(Some(m)) => (m.name().to_owned(), m.avatar_url().map(|u| u.to_string())),
        _ => (user.localpart().to_owned(), None),
    }
}

async fn read_by(room: &Room, conversation: ConversationId, user: &UserId, pos: TimelinePos) -> AdapterEvent {
    let (name, avatar) = member_profile(room, user).await;
    AdapterEvent::ReadBy { conversation, user_id: user.to_string(), name, avatar, pos }
}

async fn sticker_from(room: &Room, ev: &OriginalSyncMessageLikeEvent<StickerEventContent>, me: &OwnedUserId, account: &AccountId, index: &Mutex<Index>) -> Option<Message> {
    use matrix_sdk::ruma::events::sticker::StickerMediaSource;

    let StickerMediaSource::Plain(uri) = &ev.content.source else { return None };
    let sent_at = u64::from(ev.origin_server_ts.0);
    let pos = index.lock().unwrap().assign(&ev.event_id, sent_at);
    let (sender_name, sender_avatar) = member_profile(room, &ev.sender).await;
    Some(Message {
        id: MessageId(ev.event_id.to_string()),
        conversation: ConversationId { account: account.clone(), remote: room.room_id().to_string() },
        pos,
        sender: ev.sender.to_string(),
        sender_name,
        sent_at,
        body: MessageBody::File { name: ev.content.body.clone(), media: uri.to_string(), kind: FileKind::Sticker, mime: ev.content.info.mimetype.clone(), size: None, caption: None, voice: None },
        thread_root: None,
        reply_to: None,
        sender_avatar,
        mentions_me: false,
        from_me: &ev.sender == me,
    })
}

/// Other members' stored read receipts, for "seen" indicators. Skipped for
/// big rooms, where per-member lookups get expensive.
async fn others_receipts(room: &Room, conversation: &ConversationId, me: &UserId, index: &Mutex<Index>) -> Vec<AdapterEvent> {
    use matrix_sdk::RoomMemberships;

    if room.joined_members_count() > 25 {
        return vec![];
    }
    let Ok(members) = room.members_no_sync(RoomMemberships::JOIN).await else { return vec![] };
    let mut out = vec![];
    for member in members.iter().filter(|m| m.user_id() != me) {
        let mut best: Option<TimelinePos> = None;
        for thread in [ReceiptThread::Unthreaded, ReceiptThread::Main] {
            if let Ok(Some((event_id, receipt))) = room.load_user_receipt(ReceiptType::Read, &thread, member.user_id()).await {
                if let Some(pos) = receipt_pos(index, &event_id, &receipt) {
                    best = best.max(Some(pos));
                }
            }
        }
        if let Some(pos) = best {
            out.push(AdapterEvent::ReadBy {
                conversation: conversation.clone(),
                user_id: member.user_id().to_string(),
                name: member.name().to_owned(),
                avatar: member.avatar_url().map(|u| u.to_string()),
                pos,
            });
        }
    }
    out
}

async fn message_from(room: &Room, ev: &OriginalSyncRoomMessageEvent, me: &OwnedUserId, account: &AccountId, index: &Mutex<Index>) -> Option<AdapterEvent> {
    let conversation = ConversationId { account: account.clone(), remote: room.room_id().to_string() };
    // Edits update the original in place; the engine checks the sender matches.
    if let Some(Relation::Replacement(replacement)) = &ev.content.relates_to {
        index.lock().unwrap().assign(&ev.event_id, u64::from(ev.origin_server_ts.0));
        return Some(AdapterEvent::Edited {
            conversation,
            target: MessageId(replacement.event_id.to_string()),
            sender: ev.sender.to_string(),
            body: body_of(&replacement.new_content.msgtype, &mut index.lock().unwrap()),
            at: u64::from(ev.origin_server_ts.0),
        });
    }
    let sent_at = u64::from(ev.origin_server_ts.0);
    let pos = index.lock().unwrap().assign(&ev.event_id, sent_at);
    let (sender_name, sender_avatar) = member_profile(room, &ev.sender).await;
    let mentions_me = ev.content.mentions.as_ref().is_some_and(|m| m.room || m.user_ids.contains(me)) || ev.content.body().contains(me.localpart());
    let (thread_root, reply_to) = match &ev.content.relates_to {
        Some(Relation::Thread(t)) => (Some(MessageId(t.event_id.to_string())), None),
        Some(Relation::Reply(r)) => (None, Some(MessageId(r.in_reply_to.event_id.to_string()))),
        _ => (None, None),
    };
    let mut body = body_of(&ev.content.msgtype, &mut index.lock().unwrap());
    // Its text says "your client does not support in-chat verification", which isn't true here.
    if matches!(ev.content.msgtype, MessageType::VerificationRequest(_)) {
        body = MessageBody::Event { kind: RoomEventKind::VerificationRequest, actor: sender_name.clone(), target: None, value: None };
    }
    if let MessageBody::Text { plain, html } = &mut body {
        if reply_to.is_some() {
            *plain = strip_reply_fallback(plain);
            *html = html.as_deref().map(strip_html_reply_fallback);
        }
        if matches!(ev.content.msgtype, MessageType::Emote(_)) {
            *plain = format!("* {sender_name} {plain}");
            *html = html.as_ref().map(|h| format!("* {sender_name} {h}"));
        }
    }
    Some(AdapterEvent::Message(Message {
        id: MessageId(ev.event_id.to_string()),
        conversation,
        pos,
        sender: ev.sender.to_string(),
        sender_name,
        sent_at,
        body,
        thread_root,
        reply_to,
        sender_avatar,
        mentions_me,
        from_me: &ev.sender == me,
    }))
}

async fn reaction_from(room: &Room, ev: &OriginalSyncReactionEvent, me: &OwnedUserId, account: &AccountId) -> AdapterEvent {
    AdapterEvent::Reaction {
        conversation: ConversationId { account: account.clone(), remote: room.room_id().to_string() },
        target: MessageId(ev.content.relates_to.event_id.to_string()),
        id: MessageId(ev.event_id.to_string()),
        key: ev.content.relates_to.key.clone(),
        sender: ev.sender.to_string(),
        sender_name: member_profile(room, &ev.sender).await.0,
        from_me: &ev.sender == me,
        at: u64::from(ev.origin_server_ts.0),
    }
}

fn redaction_from(room: &Room, ev: &OriginalSyncRoomRedactionEvent, account: &AccountId) -> Option<AdapterEvent> {
    // Newer room versions put `redacts` in the content, older ones at the top level.
    let target = ev.content.redacts.clone().or_else(|| ev.redacts.clone())?;
    Some(AdapterEvent::MessageRedacted {
        conversation: ConversationId { account: account.clone(), remote: room.room_id().to_string() },
        id: MessageId(target.to_string()),
    })
}

/// The event couldn't be decrypted because its sender's device isn't signed by its owner.
fn untrusted_sender(event: &matrix_sdk::deserialized_responses::TimelineEvent) -> bool {
    use matrix_sdk::deserialized_responses::{TimelineEventKind, UnableToDecryptReason};
    matches!(&event.kind, TimelineEventKind::UnableToDecrypt { utd_info, .. } if matches!(utd_info.reason, UnableToDecryptReason::SenderIdentityNotTrusted(_)))
}

/// A "waiting for the key" placeholder; the raw event is kept for retrying.
async fn encrypted_placeholder(
    room: &Room,
    raw: matrix_sdk::ruma::serde::Raw<OriginalSyncRoomEncryptedEvent>,
    me: &OwnedUserId,
    account: &AccountId,
    index: &Mutex<Index>,
    untrusted: bool,
) -> Option<AdapterEvent> {
    use matrix_sdk::ruma::events::room::encrypted::EncryptedEventScheme;

    let ev = raw.deserialize().ok()?;
    let sent_at = u64::from(ev.origin_server_ts.0);
    let session = match &ev.content.scheme {
        EncryptedEventScheme::MegolmV1AesSha2(c) => Some(c.session_id.clone()),
        _ => None,
    };
    let pos = {
        let mut index = index.lock().unwrap();
        let pending = index.pending.entry(ev.event_id.clone()).or_insert(PendingDecryption { room: room.room_id().to_owned(), raw, session, tried_backup: false, untrusted: false });
        pending.untrusted |= untrusted;
        index.assign(&ev.event_id, sent_at)
    };
    let (sender_name, sender_avatar) = member_profile(room, &ev.sender).await;
    Some(AdapterEvent::Message(Message {
        id: MessageId(ev.event_id.to_string()),
        conversation: ConversationId { account: account.clone(), remote: room.room_id().to_string() },
        pos,
        sender: ev.sender.to_string(),
        sender_name,
        sent_at,
        body: if untrusted { MessageBody::Untrusted } else { MessageBody::Encrypted },
        thread_root: None,
        reply_to: None,
        sender_avatar,
        mentions_me: false,
        from_me: &ev.sender == me,
    }))
}

/// Retries undecryptable messages: keys can arrive later from other devices
/// or be fetched from key backup. Decrypted ones replace their placeholder.
async fn retry_decryption(client: Client, tx: mpsc::UnboundedSender<AdapterEvent>, account: AccountId, index: Arc<Mutex<Index>>) {
    let Some(me) = client.user_id().map(ToOwned::to_owned) else { return };
    loop {
        tokio::time::sleep(Duration::from_secs(15)).await;
        let pending: Vec<(OwnedEventId, OwnedRoomId, matrix_sdk::ruma::serde::Raw<OriginalSyncRoomEncryptedEvent>, Option<String>, bool)> = index
            .lock()
            .unwrap()
            .pending
            .iter()
            .map(|(id, p)| (id.clone(), p.room.clone(), p.raw.clone(), p.session.clone(), p.tried_backup))
            .collect();
        for (event_id, room_id, raw, session, tried_backup) in pending {
            let Some(room) = client.get_room(&room_id) else { continue };
            // A failed decryption comes back as an "unable to decrypt" event, not as an error.
            use matrix_sdk::deserialized_responses::TimelineEventKind;
            let result = room.decrypt_event(&raw, None).await;
            let failed = match &result {
                Ok(e) if !matches!(e.kind, TimelineEventKind::UnableToDecrypt { .. }) => None,
                Ok(e) => Some(untrusted_sender(e)),
                Err(_) => Some(false),
            };
            match (result, failed) {
                (Ok(decrypted), None) => {
                    index.lock().unwrap().pending.remove(&event_id);
                    if let Some(event) = convert(&room, &decrypted, &me, &account, &index).await {
                        let _ = tx.send(event);
                    }
                }
                // Sent from a device its owner hasn't verified: say so instead of "waiting".
                (_, Some(true)) => {
                    let shown = index.lock().unwrap().pending.get(&event_id).is_some_and(|p| p.untrusted);
                    if !shown {
                        if let Some(event) = encrypted_placeholder(&room, raw, &me, &account, &index, true).await {
                            let _ = tx.send(event);
                        }
                    }
                }
                _ if !tried_backup => {
                    if let Some(p) = index.lock().unwrap().pending.get_mut(&event_id) {
                        p.tried_backup = true;
                    }
                    if let Some(session) = session {
                        if client.encryption().backups().are_enabled().await {
                            let _ = client.encryption().backups().download_room_key(&room_id, &session).await;
                        }
                    }
                }
                _ => {}
            }
        }
        if tx.is_closed() {
            break;
        }
    }
}

/// Joins, leaves, renames and other room changes as timeline lines.
async fn room_event_from(room: &Room, state: &matrix_sdk::ruma::events::AnySyncStateEvent, me: &OwnedUserId, account: &AccountId, index: &Mutex<Index>) -> Option<AdapterEvent> {
    use matrix_sdk::ruma::events::room::member::MembershipChange as M;
    use matrix_sdk::ruma::events::{AnySyncStateEvent as S, SyncStateEvent};

    let sender = state.sender().to_owned();
    let actor = member_profile(room, &sender).await.0;
    let name_of = |id: &UserId, fallback: Option<&str>| fallback.map(ToOwned::to_owned).unwrap_or_else(|| id.localpart().to_owned());
    let (kind, actor, target, value) = match state {
        S::RoomMember(SyncStateEvent::Original(ev)) => {
            let target_name = name_of(&ev.state_key, ev.content.displayname.as_deref());
            match ev.membership_change() {
                // Joining: show the name they joined with.
                M::Joined | M::InvitationAccepted => (RoomEventKind::Joined, target_name, None, None),
                M::Left => (RoomEventKind::Left, actor, None, None),
                M::Invited => (RoomEventKind::Invited, actor, Some(target_name), None),
                M::InvitationRejected => (RoomEventKind::InviteDeclined, actor, None, None),
                M::InvitationRevoked => (RoomEventKind::InviteRevoked, actor, Some(target_name), None),
                M::Kicked => (RoomEventKind::Kicked, actor, Some(member_profile(room, &ev.state_key).await.0), None),
                M::Banned | M::KickedAndBanned => (RoomEventKind::Banned, actor, Some(member_profile(room, &ev.state_key).await.0), None),
                M::Unbanned => (RoomEventKind::Unbanned, actor, Some(target_name), None),
                M::ProfileChanged { displayname_change: Some(change), .. } => {
                    (RoomEventKind::DisplayName, name_of(&ev.state_key, change.old), None, change.new.map(ToOwned::to_owned))
                }
                M::ProfileChanged { avatar_url_change: Some(_), .. } => (RoomEventKind::Avatar, target_name, None, None),
                _ => return None,
            }
        }
        S::RoomName(SyncStateEvent::Original(ev)) => (RoomEventKind::RoomName, actor, None, Some(ev.content.name.clone())),
        S::RoomTopic(SyncStateEvent::Original(ev)) => (RoomEventKind::Topic, actor, None, Some(ev.content.topic.clone())),
        S::RoomAvatar(SyncStateEvent::Original(_)) => (RoomEventKind::RoomAvatar, actor, None, None),
        S::RoomEncryption(SyncStateEvent::Original(_)) => (RoomEventKind::Encrypted, actor, None, None),
        _ => return None,
    };
    let sent_at = u64::from(state.origin_server_ts().0);
    let id = state.event_id().to_owned();
    Some(AdapterEvent::Message(Message {
        id: MessageId(id.to_string()),
        conversation: ConversationId { account: account.clone(), remote: room.room_id().to_string() },
        pos: index.lock().unwrap().assign(&id, sent_at),
        sender: sender.to_string(),
        sender_name: actor.clone(),
        sent_at,
        body: MessageBody::Event { kind, actor, target, value },
        thread_root: None,
        reply_to: None,
        sender_avatar: None,
        mentions_me: false,
        from_me: &sender == me,
    }))
}

/// A message that was deleted before we saw it; kept as a placeholder.
async fn redacted_message(room: &Room, ev: &matrix_sdk::ruma::events::room::message::RedactedSyncRoomMessageEvent, me: &OwnedUserId, account: &AccountId, index: &Mutex<Index>) -> AdapterEvent {
    let sent_at = u64::from(ev.origin_server_ts.0);
    let (sender_name, sender_avatar) = member_profile(room, &ev.sender).await;
    AdapterEvent::Message(Message {
        id: MessageId(ev.event_id.to_string()),
        conversation: ConversationId { account: account.clone(), remote: room.room_id().to_string() },
        pos: index.lock().unwrap().assign(&ev.event_id, sent_at),
        sender: ev.sender.to_string(),
        sender_name,
        sent_at,
        body: MessageBody::Redacted,
        thread_root: None,
        reply_to: None,
        sender_avatar,
        mentions_me: false,
        from_me: &ev.sender == me,
    })
}

const BACKFILL: u32 = 30;

/// Turns a fetched event into what we show: a message, reaction, edit or deletion.
async fn convert(room: &Room, event: &matrix_sdk::deserialized_responses::TimelineEvent, me: &OwnedUserId, account: &AccountId, index: &Mutex<Index>) -> Option<AdapterEvent> {
    use matrix_sdk::ruma::events::{AnySyncMessageLikeEvent, SyncMessageLikeEvent};

    let any = event.raw().deserialize().ok()?;
    index.lock().unwrap().assign(&any.event_id().to_owned(), u64::from(any.origin_server_ts().0));
    match any {
        AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomMessage(SyncMessageLikeEvent::Original(ev))) => {
            message_from(room, &ev, me, account, index).await
        }
        AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomMessage(SyncMessageLikeEvent::Redacted(ev))) => {
            Some(redacted_message(room, &ev, me, account, index).await)
        }
        AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::Sticker(SyncMessageLikeEvent::Original(ev))) => {
            sticker_from(room, &ev, me, account, index).await.map(AdapterEvent::Message)
        }
        AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::Reaction(SyncMessageLikeEvent::Original(ev))) => {
            Some(reaction_from(room, &ev, me, account).await)
        }
        AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomRedaction(SyncRoomRedactionEvent::Original(ev))) => {
            redaction_from(room, &ev, account)
        }
        AnySyncTimelineEvent::State(state) => room_event_from(room, &state, me, account, index).await,
        AnySyncTimelineEvent::MessageLike(ev) if ev.event_type().to_string().ends_with("poll.start") => {
            let content = serde_json::to_value(ev.original_content()?).ok()?;
            poll_message(room, ev.event_id(), ev.sender(), u64::from(ev.origin_server_ts().0), &content, me, account, index).await
        }
        AnySyncTimelineEvent::MessageLike(ev) if ev.event_type().to_string().starts_with("m.call.") => {
            let content = serde_json::to_string(&ev.original_content()?).ok()?;
            call_line(room, ev.event_id(), ev.sender(), u64::from(ev.origin_server_ts().0), &ev.event_type().to_string(), &content, me, account, index).await
        }
        AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomEncrypted(SyncMessageLikeEvent::Original(_))) => {
            encrypted_placeholder(room, event.raw().clone().cast_unchecked(), me, account, index, untrusted_sender(event)).await
        }
        _ => None,
    }
}

/// One page of messages going back from `from` (None = the newest), oldest
/// first, plus the token for the page before it. Undecryptable events make
/// us pull the room's keys from key backup and try once more.
async fn fetch_page(client: &Client, room: &Room, from: Option<String>, limit: u32, me: &OwnedUserId, account: &AccountId, index: &Mutex<Index>) -> Option<(Vec<AdapterEvent>, Option<String>)> {
    use matrix_sdk::deserialized_responses::TimelineEventKind;
    use matrix_sdk::room::MessagesOptions;

    let fetch = || async {
        let mut options = MessagesOptions::backward();
        options.limit = limit.into();
        options.from = from.clone();
        room.messages(options).await.ok()
    };
    let mut page = fetch().await?;
    let undecryptable = page.chunk.iter().any(|e| matches!(e.kind, TimelineEventKind::UnableToDecrypt { .. }));
    if undecryptable && client.encryption().backups().are_enabled().await {
        if client.encryption().backups().download_room_keys_for_room(room.room_id()).await.is_ok() {
            page = fetch().await.unwrap_or(page);
        }
    }
    let mut out = vec![];
    for event in page.chunk.iter().rev() {
        out.extend(convert(room, event, me, account, index).await);
    }
    Some((out, page.end))
}

/// The latest messages of a room; remembers where scrollback continues.
async fn backfill(client: &Client, room: &Room, me: &OwnedUserId, account: &AccountId, index: &Mutex<Index>) -> Vec<AdapterEvent> {
    let Some((messages, end)) = fetch_page(client, room, None, BACKFILL, me, account, index).await else { return vec![] };
    index.lock().unwrap().back_tokens.insert(room.room_id().to_owned(), end);
    messages
}

/// Incremental syncs only mention rooms that changed, so after a restart the
/// rooms already in the local store are announced (with recent history) here.
async fn initial_load(client: Client, tx: mpsc::UnboundedSender<AdapterEvent>, account: AccountId, index: Arc<Mutex<Index>>) {
    // Pending invites first: they only need a list entry, no history.
    for room in client.invited_rooms() {
        if let Some(conv) = conversation_for(&client, &account, room.room_id()).await {
            let _ = tx.send(AdapterEvent::ConversationUpserted(conv));
        }
    }
    futures::stream::iter(client.joined_rooms())
        .for_each_concurrent(4, |room| load_room(client.clone(), tx.clone(), account.clone(), index.clone(), room))
        .await;
}

/// Announces a room with its recent history and read state, once per session.
async fn load_room(client: Client, tx: mpsc::UnboundedSender<AdapterEvent>, account: AccountId, index: Arc<Mutex<Index>>, room: Room) {
    if !index.lock().unwrap().loaded.insert(room.room_id().to_owned()) {
        return;
    }
    let Some(me) = client.user_id().map(ToOwned::to_owned) else { return };
    if let Some(team) = team_for(&account, &room).await {
        let _ = tx.send(AdapterEvent::TeamUpserted(team));
        return;
    }
    let Some(conv) = conversation_for(&client, &account, room.room_id()).await else { return };
    let id = conv.id.clone();
    let _ = tx.send(AdapterEvent::ConversationUpserted(conv));
    let events = backfill(&client, &room, &me, &account, &index).await;
    let mut thread_roots: Vec<MessageId> = events
        .iter()
        .filter_map(|e| match e {
            AdapterEvent::Message(m) => m.thread_root.clone(),
            _ => None,
        })
        .collect();
    thread_roots.sort_by(|a, b| a.0.cmp(&b.0));
    thread_roots.dedup();
    for event in events {
        let _ = tx.send(event);
    }
    for (pos, at, all_threads) in own_receipts(&client, room.room_id(), &index).await {
        let _ = tx.send(AdapterEvent::OwnReadReceipt { conversation: id.clone(), thread_root: None, pos, at, all_threads });
    }
    // Threads have their own receipts (Element marks them read separately).
    for root in thread_roots {
        for (pos, at) in thread_receipts(&room, &me, &root, &index).await {
            let _ = tx.send(AdapterEvent::OwnReadReceipt { conversation: id.clone(), thread_root: Some(root.clone()), pos, at, all_threads: false });
        }
    }
    for ev in others_receipts(&room, &id, &me, &index).await {
        let _ = tx.send(ev);
    }
}

async fn thread_receipts(room: &Room, me: &UserId, root: &MessageId, index: &Mutex<Index>) -> Vec<(TimelinePos, Timestamp)> {
    let Ok(root_id) = OwnedEventId::try_from(root.0.as_str()) else { return vec![] };
    let mut out = vec![];
    for kind in [ReceiptType::Read, ReceiptType::ReadPrivate] {
        if let Ok(Some((event_id, receipt))) = room.load_user_receipt(kind, &ReceiptThread::Thread(root_id.clone()), me).await {
            if let Some(pos) = receipt_pos(index, &event_id, &receipt) {
                out.push((pos, receipt.ts.map(|t| u64::from(t.0)).unwrap_or(0)));
            }
        }
    }
    out
}

/// A room changed in a sync (either kind): update its list entry and read state,
/// and load its history the first time we see it this session.
async fn room_changed(client: &Client, tx: &mpsc::UnboundedSender<AdapterEvent>, account: &AccountId, index: &Arc<Mutex<Index>>, room_id: &RoomId) {
    let Some(room) = client.get_room(room_id) else { return };
    match room.state() {
        matrix_sdk::RoomState::Left | matrix_sdk::RoomState::Banned => {
            let _ = tx.send(AdapterEvent::ConversationRemoved(ConversationId { account: account.clone(), remote: room_id.to_string() }));
        }
        matrix_sdk::RoomState::Invited => {
            if let Some(conv) = conversation_for(client, account, room_id).await {
                let _ = tx.send(AdapterEvent::ConversationUpserted(conv));
            }
        }
        _ => {
            if !index.lock().unwrap().loaded.contains(room_id) {
                tokio::spawn(load_room(client.clone(), tx.clone(), account.clone(), index.clone(), room));
                return;
            }
            if let Some(team) = team_for(account, &room).await {
                let _ = tx.send(AdapterEvent::TeamUpserted(team));
                return;
            }
            if let Some(conv) = conversation_for(client, account, room_id).await {
                let id = conv.id.clone();
                let _ = tx.send(AdapterEvent::ConversationUpserted(conv));
                // Within one sync, receipts can be processed before the events they
                // point at; re-read the stored receipt now every event has a position.
                for (pos, at, all_threads) in own_receipts(client, room_id, index).await {
                    let _ = tx.send(AdapterEvent::OwnReadReceipt { conversation: id.clone(), thread_root: None, pos, at, all_threads });
                }
            }
        }
    }
}

async fn classic_sync(client: Client, tx: mpsc::UnboundedSender<AdapterEvent>, account: AccountId, index: Arc<Mutex<Index>>) {
    let lost = Arc::new(Mutex::new(false));
    let result = client
        .sync_with_result_callback(SyncSettings::default(), |response| {
            let (client, tx, account, lost, index) = (client.clone(), tx.clone(), account.clone(), lost.clone(), index.clone());
            async move {
                let response = match response {
                    Ok(r) => r,
                    Err(e) => {
                        *lost.lock().unwrap() = true;
                        let _ = tx.send(AdapterEvent::ConnectionLost { reason: e.to_string() });
                        tokio::time::sleep(Duration::from_secs(5)).await;
                        return Ok(LoopCtrl::Continue);
                    }
                };
                if std::mem::take(&mut *lost.lock().unwrap()) {
                    let _ = tx.send(AdapterEvent::ConnectionRestored);
                }
                let rooms = response.rooms.joined.keys().chain(response.rooms.invited.keys()).chain(response.rooms.left.keys());
                for room_id in rooms {
                    room_changed(&client, &tx, &account, &index, room_id).await;
                }
                Ok(if tx.is_closed() { LoopCtrl::Break } else { LoopCtrl::Continue })
            }
        })
        .await;
    if let Err(e) = result {
        tracing::warn!("matrix sync stopped: {e}");
    }
}

/// Sliding sync (MSC4186). Errors before the first successful response so the
/// caller can fall back to classic sync; afterwards it reconnects by itself.
/// Events per room in the full list: enough for the preview and unread state.
/// The rooms sliding sync follows closely (more history per sync): the chat on screen, and rooms
/// where a verification is going on, whose events come in quick succession and mustn't be cut
/// short by the list's small timeline.
pub(crate) struct RoomSubscriptions {
    sliding: Arc<Mutex<Option<matrix_sdk::sliding_sync::SlidingSync>>>,
    focus: Mutex<Option<OwnedRoomId>>,
    verifying: Mutex<HashSet<OwnedRoomId>>,
}

impl RoomSubscriptions {
    fn apply(&self) {
        use matrix_sdk::ruma::api::client::sync::sync_events::v5::request::RoomSubscription;

        let Some(sync) = self.sliding.lock().unwrap().clone() else { return };
        let mut rooms: Vec<OwnedRoomId> = self.verifying.lock().unwrap().iter().cloned().collect();
        rooms.extend(self.focus.lock().unwrap().clone());
        rooms.sort();
        rooms.dedup();
        if rooms.is_empty() {
            return sync.set_room_subscriptions(&[], None, false);
        }
        let mut settings = RoomSubscription::default();
        settings.timeline_limit = matrix_sdk::ruma::UInt::from(FOCUS_TIMELINE);
        // Members stay lazy (big rooms); the member list loads them when opened.
        settings.required_state = list_required_state();
        let ids: Vec<&RoomId> = rooms.iter().map(|r| r.as_ref()).collect();
        sync.set_room_subscriptions(&ids, Some(settings), true);
    }

    /// A verification in `room` started (`on`) or ended.
    pub(crate) fn verifying(&self, room: &RoomId, on: bool) {
        let changed = if on { self.verifying.lock().unwrap().insert(room.to_owned()) } else { self.verifying.lock().unwrap().remove(room) };
        if changed {
            self.apply();
        }
    }
}

const LIST_TIMELINE: u32 = 5;
/// Rooms per batch while the list grows: the first chats show sooner on big accounts.
const LIST_BATCH: u32 = 50;
/// Events for the chat on screen (subscribed separately), so opening it is instant.
const FOCUS_TIMELINE: u32 = 30;

/// State our room list needs: names, pictures, DM/space info, teams, members for names.
fn list_required_state() -> Vec<(matrix_sdk::ruma::events::StateEventType, String)> {
    use matrix_sdk::ruma::events::StateEventType as S;
    [
        (S::RoomCreate, ""), (S::RoomName, ""), (S::RoomAvatar, ""), (S::RoomTopic, ""), (S::RoomCanonicalAlias, ""),
        (S::RoomEncryption, ""), (S::RoomTombstone, ""), (S::RoomPowerLevels, ""), (S::RoomJoinRules, ""),
        (S::RoomMember, "$LAZY"), (S::RoomMember, "$ME"), (S::SpaceChild, "*"), (S::SpaceParent, "*"),
    ]
    .into_iter()
    .map(|(k, v)| (k, v.to_owned()))
    .collect()
}

async fn sliding_sync(
    client: Client,
    tx: mpsc::UnboundedSender<AdapterEvent>,
    account: AccountId,
    index: Arc<Mutex<Index>>,
    handle: Arc<Mutex<Option<matrix_sdk::sliding_sync::SlidingSync>>>,
) -> matrix_sdk::Result<()> {
    use matrix_sdk::sliding_sync::{SlidingSyncList, SlidingSyncMode};

    let list = SlidingSyncList::builder("all").sync_mode(SlidingSyncMode::new_growing(LIST_BATCH)).timeline_limit(LIST_TIMELINE).required_state(list_required_state());
    let sync = client
        .sliding_sync("ms_trix")?
        .add_list(list)
        .with_all_extensions()
        .poll_timeout(Duration::from_secs(30))
        .network_timeout(Duration::from_secs(60))
        .build()
        .await?;
    *handle.lock().unwrap() = Some(sync.clone());

    let mut started = false;
    let mut lost = false;
    loop {
        let stream = sync.sync();
        futures::pin_mut!(stream);
        while let Some(update) = stream.next().await {
            match update {
                Ok(summary) => {
                    if !std::mem::replace(&mut started, true) {
                        tokio::spawn(poll_presence(client.clone(), tx.clone()));
                    }
                    if std::mem::take(&mut lost) {
                        let _ = tx.send(AdapterEvent::ConnectionRestored);
                    }
                    for room_id in &summary.rooms {
                        room_changed(&client, &tx, &account, &index, room_id).await;
                    }
                }
                Err(e) if !started => return Err(e),
                Err(e) => {
                    lost = true;
                    let _ = tx.send(AdapterEvent::ConnectionLost { reason: e.to_string() });
                    break;
                }
            }
            if tx.is_closed() {
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

/// Sliding sync has no presence; ask for the status of 1:1 contacts every minute.
async fn poll_presence(client: Client, tx: mpsc::UnboundedSender<AdapterEvent>) {
    use matrix_sdk::ruma::api::client::presence::get_presence::v3::Request;
    use matrix_sdk::ruma::presence::PresenceState;

    while !tx.is_closed() {
        let mut users: Vec<OwnedUserId> = client.joined_rooms().iter().flat_map(|r| r.direct_targets()).filter_map(|t| t.into_user_id()).collect();
        users.sort();
        users.dedup();
        for user in users {
            if let Ok(response) = client.send(Request::new(user.clone())).await {
                let presence = match response.presence {
                    PresenceState::Online => Presence::Available,
                    PresenceState::Unavailable => Presence::Away,
                    _ => Presence::Offline,
                };
                let status = response.status_msg.filter(|s| !s.trim().is_empty());
                let _ = tx.send(AdapterEvent::PresenceChanged { user_id: user.to_string(), presence, status });
            }
        }
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
}

/// Our stored main-timeline read receipts for a room, as known index.
/// Our stored receipts: (position, read time, unthreaded = also covers threads).
async fn own_receipts(client: &Client, room_id: &RoomId, index: &Mutex<Index>) -> Vec<(TimelinePos, Timestamp, bool)> {
    let (Some(room), Some(me)) = (client.get_room(room_id), client.user_id()) else { return vec![] };
    let mut out = vec![];
    for kind in [ReceiptType::Read, ReceiptType::ReadPrivate] {
        for thread in [ReceiptThread::Main, ReceiptThread::Unthreaded] {
            if let Ok(Some((event_id, receipt))) = room.load_user_receipt(kind.clone(), &thread, me).await {
                if let Some(pos) = receipt_pos(index, &event_id, &receipt) {
                    out.push((pos, receipt.ts.map(|t| u64::from(t.0)).unwrap_or(0), thread == ReceiptThread::Unthreaded));
                }
            }
        }
    }
    out
}

/// Where a receipt puts someone in our timeline. When the event isn't loaded
/// (older than our window, or a thread reply we never fetched), use the time
/// they read it: everything sent before that moment was read.
fn receipt_pos(index: &Mutex<Index>, event_id: &OwnedEventId, receipt: &matrix_sdk::ruma::events::receipt::Receipt) -> Option<TimelinePos> {
    if let Some(pos) = index.lock().unwrap().by_event.get(event_id).copied() {
        return Some(pos);
    }
    receipt.ts.map(|ts| (u64::from(ts.0) << 10) | 0x3ff)
}

async fn dm_avatar(room: &Room) -> Option<String> {
    for target in room.direct_targets() {
        if let Some(user) = target.as_user_id() {
            if let (_, Some(avatar)) = member_profile(room, user).await {
                return Some(avatar);
            }
        }
    }
    room.heroes().await.into_iter().find_map(|h| h.avatar_url).map(|u| u.to_string())
}

fn space_id(parent: &matrix_sdk::room::ParentSpace) -> Option<String> {
    use matrix_sdk::room::ParentSpace::*;
    match parent {
        Reciprocal(r) | WithPowerlevel(r) | Illegitimate(r) => Some(r.room_id().to_string()),
        Unverifiable(id) => Some(id.to_string()),
    }
}

/// A joined space as a team, with all the rooms it lists as children.
async fn team_for(account: &AccountId, room: &Room) -> Option<Team> {
    use matrix_sdk::deserialized_responses::SyncOrStrippedState;
    use matrix_sdk::ruma::events::space::child::SpaceChildEventContent;
    use matrix_sdk::ruma::events::SyncStateEvent;

    if !room.is_space() || room.state() != matrix_sdk::RoomState::Joined {
        return None;
    }
    let mut children = vec![];
    for raw in room.get_state_events_static::<SpaceChildEventContent>().await.ok()? {
        // A child event with an empty `via` means the room was removed from the space.
        if let Ok(SyncOrStrippedState::Sync(SyncStateEvent::Original(ev))) = raw.deserialize() {
            if !ev.content.via.is_empty() {
                children.push(ev.state_key.to_string());
            }
        }
    }
    let order = room
        .account_data(SPACE_ORDER.into())
        .await
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw.json().get()).ok())
        .and_then(|v| v["content"]["order"].as_str().map(ToOwned::to_owned));
    Some(Team {
        id: ConversationId { account: account.clone(), remote: room.room_id().to_string() },
        name: room.cached_display_name().map(|n| n.to_string()).or_else(|| room.name()).unwrap_or_else(|| room.room_id().to_string()),
        topic: room.topic(),
        avatar_url: room.avatar_url().map(|u| u.to_string()),
        children,
        order,
    })
}

fn space_name(parent: matrix_sdk::room::ParentSpace) -> Option<String> {
    use matrix_sdk::room::ParentSpace::*;
    match parent {
        Reciprocal(r) | WithPowerlevel(r) | Illegitimate(r) => r.cached_display_name().map(|n| n.to_string()).or_else(|| r.name()),
        Unverifiable(_) => None,
    }
}

/// Older clients prepend "> <@user> quoted text" to replies; drop it.
fn strip_reply_fallback(body: &str) -> String {
    if !body.starts_with("> ") {
        return body.to_owned();
    }
    body.lines().skip_while(|l| l.starts_with('>')).skip_while(|l| l.is_empty()).collect::<Vec<_>>().join("\n")
}

/// Rich replies embed the quoted message in an <mx-reply> block; drop it.
fn strip_html_reply_fallback(html: &str) -> String {
    match (html.find("<mx-reply>"), html.find("</mx-reply>")) {
        (Some(start), Some(end)) if end > start => format!("{}{}", &html[..start], &html[end + "</mx-reply>".len()..]),
        _ => html.to_owned(),
    }
}

fn body_of(msgtype: &MessageType, index: &mut Index) -> MessageBody {
    // With a caption, `body` holds the caption and `filename` the file name (MSC2530).
    let mut file = |kind: FileKind, body: &str, filename: Option<&str>, source: &MediaSource, mime: Option<String>, size: Option<u64>| MessageBody::File {
        name: filename.unwrap_or(body).to_owned(),
        caption: filename.filter(|f| *f != body).map(|_| body.to_owned()),
        media: match source {
            MediaSource::Plain(uri) => uri.to_string(),
            MediaSource::Encrypted(f) => {
                index.encrypted_media.insert(f.url.to_string(), source.clone());
                f.url.to_string()
            }
        },
        kind,
        mime,
        size,
        voice: None,
    };
    match msgtype {
        MessageType::Text(t) => MessageBody::Text {
            plain: t.body.clone(),
            html: t.formatted.as_ref().map(|f| f.body.clone()),
        },
        MessageType::Notice(n) => MessageBody::Notice { plain: n.body.clone() },
        MessageType::Emote(e) => MessageBody::Text { plain: format!("* {}", e.body), html: None },
        MessageType::File(f) => {
            let info = f.info.as_deref();
            file(FileKind::File, &f.body, f.filename.as_deref(), &f.source, info.and_then(|i| i.mimetype.clone()), info.and_then(|i| i.size.map(u64::from)))
        }
        MessageType::Image(f) => {
            let info = f.info.as_deref();
            file(FileKind::Image, &f.body, f.filename.as_deref(), &f.source, info.and_then(|i| i.mimetype.clone()), info.and_then(|i| i.size.map(u64::from)))
        }
        MessageType::Video(f) => {
            let info = f.info.as_deref();
            file(FileKind::Video, &f.body, f.filename.as_deref(), &f.source, info.and_then(|i| i.mimetype.clone()), info.and_then(|i| i.size.map(u64::from)))
        }
        MessageType::Audio(f) => {
            let info = f.info.as_deref();
            let mut body = file(FileKind::Audio, &f.body, f.filename.as_deref(), &f.source, info.and_then(|i| i.mimetype.clone()), info.and_then(|i| i.size.map(u64::from)));
            // Voice messages (Element's format): amplitudes are 0..1024.
            if f.voice.is_some() {
                if let MessageBody::File { voice, .. } = &mut body {
                    let details = f.audio.as_ref();
                    *voice = Some(VoiceInfo {
                        duration_ms: details.map(|a| a.duration.as_millis() as u64).or_else(|| info.and_then(|i| i.duration).map(|d| d.as_millis() as u64)).unwrap_or(0),
                        waveform: details.map(|a| a.waveform.iter().map(|v| u64::from(v.get()) as f32 / 1024.0).collect()).unwrap_or_default(),
                    });
                }
            }
            body
        }
        other => {
            // Element's chat effects: the UI plays them for messages with the matching emoji.
            let emoji = match other.msgtype() {
                "nic.custom.confetti" => Some("🎉"),
                "nic.custom.fireworks" => Some("🎆"),
                "io.element.effect.rainfall" => Some("🌧️"),
                "io.element.effect.snowfall" => Some("❄"),
                "io.element.effects.space_invaders" => Some("👾"),
                "io.element.effect.hearts" => Some("💝"),
                _ => None,
            };
            let body = other.body();
            let plain = match emoji {
                Some(e) if !body.contains(e.trim_end_matches('\u{fe0f}')) => format!("{body} {e}"),
                _ => body.to_owned(),
            };
            MessageBody::Text { plain, html: None }
        }
    }
}

/// Minimal stream wrapper so we don't pull in tokio-stream for one type.
mod tokio_stream_shim {
    use std::pin::Pin;
    use std::task::{Context, Poll};

    pub struct UnboundedReceiverStream<T>(tokio::sync::mpsc::UnboundedReceiver<T>);

    impl<T> UnboundedReceiverStream<T> {
        pub fn new(rx: tokio::sync::mpsc::UnboundedReceiver<T>) -> Self {
            Self(rx)
        }
    }

    impl<T> futures::Stream for UnboundedReceiverStream<T> {
        type Item = T;
        fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<T>> {
            self.0.poll_recv(cx)
        }
    }
}

/// Passes 1:1 call events (m.call.*) to the UI, which runs the call itself, and
/// adds a line to the chat for the ones worth showing (started, ended, missed, declined).
fn register_call_events(client: &Client, tx: mpsc::UnboundedSender<AdapterEvent>, account: AccountId, index: Arc<Mutex<Index>>) {
    use matrix_sdk::ruma::events::AnySyncMessageLikeEvent;

    client.add_event_handler(move |ev: AnySyncMessageLikeEvent, room: Room, client: Client| {
        let (tx, account, index) = (tx.clone(), account.clone(), index.clone());
        async move {
            let event_type = ev.event_type().to_string();
            // Polls (Element uses the unstable names): a start is a message, votes/ends refresh it.
            if is_poll_event(&event_type) {
                let Some(content) = ev.original_content().and_then(|c| serde_json::to_value(&c).ok()) else { return };
                let conversation = ConversationId { account: account.clone(), remote: room.room_id().to_string() };
                if event_type.ends_with("poll.start") {
                    if let Some(me) = client.user_id() {
                        if let Some(m) = poll_message(&room, ev.event_id(), ev.sender(), u64::from(ev.origin_server_ts().0), &content, &me.to_owned(), &account, &index).await {
                            let _ = tx.send(m);
                        }
                    }
                } else if let Some(target) = content["m.relates_to"]["event_id"].as_str() {
                    let _ = tx.send(AdapterEvent::PollChanged { conversation, poll: target.to_owned() });
                }
                return;
            }
            // Group calls (MatrixRTC) use m.call.member / m.call.notify; those aren't ours.
            if !event_type.starts_with("m.call.") || event_type == "m.call.notify" || event_type == "m.call.member" {
                return;
            }
            let Some(content) = ev.original_content().and_then(|c| serde_json::to_string(&c).ok()) else { return };
            let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
            let sent = u64::from(ev.origin_server_ts().0);
            if let Some(me) = client.user_id() {
                if let Some(line) = call_line(&room, ev.event_id(), ev.sender(), sent, &event_type, &content, &me.to_owned(), &account, &index).await {
                    let _ = tx.send(line);
                }
            }
            let _ = tx.send(AdapterEvent::CallSignal(CallSignal {
                conversation: ConversationId { account, remote: room.room_id().to_string() }.key(),
                event_type,
                content,
                sender: ev.sender().to_string(),
                from_me: client.user_id() == Some(ev.sender()),
                age_ms: now.saturating_sub(sent),
            }));
        }
    });
}

/// The chat line for a call event, or None for the plumbing ones (answer, candidates, ...).
#[allow(clippy::too_many_arguments)]
async fn call_line(room: &Room, event_id: &matrix_sdk::ruma::EventId, sender: &UserId, sent_at: u64, event_type: &str, content: &str, me: &OwnedUserId, account: &AccountId, index: &Mutex<Index>) -> Option<AdapterEvent> {
    let content: serde_json::Value = serde_json::from_str(content).ok()?;
    let value = match event_type {
        "m.call.invite" => {
            let video = content["offer"]["sdp"].as_str().is_some_and(|sdp| sdp.contains("m=video"));
            if video { "invite_video" } else { "invite_voice" }
        }
        "m.call.hangup" if content["reason"] == "invite_timeout" => "missed",
        "m.call.hangup" => "ended",
        "m.call.reject" => "declined",
        _ => return None,
    };
    let pos = index.lock().unwrap().assign(&event_id.to_owned(), sent_at);
    let (sender_name, sender_avatar) = member_profile(room, sender).await;
    Some(AdapterEvent::Message(Message {
        id: MessageId(event_id.to_string()),
        conversation: ConversationId { account: account.clone(), remote: room.room_id().to_string() },
        pos,
        sender: sender.to_string(),
        body: MessageBody::Event { kind: RoomEventKind::Call, actor: sender_name.clone(), target: None, value: Some(value.to_owned()) },
        sender_name,
        sent_at,
        thread_root: None,
        reply_to: None,
        sender_avatar,
        mentions_me: false,
        from_me: sender == me,
    }))
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// One MSC2545 image pack: `images` by shortcode, usage per image or for the whole pack.
fn parse_pack(v: &serde_json::Value, fallback_name: &str) -> Option<ImagePack> {
    let pack_usage: Vec<&str> = v["pack"]["usage"].as_array().map(|u| u.iter().filter_map(|x| x.as_str()).collect()).unwrap_or_default();
    let images = v["images"].as_object()?;
    let images: Vec<PackImage> = images
        .iter()
        .filter_map(|(code, img)| {
            let url = img["url"].as_str()?.to_owned();
            let usage: Vec<&str> = img["usage"].as_array().map(|u| u.iter().filter_map(|x| x.as_str()).collect()).unwrap_or_else(|| pack_usage.clone());
            // No usage given means both.
            let both = usage.is_empty();
            Some(PackImage { shortcode: code.clone(), url, body: img["body"].as_str().map(ToOwned::to_owned), emoticon: both || usage.contains(&"emoticon"), sticker: both || usage.contains(&"sticker") })
        })
        .collect();
    if images.is_empty() {
        return None;
    }
    let name = v["pack"]["display_name"].as_str().filter(|n| !n.is_empty()).unwrap_or(fallback_name).to_owned();
    Some(ImagePack { name, images })
}

fn is_poll_event(event_type: &str) -> bool {
    matches!(
        event_type,
        "org.matrix.msc3381.poll.start" | "m.poll.start" | "org.matrix.msc3381.poll.response" | "m.poll.response" | "org.matrix.msc3381.poll.end" | "m.poll.end"
    )
}

/// (question, [(answer id, text)], max selections, results visible while open) from a
/// poll start, unstable (Element) or stable (MSC3381) form.
fn parse_poll(content: &serde_json::Value) -> Option<(String, Vec<(String, String)>, u32, bool)> {
    if let Some(p) = content.get("org.matrix.msc3381.poll.start") {
        let question = p["question"]["org.matrix.msc1767.text"].as_str().or_else(|| p["question"]["body"].as_str())?.to_owned();
        let answers = p["answers"].as_array()?.iter().filter_map(|a| Some((a["id"].as_str()?.to_owned(), a["org.matrix.msc1767.text"].as_str().or_else(|| a["body"].as_str())?.to_owned()))).collect();
        let disclosed = p["kind"].as_str() != Some("org.matrix.msc3381.poll.undisclosed");
        return Some((question, answers, p["max_selections"].as_u64().unwrap_or(1) as u32, disclosed));
    }
    let p = content.get("m.poll")?;
    let text = |v: &serde_json::Value| v["m.text"][0]["body"].as_str().map(ToOwned::to_owned);
    let question = text(&p["question"])?;
    let answers = p["answers"].as_array()?.iter().filter_map(|a| Some((a["m.id"].as_str()?.to_owned(), text(a)?))).collect();
    let disclosed = p["kind"].as_str() != Some("m.undisclosed");
    Some((question, answers, p["max_selections"].as_u64().unwrap_or(1) as u32, disclosed))
}

#[allow(clippy::too_many_arguments)]
async fn poll_message(room: &Room, event_id: &matrix_sdk::ruma::EventId, sender: &UserId, sent_at: u64, content: &serde_json::Value, me: &OwnedUserId, account: &AccountId, index: &Mutex<Index>) -> Option<AdapterEvent> {
    let (question, ..) = parse_poll(content)?;
    let pos = index.lock().unwrap().assign(&event_id.to_owned(), sent_at);
    let (sender_name, sender_avatar) = member_profile(room, sender).await;
    Some(AdapterEvent::Message(Message {
        id: MessageId(event_id.to_string()),
        conversation: ConversationId { account: account.clone(), remote: room.room_id().to_string() },
        pos,
        sender: sender.to_string(),
        body: MessageBody::Poll { id: event_id.to_string(), question },
        sender_name,
        sent_at,
        thread_root: None,
        reply_to: None,
        sender_avatar,
        mentions_me: false,
        from_me: sender == me,
    }))
}

