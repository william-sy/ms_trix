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

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use futures::stream::{BoxStream, StreamExt};
use matrix_sdk::config::SyncSettings;
use matrix_sdk::authentication::matrix::MatrixSession;
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
use matrix_sdk::ruma::events::{AnySyncTimelineEvent, OriginalSyncMessageLikeEvent, RoomAccountDataEvent, SyncEphemeralRoomEvent};
use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId, OwnedUserId, RoomId, UserId};
use matrix_sdk::notification_settings::RoomNotificationMode;
use matrix_sdk::{Client, LoopCtrl, Room};
use rand::distr::{Alphanumeric, SampleString};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_stream_shim::UnboundedReceiverStream;
use trix_core::adapter::{AdapterError, AdapterFactory, History, RecoveryStatus, Result, SecurityStatus};
use trix_core::*;

pub const PROTOCOL: &str = "matrix";

/// Everything needed to bring an account back after a restart. The host must
/// keep this in the OS keychain: it contains the access token and the
/// passphrase of the encrypted local store.
#[derive(Serialize, Deserialize)]
struct StoredSession {
    homeserver: String,
    session: MatrixSession,
    store_passphrase: String,
}

fn err(e: impl std::fmt::Display) -> AdapterError {
    AdapterError::Other(e.to_string())
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

pub struct MatrixAdapter {
    account: Mutex<Account>,
    client: Client,
    index: Arc<Mutex<Index>>,
    sync_task: Mutex<Option<JoinHandle<()>>>,
    /// Lets us push updates outside a sync (e.g. after changing notification level).
    events: Mutex<Option<mpsc::UnboundedSender<AdapterEvent>>>,
    retry_task: Mutex<Option<JoinHandle<()>>>,
}

/// What a homeserver accepts, so the login screen only offers what works.
#[derive(Debug, Clone, Serialize)]
pub struct LoginMethods {
    pub homeserver: String,
    pub password: bool,
    pub sso: bool,
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
    let types = client.matrix_auth().get_login_types().await.map_err(|e| AdapterError::Network(e.to_string()))?;
    let mut methods = LoginMethods { homeserver: client.homeserver().to_string(), password: false, sso: false, identity_providers: vec![] };
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

        let session = client.matrix_auth().session().ok_or_else(|| AdapterError::Auth("no session after login".into()))?;
        let stored = StoredSession { homeserver: client.homeserver().to_string(), session, store_passphrase };
        let blob = serde_json::to_vec(&stored).map_err(err)?;
        let account = account_for(&client, account_id).await?;
        Ok((Arc::new(Self::new(account, client)), blob))
    }

    pub async fn restore(data_dir: &Path, account: Account, blob: &[u8]) -> Result<Arc<Self>> {
        let stored: StoredSession = serde_json::from_slice(blob).map_err(err)?;
        let client = build_client(&store_dir(data_dir, &account.id), &stored.homeserver, &stored.store_passphrase).await?;
        client.restore_session(stored.session).await.map_err(|e| AdapterError::Auth(e.to_string()))?;
        Ok(Arc::new(Self::new(account, client)))
    }

    fn new(account: Account, client: Client) -> Self {
        Self { account: Mutex::new(account), client, index: Default::default(), sync_task: Mutex::new(None), events: Mutex::new(None), retry_task: Mutex::new(None) }
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
                    if let Some(event) = encrypted_placeholder(&room, raw, &me, &account, &index).await {
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
        use matrix_sdk::attachment::AttachmentConfig;
        use matrix_sdk::ruma::events::room::message::TextMessageEventContent;

        let mime: mime::Mime = mime.and_then(|m| m.parse().ok()).unwrap_or_else(|| mime_guess::from_path(name).first_or_octet_stream());
        // The SDK encrypts the upload in encrypted rooms.
        let config = AttachmentConfig::new().caption(caption.filter(|c| !c.trim().is_empty()).map(TextMessageEventContent::markdown));
        self.room(conversation)?.send_attachment(name, &mime, data, config).await.map_err(err)?;
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
        let done = |message: String| Ok(CommandOutput { message, open: None });

        match name {
            "join" | "goto" => {
                let target = RoomOrAliasId::parse(args.trim()).map_err(|_| AdapterError::Other("Use a room address like #room:server.org".into()))?;
                let room = self.client.join_room_by_id_or_alias(&target, &[]).await.map_err(err)?;
                Ok(CommandOutput { message: format!("Joined {}", args.trim()), open: Some(key(room.room_id())) })
            }
            "part" | "leave" => {
                self.room(conversation)?.leave().await.map_err(err)?;
                done("You left the room".into())
            }
            "invite" => {
                let user = user_arg()?;
                self.room(conversation)?.invite_user_by_id(&user).await.map_err(err)?;
                done(format!("Invited {user}"))
            }
            "topic" => {
                let room = self.room(conversation)?;
                if args.trim().is_empty() {
                    return done(room.topic().map(|t| format!("Topic: {t}")).unwrap_or_else(|| "This room has no topic".into()));
                }
                room.set_room_topic(args.trim()).await.map_err(err)?;
                done("Topic updated".into())
            }
            "roomname" => {
                self.room(conversation)?.set_name(args.trim().to_owned()).await.map_err(err)?;
                done("Room name updated".into())
            }
            "nick" => {
                self.client.account().set_display_name(Some(args.trim())).await.map_err(err)?;
                done(format!("Your display name is now {}", args.trim()))
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
                Ok(CommandOutput { message: format!("Chat with {user}"), open: Some(key(room.room_id())) })
            }
            "whois" => {
                let user = user_arg()?;
                let room = self.room(conversation)?;
                let (display, _) = member_profile(&room, &user).await;
                let level = room.get_user_power_level(&user).await.map(|l| format!(", power level {l:?}")).unwrap_or_default();
                done(format!("{display} ({user}){level}"))
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

    async fn leave(&self, conversation: &ConversationId) -> Result<()> {
        self.room(conversation)?.leave().await.map_err(err)
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
            return Ok(CommandOutput { message: String::new(), open: Some(key(&room)) });
        }

        let mut request = Request::new();
        request.invite = ids;
        request.name = name.map(ToOwned::to_owned);
        request.preset = Some(RoomPreset::PrivateChat);
        // New group chats are end-to-end encrypted, like Element's default.
        request.initial_state = vec![InitialStateEvent::with_empty_state_key(RoomEncryptionEventContent::with_recommended_defaults()).to_raw_any()];
        let room = self.client.create_room(request).await.map_err(err)?;
        Ok(CommandOutput { message: String::new(), open: Some(key(&room)) })
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

        let space_id = OwnedRoomId::try_from(space).map_err(err)?;
        let mut request = Request::new(space_id.clone());
        request.max_depth = Some(1u32.into());
        request.limit = Some(100u32.into());
        let response = self.client.send(request).await.map_err(err)?;
        Ok(response
            .rooms
            .into_iter()
            .filter(|r| r.summary.room_id != space_id) // the space itself comes first
            .map(|r| {
                let s = r.summary;
                let is_space = s.room_type == Some(RoomType::Space);
                self.directory_room(s.room_id, s.canonical_alias.map(|a| a.to_string()), s.name, s.topic, s.num_joined_members.into(), s.avatar_url.map(|u| u.to_string()), is_space)
            })
            .collect())
    }

    async fn join_room(&self, address: &str, via: Option<&str>) -> Result<CommandOutput> {
        use matrix_sdk::ruma::{OwnedServerName, RoomOrAliasId};

        let target = RoomOrAliasId::parse(address.trim()).map_err(|_| AdapterError::Other("Use a room address like #room:server.org".into()))?;
        let via: Vec<OwnedServerName> = via.and_then(|s| OwnedServerName::try_from(s).ok()).into_iter().collect();
        let room = self.client.join_room_by_id_or_alias(&target, &via).await.map_err(err)?;
        let key = ConversationId { account: self.account().id, remote: room.room_id().to_string() }.key();
        Ok(CommandOutput { message: format!("Joined {}", room.cached_display_name().map(|n| n.to_string()).unwrap_or_else(|| address.to_owned())), open: Some(key) })
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
            })
            .collect();
        // Admins first, then moderators, then alphabetical.
        members.sort_by_key(|m| (m.role.as_deref().map(|r| if r == "admin" { 0 } else { 1 }).unwrap_or(2), m.name.to_lowercase()));
        Ok(RoomDetails {
            name: room.cached_display_name().map(|n| n.to_string()).or_else(|| room.name()).unwrap_or_else(|| room.room_id().to_string()),
            topic: room.topic(),
            avatar: room.avatar_url().map(|u| u.to_string()),
            alias: room.canonical_alias().map(|a| a.to_string()),
            encrypted: room.encryption_state().is_encrypted(),
            is_direct: room.is_direct().await.unwrap_or(false),
            notifications: notifications.to_owned(),
            can_edit: can(StateEventType::RoomName),
            can_invite: power.as_ref().is_some_and(|p| p.user_can_invite(&me)),
            members,
        })
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
        self.register_handlers(tx.clone());

        let client = self.client.clone();
        let account = self.account().id;
        let index = self.index.clone();
        tokio::spawn(initial_load(client.clone(), tx.clone(), account.clone(), index.clone()));
        *self.retry_task.lock().unwrap() = Some(tokio::spawn(retry_decryption(client.clone(), tx.clone(), account.clone(), index.clone())));
        let task = tokio::spawn(async move {
            // Sliding sync (what Element X uses) starts fast on big accounts; fall back
            // to classic /sync when the server doesn't offer it or it fails to start.
            let classic_forced = std::env::var_os("MS_TRIX_CLASSIC_SYNC").is_some();
            if !classic_forced && !matches!(client.sliding_sync_version(), matrix_sdk::sliding_sync::Version::None) {
                match sliding_sync(client.clone(), tx.clone(), account.clone(), index.clone()).await {
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

    async fn send(&self, conversation: &ConversationId, message: Outgoing) -> Result<MessageId> {
        use matrix_sdk::ruma::events::relation::{InReplyTo, Reply};

        let room = self.room(conversation)?;
        let mut content = if message.emote {
            RoomMessageEventContent::emote_markdown(message.text)
        } else {
            RoomMessageEventContent::text_markdown(message.text)
        };
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
        let sent = room.send(content).await.map_err(err)?;
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
        let mut request = create_receipt::v3::Request::new(room_id, create_receipt::v3::ReceiptType::Read, event_id);
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

async fn build_client(store: &Path, homeserver: &str, passphrase: &str) -> Result<Client> {
    Client::builder()
        .server_name_or_homeserver_url(homeserver)
        .sqlite_store(store, Some(passphrase))
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
    if room.is_space() {
        return None;
    }
    let mut team_id = None;
    let kind = if room.is_direct().await.unwrap_or(false) {
        ConversationKind::Direct
    } else {
        match room.parent_spaces().await {
            Ok(mut parents) => match parents.next().await {
                Some(Ok(parent)) => {
                    team_id = space_id(&parent);
                    ConversationKind::Channel { team: space_name(parent) }
                }
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
        muted: notify == Some(RoomNotificationMode::Mute),
        mentions_only: notify == Some(RoomNotificationMode::MentionsAndKeywordsOnly),
        invited_by,
        team_id,
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
        body: MessageBody::File { name: ev.content.body.clone(), media: uri.to_string(), kind: FileKind::Sticker, mime: ev.content.info.mimetype.clone(), size: None },
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

/// A "waiting for the key" placeholder; the raw event is kept for retrying.
async fn encrypted_placeholder(
    room: &Room,
    raw: matrix_sdk::ruma::serde::Raw<OriginalSyncRoomEncryptedEvent>,
    me: &OwnedUserId,
    account: &AccountId,
    index: &Mutex<Index>,
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
        index.pending.entry(ev.event_id.clone()).or_insert(PendingDecryption { room: room.room_id().to_owned(), raw, session, tried_backup: false });
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
        body: MessageBody::Encrypted,
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
            match room.decrypt_event(&raw, None).await {
                Ok(decrypted) => {
                    index.lock().unwrap().pending.remove(&event_id);
                    if let Some(event) = convert(&room, &decrypted, &me, &account, &index).await {
                        let _ = tx.send(event);
                    }
                }
                Err(_) if !tried_backup => {
                    if let Some(p) = index.lock().unwrap().pending.get_mut(&event_id) {
                        p.tried_backup = true;
                    }
                    if let Some(session) = session {
                        if client.encryption().backups().are_enabled().await {
                            let _ = client.encryption().backups().download_room_key(&room_id, &session).await;
                        }
                    }
                }
                Err(_) => {}
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
        AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomEncrypted(SyncMessageLikeEvent::Original(_))) => {
            encrypted_placeholder(room, event.raw().clone().cast_unchecked(), me, account, index).await
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
async fn sliding_sync(client: Client, tx: mpsc::UnboundedSender<AdapterEvent>, account: AccountId, index: Arc<Mutex<Index>>) -> matrix_sdk::Result<()> {
    use matrix_sdk::ruma::events::StateEventType as S;
    use matrix_sdk::sliding_sync::{SlidingSyncList, SlidingSyncMode};

    // State our room list needs: names, pictures, DM/space info, teams, members for names.
    let required_state = [
        (S::RoomCreate, ""), (S::RoomName, ""), (S::RoomAvatar, ""), (S::RoomTopic, ""), (S::RoomCanonicalAlias, ""),
        (S::RoomEncryption, ""), (S::RoomTombstone, ""), (S::RoomPowerLevels, ""), (S::RoomJoinRules, ""),
        (S::RoomMember, "$LAZY"), (S::RoomMember, "$ME"), (S::SpaceChild, "*"), (S::SpaceParent, "*"),
    ]
    .into_iter()
    .map(|(k, v)| (k, v.to_owned()))
    .collect();
    let list = SlidingSyncList::builder("all").sync_mode(SlidingSyncMode::new_growing(100)).timeline_limit(10).required_state(required_state);
    let sync = client
        .sliding_sync("ms_trix")?
        .add_list(list)
        .with_all_extensions()
        .poll_timeout(Duration::from_secs(30))
        .network_timeout(Duration::from_secs(60))
        .build()
        .await?;

    tokio::spawn(poll_presence(client.clone(), tx.clone()));
    let mut started = false;
    let mut lost = false;
    loop {
        let stream = sync.sync();
        futures::pin_mut!(stream);
        while let Some(update) = stream.next().await {
            match update {
                Ok(summary) => {
                    started = true;
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
    Some(Team {
        id: ConversationId { account: account.clone(), remote: room.room_id().to_string() },
        name: room.cached_display_name().map(|n| n.to_string()).or_else(|| room.name()).unwrap_or_else(|| room.room_id().to_string()),
        topic: room.topic(),
        avatar_url: room.avatar_url().map(|u| u.to_string()),
        children,
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
    let mut file = |kind: FileKind, name: &str, source: &MediaSource, mime: Option<String>, size: Option<u64>| MessageBody::File {
        name: name.to_owned(),
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
            file(FileKind::File, &f.body, &f.source, info.and_then(|i| i.mimetype.clone()), info.and_then(|i| i.size.map(u64::from)))
        }
        MessageType::Image(f) => {
            let info = f.info.as_deref();
            file(FileKind::Image, &f.body, &f.source, info.and_then(|i| i.mimetype.clone()), info.and_then(|i| i.size.map(u64::from)))
        }
        MessageType::Video(f) => {
            let info = f.info.as_deref();
            file(FileKind::Video, &f.body, &f.source, info.and_then(|i| i.mimetype.clone()), info.and_then(|i| i.size.map(u64::from)))
        }
        MessageType::Audio(f) => {
            let info = f.info.as_deref();
            file(FileKind::Audio, &f.body, &f.source, info.and_then(|i| i.mimetype.clone()), info.and_then(|i| i.size.map(u64::from)))
        }
        other => MessageBody::Text { plain: other.body().to_owned(), html: None },
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
