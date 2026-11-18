//! Local full-text search: indexes messages as they arrive, crawls older history
//! in the background, and answers queries. The index itself is encrypted
//! (see trix-search); its key lives in the OS keychain.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use trix_core::engine::{snippet, SearchHit};
use serde::Serialize;
use trix_core::{AdapterEvent, ConversationId, FileKind, Message, MessageBody, MessageId, MessageView, ProtocolAdapter};
use trix_search::{CrawlState, Doc, DocMedia, Kind, SearchIndex, CRAWL_VERSION};

use crate::{accounts, AppState};

const FILE: &str = "search.sqlite";
const PAGE: u32 = 100;
/// Pages per conversation before moving on, so every chat gets some history early.
const PAGES_PER_TURN: usize = 5;
const PAUSE: Duration = Duration::from_millis(300);
/// Once everything is crawled: how often to look for new rooms and retry undecryptable messages.
const IDLE: Duration = Duration::from_secs(10 * 60);
/// Undecryptable messages remembered per conversation for a later retry.
const MAX_UNDECRYPTED: usize = 500;

pub fn open(data_dir: &Path) -> Option<Arc<SearchIndex>> {
    let key = match accounts::search_key() {
        Ok(key) => key,
        Err(e) => {
            log::warn!("search index disabled: {e}");
            return None;
        }
    };
    let _ = std::fs::create_dir_all(data_dir);
    let path = data_dir.join(FILE);
    match SearchIndex::open(&path, &key) {
        Ok(index) => Some(Arc::new(index)),
        // The keychain entry was lost or reset: the old index is unreadable, start over.
        Err(trix_search::Error::WrongKey) => {
            log::warn!("search index key changed; rebuilding the index");
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(data_dir.join(format!("{FILE}{suffix}")));
            }
            SearchIndex::open(&path, &key).map(Arc::new).map_err(|e| log::warn!("search index disabled: {e}")).ok()
        }
        Err(e) => {
            log::warn!("search index disabled: {e}");
            None
        }
    }
}

fn kind_name(kind: FileKind) -> &'static str {
    match kind {
        FileKind::Image => "image",
        FileKind::Video => "video",
        FileKind::Audio => "audio",
        FileKind::File => "file",
        FileKind::Sticker => "sticker",
    }
}

fn text_of(body: &str, caption: Option<&str>) -> String {
    match caption {
        Some(c) if !c.is_empty() && c != body => format!("{c} {body}"),
        _ => body.to_owned(),
    }
}

/// Changed messages from the engine: index new and edited ones, drop deleted ones.
pub fn index_views(app: &AppHandle, views: &[MessageView]) {
    let Some(index) = app.state::<AppState>().search.clone() else { return };
    let mut docs = vec![];
    let mut gone = vec![];
    for v in views {
        if v.deleted {
            gone.push((v.conversation.clone(), v.id.clone()));
            continue;
        }
        let text = text_of(&v.body, v.media.as_ref().and_then(|m| m.caption.as_deref()));
        if v.event.is_some() || v.encrypted || text.trim().is_empty() {
            continue;
        }
        let media = v.media.as_ref().map(|m| DocMedia { id: m.id.clone(), kind: kind_name(m.kind).to_owned(), name: m.name.clone(), mime: m.mime.clone() });
        docs.push(Doc { conversation: v.conversation.clone(), event_id: v.id.clone(), sender_name: v.sender_name.clone(), from_me: v.from_me, body: text, ts: v.sent_at, media });
    }
    if docs.is_empty() && gone.is_empty() {
        return;
    }
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(e) = index.add(&docs) {
            log::warn!("{e}");
        }
        for (conversation, id) in gone {
            let _ = index.remove(&conversation, &id);
        }
    });
}

fn doc_of(m: &Message, body: &MessageBody) -> Option<Doc> {
    let (text, media) = match body {
        MessageBody::Text { plain, .. } | MessageBody::Notice { plain } => (plain.clone(), None),
        MessageBody::Poll { question, .. } => (question.clone(), None),
        MessageBody::File { name, caption, media, kind, mime, .. } => {
            (text_of(name, caption.as_deref()), Some(DocMedia { id: media.clone(), kind: kind_name(*kind).to_owned(), name: name.clone(), mime: mime.clone() }))
        }
        MessageBody::Redacted | MessageBody::Event { .. } | MessageBody::Encrypted | MessageBody::Untrusted => return None,
    };
    (!text.trim().is_empty()).then(|| Doc { conversation: m.conversation.key(), event_id: m.id.0.clone(), sender_name: m.sender_name.clone(), from_me: m.from_me, body: text, ts: m.sent_at, media })
}

/// Indexes the history of every conversation of this account, oldest pages last.
/// Resumes where it stopped. When all is done it keeps watching (every few minutes)
/// for rooms joined since and for messages whose decryption key has arrived.
/// Returns when the account is gone or the protocol can't crawl.
pub async fn crawl(app: AppHandle, adapter: Arc<dyn ProtocolAdapter>) {
    let Some(index) = app.state::<AppState>().search.clone() else { return };
    let account = adapter.account().id;
    // Let the first sync settle before adding load.
    tokio::time::sleep(Duration::from_secs(20)).await;
    // Edits seen (newest first) before the message they change, per conversation.
    let mut edits: HashMap<String, HashMap<String, (u64, MessageBody)>> = HashMap::new();
    loop {
        let still_signed_in = app.state::<AppState>().engine.lock().unwrap().adapter(&account).is_some();
        if !still_signed_in {
            return;
        }
        let convs: Vec<String> = app.state::<AppState>().engine.lock().unwrap().conversations().into_iter()
            .filter(|c| c.account == account.0 && c.invited_by.is_none())
            .map(|c| c.key)
            .collect();
        let mut worked = false;
        for key in convs {
            let Some(id) = ConversationId::from_key(&key) else { continue };
            let mut state = match index.crawl_state(&key) {
                // Crawled by an older version that stored less: go through it once more.
                Ok(s) if s.version != CRAWL_VERSION => CrawlState { version: CRAWL_VERSION, ..CrawlState::default() },
                Ok(s) if !s.done => s,
                _ => continue,
            };
            for _ in 0..PAGES_PER_TURN {
                let page = match adapter.crawl(&id, state.token.clone(), PAGE).await {
                    Ok(Some(page)) => page,
                    Ok(None) => return, // protocol can't crawl
                    Err(e) => {
                        log::warn!("search crawl of {key} paused: {e}");
                        break;
                    }
                };
                worked = true;
                let pending = edits.entry(key.clone()).or_default();
                let mut docs = vec![];
                let mut removed = HashSet::new();
                // Edits and deletions first: within a page they may come after the message
                // (pages can be in either order); across pages they come first, as we go back.
                for event in &page.events {
                    match event {
                        AdapterEvent::Edited { target, body, at, .. } => {
                            let newer = pending.get(&target.0).is_none_or(|(t, _)| *at > *t);
                            if newer {
                                pending.insert(target.0.clone(), (*at, body.clone()));
                            }
                        }
                        AdapterEvent::MessageRedacted { id, .. } => {
                            removed.insert(id.0.clone());
                        }
                        _ => {}
                    }
                }
                for event in page.events {
                    if let AdapterEvent::Message(m) = event {
                        if removed.contains(&m.id.0) {
                            continue;
                        }
                        if m.body.is_placeholder() {
                            if state.undecrypted.len() < MAX_UNDECRYPTED {
                                state.undecrypted.push(m.id.0.clone());
                            }
                            continue;
                        }
                        let body = pending.remove(&m.id.0).map(|(_, b)| b).unwrap_or_else(|| m.body.clone());
                        docs.extend(doc_of(&m, &body));
                    }
                }
                let (index2, conv) = (index.clone(), key.clone());
                let ok = tauri::async_runtime::spawn_blocking(move || {
                    index2.add(&docs)?;
                    for id in removed {
                        index2.remove(&conv, &id)?;
                    }
                    Ok::<_, trix_search::Error>(())
                })
                .await;
                if !matches!(ok, Ok(Ok(()))) {
                    log::warn!("search index write failed: {ok:?}");
                    return;
                }
                state.done = page.next.is_none();
                state.token = page.next;
                state.version = CRAWL_VERSION;
                let _ = index.set_crawl_state(&key, &state);
                if state.done {
                    edits.remove(&key);
                    break;
                }
                tokio::time::sleep(PAUSE).await;
            }
        }
        if !worked {
            retry_undecrypted(&app, &index, &adapter).await;
            tokio::time::sleep(IDLE).await;
        }
    }
}

/// Fetches messages that couldn't be decrypted during the crawl again and indexes
/// the ones that can be read now (keys arrive later from backup or other devices).
async fn retry_undecrypted(app: &AppHandle, index: &Arc<SearchIndex>, adapter: &Arc<dyn ProtocolAdapter>) {
    let account = adapter.account().id;
    let convs: Vec<String> = app.state::<AppState>().engine.lock().unwrap().conversations().into_iter().filter(|c| c.account == account.0).map(|c| c.key).collect();
    for key in convs {
        let Ok(mut state) = index.crawl_state(&key) else { continue };
        if state.undecrypted.is_empty() {
            continue;
        }
        let Some(id) = ConversationId::from_key(&key) else { continue };
        let mut still = vec![];
        for chunk in state.undecrypted.chunks(50) {
            let ids: Vec<MessageId> = chunk.iter().cloned().map(MessageId).collect();
            let events = match adapter.refetch(&id, &ids).await {
                Ok(events) => events,
                Err(_) => {
                    still.extend_from_slice(chunk);
                    continue;
                }
            };
            let mut docs = vec![];
            let mut readable = HashSet::new();
            for event in events {
                if let AdapterEvent::Message(m) = event {
                    if !m.body.is_placeholder() {
                        readable.insert(m.id.0.clone());
                        docs.extend(doc_of(&m, &m.body));
                    }
                }
            }
            still.extend(chunk.iter().filter(|id| !readable.contains(*id)).cloned());
            let index = index.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || index.add(&docs)).await;
            tokio::time::sleep(PAUSE).await;
        }
        state.undecrypted = still;
        let _ = index.set_crawl_state(&key, &state);
    }
}

/// Full-history hits from the index plus whatever the engine has loaded, newest first.
pub fn search(app: &AppHandle, query: &str, conversation: Option<&str>, limit: usize) -> Vec<SearchHit> {
    let state = app.state::<AppState>();
    let (names, mut hits): (HashMap<String, String>, Vec<SearchHit>) = {
        let engine = state.engine.lock().unwrap();
        let names = engine.conversations().into_iter().map(|c| (c.key, c.name)).collect();
        let hits = engine.search(query, limit).into_iter().filter(|h| conversation.is_none_or(|c| h.conversation == c)).collect();
        (names, hits)
    };
    if let Some(index) = state.search.clone() {
        let first = query.split_whitespace().next().unwrap_or_default().to_lowercase();
        for doc in index.search(query, conversation, limit).unwrap_or_default() {
            // Rooms we've left stay out of results.
            let Some(name) = names.get(&doc.conversation) else { continue };
            if hits.iter().any(|h| h.conversation == doc.conversation && h.message == doc.event_id) {
                continue;
            }
            let at = doc.body.to_lowercase().find(&first).unwrap_or(0);
            hits.push(SearchHit {
                conversation: doc.conversation.clone(),
                conversation_name: name.clone(),
                message: doc.event_id,
                sender_name: if doc.from_me { String::new() } else { doc.sender_name },
                snippet: snippet(&doc.body, at, first.len()),
                at: doc.ts,
            });
        }
    }
    hits.sort_by(|a, b| b.at.cmp(&a.at));
    hits.truncate(limit);
    hits
}

/// One entry of a chat's Shared tab.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedItem {
    pub message: String,
    pub sender_name: String,
    pub from_me: bool,
    pub at: u64,
    pub media: Option<DocMedia>,
    pub links: Vec<String>,
    pub text: String,
}

/// Media, files or links shared in a conversation, newest first.
pub async fn shared(app: &AppHandle, conversation: &str, kind: Kind, before: Option<u64>, limit: usize) -> Result<Vec<SharedItem>, String> {
    let Some(index) = app.state::<AppState>().search.clone() else { return Err("search index unavailable".into()) };
    let id = ConversationId::from_key(conversation).ok_or("bad conversation")?;
    let adapter = app.state::<AppState>().engine.lock().unwrap().adapter(&id.account).ok_or("account not signed in")?;
    let conv = conversation.to_owned();
    let docs = tauri::async_runtime::spawn_blocking(move || index.list(&conv, kind, before, limit)).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    let mut out = vec![];
    for doc in docs {
        if let Some(media) = &doc.media {
            // Pictures from older history may need their decryption key looked up first.
            if let Err(e) = adapter.prepare_media(&id, &MessageId(doc.event_id.clone()), &media.id).await {
                log::warn!("shared media {}: {e}", doc.event_id);
            }
        }
        out.push(SharedItem { links: trix_search::links(&doc.body), message: doc.event_id, sender_name: doc.sender_name, from_me: doc.from_me, at: doc.ts, media: doc.media, text: doc.body });
    }
    Ok(out)
}

