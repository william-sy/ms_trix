//! Nextcloud Talk adapter, on Talk's OCS REST API.
//!
//! * Login: Nextcloud Login Flow v2 (browser sign-in, SSO and 2FA included)
//!   gives an app password; it is revoked on sign-out.
//! * Conversations: `GET /room` (v4); 1:1 chats map to Direct, the rest to Group.
//! * Messages: `GET /chat/{token}` (v1). Talk message ids only grow, so the id
//!   doubles as the timeline position and read markers map directly.
//! * Updates: the conversation list is polled every few seconds and new
//!   messages are fetched for conversations that changed. Push via Talk's
//!   signaling server (also needed for typing and calls) comes later.
//! * Reactions, edits and deletions arrive as system messages carrying the
//!   updated parent message; reactions are counts, not per person.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use futures::stream::{BoxStream, StreamExt};
use rand::distr::{Alphanumeric, SampleString};
use reqwest::{Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use trix_core::adapter::{AdapterError, AdapterFactory, CrawlPage, History, Result};
use trix_core::*;

mod dav;

pub const PROTOCOL: &str = "talk";
/// Nextcloud Notes' REST API.
const NOTES: &str = "/index.php/apps/notes/api/v1/notes";

/// Talk messages are Markdown, as Talk's own apps show them: as HTML when there's any formatting
/// (a table, bold, a list, code), else None and the text stays plain. Line breaks stay line breaks,
/// and HTML typed into a message stays text, as in Talk.
fn markdown_html(text: &str) -> Option<String> {
    use pulldown_cmark::{Event, Options, Parser, Tag};
    let options = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    let formatted = Parser::new_ext(text, options).any(|e| match e {
        Event::Start(tag) => !matches!(tag, Tag::Paragraph),
        Event::Code(_) | Event::TaskListMarker(_) => true,
        _ => false,
    });
    if !formatted {
        return None;
    }
    let events = Parser::new_ext(text, options).map(|e| match e {
        Event::SoftBreak => Event::HardBreak,
        Event::Html(raw) | Event::InlineHtml(raw) => Event::Text(raw),
        other => other,
    });
    let mut html = String::new();
    pulldown_cmark::html::push_html(&mut html, events);
    Some(html)
}

fn note_from(v: &Value) -> Option<Note> {
    Some(Note {
        id: v["id"].as_u64()?,
        title: v["title"].as_str().unwrap_or_default().to_owned(),
        category: v["category"].as_str().unwrap_or_default().to_owned(),
        modified: v["modified"].as_u64().unwrap_or(0),
        favorite: v["favorite"].as_bool().unwrap_or(false),
        readonly: v["readonly"].as_bool().unwrap_or(false),
        etag: v["etag"].as_str().unwrap_or_default().to_owned(),
        content: v["content"].as_str().map(ToOwned::to_owned),
    })
}

const CHAT: &str = "/ocs/v2.php/apps/spreed/api/v1/chat";
const ROOM: &str = "/ocs/v2.php/apps/spreed/api/v4/room";
const REACTION: &str = "/ocs/v2.php/apps/spreed/api/v1/reaction";
const POLL: &str = "/ocs/v2.php/apps/spreed/api/v1/poll";
const POLL_EVERY: Duration = Duration::from_secs(5);
/// The quick rounds only list changed conversations; a full list (this often) also shows the ones
/// deleted or left elsewhere, so they disappear here within half a minute. (Talk's docs ask for at
/// least one every 5 minutes; one list request per 30 s is still light.)
const FULL_REFRESH: Duration = Duration::from_secs(30);
const BACKFILL: u32 = 30;

/// Stored in the OS keychain by the host.
#[derive(Clone, Serialize, Deserialize)]
struct Session {
    server: String,
    login: String,
    app_password: String,
}

/// A request that didn't get through (no network, server unreachable).
fn net(e: reqwest::Error) -> AdapterError {
    AdapterError::Network(e.to_string())
}

fn err(e: impl std::fmt::Display) -> AdapterError {
    AdapterError::Other(e.to_string())
}

/// Centre-cropped square PNG of at most 512 px; None if the image can't be read.
fn square_png(data: &[u8]) -> Option<Vec<u8>> {
    let img = image::load_from_memory(data).ok()?;
    let side = img.width().min(img.height());
    let img = img.crop_imm((img.width() - side) / 2, (img.height() - side) / 2, side, side);
    let img = if side > 512 { img.resize_exact(512, 512, image::imageops::FilterType::Lanczos3) } else { img };
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).ok()?;
    Some(out.into_inner())
}

fn now() -> Timestamp {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The current UTC time in iCalendar form.
fn stamp_now() -> String {
    let secs = now() / 1000;
    let (days, rest) = (secs / 86400, secs % 86400);
    let (y, m, d) = dav::civil(days as i64);
    format!("{y:04}{m:02}{d:02}T{:02}{:02}{:02}Z", rest / 3600, rest % 3600 / 60, rest % 60)
}

fn normalize(server: &str) -> String {
    let s = server.trim().trim_end_matches('/');
    if s.starts_with("http://") || s.starts_with("https://") { s.to_owned() } else { format!("https://{s}") }
}

fn host(server: &str) -> String {
    server.split("://").nth(1).unwrap_or(server).split('/').next().unwrap_or(server).to_owned()
}

#[derive(Default)]
struct State {
    /// Newest message id we've delivered per conversation.
    last_known: HashMap<String, i64>,
    /// Paging token for older messages per conversation (oldest id we have).
    oldest: HashMap<String, Option<i64>>,
    last_read: HashMap<String, i64>,
    /// Conversations announced this session.
    known: HashSet<String>,
    /// The conversation on screen; watched with a long poll for instant messages.
    focused: Option<String>,
}

pub struct TalkAdapter {
    account: Mutex<Account>,
    session: Session,
    http: reqwest::Client,
    state: Arc<Mutex<State>>,
    task: Mutex<Option<JoinHandle<()>>>,
    /// Long poll on the open conversation (see `set_focus`).
    watch_task: Mutex<Option<JoinHandle<()>>>,
    /// The Nextcloud user id for WebDAV paths (can differ from the login name, e.g. with SSO),
    /// and the user as a meeting organizer (when they have an email address).
    dav_user: Mutex<Option<(String, Option<Attendee>)>>,
    /// Ends the wait between polls early (the computer woke up).
    wake: Arc<tokio::sync::Notify>,
    /// Talk's features on this server (capabilities), once asked.
    features: Mutex<Option<Vec<String>>>,
    /// How this Nextcloud translates, once asked.
    translator: Mutex<Option<Translator>>,
}

/// How a Nextcloud translates text.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Translator {
    /// Its translation API (Nextcloud 26+), answers at once.
    Direct,
    /// A Task Processing task (Nextcloud 30+; also language models): asked, then waited for.
    Task,
    None,
}

const TRANSLATE_TASK: &str = "core:text2text:translate";

/// Sign in through the browser (Login Flow v2). `open_url` opens the sign-in page.
pub async fn login(server: &str, open_url: Box<dyn FnOnce(String) -> Result<()> + Send>) -> Result<(Arc<TalkAdapter>, Vec<u8>)> {
    let base = normalize(server);
    let http = client();
    let start: Value = http
        .post(format!("{base}/index.php/login/v2"))
        .send()
        .await
        .map_err(|e| AdapterError::Network(format!("Couldn't reach a Nextcloud server at \"{base}\": {e}")))?
        .error_for_status()
        .map_err(|e| AdapterError::Network(format!("\"{base}\" doesn't look like a Nextcloud server: {e}")))?
        .json()
        .await
        .map_err(err)?;
    let (Some(login_url), Some(endpoint), Some(token)) = (start["login"].as_str(), start["poll"]["endpoint"].as_str(), start["poll"]["token"].as_str()) else {
        return Err(AdapterError::Other("Unexpected login response from Nextcloud".into()));
    };
    open_url(login_url.to_owned())?;

    // The poll token lives 20 minutes; the server answers 404 until the user is done.
    let deadline = std::time::Instant::now() + Duration::from_secs(20 * 60);
    let creds: Value = loop {
        if std::time::Instant::now() > deadline {
            return Err(AdapterError::Auth("Sign-in timed out".into()));
        }
        let response = http.post(endpoint).form(&[("token", token)]).send().await.map_err(net)?;
        if response.status() == StatusCode::OK {
            break response.json().await.map_err(err)?;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    };
    let session = Session {
        server: creds["server"].as_str().map(normalize).unwrap_or(base),
        login: creds["loginName"].as_str().unwrap_or_default().to_owned(),
        app_password: creds["appPassword"].as_str().unwrap_or_default().to_owned(),
    };
    let account_id = AccountId(Alphanumeric.sample_string(&mut rand::rng(), 12));
    let adapter = TalkAdapter::new(placeholder_account(account_id, &session), session.clone());
    let account = adapter.refresh_profile().await?;
    *adapter.account.lock().unwrap() = account;
    Ok((Arc::new(adapter), serde_json::to_vec(&session).map_err(err)?))
}

/// Nextcloud names the app password after the User-Agent ("ms_trix (Desktop)").
/// Keeps cookies: Talk ties joining a conversation and then its call to the same
/// (cookie-based) session, like its own apps do.
fn client() -> reqwest::Client {
    reqwest::Client::builder().user_agent(concat!("ms_trix (Desktop) ", env!("CARGO_PKG_VERSION"))).cookie_store(true).build().unwrap_or_default()
}

fn placeholder_account(id: AccountId, session: &Session) -> Account {
    Account {
        id,
        protocol: ProtocolId(PROTOCOL.into()),
        org_name: host(&session.server),
        user_id: session.login.clone(),
        display_name: session.login.clone(),
        avatar_url: Some(format!("user:{}", session.login)),
    }
}

impl TalkAdapter {
    fn new(account: Account, session: Session) -> Self {
        Self { account: Mutex::new(account), session, http: client(), state: Default::default(), task: Mutex::new(None), watch_task: Mutex::new(None), dav_user: Mutex::new(None), wake: Default::default(), features: Mutex::new(None), translator: Mutex::new(None) }
    }

    pub fn restore(account: Account, blob: &[u8]) -> Result<Arc<Self>> {
        let session: Session = serde_json::from_slice(blob).map_err(err)?;
        Ok(Arc::new(Self::new(account, session)))
    }

    /// Whether this server's Talk has `name` (its capabilities, asked once).
    async fn has_feature(&self, name: &str) -> bool {
        if let Some(features) = self.features.lock().unwrap().as_ref() {
            return features.iter().any(|f| f == name);
        }
        let Ok(Some((data, _))) = self.ocs(self.request(Method::GET, "/ocs/v2.php/cloud/capabilities")).await else { return false };
        let features: Vec<String> = data["capabilities"]["spreed"]["features"].as_array().into_iter().flatten().filter_map(|f| f.as_str().map(ToOwned::to_owned)).collect();
        let found = features.iter().any(|f| f == name);
        *self.features.lock().unwrap() = Some(features);
        found
    }

    async fn translator(&self) -> Result<Translator> {
        if let Some(found) = *self.translator.lock().unwrap() {
            return Ok(found);
        }
        // Not remembered when the server couldn't be asked (offline): asked again next time.
        let direct = match self.ocs(self.request(Method::GET, "/ocs/v2.php/translation/languages")).await {
            Err(e @ (AdapterError::Network(_) | AdapterError::Auth(_))) => return Err(e),
            other => other.ok().flatten(),
        };
        let found = if direct.is_some_and(|(d, _)| d["languages"].as_array().is_some_and(|l| !l.is_empty())) {
            Translator::Direct
        } else {
            let types = self.ocs(self.request(Method::GET, "/ocs/v2.php/taskprocessing/tasktypes")).await.ok().flatten();
            if types.is_some_and(|(d, _)| d["types"].get(TRANSLATE_TASK).is_some()) { Translator::Task } else { Translator::None }
        };
        *self.translator.lock().unwrap() = Some(found);
        Ok(found)
    }

    /// Through Task Processing: the task is started, then asked after until it's done.
    async fn translate_task(&self, text: &str, to: &str) -> Result<Translation> {
        let body = serde_json::json!({
            "type": TRANSLATE_TASK,
            "appId": "spreed",
            "input": { "input": text, "origin_language": "detect_language", "target_language": to },
        });
        let (data, _) = self.ocs(self.request(Method::POST, "/ocs/v2.php/taskprocessing/schedule").json(&body)).await?.ok_or_else(|| err("no answer"))?;
        let id = data["task"]["id"].as_u64().ok_or_else(|| err("the server started no translation"))?;
        // Language models can take a while.
        for _ in 0..120 {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let Some((data, _)) = self.ocs(self.request(Method::GET, &format!("/ocs/v2.php/taskprocessing/task/{id}"))).await? else { continue };
            match data["task"]["status"].as_str() {
                Some("STATUS_SUCCESSFUL") => return Ok(Translation { text: data["task"]["output"]["output"].as_str().unwrap_or_default().to_owned(), from: None }),
                Some("STATUS_FAILED" | "STATUS_CANCELLED") => return Err(err(data["task"]["errorMessage"].as_str().unwrap_or("the translation failed"))),
                _ => {}
            }
        }
        Err(err("the translation took too long"))
    }

    /// Uploads to our "Talk" folder, then shares it into the conversation (with its caption, and
    /// the message it replies to).
    async fn upload_and_share(&self, conversation: &ConversationId, name: &str, mime: Option<&str>, data: Vec<u8>, caption: Option<&str>, reply_to: Option<&MessageId>) -> Result<()> {
        // Our files root has our user id, not necessarily the login name.
        let folder = format!("{}/Talk", self.files_root().await);
        let _ = self.request(Method::from_bytes(b"MKCOL").unwrap(), &folder).send().await;
        let unique = format!("{}-{name}", now());
        let encoded = percent_encoding::utf8_percent_encode(&unique, percent_encoding::NON_ALPHANUMERIC).to_string();
        let mut put = self.request(Method::PUT, &format!("{folder}/{encoded}")).body(data);
        if let Some(mime) = mime {
            put = put.header("Content-Type", mime);
        }
        let status = put.send().await.map_err(net)?.status();
        if !status.is_success() {
            return Err(err(format!("upload failed: {status}")));
        }
        let mut meta = serde_json::json!({ "caption": caption.unwrap_or_default() });
        if let Some(parent) = reply_to {
            meta["replyTo"] = parent.0.parse::<u64>().map(Into::into).unwrap_or_else(|_| parent.0.clone().into());
        }
        let meta = meta.to_string();
        let share = self.request(Method::POST, "/ocs/v2.php/apps/files_sharing/api/v1/shares").form(&[
            ("shareType", "10"),
            ("shareWith", Self::token(conversation)),
            ("path", &format!("/Talk/{unique}")),
            ("talkMetaData", &meta),
        ]);
        self.ocs(share).await?;
        Ok(())
    }

    fn request(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, format!("{}{path}", self.session.server))
            .basic_auth(&self.session.login, Some(&self.session.app_password))
            .header("OCS-APIRequest", "true")
            .header("Accept", "application/json")
    }

    /// Sends an OCS request and returns `ocs.data` plus the headers (None on 304).
    async fn ocs(&self, builder: reqwest::RequestBuilder) -> Result<Option<(Value, reqwest::header::HeaderMap)>> {
        let response = builder.send().await.map_err(net)?;
        let status = response.status();
        if status == StatusCode::NOT_MODIFIED {
            return Ok(None);
        }
        let headers = response.headers().clone();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        if status == StatusCode::UNAUTHORIZED {
            return Err(AdapterError::Auth("Nextcloud rejected the app password; sign in again".into()));
        }
        if !status.is_success() {
            let message = body["ocs"]["meta"]["message"].as_str().filter(|m| !m.is_empty()).map(ToOwned::to_owned).unwrap_or_else(|| status.to_string());
            return Err(AdapterError::Other(message));
        }
        Ok(Some((body["ocs"]["data"].clone(), headers)))
    }

    fn me(&self) -> String {
        self.session.login.clone()
    }

    /// A WebDAV request (PROPFIND, REPORT) with an XML body; returns the reply text.
    async fn dav(&self, method: &str, path: &str, depth: &str, body: String) -> Result<String> {
        let response = self
            .request(Method::from_bytes(method.as_bytes()).map_err(err)?, path)
            .header("Depth", depth)
            .header("Content-Type", "application/xml; charset=utf-8")
            .header("Accept", "application/xml")
            .body(body)
            .send()
            .await
            .map_err(net)?;
        match response.status() {
            StatusCode::UNAUTHORIZED => Err(AdapterError::Auth("Nextcloud rejected the app password; sign in again".into())),
            StatusCode::NOT_FOUND => Err(err("not found")),
            s if !s.is_success() => Err(err(s)),
            _ => response.text().await.map_err(err),
        }
    }

    async fn whoami(&self) -> (String, Option<Attendee>) {
        if let Some(me) = self.dav_user.lock().unwrap().clone() {
            return me;
        }
        let me = self.ocs(self.request(Method::GET, "/ocs/v2.php/cloud/user")).await.ok().flatten().map(|(d, _)| d).unwrap_or(Value::Null);
        let id = me["id"].as_str().filter(|id| !id.is_empty()).map(ToOwned::to_owned).unwrap_or_else(|| self.session.login.clone());
        let organizer = me["email"].as_str().filter(|e| e.contains('@')).map(|email| Attendee {
            name: me["displayname"].as_str().or(me["display-name"].as_str()).map(ToOwned::to_owned),
            email: email.to_owned(),
            status: None,
            user: None,
        });
        *self.dav_user.lock().unwrap() = Some((id.clone(), organizer.clone()));
        (id, organizer)
    }

    async fn dav_user(&self) -> String {
        self.whoami().await.0
    }

    /// A calendar object's address (from [`CalendarEvent::href`]), checked to be in one of this user's calendars.
    async fn object_href(&self, href: &str) -> Result<String> {
        let (calendar, name) = href.rsplit_once('/').ok_or_else(|| err("unknown event"))?;
        if !name.ends_with(".ics") || name.contains("..") || name.contains(['?', '#']) {
            return Err(err("unknown event"));
        }
        Ok(format!("{}{name}", self.calendar_href(calendar).await?))
    }

    async fn put_event(&self, href: &str, ics: String, etag: Option<&str>) -> Result<()> {
        let mut put = self.request(Method::PUT, href).header("Content-Type", "text/calendar; charset=utf-8");
        put = match etag {
            Some(etag) => put.header("If-Match", etag),
            None => put.header("If-None-Match", "*"),
        };
        let status = put.body(ics).send().await.map_err(net)?.status();
        match status {
            StatusCode::PRECONDITION_FAILED => Err(err("the event was changed elsewhere; reload the calendar and try again")),
            s if !s.is_success() => Err(err(format!("Nextcloud refused the event: {s}"))),
            _ => Ok(()),
        }
    }

    async fn files_root(&self) -> String {
        format!("/remote.php/dav/files/{}", percent_encoding::utf8_percent_encode(&self.dav_user().await, percent_encoding::NON_ALPHANUMERIC))
    }

    async fn calendars_root(&self) -> String {
        format!("/remote.php/dav/calendars/{}/", percent_encoding::utf8_percent_encode(&self.dav_user().await, percent_encoding::NON_ALPHANUMERIC))
    }

    /// The server-relative address of a calendar id (its href as the server sent it),
    /// checked to be one of this user's calendars.
    async fn calendar_href(&self, id: &str) -> Result<String> {
        let unknown = || err("unknown calendar");
        // From "/remote.php/" on: the server address may itself have a path.
        let path = id.find("/remote.php/dav/calendars/").map(|at| &id[at..]).ok_or_else(unknown)?.trim_end_matches('/');
        let segments: Vec<&str> = path.split('/').collect(); // "", remote.php, dav, calendars, user, calendar
        if segments.len() != 6 || segments[5].is_empty() || segments.iter().any(|s| s.contains("..") || s.contains(['?', '#'])) {
            return Err(unknown());
        }
        if dav::decode(segments[4]) != self.dav_user().await {
            return Err(unknown());
        }
        Ok(format!("{path}/"))
    }

    fn conv_id(&self, token: &str) -> ConversationId {
        ConversationId { account: self.account().id, remote: token.to_owned() }
    }

    fn conversation(&self, room: &Value) -> Option<Conversation> {
        let token = room["token"].as_str()?;
        let kind_code = room["type"].as_i64().unwrap_or(2);
        // 1 = one-to-one, 5 = former one-to-one (other person deleted).
        let direct = kind_code == 1 || kind_code == 5;
        let level = room["notificationLevel"].as_i64().unwrap_or(0);
        Some(Conversation {
            id: self.conv_id(token),
            kind: if direct { ConversationKind::Direct } else { ConversationKind::Group },
            name: room["displayName"].as_str().filter(|n| !n.is_empty()).or(room["name"].as_str()).unwrap_or(token).to_owned(),
            avatar_url: Some(format!("room:{token}:{}", room["avatarVersion"].as_str().unwrap_or("0"))),
            favourite: room["isFavorite"].as_bool().unwrap_or(false),
            archived: room["isArchived"].as_bool().unwrap_or(false),
            // Notification levels: 1 always, 2 mentions, 3 never (0 = server default).
            muted: level == 3,
            mentions_only: level == 2,
            dm_user: if kind_code == 1 { room["name"].as_str().map(ToOwned::to_owned) } else { None },
            invited_by: None,
            team_id: None,
            call_active: room["hasCall"].as_bool().unwrap_or(false),
            // Started with "Start call silently": its "call started" message is marked silent.
            call_silent: room["hasCall"].as_bool().unwrap_or(false)
                && room["lastMessage"]["systemMessage"].as_str() == Some("call_started")
                && room["lastMessage"]["silent"].as_bool().unwrap_or(false),
            encrypted: false,
            // Talk 23 and later: the conversation says which message was pinned last.
            can_pin: room.get("lastPinnedId").is_some(),
            pins: room["lastPinnedId"].as_i64().filter(|&id| id > 0).map(|id| id.to_string()),
        })
    }

    /// Turns a Talk message (and the updates it may carry) into adapter events.
    fn events_from(&self, token: &str, m: &Value) -> Vec<AdapterEvent> {
        let me = self.me();
        let conversation = self.conv_id(token);
        let Some(id) = m["id"].as_i64() else { return vec![] };
        let parent = &m["parent"];
        let system = m["systemMessage"].as_str().unwrap_or_default();
        let mut out = vec![];

        match (m["messageType"].as_str().unwrap_or("comment"), system) {
            // Updates to an earlier message ride along as system messages.
            ("system", "reaction" | "reaction_revoked" | "reaction_deleted") => {
                if let Some(target) = parent["id"].as_i64() {
                    out.push(reactions(&conversation, target, parent));
                }
                return out;
            }
            // Someone voted: no line in the chat, just fresh results for the poll card.
            ("system", "poll_voted") => {
                let poll = &m["messageParameters"]["poll"]["id"];
                if let Some(poll) = poll.as_str().map(ToOwned::to_owned).or_else(|| poll.as_i64().map(|i| i.to_string())) {
                    out.push(AdapterEvent::PollChanged { conversation, poll });
                }
                return out;
            }
            ("system", "poll_closed") => {
                let poll = &m["messageParameters"]["poll"]["id"];
                if let Some(poll) = poll.as_str().map(ToOwned::to_owned).or_else(|| poll.as_i64().map(|i| i.to_string())) {
                    out.push(AdapterEvent::PollChanged { conversation: conversation.clone(), poll });
                }
            }
            ("system", "message_edited") => {
                if let Some(target) = parent["id"].as_i64() {
                    out.push(AdapterEvent::Edited {
                        conversation,
                        target: MessageId(target.to_string()),
                        sender: actor_id(parent),
                        body: self.body(parent),
                        at: m["timestamp"].as_u64().unwrap_or(0) * 1000,
                    });
                }
                return out;
            }
            ("system", "message_deleted") => {
                if let Some(target) = parent["id"].as_i64() {
                    out.push(AdapterEvent::MessageRedacted { conversation, id: MessageId(target.to_string()) });
                }
                return out;
            }
            _ => {}
        }

        let sender = actor_id(m);
        let mentions_me = m["messageParameters"]
            .as_object()
            .is_some_and(|params| params.values().any(|p| (p["type"] == "user" && p["id"] == me.as_str()) || p["type"] == "call"));
        let body = match m["messageType"].as_str() {
            Some("comment_deleted") => MessageBody::Redacted,
            Some("system") => MessageBody::Event { kind: RoomEventKind::Other, actor: display_name(m), target: None, value: Some(render(m)) },
            _ => self.body(m),
        };
        out.push(AdapterEvent::Message(Message {
            id: MessageId(id.to_string()),
            conversation: conversation.clone(),
            pos: id as TimelinePos,
            sender_avatar: (m["actorType"] == "users").then(|| format!("user:{sender}")),
            from_me: m["actorType"] == "users" && sender == me,
            sender,
            sender_name: display_name(m),
            sent_at: m["timestamp"].as_u64().unwrap_or(0) * 1000,
            body,
            // Talk 22+ threads: a reply carries its thread's id, which is the first message's.
            thread_root: m["threadId"].as_i64().filter(|&t| t > 0 && t != id).map(|t| MessageId(t.to_string())),
            reply_to: parent["id"].as_i64().map(|p| MessageId(p.to_string())),
            mentions_me,
        }));
        if m["reactions"].as_object().is_some_and(|r| !r.is_empty()) {
            out.push(reactions(&conversation, id, m));
        }
        out
    }

    fn body(&self, m: &Value) -> MessageBody {
        // A poll: the message carries only its id and question; results come from the poll API.
        let object = &m["messageParameters"]["object"];
        if object["type"] == "talk-poll" {
            if let Some(id) = object["id"].as_str().map(ToOwned::to_owned).or_else(|| object["id"].as_i64().map(|i| i.to_string())) {
                return MessageBody::Poll { id, question: object["name"].as_str().unwrap_or_default().to_owned() };
            }
        }
        // A shared file; any other text in the message is its caption.
        let f = &m["messageParameters"]["file"];
        if f.is_object() {
            let caption = m["message"]
                .as_str()
                .filter(|text| *text != "{file}")
                .map(|text| render(&serde_json::json!({ "message": text.replace("{file}", ""), "messageParameters": m["messageParameters"] })).trim().to_owned())
                .filter(|c| !c.is_empty());
            let mime = f["mimetype"].as_str().map(ToOwned::to_owned);
            let kind = match mime.as_deref().unwrap_or_default().split('/').next() {
                Some("image") => FileKind::Image,
                Some("video") => FileKind::Video,
                Some("audio") => FileKind::Audio,
                _ => FileKind::File,
            };
            return MessageBody::File {
                name: f["name"].as_str().unwrap_or("file").to_owned(),
                media: format!("file:{}:{}", f["id"].as_str().map(ToOwned::to_owned).unwrap_or_else(|| f["id"].to_string()), f["path"].as_str().unwrap_or_default()),
                kind,
                mime,
                size: f["size"].as_u64().or_else(|| f["size"].as_str().and_then(|s| s.parse().ok())),
                caption,
                voice: None,
            };
        }
        let plain = render(m);
        let html = markdown_html(&plain);
        MessageBody::Text { plain, html }
    }

    async fn room_list(&self, modified_since: Option<i64>) -> Result<(Vec<Value>, Option<i64>)> {
        let mut req = self.request(Method::GET, ROOM).query(&[("includeStatus", "true"), ("noStatusUpdate", "1")]);
        if let Some(since) = modified_since {
            req = req.query(&[("modifiedSince", since.to_string())]);
        }
        let Some((data, headers)) = self.ocs(req).await? else { return Ok((vec![], modified_since)) };
        let next = headers.get("X-Nextcloud-Talk-Modified-Before").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok());
        Ok((data.as_array().cloned().unwrap_or_default(), next))
    }

    /// Messages before `before` (None = newest), oldest first, plus the next paging id.
    async fn history(&self, token: &str, before: Option<i64>, limit: u32) -> Result<(Vec<Value>, Option<i64>)> {
        let mut req = self.request(Method::GET, &format!("{CHAT}/{token}")).query(&[
            ("lookIntoFuture", "0".to_owned()),
            ("limit", limit.to_string()),
            ("setReadMarker", "0".to_owned()),
            ("markNotificationsAsRead", "0".to_owned()),
        ]);
        if let Some(id) = before {
            req = req.query(&[("lastKnownMessageId", id.to_string())]);
        }
        let Some((data, headers)) = self.ocs(req).await? else { return Ok((vec![], None)) };
        let mut messages = data.as_array().cloned().unwrap_or_default();
        messages.sort_by_key(|m| m["id"].as_i64().unwrap_or(0));
        let next = headers.get("X-Chat-Last-Given").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok());
        let more = messages.len() as u32 >= limit;
        Ok((messages, if more { next } else { None }))
    }

    /// Messages newer than `after`, oldest first (returns immediately).
    async fn newer(&self, token: &str, after: i64) -> Result<Vec<Value>> {
        self.newer_wait(token, after, 0).await
    }

    /// Like `newer`, but the server holds the request up to `wait` seconds until
    /// something arrives (Talk's long poll, as its web app does for the open chat).
    async fn newer_wait(&self, token: &str, after: i64, wait: u32) -> Result<Vec<Value>> {
        let req = self.request(Method::GET, &format!("{CHAT}/{token}")).timeout(Duration::from_secs(u64::from(wait) + 15)).query(&[
            ("lookIntoFuture", "1".to_owned()),
            ("timeout", wait.to_string()),
            ("limit", "200".to_owned()),
            ("lastKnownMessageId", after.to_string()),
            ("setReadMarker", "0".to_owned()),
            ("markNotificationsAsRead", "0".to_owned()),
        ]);
        let Some((data, _)) = self.ocs(req).await? else { return Ok(vec![]) };
        let mut messages = data.as_array().cloned().unwrap_or_default();
        messages.sort_by_key(|m| m["id"].as_i64().unwrap_or(0));
        Ok(messages)
    }

    /// One round: list conversations, announce new ones with history, fetch new
    /// messages where something happened, follow read markers and presence.
    async fn poll_once(&self, tx: &mpsc::UnboundedSender<AdapterEvent>, since: Option<i64>, full: bool) -> Result<Option<i64>> {
        let (rooms, next) = self.room_list(since).await?;
        let mut seen = HashSet::new();
        for room in &rooms {
            let Some(token) = room["token"].as_str() else { continue };
            seen.insert(token.to_owned());
            let Some(conv) = self.conversation(room) else { continue };
            let _ = tx.send(AdapterEvent::ConversationUpserted(conv));

            let first_time = self.state.lock().unwrap().known.insert(token.to_owned());
            if first_time {
                let (messages, oldest) = self.history(token, None, BACKFILL).await.unwrap_or_default();
                {
                    let mut state = self.state.lock().unwrap();
                    state.oldest.insert(token.to_owned(), oldest);
                    let newest = messages.last().and_then(|m| m["id"].as_i64()).unwrap_or(0);
                    state.last_known.insert(token.to_owned(), newest);
                }
                for m in &messages {
                    for ev in self.events_from(token, m) {
                        let _ = tx.send(ev);
                    }
                }
            } else {
                let last_message = room["lastMessage"]["id"].as_i64().unwrap_or(0);
                let known = self.state.lock().unwrap().last_known.get(token).copied().unwrap_or(0);
                if last_message > known {
                    let messages = self.newer(token, known).await.unwrap_or_default();
                    if let Some(newest) = messages.last().and_then(|m| m["id"].as_i64()) {
                        self.state.lock().unwrap().last_known.insert(token.to_owned(), newest);
                    }
                    for m in &messages {
                        for ev in self.events_from(token, m) {
                            let _ = tx.send(ev);
                        }
                    }
                }
            }

            // Read marker set elsewhere (web, phone) or by us.
            if let Some(read) = room["lastReadMessage"].as_i64() {
                let changed = self.state.lock().unwrap().last_read.insert(token.to_owned(), read) != Some(read);
                if changed {
                    let at = if first_time { 0 } else { now() };
                    let _ = tx.send(AdapterEvent::OwnReadReceipt { conversation: self.conv_id(token), thread_root: None, pos: read as TimelinePos, at, all_threads: true });
                }
            }

            if let (Some(user), Some(status)) = (room["name"].as_str(), room["status"].as_str()) {
                if room["type"] == 1 {
                    let presence = match status {
                        "online" => Presence::Available,
                        "away" => Presence::Away,
                        "dnd" => Presence::Busy,
                        _ => Presence::Offline,
                    };
                    let status_text = room["statusMessage"].as_str().filter(|s| !s.is_empty()).map(ToOwned::to_owned);
                    let _ = tx.send(AdapterEvent::PresenceChanged { user_id: user.to_owned(), presence, status: status_text });
                }
            }
        }
        // A full list also tells us which conversations we left or lost.
        if full {
            let gone: Vec<String> = self.state.lock().unwrap().known.iter().filter(|t| !seen.contains(*t)).cloned().collect();
            for token in gone {
                self.state.lock().unwrap().known.remove(&token);
                let _ = tx.send(AdapterEvent::ConversationRemoved(self.conv_id(&token)));
            }
        }
        Ok(next)
    }

    fn token(conversation: &ConversationId) -> &str {
        &conversation.remote
    }
}

fn actor_id(m: &Value) -> String {
    m["actorId"].as_str().unwrap_or_default().to_owned()
}

fn display_name(m: &Value) -> String {
    m["actorDisplayName"].as_str().filter(|n| !n.is_empty()).or(m["actorId"].as_str()).unwrap_or("?").to_owned()
}

/// Fills a Talk rich-object string: `{mention-user1}` -> `@Name`, `{file}` -> name.
fn render(m: &Value) -> String {
    let mut text = m["message"].as_str().unwrap_or_default().to_owned();
    if let Some(params) = m["messageParameters"].as_object() {
        for (key, p) in params {
            let name = p["name"].as_str().or(p["id"].as_str()).unwrap_or_default();
            let shown = match p["type"].as_str() {
                Some("user" | "guest" | "call" | "user-group" | "email") => format!("@{name}"),
                _ => name.to_owned(),
            };
            text = text.replace(&format!("{{{key}}}"), &shown);
        }
    }
    text
}

fn reactions(conversation: &ConversationId, target: i64, m: &Value) -> AdapterEvent {
    let mine: HashSet<&str> = m["reactionsSelf"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let reactions = m["reactions"]
        .as_object()
        .map(|r| {
            r.iter()
                .map(|(key, count)| ReactionCount { key: key.clone(), count: count.as_u64().unwrap_or(0) as usize, mine: mine.contains(key.as_str()) })
                .filter(|r| r.count > 0)
                .collect()
        })
        .unwrap_or_default();
    AdapterEvent::ReactionsReplaced { conversation: conversation.clone(), target: MessageId(target.to_string()), reactions }
}

/// Our composer writes mentions as markdown links to the user id (the Matrix
/// convention); Talk wants `@"user id"` instead.
fn talk_mentions(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('[') {
        let Some(mid) = rest[start..].find("](https://matrix.to/#/") else { break };
        let after = start + mid + "](https://matrix.to/#/".len();
        let Some(end) = rest[after..].find(')') else { break };
        out.push_str(&rest[..start]);
        out.push_str(&format!("@\"{}\"", &rest[after..after + end]));
        rest = &rest[after + end + 1..];
    }
    out.push_str(rest);
    out
}

#[async_trait]
impl ProtocolAdapter for TalkAdapter {
    fn account(&self) -> Account {
        self.account.lock().unwrap().clone()
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            e2ee: false,
            // Talk 22+, once the server's features are known.
            threads: self.features.lock().unwrap().as_ref().is_some_and(|f| f.iter().any(|x| x == "threads")),
            reactions: true,
            edits: true,
            read_receipts: true,
            synced_marked_unread: true,
            teams: false,
            presence: true,
            typing: false,
            calls: true,
        }
    }

    async fn refresh_profile(&self) -> Result<Account> {
        let me = self.ocs(self.request(Method::GET, "/ocs/v2.php/cloud/user")).await?.map(|(d, _)| d).unwrap_or(Value::Null);
        if let Some(name) = me["displayname"].as_str().or(me["display-name"].as_str()) {
            self.account.lock().unwrap().display_name = name.to_owned();
        }
        // Version the picture key by its content, so a picture changed here or
        // on the web isn't hidden behind the cached old one.
        let user = percent_encoding::utf8_percent_encode(&self.session.login, percent_encoding::NON_ALPHANUMERIC).to_string();
        let version = match self.request(Method::GET, &format!("/index.php/avatar/{user}/64")).send().await {
            Ok(r) if r.status().is_success() => r.bytes().await.ok().map(|b| {
                use std::hash::{Hash, Hasher};
                let mut h = std::collections::hash_map::DefaultHasher::new();
                b.hash(&mut h);
                format!("?{:x}", h.finish())
            }),
            _ => None,
        };
        let mut account = self.account.lock().unwrap();
        account.avatar_url = Some(format!("user:{}{}", self.session.login, version.unwrap_or_default()));
        Ok(account.clone())
    }

    fn home_server(&self) -> Option<String> {
        Some(host(&self.session.server))
    }

    /// Nextcloud has no API for the list of app passwords; its Security settings show and revoke them.
    fn security_page(&self) -> Option<String> {
        Some(format!("{}/index.php/settings/user/security", self.session.server))
    }

    async fn start(&self) -> Result<BoxStream<'static, AdapterEvent>> {
        let (tx, rx) = mpsc::unbounded_channel();
        let this = TalkAdapter::new(self.account(), self.session.clone());
        let this = Arc::new(TalkAdapter { state: self.state.clone(), wake: self.wake.clone(), ..this });
        let (this_for_watch, tx_watch) = (this.clone(), tx.clone());
        let task = tokio::spawn(async move {
            let mut since = None;
            let mut last_full = std::time::Instant::now() - FULL_REFRESH;
            let mut lost = false;
            loop {
                let full = last_full.elapsed() >= FULL_REFRESH;
                match this.poll_once(&tx, if full { None } else { since }, full).await {
                    Ok(next) => {
                        since = next.or(since);
                        if full {
                            last_full = std::time::Instant::now();
                        }
                        if std::mem::take(&mut lost) {
                            let _ = tx.send(AdapterEvent::ConnectionRestored);
                        }
                    }
                    Err(e) => {
                        lost = true;
                        let _ = tx.send(AdapterEvent::ConnectionLost { reason: e.to_string() });
                    }
                }
                if tx.is_closed() {
                    break;
                }
                tokio::select! {
                    _ = tokio::time::sleep(POLL_EVERY) => {}
                    _ = this.wake.notified() => {}
                }
            }
        });
        *self.task.lock().unwrap() = Some(task);
        // The open conversation gets new messages at once instead of on the next round.
        let watcher = {
            let this = this_for_watch.clone();
            let tx = tx_watch;
            tokio::spawn(async move {
                loop {
                    let focused = this.state.lock().unwrap().focused.clone();
                    let Some(token) = focused.filter(|t| this.state.lock().unwrap().known.contains(t)) else {
                        tokio::time::sleep(Duration::from_millis(500)).await;
                        if tx.is_closed() { break; }
                        continue;
                    };
                    let known = this.state.lock().unwrap().last_known.get(&token).copied().unwrap_or(0);
                    match this.newer_wait(&token, known, 30).await {
                        Ok(messages) => {
                            let mut state = this.state.lock().unwrap();
                            if let Some(newest) = messages.last().and_then(|m| m["id"].as_i64()) {
                                let entry = state.last_known.entry(token.clone()).or_insert(0);
                                *entry = (*entry).max(newest);
                            }
                            drop(state);
                            for m in &messages {
                                for ev in this.events_from(&token, m) {
                                    let _ = tx.send(ev);
                                }
                            }
                        }
                        // Network hiccup: the normal rounds keep going; retry calmly.
                        Err(_) => tokio::time::sleep(Duration::from_secs(5)).await,
                    }
                    if tx.is_closed() {
                        break;
                    }
                }
            })
        };
        *self.watch_task.lock().unwrap() = Some(watcher);
        Ok(ReceiverStream(rx).boxed())
    }

    async fn stop(&self) -> Result<()> {
        if let Some(task) = self.task.lock().unwrap().take() {
            task.abort();
        }
        if let Some(task) = self.watch_task.lock().unwrap().take() {
            task.abort();
        }
        Ok(())
    }

    fn set_focus(&self, conversation: Option<&ConversationId>) {
        self.state.lock().unwrap().focused = conversation.map(|c| Self::token(c).to_owned());
    }

    async fn logout(&self) -> Result<()> {
        self.ocs(self.request(Method::DELETE, "/ocs/v2.php/core/apppassword")).await?;
        Ok(())
    }

    async fn send(&self, conversation: &ConversationId, message: Outgoing) -> Result<MessageId> {
        let text = talk_mentions(&message.text);
        let text = if message.emote { format!("_{text}_") } else { text };
        let mut form = vec![("message", text)];
        // Talk 22+: in a thread, without quoting its first message. A message that doesn't start
        // a thread (or a server without threads) gets a normal reply instead.
        if let (Some(root), None, true) = (&message.thread_root, &message.reply_to, self.has_feature("threads").await) {
            let mut in_thread = form.clone();
            in_thread.push(("threadId", root.0.clone()));
            if let Ok(data) = self.ocs(self.request(Method::POST, &format!("{CHAT}/{}", Self::token(conversation))).form(&in_thread)).await {
                return Ok(MessageId(data.and_then(|(d, _)| d["id"].as_i64()).unwrap_or_default().to_string()));
            }
        }
        // A reply to a message in a thread lands in that thread.
        if let Some(parent) = message.reply_to.or(message.thread_root) {
            form.push(("replyTo", parent.0));
        }
        let data = self.ocs(self.request(Method::POST, &format!("{CHAT}/{}", Self::token(conversation))).form(&form)).await?;
        Ok(MessageId(data.and_then(|(d, _)| d["id"].as_i64()).unwrap_or_default().to_string()))
    }

    async fn send_read_receipt(&self, conversation: &ConversationId, _thread_root: Option<&MessageId>, up_to: &MessageId) -> Result<()> {
        let req = self.request(Method::POST, &format!("{CHAT}/{}/read", Self::token(conversation))).form(&[("lastReadMessage", up_to.0.as_str())]);
        self.ocs(req).await?;
        self.state.lock().unwrap().last_read.insert(Self::token(conversation).to_owned(), up_to.0.parse().unwrap_or(0));
        Ok(())
    }

    async fn set_marked_unread(&self, conversation: &ConversationId, value: bool) -> Result<()> {
        let token = Self::token(conversation);
        if value {
            // Moves the read marker back before the last message.
            self.ocs(self.request(Method::DELETE, &format!("{CHAT}/{token}/read"))).await?;
        } else {
            let last = self.state.lock().unwrap().last_known.get(token).copied().unwrap_or(0);
            self.ocs(self.request(Method::POST, &format!("{CHAT}/{token}/read")).form(&[("lastReadMessage", last.to_string())])).await?;
        }
        Ok(())
    }

    async fn set_favourite(&self, conversation: &ConversationId, value: bool) -> Result<()> {
        let method = if value { Method::POST } else { Method::DELETE };
        self.ocs(self.request(method, &format!("{ROOM}/{}/favorite", Self::token(conversation)))).await?;
        Ok(())
    }

    /// Talk 20+ archives conversations per user.
    async fn set_archived(&self, conversation: &ConversationId, value: bool) -> Result<()> {
        let method = if value { Method::POST } else { Method::DELETE };
        self.ocs(self.request(method, &format!("{ROOM}/{}/archive", Self::token(conversation)))).await?;
        Ok(())
    }

    async fn set_notification_level(&self, conversation: &ConversationId, level: &str) -> Result<()> {
        let level = match level {
            "mute" => "3",
            "mentions" => "2",
            _ => "1",
        };
        self.ocs(self.request(Method::POST, &format!("{ROOM}/{}/notify", Self::token(conversation))).form(&[("level", level)])).await?;
        Ok(())
    }

    async fn leave(&self, conversation: &ConversationId) -> Result<()> {
        self.ocs(self.request(Method::DELETE, &format!("{ROOM}/{}/participants/self", Self::token(conversation)))).await?;
        Ok(())
    }

    async fn react(&self, conversation: &ConversationId, target: &MessageId, key: &str) -> Result<()> {
        let req = self.request(Method::POST, &format!("{REACTION}/{}/{}", Self::token(conversation), target.0)).form(&[("reaction", key)]);
        self.ocs(req).await?;
        Ok(())
    }

    async fn edit(&self, conversation: &ConversationId, target: &MessageId, text: &str) -> Result<()> {
        let req = self.request(Method::PUT, &format!("{CHAT}/{}/{}", Self::token(conversation), target.0)).form(&[("message", talk_mentions(text))]);
        self.ocs(req).await?;
        Ok(())
    }

    /// Deletes a message, or removes our reaction (`reaction|<message>|<emoji>|me`).
    async fn redact(&self, conversation: &ConversationId, id: &MessageId) -> Result<()> {
        let token = Self::token(conversation);
        if let Some(rest) = id.0.strip_prefix("reaction|") {
            let mut parts = rest.splitn(3, '|');
            let (Some(message), Some(emoji)) = (parts.next(), parts.next()) else { return Err(err("bad reaction id")) };
            self.ocs(self.request(Method::DELETE, &format!("{REACTION}/{token}/{message}")).query(&[("reaction", emoji)])).await?;
            return Ok(());
        }
        self.ocs(self.request(Method::DELETE, &format!("{CHAT}/{token}/{}", id.0))).await?;
        Ok(())
    }

    async fn load_older(&self, conversation: &ConversationId, limit: u32) -> Result<History> {
        let token = Self::token(conversation);
        let before = match self.state.lock().unwrap().oldest.get(token).cloned() {
            Some(None) => return Ok(History { events: vec![], has_more: false }),
            Some(Some(id)) => Some(id),
            None => None,
        };
        let (messages, oldest) = self.history(token, before, limit).await?;
        self.state.lock().unwrap().oldest.insert(token.to_owned(), oldest);
        let events = messages.iter().flat_map(|m| self.events_from(token, m)).collect();
        Ok(History { events, has_more: oldest.is_some() })
    }

    /// Talk's call and signalling REST endpoints, for the call engine in the UI.
    async fn call_api(&self, method: &str, path: &str, form: &[(String, String)], timeout_secs: u64) -> Result<(String, String)> {
        // Calls (room and call membership, signalling) and conversation settings: the room API,
        // creating a meeting, bans, poll drafts, and clearing the chat history.
        let method = Method::from_bytes(method.as_bytes()).map_err(|_| AdapterError::Other("bad method".into()))?;
        let allowed = ["/ocs/v2.php/apps/spreed/api/v3/signaling/", "/ocs/v2.php/apps/spreed/api/v4/call/", "/ocs/v2.php/apps/spreed/api/v4/room/", "/ocs/v2.php/apps/spreed/api/v1/ban/"];
        let ok = allowed.iter().any(|p| path.starts_with(p))
            || (path == ROOM && method == Method::POST)
            || (path.starts_with(POLL) && path.ends_with("/drafts"))
            || (path.starts_with(CHAT) && method == Method::DELETE && path[CHAT.len()..].trim_matches('/').chars().all(|c| c.is_ascii_alphanumeric()));
        if !ok || path.contains("..") {
            return Err(AdapterError::Other(format!("not an allowed endpoint: {path}")));
        }
        let mut req = self.request(method.clone(), path).timeout(Duration::from_secs(timeout_secs.max(10)));
        if !form.is_empty() {
            req = if method == Method::GET { req.query(form) } else { req.form(form) };
        }
        let data = self.ocs(req).await?.map(|(d, _)| d).unwrap_or(Value::Null);
        Ok((data.to_string(), self.session.server.clone()))
    }

    async fn call_api_upload(&self, path: &str, field: &str, file_name: &str, mime: &str, data: Vec<u8>) -> Result<String> {
        // A conversation's picture, and the email participants list (CSV).
        let room = path.strip_prefix(&format!("{ROOM}/")).unwrap_or_default();
        let ok = matches!(room.split_once('/'), Some((token, "avatar" | "import-emails")) if token.chars().all(|c| c.is_ascii_alphanumeric()));
        if !ok {
            return Err(AdapterError::Other(format!("not an upload endpoint: {path}")));
        }
        let part = reqwest::multipart::Part::bytes(data).file_name(file_name.to_owned()).mime_str(mime).map_err(err)?;
        let req = self.request(Method::POST, path).multipart(reqwest::multipart::Form::new().part(field.to_owned(), part));
        Ok(self.ocs(req).await?.map(|(d, _)| d).unwrap_or(Value::Null).to_string())
    }

    async fn cloud_file_bytes(&self, path: &str) -> Result<Vec<u8>> {
        let encoded = dav::encode_path(path).ok_or_else(|| err("bad path"))?;
        let response = self.request(Method::GET, &format!("{}{encoded}", self.files_root().await)).send().await.map_err(net)?;
        if !response.status().is_success() {
            return Err(err(response.status()));
        }
        Ok(response.bytes().await.map_err(err)?.to_vec())
    }

    /// Talk polls: options are numbered; `resultMode` 1 hides results until closed.
    async fn poll(&self, conversation: &ConversationId, poll: &str) -> Result<PollView> {
        let token = Self::token(conversation);
        let data = self.ocs(self.request(Method::GET, &format!("{POLL}/{token}/{poll}"))).await?.map(|(d, _)| d).unwrap_or(Value::Null);
        let options: Vec<String> = data["options"].as_array().map(|o| o.iter().filter_map(|x| x.as_str().map(ToOwned::to_owned)).collect()).unwrap_or_default();
        let votes = &data["votes"];
        Ok(PollView {
            question: data["question"].as_str().unwrap_or_default().to_owned(),
            answers: options.iter().enumerate().map(|(i, text)| (i.to_string(), text.clone(), votes[format!("option-{i}")].as_u64().unwrap_or(0) as u32)).collect(),
            max_selections: match data["maxVotes"].as_u64() { Some(0) | None => options.len() as u32, Some(n) => n as u32 },
            disclosed: data["resultMode"].as_i64() != Some(1),
            ended: data["status"].as_i64() == Some(1),
            mine: data["votedSelf"].as_array().map(|v| v.iter().filter_map(|x| x.as_i64().map(|i| i.to_string())).collect()).unwrap_or_default(),
            voters: data["numVoters"].as_u64().unwrap_or(0) as u32,
            ours: data["actorType"] == "users" && data["actorId"].as_str() == Some(self.me().as_str()),
        })
    }

    async fn vote(&self, conversation: &ConversationId, poll: &str, answers: &[String]) -> Result<()> {
        let token = Self::token(conversation);
        let form: Vec<(&str, &str)> = answers.iter().map(|a| ("optionIds[]", a.as_str())).collect();
        self.ocs(self.request(Method::POST, &format!("{POLL}/{token}/{poll}")).form(&form)).await?;
        Ok(())
    }

    async fn end_poll(&self, conversation: &ConversationId, poll: &str) -> Result<()> {
        self.ocs(self.request(Method::DELETE, &format!("{POLL}/{}/{poll}", Self::token(conversation)))).await?;
        Ok(())
    }

    async fn create_poll(&self, conversation: &ConversationId, question: &str, answers: &[String], max_selections: u32, disclosed: bool) -> Result<()> {
        let mut form: Vec<(&str, String)> = vec![("question", question.to_owned()), ("resultMode", if disclosed { "0" } else { "1" }.to_owned()), ("maxVotes", max_selections.to_string())];
        form.extend(answers.iter().map(|a| ("options[]", a.clone())));
        self.ocs(self.request(Method::POST, &format!("{POLL}/{}", Self::token(conversation))).form(&form)).await?;
        Ok(())
    }

    /// Talk 19+ has a context endpoint around one message.
    async fn context(&self, conversation: &ConversationId, message: &MessageId, size: u32) -> Result<Vec<Message>> {
        let token = Self::token(conversation);
        let req = self.request(Method::GET, &format!("{CHAT}/{token}/{}/context", message.0)).query(&[("limit", size.to_string())]);
        let mut messages = self.ocs(req).await?.and_then(|(d, _)| d.as_array().cloned()).unwrap_or_default();
        messages.sort_by_key(|m| m["id"].as_i64().unwrap_or(0));
        Ok(messages.iter().flat_map(|m| self.events_from(token, m)).filter_map(|e| if let AdapterEvent::Message(m) = e { Some(m) } else { None }).collect())
    }

    /// Talk 22+: a thread's messages (the chat history has them too, but maybe not this far back).
    async fn load_thread(&self, conversation: &ConversationId, root: &MessageId) -> Result<History> {
        if !self.has_feature("threads").await {
            return Ok(History::default());
        }
        let token = Self::token(conversation);
        let req = self.request(Method::GET, &format!("{CHAT}/{token}")).query(&[
            ("lookIntoFuture", "0"),
            ("limit", "200"),
            ("setReadMarker", "0"),
            ("markNotificationsAsRead", "0"),
            ("threadId", root.0.as_str()),
        ]);
        let mut messages = self.ocs(req).await?.and_then(|(d, _)| d.as_array().cloned()).unwrap_or_default();
        // The first message comes with the thread's own record.
        if let Ok(Some((info, _))) = self.ocs(self.request(Method::GET, &format!("{CHAT}/{token}/threads/{}", root.0))).await {
            if info["first"].is_object() {
                messages.push(info["first"].clone());
            }
        }
        messages.sort_by_key(|m| m["id"].as_i64().unwrap_or(0));
        messages.dedup_by_key(|m| m["id"].as_i64().unwrap_or(0));
        Ok(History { events: messages.iter().flat_map(|m| self.events_from(token, m)).collect(), has_more: false })
    }

    /// Talk 22+: the threads with recent activity.
    async fn threads(&self, conversation: &ConversationId, mine: bool) -> Result<Vec<ThreadInfo>> {
        if !self.has_feature("threads").await {
            return Err(AdapterError::Unsupported("thread lists"));
        }
        let token = Self::token(conversation);
        let data = self.ocs(self.request(Method::GET, &format!("{CHAT}/{token}/threads/recent")).query(&[("limit", "50")])).await?.map(|(d, _)| d).unwrap_or(Value::Null);
        let me = self.me();
        let by_me = |m: &Value| m["actorType"] == "users" && m["actorId"].as_str() == Some(me.as_str());
        let mut out: Vec<ThreadInfo> = data
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|info| {
                let (thread, first, last) = (&info["thread"], &info["first"], &info["last"]);
                let preview = thread["title"].as_str().filter(|t| !t.is_empty()).map(ToOwned::to_owned).unwrap_or_else(|| render(first));
                Some(ThreadInfo {
                    root: thread["id"].as_i64()?.to_string(),
                    sender_name: display_name(first),
                    sender_avatar: (first["actorType"] == "users").then(|| format!("user:{}", first["actorId"].as_str().unwrap_or_default())),
                    preview: preview.chars().take(140).collect(),
                    sent_at: first["timestamp"].as_u64().unwrap_or(0) * 1000,
                    replies: thread["numReplies"].as_u64().unwrap_or(0) as u32,
                    latest_name: last.is_object().then(|| display_name(last)),
                    latest_at: thread["lastActivity"].as_u64().map(|t| t * 1000),
                    mine: by_me(first) || by_me(last),
                })
            })
            .filter(|t| !mine || t.mine)
            .collect();
        out.sort_by_key(|t| std::cmp::Reverse(t.latest_at.unwrap_or(t.sent_at)));
        Ok(out)
    }

    /// Talk 23+: pinned messages are a kind of shared item; each knows when it was pinned.
    async fn pinned(&self, conversation: &ConversationId) -> Result<Vec<Message>> {
        let token = Self::token(conversation);
        let req = self.request(Method::GET, &format!("{CHAT}/{token}/share")).query(&[("objectType", "pinned"), ("limit", "50")]);
        let data = self.ocs(req).await?.map(|(d, _)| d).unwrap_or(Value::Null);
        // Keyed by message id (a list when empty).
        let mut list: Vec<&Value> = match &data {
            Value::Object(map) => map.values().collect(),
            Value::Array(items) => items.iter().collect(),
            _ => vec![],
        };
        list.sort_by_key(|m| std::cmp::Reverse(m["metaData"]["pinnedAt"].as_i64().unwrap_or(0)));
        Ok(list.into_iter().flat_map(|m| self.events_from(token, m)).filter_map(|e| if let AdapterEvent::Message(m) = e { Some(m) } else { None }).collect())
    }

    async fn set_pinned(&self, conversation: &ConversationId, message: &MessageId, pinned: bool) -> Result<()> {
        let token = Self::token(conversation);
        let method = if pinned { Method::POST } else { Method::DELETE };
        self.ocs(self.request(method, &format!("{CHAT}/{token}/{}/pin", message.0))).await?;
        Ok(())
    }

    /// Pages back by message id; the token is the oldest id seen so far.
    async fn crawl(&self, conversation: &ConversationId, from: Option<String>, limit: u32) -> Result<Option<CrawlPage>> {
        let token = Self::token(conversation);
        let before = from.and_then(|f| f.parse::<i64>().ok());
        let (messages, oldest) = self.history(token, before, limit).await?;
        let events = messages.iter().flat_map(|m| self.events_from(token, m)).collect();
        Ok(Some(CrawlPage { events, next: oldest.map(|id| id.to_string()) }))
    }

    async fn fetch_media(&self, media: &str, thumbnail: Option<(u32, u32)>) -> Result<Vec<u8>> {
        let size = thumbnail.map(|(w, _)| w.max(64)).unwrap_or(256);
        let req = if let Some(rest) = media.strip_prefix("room:") {
            let token = rest.split(':').next().unwrap_or_default();
            self.request(Method::GET, &format!("/ocs/v2.php/apps/spreed/api/v1/room/{token}/avatar"))
        } else if let Some(user) = media.strip_prefix("user:") {
            // An optional "?version" only busts caches.
            let user = user.split('?').next().unwrap_or_default();
            let user = percent_encoding::utf8_percent_encode(user, percent_encoding::NON_ALPHANUMERIC);
            self.request(Method::GET, &format!("/index.php/avatar/{user}/{size}"))
        } else if let Some(rest) = media.strip_prefix("file:") {
            let (id, path) = rest.split_once(':').unwrap_or((rest, ""));
            let preview = |w: u32, h: u32| self.request(Method::GET, "/index.php/core/preview").query(&[("fileId", id), ("x", &w.to_string()), ("y", &h.to_string()), ("a", "1")]);
            match thumbnail {
                Some((w, h)) => preview(w, h),
                None => {
                    // Talk gives the path in our own files without a leading slash ("Talk/x.jpg");
                    // the files root has our user id (not necessarily the login name).
                    let encoded = dav::encode_path(path).ok_or_else(|| err("bad path"))?;
                    let response = self.request(Method::GET, &format!("{}{encoded}", self.files_root().await)).header("Accept", "*/*").send().await.map_err(net)?;
                    if response.status().is_success() {
                        return Ok(response.bytes().await.map_err(err)?.to_vec());
                    }
                    // A picture not in our files (yet): Nextcloud's own large preview of it. Other
                    // files must come as they are, so they fail here.
                    let picture = path.rsplit('.').next().is_some_and(|ext| matches!(ext.to_ascii_lowercase().as_str(), "jpg" | "jpeg" | "png" | "gif" | "webp" | "heic" | "heif" | "bmp"));
                    if !picture {
                        return Err(err(response.status()));
                    }
                    preview(2048, 2048)
                }
            }
        } else {
            return Err(err("unknown media"));
        };
        let response = req.header("Accept", "*/*").send().await.map_err(net)?;
        if !response.status().is_success() {
            return Err(err(response.status()));
        }
        Ok(response.bytes().await.map_err(err)?.to_vec())
    }

    async fn send_file(&self, conversation: &ConversationId, name: &str, mime: Option<&str>, data: Vec<u8>, caption: Option<&str>) -> Result<()> {
        self.upload_and_share(conversation, name, mime, data, caption, None).await
    }

    /// Talk has no threads; a reply goes along with the share (Talk ignores it where it can't).
    async fn send_file_related(&self, conversation: &ConversationId, _thread_root: Option<&MessageId>, reply_to: Option<&MessageId>, name: &str, mime: Option<&str>, data: Vec<u8>, caption: Option<&str>, _thumb: Option<VideoThumb>) -> Result<()> {
        self.upload_and_share(conversation, name, mime, data, caption, reply_to).await
    }

    async fn members(&self, conversation: &ConversationId) -> Result<Vec<Member>> {
        let data = self.ocs(self.request(Method::GET, &format!("{ROOM}/{}/participants", Self::token(conversation)))).await?;
        Ok(data
            .and_then(|(d, _)| d.as_array().cloned())
            .unwrap_or_default()
            .iter()
            .filter(|p| p["actorType"] == "users")
            .map(|p| {
                let id = p["actorId"].as_str().unwrap_or_default().to_owned();
                Member { name: p["displayName"].as_str().filter(|n| !n.is_empty()).unwrap_or(&id).to_owned(), avatar: Some(format!("user:{id}")), user_id: id }
            })
            .collect())
    }

    async fn room_details(&self, conversation: &ConversationId) -> Result<RoomDetails> {
        let token = Self::token(conversation);
        let room = self.ocs(self.request(Method::GET, &format!("{ROOM}/{token}"))).await?.map(|(d, _)| d).unwrap_or(Value::Null);
        let participants = self.ocs(self.request(Method::GET, &format!("{ROOM}/{token}/participants"))).await?.and_then(|(d, _)| d.as_array().cloned()).unwrap_or_default();
        // Participant types: 1 owner, 2 moderator, 6 guest moderator.
        let me_type = room["participantType"].as_i64().unwrap_or(3);
        let members = participants
            .iter()
            .map(|p| {
                let id = p["actorId"].as_str().unwrap_or_default().to_owned();
                RoomMemberInfo {
                    name: p["displayName"].as_str().filter(|n| !n.is_empty()).unwrap_or(&id).to_owned(),
                    avatar: (p["actorType"] == "users").then(|| format!("user:{id}")),
                    role: match p["participantType"].as_i64() {
                        Some(1) => Some("admin".into()),
                        Some(2 | 6) => Some("moderator".into()),
                        _ => None,
                    },
                    level: match p["participantType"].as_i64() {
                        Some(1) => 100,
                        Some(2 | 6) => 50,
                        _ => 0,
                    },
                    user_id: id,
                }
            })
            .collect();
        let level = room["notificationLevel"].as_i64().unwrap_or(0);
        let moderator = matches!(me_type, 1 | 2 | 6);
        Ok(RoomDetails {
            name: room["displayName"].as_str().unwrap_or(token).to_owned(),
            topic: room["description"].as_str().filter(|d| !d.is_empty()).map(ToOwned::to_owned),
            avatar: Some(format!("room:{token}:{}", room["avatarVersion"].as_str().unwrap_or("0"))),
            alias: None,
            encrypted: false,
            is_direct: room["type"] == 1,
            notifications: match level { 3 => "mute", 2 => "mentions", _ => "all" }.to_owned(),
            can_edit: moderator && room["type"] != 1,
            can_invite: moderator && room["type"] != 1,
            members,
            // Talk room types: 1 one-to-one, 2 group (invite only), 3 public (link).
            join_rule: if room["type"] == 3 { "public" } else { "invite" }.to_owned(),
            in_team: false,
            can_set_join_rule: moderator && matches!(room["type"].as_i64(), Some(2 | 3)),
            can_encrypt: false,
            can_set_alias: false,
            can_kick: false,
            can_ban: false,
            can_set_roles: false,
            my_level: match me_type { 1 => 100, 2 | 6 => 50, _ => 0 },
            banned: vec![],
            history_visibility: "shared".into(),
            can_set_history: false,
            permissions: vec![],
            server_acl: None,
            can_set_acl: false,
        })
    }

    /// Public = anyone with the link can join.
    async fn set_join_rule(&self, conversation: &ConversationId, rule: &str) -> Result<()> {
        let method = if rule == "public" { Method::POST } else { Method::DELETE };
        self.ocs(self.request(method, &format!("{ROOM}/{}/public", Self::token(conversation)))).await?;
        Ok(())
    }

    async fn set_room_name(&self, conversation: &ConversationId, name: &str) -> Result<()> {
        self.ocs(self.request(Method::PUT, &format!("{ROOM}/{}", Self::token(conversation))).form(&[("roomName", name.trim())])).await?;
        Ok(())
    }

    async fn set_display_name(&self, name: &str) -> Result<()> {
        let path = format!("/ocs/v2.php/cloud/users/{}", self.session.login);
        self.ocs(self.request(Method::PUT, &path).form(&[("key", "displayname"), ("value", name.trim())])).await?;
        self.account.lock().unwrap().display_name = name.trim().to_owned();
        Ok(())
    }

    async fn set_avatar(&self, original_mime: Option<&str>, data: Vec<u8>) -> Result<()> {
        // Nextcloud only takes square pictures straight away; anything else
        // goes through a crop step meant for its web UI. Crop the centred
        // square here (and cap the size) so the upload is final.
        let (data, mime) = tokio::task::spawn_blocking(move || square_png(&data).map(|png| (png, None)).unwrap_or((data, Some(()))))
            .await
            .map_err(err)?;
        // Undecodable here: send it as is and let Nextcloud judge.
        let mime = if mime.is_some() { original_mime.unwrap_or("image/png") } else { "image/png" };
        let part = reqwest::multipart::Part::bytes(data).file_name("avatar.png").mime_str(mime).map_err(err)?;
        // Nextcloud's avatar endpoint is a web route; the OCS-APIRequest header
        // set by request() exempts it from the browser CSRF token.
        let response = self.request(Method::POST, "/index.php/avatar/").multipart(reqwest::multipart::Form::new().part("files[]", part)).send().await.map_err(net)?;
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        if !status.is_success() || body["data"] == "notsquare" {
            let message = body["data"]["message"].as_str().map(ToOwned::to_owned).unwrap_or_else(|| status.to_string());
            return Err(AdapterError::Other(format!("Nextcloud refused the picture: {message}")));
        }
        Ok(())
    }

    async fn set_privacy(&self, share_receipts: bool, share_typing: bool) -> Result<()> {
        // Talk's own user settings (1 = private); older servers lack typing_privacy.
        let path = "/ocs/v2.php/apps/spreed/api/v1/settings/user";
        let flag = |share: bool| if share { "0" } else { "1" };
        self.ocs(self.request(Method::POST, path).form(&[("key", "read_status_privacy"), ("value", flag(share_receipts))])).await?;
        let _ = self.ocs(self.request(Method::POST, path).form(&[("key", "typing_privacy"), ("value", flag(share_typing))])).await;
        Ok(())
    }

    async fn set_room_topic(&self, conversation: &ConversationId, topic: &str) -> Result<()> {
        self.ocs(self.request(Method::PUT, &format!("{ROOM}/{}/description", Self::token(conversation))).form(&[("description", topic.trim())])).await?;
        Ok(())
    }

    async fn set_room_avatar(&self, conversation: &ConversationId, mime: Option<&str>, data: Vec<u8>) -> Result<()> {
        let mime = mime.unwrap_or("image/png");
        let name = if mime == "image/jpeg" { "picture.jpg" } else { "picture.png" };
        self.call_api_upload(&format!("{ROOM}/{}/avatar", Self::token(conversation)), "file", name, mime, data).await.map(drop)
    }

    async fn invite(&self, conversation: &ConversationId, user_id: &str) -> Result<()> {
        let req = self.request(Method::POST, &format!("{ROOM}/{}/participants", Self::token(conversation))).form(&[("newParticipant", user_id), ("source", "users")]);
        self.ocs(req).await?;
        Ok(())
    }

    async fn search_users(&self, term: &str) -> Result<Vec<Member>> {
        let req = self.request(Method::GET, "/ocs/v2.php/core/autocomplete/get").query(&[("search", term), ("itemType", "call"), ("itemId", "new"), ("shareTypes[]", "0"), ("limit", "20")]);
        let data = self.ocs(req).await?;
        Ok(data
            .and_then(|(d, _)| d.as_array().cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|u| {
                let id = u["id"].as_str()?.to_owned();
                Some(Member { name: u["label"].as_str().unwrap_or(&id).to_owned(), avatar: Some(format!("user:{id}")), user_id: id })
            })
            .collect())
    }

    async fn create_chat(&self, users: &[String], name: Option<&str>) -> Result<CommandOutput> {
        let name = name.map(str::trim).filter(|n| !n.is_empty());
        let room = if let ([user], None) = (users, name) {
            // Talk returns the existing 1:1 conversation if there is one.
            self.ocs(self.request(Method::POST, ROOM).form(&[("roomType", "1"), ("invite", user.as_str())])).await?
        } else {
            self.ocs(self.request(Method::POST, ROOM).form(&[("roomType", "2"), ("roomName", name.unwrap_or("Group chat"))])).await?
        };
        let token = room.and_then(|(d, _)| d["token"].as_str().map(ToOwned::to_owned)).ok_or_else(|| err("no conversation returned"))?;
        if users.len() > 1 || name.is_some() {
            for user in users {
                let conv = self.conv_id(&token);
                self.invite(&conv, user).await?;
            }
        }
        Ok(CommandOutput::open(self.conv_id(&token).key()))
    }

    /// Talk room types: 2 = group (invite only), 3 = public (anyone with the link).
    async fn create_room(&self, spec: &NewRoom) -> Result<CommandOutput> {
        let kind = if spec.public { "3" } else { "2" };
        let room = self.ocs(self.request(Method::POST, ROOM).form(&[("roomType", kind), ("roomName", spec.name.trim())])).await?;
        let token = room.and_then(|(d, _)| d["token"].as_str().map(ToOwned::to_owned)).ok_or_else(|| err("no conversation returned"))?;
        let conv = self.conv_id(&token);
        if let Some(topic) = spec.topic.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            self.ocs(self.request(Method::PUT, &format!("{ROOM}/{token}/description")).form(&[("description", topic)])).await?;
        }
        for user in &spec.invite {
            self.invite(&conv, user).await?;
        }
        Ok(CommandOutput::open(conv.key()))
    }

    async fn directory(&self, _server: Option<&str>, term: &str, spaces: bool) -> Result<Vec<DirectoryRoom>> {
        // Talk has no spaces; "rooms" are the open (listable) conversations.
        if spaces {
            return Ok(vec![]);
        }
        let data = self.ocs(self.request(Method::GET, "/ocs/v2.php/apps/spreed/api/v4/listed-room").query(&[("searchTerm", term.trim())])).await?;
        let known = self.state.lock().unwrap().known.clone();
        Ok(data
            .and_then(|(d, _)| d.as_array().cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|r| {
                let token = r["token"].as_str()?.to_owned();
                Some(DirectoryRoom {
                    name: r["displayName"].as_str().unwrap_or(&token).to_owned(),
                    topic: r["description"].as_str().filter(|d| !d.is_empty()).map(ToOwned::to_owned),
                    members: 0,
                    avatar: Some(format!("room:{token}:{}", r["avatarVersion"].as_str().unwrap_or("0"))),
                    is_space: false,
                    joined: known.contains(&token).then(|| self.conv_id(&token).key()),
                    join_rule: Some("public".into()),
                    alias: None,
                    id: token,
                })
            })
            .collect())
    }

    async fn join_room(&self, address: &str, _via: Option<&str>) -> Result<CommandOutput> {
        let token = address.trim();
        self.ocs(self.request(Method::POST, &format!("{ROOM}/{token}/participants/active"))).await?;
        Ok(CommandOutput::open(self.conv_id(token).key()))
    }

    async fn profile(&self, user_id: &str) -> Result<Profile> {
        let encoded = percent_encoding::utf8_percent_encode(user_id, percent_encoding::NON_ALPHANUMERIC);
        let user = self.ocs(self.request(Method::GET, &format!("/ocs/v2.php/cloud/users/{encoded}")));
        // Out of office (Nextcloud 28+): "not found" when they aren't.
        let away = self.ocs(self.request(Method::GET, &format!("/ocs/v2.php/apps/dav/api/v1/outOfOffice/{encoded}/now")));
        let (user, away) = futures::join!(user, away);
        let data = user.ok().flatten().map(|(d, _)| d).unwrap_or(Value::Null);
        let absence = away.ok().flatten().map(|(a, _)| Absence {
            until: a["endDate"].as_i64().map(|s| s * 1000),
            short_message: a["shortMessage"].as_str().unwrap_or_default().to_owned(),
            message: a["message"].as_str().unwrap_or_default().to_owned(),
            replacement: a["replacementUserDisplayName"].as_str().or(a["replacementUserId"].as_str()).filter(|r| !r.is_empty()).map(ToOwned::to_owned),
        });
        Ok(Profile {
            absence,
            name: data["displayname"].as_str().unwrap_or(user_id).to_owned(),
            avatar: Some(format!("user:{user_id}")),
            user_id: user_id.to_owned(),
            verified: None,
            shared: vec![],
            ignored: false,
        })
    }

    /// Talk's own call page; it handles video, screen sharing and the HPB.
    /// `#direct-call` makes Talk open its join dialog (camera/mic check) right
    /// away, as its "Join call" notification does; joining still needs a click.
    async fn call_link(&self, conversation: &ConversationId) -> Result<String> {
        Ok(format!("{}/call/{}#direct-call", self.session.server, Self::token(conversation)))
    }

    async fn in_call(&self, conversation: &ConversationId) -> Result<bool> {
        // The room's `participantFlags` only describes the session making the
        // request, and ours has none (the call runs in the web page's session),
        // so look for our user among the call's connected participants instead.
        let path = format!("/ocs/v2.php/apps/spreed/api/v4/call/{}", Self::token(conversation));
        let participants = self.ocs(self.request(Method::GET, &path)).await?.map(|(d, _)| d).unwrap_or(Value::Null);
        let me = self.me();
        Ok(participants.as_array().is_some_and(|list| list.iter().any(|p| p["actorType"] == "users" && p["actorId"] == me.as_str())))
    }

    async fn set_presence(&self, presence: Presence, _status_message: Option<String>) -> Result<()> {
        let status = match presence {
            Presence::Available => "online",
            Presence::Away => "away",
            Presence::Busy => "dnd",
            Presence::Offline => "invisible",
        };
        self.ocs(self.request(Method::PUT, "/ocs/v2.php/apps/user_status/api/v1/user_status/status").form(&[("statusType", status)])).await?;
        Ok(())
    }

    async fn cloud_files(&self, path: &str) -> Result<Vec<CloudFile>> {
        let encoded = dav::encode_path(path).ok_or_else(|| err("bad path"))?;
        let xml = self.dav("PROPFIND", &format!("{}{encoded}/", self.files_root().await), "1", dav::PROPFIND_FILES.into()).await?;
        let marker = "/remote.php/dav/files/";
        let mut files: Vec<CloudFile> = dav::multistatus(&xml)
            .into_iter()
            .filter_map(|r| {
                let href = dav::decode(&r.href);
                // Strip "…/remote.php/dav/files/<user>" to get the path from the storage root.
                let after = &href[href.find(marker)? + marker.len()..];
                let path = after.split_once('/').map(|(_, p)| format!("/{}", p.trim_end_matches('/'))).unwrap_or_else(|| "/".into());
                let dir = r.types.iter().any(|t| t == "collection");
                let name = path.rsplit('/').next().unwrap_or_default().to_owned();
                let size = r.props.get(if dir { "size" } else { "getcontentlength" }).and_then(|v| v.trim().parse().ok()).unwrap_or(0);
                Some(CloudFile {
                    name,
                    path,
                    dir,
                    size,
                    mime: r.props.get("getcontenttype").cloned(),
                    modified: r.props.get("getlastmodified").cloned(),
                    file_id: r.props.get("fileid").cloned(),
                })
            })
            .collect();
        // The first entry is the folder itself.
        let own = format!("/{}", path.trim_matches('/'));
        files.retain(|f| f.path != own && !f.name.is_empty());
        files.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        Ok(files)
    }

    async fn share_cloud_file(&self, conversation: &ConversationId, path: &str, caption: Option<&str>) -> Result<()> {
        dav::encode_path(path).ok_or_else(|| err("bad path"))?;
        let meta = serde_json::json!({ "caption": caption.unwrap_or_default() }).to_string();
        let share = self.request(Method::POST, "/ocs/v2.php/apps/files_sharing/api/v1/shares").form(&[
            ("shareType", "10"),
            ("shareWith", Self::token(conversation)),
            ("path", path),
            ("talkMetaData", &meta),
        ]);
        self.ocs(share).await?;
        Ok(())
    }

    async fn cloud_link(&self, path: &str) -> Result<String> {
        dav::encode_path(path).ok_or_else(|| err("bad path"))?;
        // Read-only public link (Nextcloud may refuse it if links need a password by policy).
        let share = self.request(Method::POST, "/ocs/v2.php/apps/files_sharing/api/v1/shares").form(&[("shareType", "3"), ("path", path), ("permissions", "1")]);
        let data = self.ocs(share).await?.map(|(d, _)| d).unwrap_or(Value::Null);
        data["url"].as_str().map(ToOwned::to_owned).ok_or_else(|| err("Nextcloud returned no link"))
    }

    /// Talk's conversation links: <server>/call/<token> (also with /index.php).
    fn link_target(&self, url: &str) -> Option<String> {
        let rest = url.strip_prefix(self.session.server.trim_end_matches('/'))?;
        let rest = rest.strip_prefix("/index.php").unwrap_or(rest);
        let token = rest.strip_prefix("/call/")?.split(['/', '?', '#']).next()?;
        (token.len() >= 4 && token.chars().all(|c| c.is_ascii_alphanumeric())).then(|| self.conv_id(token).key())
    }

    /// The apps in our Nextcloud navigation bar, as in its web interface. The calendar store
    /// exists without the Calendar app; this tells whether people here actually use calendars.
    async fn cloud_apps(&self) -> Result<Vec<String>> {
        let data = self.ocs(self.request(Method::GET, "/ocs/v2.php/core/navigation/apps")).await?.map(|(d, _)| d).unwrap_or(Value::Null);
        Ok(data.as_array().map(|apps| apps.iter().filter_map(|a| a["id"].as_str().map(ToOwned::to_owned)).collect()).unwrap_or_default())
    }

    fn wake(&self) {
        self.wake.notify_one();
    }

    async fn can_translate(&self) -> Result<bool> {
        Ok(self.translator().await? != Translator::None)
    }

    async fn translate(&self, text: &str, to: &str) -> Result<Translation> {
        match self.translator().await? {
            Translator::Direct => {
                // Without a source language: the server detects it.
                let request = self.request(Method::POST, "/ocs/v2.php/translation/translate").form(&[("text", text), ("toLanguage", to)]);
                let response = request.send().await.map_err(net)?;
                let status = response.status();
                let body: Value = response.json().await.unwrap_or(Value::Null);
                let data = &body["ocs"]["data"];
                if !status.is_success() {
                    // Nextcloud words these itself, in the user's language.
                    return Err(err(data["message"].as_str().filter(|m| !m.is_empty()).map(ToOwned::to_owned).unwrap_or_else(|| status.to_string())));
                }
                Ok(Translation { text: data["text"].as_str().unwrap_or_default().to_owned(), from: data["from"].as_str().map(ToOwned::to_owned) })
            }
            Translator::Task => self.translate_task(text, to).await,
            Translator::None => Err(AdapterError::Unsupported("translation")),
        }
    }

    async fn notes(&self, with_content: bool) -> Result<Vec<Note>> {
        let url = if with_content { NOTES.to_owned() } else { format!("{NOTES}?exclude=content") };
        let response = self.request(Method::GET, &url).send().await.map_err(net)?;
        // No Notes app on this server.
        if matches!(response.status(), StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED) {
            return Err(AdapterError::Unsupported("notes"));
        }
        if !response.status().is_success() {
            return Err(err(response.status()));
        }
        let list: Vec<Value> = response.json().await.map_err(err)?;
        Ok(list.iter().filter_map(note_from).collect())
    }

    async fn note(&self, id: u64) -> Result<Note> {
        let response = self.request(Method::GET, &format!("{NOTES}/{id}")).send().await.map_err(net)?;
        if !response.status().is_success() {
            return Err(err(response.status()));
        }
        note_from(&response.json::<Value>().await.map_err(err)?).ok_or_else(|| err("unreadable note"))
    }

    async fn save_note(&self, id: Option<u64>, etag: Option<&str>, change: &NoteChange) -> Result<Note> {
        // Only what changes (moving a note to another category sends just that).
        let mut body = serde_json::Map::new();
        if let Some(title) = &change.title {
            body.insert("title".into(), title.clone().into());
        }
        if let Some(content) = &change.content {
            body.insert("content".into(), content.clone().into());
        }
        if let Some(category) = &change.category {
            body.insert("category".into(), category.clone().into());
        }
        if let Some(favorite) = change.favorite {
            body.insert("favorite".into(), favorite.into());
        }
        let mut builder = match id {
            Some(id) => self.request(Method::PUT, &format!("{NOTES}/{id}")),
            None => self.request(Method::POST, NOTES),
        };
        if let (Some(_), Some(etag)) = (id, etag.filter(|e| !e.is_empty())) {
            builder = builder.header("If-Match", format!("\"{}\"", etag.trim_matches('"')));
        }
        let response = builder.json(&body).send().await.map_err(net)?;
        if response.status() == StatusCode::PRECONDITION_FAILED {
            return Err(err("changed elsewhere"));
        }
        if !response.status().is_success() {
            return Err(err(response.status()));
        }
        note_from(&response.json::<Value>().await.map_err(err)?).ok_or_else(|| err("unreadable note"))
    }

    async fn delete_note(&self, id: u64) -> Result<()> {
        let response = self.request(Method::DELETE, &format!("{NOTES}/{id}")).send().await.map_err(net)?;
        if !response.status().is_success() && response.status() != StatusCode::NOT_FOUND {
            return Err(err(response.status()));
        }
        Ok(())
    }

    async fn calendars(&self) -> Result<Vec<Calendar>> {
        let xml = self.dav("PROPFIND", &self.calendars_root().await, "1", dav::PROPFIND_CALENDARS.into()).await?;
        Ok(dav::multistatus(&xml)
            .into_iter()
            .filter(|r| r.types.iter().any(|t| t == "calendar") && (r.components.is_empty() || r.components.iter().any(|c| c == "VEVENT")))
            .map(|r| Calendar {
                name: r.props.get("displayname").cloned().unwrap_or_else(|| dav::decode(r.href.trim_end_matches('/').rsplit('/').next().unwrap_or_default())),
                // Nextcloud sends #RRGGBBAA; CSS understands that too.
                color: r.props.get("calendar-color").map(|c| c.trim().to_owned()),
                writable: r.privileges.iter().any(|p| p == "write" || p == "all" || p == "write-content"),
                id: r.href,
            })
            .collect())
    }

    async fn calendar_events(&self, from: &str, to: &str) -> Result<Vec<CalendarEvent>> {
        if !dav::valid_time(from) || !dav::valid_time(to) {
            return Err(err("bad time range"));
        }
        let calendars = self.calendars().await?;
        let me: Vec<String> = self.whoami().await.1.map(|o| o.email).into_iter().collect();
        let me = &me;
        let queries = calendars.iter().map(|c| async move {
            let href = self.calendar_href(&c.id).await?;
            let xml = self.dav("REPORT", &href, "1", dav::events_query(from, to)).await?;
            Ok::<_, AdapterError>(
                dav::multistatus(&xml)
                    .iter()
                    .filter_map(|r| Some((r, r.props.get("calendar-data")?)))
                    .flat_map(|(r, ics)| dav::parse_events(&c.id, &r.href, r.props.get("getetag").map(String::as_str), &me, ics))
                    .collect::<Vec<_>>(),
            )
        });
        let mut events = vec![];
        for result in futures::future::join_all(queries).await {
            match result {
                Ok(found) => events.extend(found),
                // One broken calendar (e.g. a stale subscription) shouldn't hide the others.
                Err(e) => tracing::warn!("calendar query failed: {e}"),
            }
        }
        Ok(events)
    }

    async fn create_event(&self, event: &NewEvent) -> Result<()> {
        if !dav::valid_times(event) {
            return Err(err("bad time"));
        }
        let href = self.calendar_href(&event.calendar).await?;
        let uid = format!("{}-{}@ms_trix", now(), Alphanumeric.sample_string(&mut rand::rng(), 12));
        let stamp = stamp_now();
        let organizer = self.whoami().await.1;
        if !event.attendees.is_empty() && organizer.is_none() {
            return Err(err("set an email address in your Nextcloud profile to invite people"));
        }
        self.put_event(&format!("{href}{uid}.ics"), dav::event_ics(&uid, &stamp, event, organizer.as_ref()), None).await
    }

    async fn update_event(&self, href: &str, etag: Option<&str>, event: &NewEvent) -> Result<()> {
        if !dav::valid_time(&event.start) || !dav::valid_time(&event.end) {
            return Err(err("bad time"));
        }
        let href = self.object_href(href).await?;
        let response = self.request(Method::GET, &href).header("Accept", "text/calendar").send().await.map_err(net)?;
        if !response.status().is_success() {
            return Err(err(response.status()));
        }
        let current_etag = response.headers().get("etag").and_then(|v| v.to_str().ok()).map(ToOwned::to_owned);
        let original = response.text().await.map_err(err)?;
        let organizer = self.whoami().await.1;
        if !event.attendees.is_empty() && organizer.is_none() {
            return Err(err("set an email address in your Nextcloud profile to invite people"));
        }
        let repeating = original.contains("RRULE") || original.contains("RECURRENCE-ID") || original.contains("RDATE");
        let ics = match event.occurrence.as_deref().filter(|o| dav::valid_time(o)) {
            Some(occurrence) if event.series => dav::rewrite_series(&original, &stamp_now(), event, organizer.as_ref(), occurrence),
            Some(occurrence) => dav::override_occurrence(&original, &stamp_now(), event, organizer.as_ref(), occurrence),
            None if repeating => return Err(err("choose this occurrence or the whole series")),
            None => dav::rewrite_event(&original, &stamp_now(), event, organizer.as_ref()),
        }
        .ok_or_else(|| err("could not read the event"))?;
        self.put_event(&href, ics, etag.or(current_etag.as_deref())).await
    }

    async fn delete_event(&self, href: &str, etag: Option<&str>, occurrence: Option<&str>) -> Result<()> {
        let href = self.object_href(href).await?;
        if let Some(occurrence) = occurrence.filter(|o| dav::valid_time(o)) {
            let response = self.request(Method::GET, &href).header("Accept", "text/calendar").send().await.map_err(net)?;
            if !response.status().is_success() {
                return Err(err(response.status()));
            }
            let current_etag = response.headers().get("etag").and_then(|v| v.to_str().ok()).map(ToOwned::to_owned);
            let original = response.text().await.map_err(err)?;
            let ics = dav::exclude_occurrence(&original, occurrence).ok_or_else(|| err("could not read the event"))?;
            return self.put_event(&href, ics, etag.or(current_etag.as_deref())).await;
        }
        let mut req = self.request(Method::DELETE, &href);
        if let Some(etag) = etag {
            req = req.header("If-Match", etag);
        }
        let status = req.send().await.map_err(net)?.status();
        match status {
            StatusCode::PRECONDITION_FAILED => Err(err("the event was changed elsewhere; reload the calendar and try again")),
            s if !s.is_success() && s != StatusCode::NOT_FOUND => Err(err(s)),
            _ => Ok(()),
        }
    }

    async fn respond_event(&self, href: &str, etag: Option<&str>, status: &str) -> Result<()> {
        if !matches!(status, "ACCEPTED" | "TENTATIVE" | "DECLINED") {
            return Err(err("bad reply"));
        }
        let href = self.object_href(href).await?;
        let me = self.whoami().await.1.ok_or_else(|| err("your Nextcloud profile has no email address"))?;
        let response = self.request(Method::GET, &href).header("Accept", "text/calendar").send().await.map_err(net)?;
        if !response.status().is_success() {
            return Err(err(response.status()));
        }
        let current_etag = response.headers().get("etag").and_then(|v| v.to_str().ok()).map(ToOwned::to_owned);
        let original = response.text().await.map_err(err)?;
        let ics = dav::set_my_status(&original, &stamp_now(), &me.email, status).ok_or_else(|| err("you're not invited to this event"))?;
        // Nextcloud sends the organizer the reply.
        self.put_event(&href, ics, etag.or(current_etag.as_deref())).await
    }

    async fn calendar_people(&self, term: &str) -> Result<Vec<Attendee>> {
        if term.trim().len() < 2 {
            return Ok(vec![]);
        }
        let xml = self.dav("REPORT", "/remote.php/dav/principals/users/", "0", dav::people_query(term.trim())).await?;
        let me = self.dav_user().await;
        let mut seen = HashSet::new();
        Ok(dav::multistatus(&xml)
            .into_iter()
            .filter_map(|r| {
                // Principals are ".../principals/users/<id>/".
                let href = dav::decode(&r.href);
                let user = href.trim_end_matches('/').rsplit('/').next().unwrap_or_default().to_owned();
                let email = r.props.get("email-address")?.trim().to_owned();
                (user != me).then(|| Attendee { name: r.props.get("displayname").cloned(), email, status: None, user: Some(user).filter(|u| !u.is_empty()) })
            })
            // The same person can match on name and address.
            .filter(|a| seen.insert(a.email.to_lowercase()))
            .take(10)
            .collect())
    }

    async fn conversation_link(&self, conversation: &ConversationId) -> Result<String> {
        Ok(format!("{}/index.php/call/{}", self.session.server, Self::token(conversation)))
    }
}

pub struct TalkFactory;

#[async_trait]
impl AdapterFactory for TalkFactory {
    fn protocol(&self) -> ProtocolId {
        ProtocolId(PROTOCOL.into())
    }

    fn display_name(&self) -> &'static str {
        "Nextcloud Talk"
    }

    async fn restore(&self, account: Account, session: Vec<u8>) -> Result<Arc<dyn ProtocolAdapter>> {
        Ok(TalkAdapter::restore(account, &session)?)
    }
}

struct ReceiverStream<T>(mpsc::UnboundedReceiver<T>);

impl<T> futures::Stream for ReceiverStream<T> {
    type Item = T;
    fn poll_next(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<Option<T>> {
        self.0.poll_recv(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_only_when_formatted() {
        assert_eq!(markdown_html("just text\nwith https://example.org"), None);
        let table = markdown_html("| a | b |\n| --- | --- |\n| 1 | 2 |").unwrap();
        assert!(table.contains("<table>") && table.contains("<td>1</td>"), "{table}");
        let mixed = markdown_html("**bold**\nnext line <b>not html</b>").unwrap();
        assert!(mixed.contains("<strong>bold</strong><br />") && mixed.contains("&lt;b&gt;not html&lt;/b&gt;"), "{mixed}");
    }

    #[test]
    fn reads_a_note_as_the_notes_api_sends_it() {
        let v: Value = serde_json::from_str(r##"{"id":76,"etag":"be284e0e2ca2b9a3b0b6bd2b3a2b1a0c","readonly":false,"modified":1795080000,"title":"Shopping","category":"Home/Lists","content":"# Shopping\n- milk","favorite":true}"##).unwrap();
        let note = note_from(&v).unwrap();
        assert_eq!((note.id, note.title.as_str(), note.category.as_str(), note.favorite, note.readonly), (76, "Shopping", "Home/Lists", true, false));
        assert_eq!(note.content.as_deref(), Some("# Shopping\n- milk"));
        assert!(note_from(&serde_json::json!({"title": "no id"})).is_none());
    }

    #[test]
    fn pins_need_talk_23() {
        let talk = TalkAdapter::new(placeholder_account(AccountId("a".into()), &Session { server: "https://cloud.example.org".into(), login: "me".into(), app_password: String::new() }), Session { server: "https://cloud.example.org".into(), login: "me".into(), app_password: String::new() });
        let old = talk.conversation(&serde_json::json!({ "token": "t1", "type": 2 })).unwrap();
        assert!(!old.can_pin && old.pins.is_none(), "Talk 22: no pinning");
        let none = talk.conversation(&serde_json::json!({ "token": "t1", "type": 2, "lastPinnedId": 0 })).unwrap();
        assert!(none.can_pin && none.pins.is_none());
        let some = talk.conversation(&serde_json::json!({ "token": "t1", "type": 2, "lastPinnedId": 42 })).unwrap();
        assert_eq!(some.pins.as_deref(), Some("42"));
    }

    #[test]
    fn knows_its_own_call_links() {
        let talk = TalkAdapter::new(placeholder_account(AccountId("a".into()), &Session { server: "https://cloud.example.org".into(), login: "me".into(), app_password: String::new() }), Session { server: "https://cloud.example.org".into(), login: "me".into(), app_password: String::new() });
        assert_eq!(talk.link_target("https://cloud.example.org/index.php/call/ab12cd34").as_deref(), Some("a|ab12cd34"));
        assert_eq!(talk.link_target("https://cloud.example.org/call/ab12cd34#message_5").as_deref(), Some("a|ab12cd34"));
        assert!(talk.link_target("https://elsewhere.example/call/ab12cd34").is_none());
        assert!(talk.link_target("https://cloud.example.org/apps/files").is_none());
    }

    #[test]
    fn renders_mentions_and_files() {
        let m = serde_json::json!({
            "message": "Hi {mention-user1}, see {file}",
            "messageParameters": {
                "mention-user1": { "type": "user", "id": "anna", "name": "Anna" },
                "file": { "type": "file", "id": "12", "name": "plan.pdf" }
            }
        });
        assert_eq!(render(&m), "Hi @Anna, see plan.pdf");
    }

    #[test]
    fn converts_mention_links_for_talk() {
        assert_eq!(talk_mentions("hi [Anna de Vries](https://matrix.to/#/anna) and [B](https://matrix.to/#/b.c)!"), "hi @\"anna\" and @\"b.c\"!");
        assert_eq!(talk_mentions("no [link](https://example.org) here"), "no [link](https://example.org) here");
    }

    #[test]
    fn file_with_caption() {
        let adapter = TalkAdapter::new(
            placeholder_account(AccountId("a".into()), &Session { server: "https://x".into(), login: "me".into(), app_password: String::new() }),
            Session { server: "https://x".into(), login: "me".into(), app_password: String::new() },
        );
        let m = serde_json::json!({
            "message": "Talk and Matrix in one client",
            "messageParameters": { "file": { "type": "file", "id": "7", "name": "shot.png", "path": "/Talk/shot.png", "mimetype": "image/png" } }
        });
        match adapter.body(&m) {
            MessageBody::File { name, caption, kind, .. } => assert_eq!((name.as_str(), caption.as_deref(), kind), ("shot.png", Some("Talk and Matrix in one client"), FileKind::Image)),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn thread_replies_know_their_thread() {
        let adapter = TalkAdapter::new(
            placeholder_account(AccountId("a".into()), &Session { server: "https://x".into(), login: "me".into(), app_password: String::new() }),
            Session { server: "https://x".into(), login: "me".into(), app_password: String::new() },
        );
        let message = |id: i64, thread: i64| {
            let m = serde_json::json!({ "id": id, "threadId": thread, "isThread": id == thread, "actorType": "users", "actorId": "ann", "message": "hi", "messageType": "comment", "timestamp": 1 });
            match adapter.events_from("tok", &m).into_iter().next() {
                Some(AdapterEvent::Message(m)) => m.thread_root.map(|r| r.0),
                other => panic!("{other:?}"),
            }
        };
        assert_eq!(message(10, 10), None, "the first message is the thread itself");
        assert_eq!(message(12, 10).as_deref(), Some("10"));
        assert_eq!(message(13, 0), None, "not in a thread");
    }

    #[test]
    fn normalizes_server() {
        assert_eq!(normalize("cloud.example.org/"), "https://cloud.example.org");
        assert_eq!(host("https://cloud.example.org"), "cloud.example.org");
    }
}
