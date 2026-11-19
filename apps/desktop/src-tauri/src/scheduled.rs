//! Send later: messages written now that this app sends at a chosen time. Matrix has no
//! server-side scheduling yet, so the app has to be running then; a message whose time passed
//! while it was closed goes out once the app is back. Kept on disk encrypted with the search
//! index's key (they can come from encrypted chats); without a keychain only in memory.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use trix_core::{MessageId, Outgoing};

use crate::{conv, now, AppState};

const FILE: &str = "scheduled.bin";
/// A failed attempt (the account still connecting, no network) is tried again after this.
const RETRY_MS: u64 = 60_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scheduled {
    pub id: String,
    pub conversation: String,
    /// When to send it (ms since 1970).
    pub at: u64,
    pub text: String,
    #[serde(default)]
    pub emote: bool,
    pub reply_to: Option<String>,
    pub thread_root: Option<String>,
    #[serde(default)]
    pub mentions: Vec<String>,
    pub html: Option<String>,
    pub msgtype: Option<String>,
    #[serde(default)]
    pub emotes: Vec<(String, String)>,
    /// Why the last attempt failed; it's tried again a minute later.
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub retry_at: u64,
}

static LIST: Mutex<Vec<Scheduled>> = Mutex::new(Vec::new());
/// One sending round at a time ("Send now" next to the timer), so nothing goes out twice.
static ROUND: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub fn list() -> Vec<Scheduled> {
    LIST.lock().unwrap().clone()
}

/// Reads the list saved by the previous run.
pub fn load(app: &AppHandle) {
    let state = app.state::<AppState>();
    let Some(index) = state.search.clone() else { return };
    let Ok(data) = std::fs::read(state.data_dir.join(FILE)) else { return };
    match index.unseal::<Vec<Scheduled>>(&data) {
        Ok(all) => *LIST.lock().unwrap() = all,
        Err(e) => log::warn!("could not read the scheduled messages: {e}"),
    }
}

/// Saves the list and tells the UI.
fn changed(app: &AppHandle) {
    let all = list();
    let state = app.state::<AppState>();
    if let Some(index) = state.search.clone() {
        let path = state.data_dir.join(FILE);
        let saved = if all.is_empty() {
            match std::fs::remove_file(&path) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
                _ => Ok(()),
            }
        } else {
            index.seal(&all).map_err(|e| e.to_string()).and_then(|data| std::fs::write(&path, data).map_err(|e| e.to_string()))
        };
        if let Err(e) = saved {
            log::warn!("could not save the scheduled messages: {e}");
        }
    }
    let _ = app.emit("trix://scheduled", &all);
}

pub fn add(app: &AppHandle, message: Scheduled) {
    LIST.lock().unwrap().push(message);
    changed(app);
}

/// Takes a message off the list (deleted, or back in the composer to edit).
pub fn remove(app: &AppHandle, id: &str) -> Option<Scheduled> {
    let removed = {
        let mut all = LIST.lock().unwrap();
        let at = all.iter().position(|m| m.id == id)?;
        all.remove(at)
    };
    changed(app);
    Some(removed)
}

/// Makes a message due now; the next round sends it (so it can't go out twice).
pub fn due_now(app: &AppHandle, id: &str) {
    if let Some(m) = LIST.lock().unwrap().iter_mut().find(|m| m.id == id) {
        m.at = now();
        m.retry_at = 0;
    }
    changed(app);
}

/// Sends whatever is due; runs every few seconds, one round at a time.
pub async fn send_due(app: &AppHandle) {
    let _round = ROUND.lock().await;
    let time = now();
    let due: Vec<Scheduled> = LIST.lock().unwrap().iter().filter(|m| m.at <= time && m.retry_at <= time).cloned().collect();
    for message in due {
        let result = send(app, &message).await;
        {
            let mut all = LIST.lock().unwrap();
            match &result {
                Ok(()) => all.retain(|m| m.id != message.id),
                Err(e) => {
                    if let Some(m) = all.iter_mut().find(|m| m.id == message.id) {
                        m.error = Some(e.clone());
                        m.retry_at = now() + RETRY_MS;
                    }
                }
            }
        }
        if let Err(e) = &result {
            log::warn!("scheduled message not sent yet: {e}");
        }
        changed(app);
    }
}

async fn send(app: &AppHandle, m: &Scheduled) -> Result<(), String> {
    let id = conv(&m.conversation)?;
    let adapter = app.state::<AppState>().engine.lock().unwrap().adapter(&id.account).ok_or("account not signed in")?;
    let message = Outgoing {
        text: m.text.clone(),
        emote: m.emote,
        reply_to: m.reply_to.clone().map(MessageId),
        thread_root: m.thread_root.clone().map(MessageId),
        mentions: m.mentions.clone(),
        html: m.html.clone(),
        msgtype: m.msgtype.clone(),
        emotes: m.emotes.clone(),
    };
    adapter.send(&id, message).await.map(|_| ()).map_err(|e| e.to_string())
}
