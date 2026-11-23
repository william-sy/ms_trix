//! ntfy as an account: watch ntfy topics (ntfy.sh or your own server) and read their messages in
//! Trixcomm like chats, with notifications. Each topic is a conversation; writing in it publishes
//! to the topic. A topic is added as a new room and removed by leaving it.

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use futures::stream::{BoxStream, StreamExt};
use rand::distr::{Alphanumeric, SampleString};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use trix_core::adapter::{AdapterError, Result};
use trix_core::*;

pub const PROTOCOL: &str = "ntfy";
/// How far back the server's cache is read when watching starts (ntfy.sh keeps 12 hours).
const HISTORY: &str = "12h";
/// ntfy sends a keepalive every 45 seconds; silence much longer than that is a dead connection.
const SILENCE: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Session {
    server: String,
    topics: Vec<String>,
    /// An access token ("tk_…"), or user:password.
    token: Option<String>,
}

pub struct NtfyAdapter {
    account: Account,
    session: Mutex<Session>,
    http: reqwest::Client,
    events: Mutex<Option<mpsc::UnboundedSender<AdapterEvent>>>,
    watcher: Mutex<Option<JoinHandle<()>>>,
    shared: Arc<Shared>,
}

/// What the adapter and its watcher task both use.
struct Shared {
    account: AccountId,
    pos: AtomicU64,
    /// Messages already passed on (the cached history and the live stream overlap).
    seen: Mutex<HashSet<String>>,
    /// Messages we published ourselves (the stream echoes them back).
    sent: Mutex<HashSet<String>>,
}

fn err(e: impl std::fmt::Display) -> AdapterError {
    AdapterError::Other(e.to_string())
}

fn network(e: reqwest::Error) -> AdapterError {
    AdapterError::Network(e.to_string())
}

/// A topic name as ntfy allows it.
pub fn valid_topic(topic: &str) -> bool {
    !topic.is_empty() && topic.len() <= 64 && topic.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn client() -> reqwest::Client {
    // No overall timeout: the watching connection stays open (see SILENCE).
    reqwest::Client::builder().connect_timeout(Duration::from_secs(10)).user_agent("Trixcomm").build().expect("http client")
}

fn authorized(builder: reqwest::RequestBuilder, token: Option<&str>) -> reqwest::RequestBuilder {
    match token.map(|t| (t, t.split_once(':'))) {
        Some((_, Some((user, password)))) => builder.basic_auth(user, Some(password)),
        Some((token, None)) => builder.bearer_auth(token),
        None => builder,
    }
}

/// Adds an ntfy account: checks that the server answers and the topics can be read.
pub async fn login(server: &str, topics: &[String], token: Option<&str>) -> Result<(Arc<NtfyAdapter>, Vec<u8>)> {
    let server = server.trim().trim_end_matches('/');
    let server = if server.starts_with("http") { server.to_owned() } else { format!("https://{server}") };
    let topics: Vec<String> = topics.iter().map(|t| t.trim().to_owned()).filter(|t| !t.is_empty()).collect();
    if topics.is_empty() {
        return Err(err("add at least one topic"));
    }
    if let Some(bad) = topics.iter().find(|t| !valid_topic(t)) {
        return Err(err(format!("\"{bad}\" isn't a topic name (letters, digits, - and _)")));
    }
    let token = token.map(str::trim).filter(|t| !t.is_empty()).map(ToOwned::to_owned);
    let http = client();
    // Reading the topics checks the server and the token in one go.
    let url = format!("{server}/{}/json?poll=1&since=1s", topics.join(","));
    let probe = authorized(http.get(url), token.as_deref()).timeout(Duration::from_secs(15)).send().await.map_err(network)?;
    match probe.status().as_u16() {
        200 => {}
        401 | 403 => return Err(AdapterError::Auth("the server wants an access token for these topics".into())),
        status => return Err(err(format!("the server answered {status}"))),
    }
    let host = reqwest::Url::parse(&server).ok().and_then(|u| u.host_str().map(ToOwned::to_owned)).unwrap_or_else(|| server.clone());
    let session = Session { server, topics, token };
    let blob = serde_json::to_vec(&session).map_err(err)?;
    let account = Account {
        id: AccountId(Alphanumeric.sample_string(&mut rand::rng(), 12)),
        protocol: ProtocolId(PROTOCOL.into()),
        org_name: format!("ntfy · {host}"),
        user_id: host,
        display_name: "ntfy".into(),
        avatar_url: None,
    };
    Ok((Arc::new(NtfyAdapter::new(account, session, http)), blob))
}

impl NtfyAdapter {
    fn new(account: Account, session: Session, http: reqwest::Client) -> Self {
        let shared = Arc::new(Shared { account: account.id.clone(), pos: AtomicU64::new(0), seen: Mutex::default(), sent: Mutex::default() });
        Self { account, session: Mutex::new(session), http, events: Mutex::new(None), watcher: Mutex::new(None), shared }
    }

    pub fn restore(account: Account, blob: &[u8]) -> Result<Arc<Self>> {
        let session: Session = serde_json::from_slice(blob).map_err(err)?;
        Ok(Arc::new(Self::new(account, session, client())))
    }

    fn conversation(&self, topic: &str) -> Conversation {
        Conversation {
            id: ConversationId { account: self.account.id.clone(), remote: topic.to_owned() },
            // A named room: every message notifies by default (Settings → Notifications → chats).
            kind: ConversationKind::Room,
            name: topic.to_owned(),
            avatar_url: None,
            favourite: false,
            archived: false,
            muted: false,
            mentions_only: false,
            dm_user: None,
            invited_by: None,
            team_id: None,
            call_active: false,
            call_silent: false,
            can_pin: false,
            pins: None,
            encrypted: false,
        }
    }

    fn send_event(&self, event: AdapterEvent) {
        if let Some(tx) = self.events.lock().unwrap().as_ref() {
            let _ = tx.send(event);
        }
    }

    /// (Re)starts watching the current topics, in one connection.
    fn watch(&self) {
        let Some(tx) = self.events.lock().unwrap().clone() else { return };
        if let Some(old) = self.watcher.lock().unwrap().take() {
            old.abort();
        }
        let session = self.session.lock().unwrap().clone();
        let (http, shared) = (self.http.clone(), self.shared.clone());
        *self.watcher.lock().unwrap() = Some(tokio::spawn(async move { shared.watch(http, session, tx).await }));
    }

    /// The topic list changed: stored again by the host, and watched anew.
    fn topics_changed(&self) {
        if let Ok(blob) = serde_json::to_vec(&*self.session.lock().unwrap()) {
            self.send_event(AdapterEvent::SessionChanged { account: self.account.id.clone(), session: blob });
        }
        self.watch();
    }
}

impl Shared {
    async fn watch(&self, http: reqwest::Client, session: Session, tx: mpsc::UnboundedSender<AdapterEvent>) {
        if session.topics.is_empty() {
            return;
        }
        // First the server's cached history, then from the last message seen after a reconnect.
        let mut since = HISTORY.to_owned();
        let mut lost = false;
        let mut wait = Duration::from_secs(2);
        loop {
            let url = format!("{}/{}/json?since={since}", session.server, session.topics.join(","));
            if let Err(reason) = self.listen(&http, &url, session.token.as_deref(), &tx, &mut since, &mut lost, &mut wait).await {
                if !std::mem::replace(&mut lost, true) {
                    let _ = tx.send(AdapterEvent::ConnectionLost { reason });
                }
            }
            if tx.is_closed() {
                return;
            }
            tokio::time::sleep(wait).await;
            wait = (wait * 2).min(Duration::from_secs(60));
        }
    }

    /// One connection: passes on messages until it closes (Ok) or fails.
    #[allow(clippy::too_many_arguments)]
    async fn listen(&self, http: &reqwest::Client, url: &str, token: Option<&str>, tx: &mpsc::UnboundedSender<AdapterEvent>, since: &mut String, lost: &mut bool, wait: &mut Duration) -> std::result::Result<(), String> {
        let mut response = authorized(http.get(url), token).send().await.map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("the server answered {}", response.status()));
        }
        if std::mem::take(lost) {
            let _ = tx.send(AdapterEvent::ConnectionRestored);
        }
        *wait = Duration::from_secs(2);
        let mut buffer: Vec<u8> = vec![];
        loop {
            let chunk = match tokio::time::timeout(SILENCE, response.chunk()).await {
                Err(_) => return Err("no keepalive from the server".into()),
                Ok(Err(e)) => return Err(e.to_string()),
                Ok(Ok(None)) => return Ok(()),
                Ok(Ok(Some(chunk))) => chunk,
            };
            buffer.extend_from_slice(&chunk);
            while let Some(end) = buffer.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = buffer.drain(..=end).collect();
                let Ok(event) = serde_json::from_slice::<Value>(&line) else { continue };
                if event["event"] != "message" {
                    continue; // open, keepalive, poll_request
                }
                if let Some(id) = event["id"].as_str() {
                    *since = id.to_owned();
                }
                if let Some(message) = self.message(&event) {
                    let _ = tx.send(AdapterEvent::Message(message));
                }
            }
            if tx.is_closed() {
                return Ok(());
            }
        }
    }

    /// An ntfy message as a chat message: the title as the sender, tags as emoji, the link and
    /// attachment below the text; priority 4 and 5 count as a mention (they notify anyway).
    fn message(&self, e: &Value) -> Option<Message> {
        let id = e["id"].as_str()?.to_owned();
        if !self.seen.lock().unwrap().insert(id.clone()) {
            return None;
        }
        let topic = e["topic"].as_str()?.to_owned();
        let marks: String = e["tags"].as_array().map(|tags| tags.iter().filter_map(|t| t.as_str()).filter_map(emoji).collect()).unwrap_or_default();
        let mut text = if marks.is_empty() { String::new() } else { format!("{marks} ") };
        text.push_str(e["message"].as_str().unwrap_or_default());
        if let Some(click) = e["click"].as_str().filter(|c| !c.is_empty()) {
            text.push_str(&format!("\n{click}"));
        }
        if let (Some(name), Some(url)) = (e["attachment"]["name"].as_str(), e["attachment"]["url"].as_str()) {
            text.push_str(&format!("\n📎 {name}: {url}"));
        }
        let from_me = self.sent.lock().unwrap().contains(&id);
        let sender_name = e["title"].as_str().filter(|t| !t.is_empty()).unwrap_or(&topic).to_owned();
        Some(Message {
            id: MessageId(id),
            conversation: ConversationId { account: self.account.clone(), remote: topic.clone() },
            pos: self.pos.fetch_add(1, Ordering::Relaxed) + 1,
            sender: format!("ntfy:{topic}"),
            sender_name,
            sent_at: e["time"].as_u64().unwrap_or(0) * 1000,
            body: MessageBody::Text { plain: text, html: None },
            thread_root: None,
            reply_to: None,
            sender_avatar: None,
            mentions_me: e["priority"].as_u64().unwrap_or(3) >= 4 && !from_me,
            from_me,
        })
    }
}

/// The emoji for ntfy's most used tags (other tags aren't shown, as in ntfy's own apps).
fn emoji(tag: &str) -> Option<&'static str> {
    Some(match tag {
        "warning" => "⚠️",
        "rotating_light" => "🚨",
        "white_check_mark" | "heavy_check_mark" => "✅",
        "x" | "no_entry" => "❌",
        "tada" | "partying_face" => "🎉",
        "skull" => "💀",
        "loudspeaker" => "📢",
        "bell" => "🔔",
        "+1" => "👍",
        "-1" => "👎",
        "computer" => "💻",
        "fire" => "🔥",
        "calendar" => "📅",
        "speech_balloon" => "💬",
        "telephone_receiver" => "📞",
        "information_source" => "ℹ️",
        _ => return None,
    })
}

#[async_trait]
impl ProtocolAdapter for NtfyAdapter {
    fn account(&self) -> Account {
        self.account.clone()
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities::default()
    }

    async fn start(&self) -> Result<BoxStream<'static, AdapterEvent>> {
        let (tx, rx) = mpsc::unbounded_channel();
        for topic in &self.session.lock().unwrap().topics {
            let _ = tx.send(AdapterEvent::ConversationUpserted(self.conversation(topic)));
        }
        *self.events.lock().unwrap() = Some(tx);
        self.watch();
        Ok(ReceiverStream(rx).boxed())
    }

    /// A fresh connection, continuing after the last message seen (seen ones aren't repeated).
    fn wake(&self) {
        self.watch();
    }

    async fn stop(&self) -> Result<()> {
        if let Some(task) = self.watcher.lock().unwrap().take() {
            task.abort();
        }
        *self.events.lock().unwrap() = None;
        Ok(())
    }

    /// Publishes to the topic (Markdown, as the composer writes it).
    async fn send(&self, conversation: &ConversationId, message: Outgoing) -> Result<MessageId> {
        let session = self.session.lock().unwrap().clone();
        let body = serde_json::json!({ "topic": conversation.remote, "message": message.text, "markdown": true });
        let request = self.http.post(&session.server).timeout(Duration::from_secs(15)).header("Content-Type", "application/json").body(body.to_string());
        let response = authorized(request, session.token.as_deref()).send().await.map_err(network)?;
        if !response.status().is_success() {
            return Err(err(format!("the server answered {}", response.status())));
        }
        let published: Value = response.json().await.map_err(network)?;
        let id = published["id"].as_str().ok_or_else(|| err("the server sent no message id"))?.to_owned();
        self.shared.sent.lock().unwrap().insert(id.clone());
        Ok(MessageId(id))
    }

    /// The topic's page on the server (subscribe there or in the ntfy app).
    async fn conversation_link(&self, conversation: &ConversationId) -> Result<String> {
        Ok(format!("{}/{}", self.session.lock().unwrap().server, conversation.remote))
    }

    /// ntfy has no read receipts; what you've read is kept here only.
    async fn send_read_receipt(&self, _conversation: &ConversationId, _thread_root: Option<&MessageId>, _up_to: &MessageId) -> Result<()> {
        Ok(())
    }

    /// "New room": watches another topic.
    async fn create_room(&self, room: &NewRoom) -> Result<CommandOutput> {
        let topic = room.name.trim().to_owned();
        if !valid_topic(&topic) {
            return Err(err(format!("\"{topic}\" isn't a topic name (letters, digits, - and _)")));
        }
        {
            let mut session = self.session.lock().unwrap();
            if !session.topics.contains(&topic) {
                session.topics.push(topic.clone());
            }
        }
        let conversation = self.conversation(&topic);
        let key = conversation.id.key();
        self.send_event(AdapterEvent::ConversationUpserted(conversation));
        self.topics_changed();
        Ok(CommandOutput { message: format!("Watching {topic}"), open: Some(key), text: None })
    }

    /// Leaving a topic's room stops watching it.
    async fn leave(&self, conversation: &ConversationId) -> Result<()> {
        self.session.lock().unwrap().topics.retain(|t| *t != conversation.remote);
        self.send_event(AdapterEvent::ConversationRemoved(conversation.clone()));
        self.topics_changed();
        Ok(())
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

    fn shared() -> Shared {
        Shared { account: AccountId("a".into()), pos: AtomicU64::new(0), seen: Mutex::default(), sent: Mutex::default() }
    }

    #[test]
    fn turns_an_ntfy_message_into_a_chat_message() {
        let s = shared();
        let e = serde_json::json!({ "id": "abc", "time": 1795080000, "event": "message", "topic": "backups", "title": "Nightly backup", "message": "Done in 4 min",
            "priority": 5, "tags": ["white_check_mark", "server"], "click": "https://example.org/log", "attachment": { "name": "log.txt", "url": "https://example.org/log.txt" } });
        let m = s.message(&e).unwrap();
        assert_eq!(m.sender_name, "Nightly backup");
        assert_eq!(m.conversation.remote, "backups");
        assert_eq!(m.sent_at, 1_795_080_000_000);
        assert!(m.mentions_me && !m.from_me);
        assert_eq!(m.body.plain_text(), "✅ Done in 4 min\nhttps://example.org/log\n📎 log.txt: https://example.org/log.txt");
        // Seen once: the same message from the history and the stream shows once.
        assert!(s.message(&e).is_none());
    }

    #[test]
    fn topic_names() {
        assert!(valid_topic("trixcomm-alerts_1"));
        assert!(!valid_topic("with space") && !valid_topic("a/b") && !valid_topic(""));
    }
}

#[cfg(test)]
mod live {
    use super::*;

    #[tokio::test]
    #[ignore = "needs the internet (a throwaway topic on ntfy.sh)"]
    async fn watches_and_publishes() {
        let topic = format!("trixcomm-test-{}", rand::random::<u64>());
        let (adapter, _) = login("ntfy.sh", std::slice::from_ref(&topic), None).await.expect("login");
        let mut events = adapter.start().await.expect("start");
        assert!(matches!(events.next().await, Some(AdapterEvent::ConversationUpserted(c)) if c.name == topic));
        // Give the watcher a moment to connect, then publish into the topic.
        tokio::time::sleep(Duration::from_secs(2)).await;
        let conversation = ConversationId { account: adapter.account().id, remote: topic.clone() };
        let id = adapter.send(&conversation, Outgoing { text: "hello **world**".into(), ..Default::default() }).await.expect("send");
        let message = tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                if let Some(AdapterEvent::Message(m)) = events.next().await {
                    return m;
                }
            }
        })
        .await
        .expect("the message comes back over the watching connection");
        assert_eq!(message.id, id);
        assert!(message.from_me);
        assert_eq!(message.body.plain_text(), "hello **world**");
        adapter.stop().await.unwrap();
    }
}
