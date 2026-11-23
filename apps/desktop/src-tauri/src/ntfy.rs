//! ntfy add-on: notifications also go to an ntfy topic (ntfy.sh or your own server), e.g. to your
//! phone while you're away from the computer. Only what would show as a notification here, never
//! during do not disturb; by default without the message text. The access token is kept in the
//! keychain.

use std::sync::Mutex;

use serde::Deserialize;
use tauri::{AppHandle, Manager};
use trix_core::engine::NotificationKind;

use crate::AppState;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prefs {
    /// "https://ntfy.sh", or your own server.
    pub server: String,
    pub topic: String,
    /// Only while you're away from the computer (no input for `away_after_secs`).
    pub only_away: bool,
    pub away_after_secs: u64,
    /// Send what the message says, not just that there is one (and from whom).
    pub include_text: bool,
}

/// What a forwarded notification is about.
#[derive(Debug, Clone, Copy)]
pub enum Kind {
    Message(NotificationKind),
    Reminder,
}

static PREFS: Mutex<Option<Prefs>> = Mutex::new(None);
/// The access token, read from the keychain once (None inside: there is none).
static TOKEN: Mutex<Option<Option<String>>> = Mutex::new(None);

pub fn set_prefs(prefs: Option<Prefs>) {
    *PREFS.lock().unwrap() = prefs.filter(|p| !p.topic.trim().is_empty() && p.server.starts_with("http"));
}

pub fn set_token(token: Option<String>) -> Result<(), String> {
    let token = token.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty());
    crate::accounts::set_ntfy_token(token.as_deref())?;
    *TOKEN.lock().unwrap() = Some(token);
    Ok(())
}

fn token() -> Option<String> {
    TOKEN.lock().unwrap().get_or_insert_with(crate::accounts::ntfy_token).clone()
}

pub fn has_token() -> bool {
    token().is_some()
}

/// Away from the computer: no input for a while (or, where that's unknown, the app in the background).
fn away(app: &AppHandle, after_secs: u64) -> bool {
    match crate::idle_seconds() {
        Some(idle) => idle >= after_secs,
        None => !app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false),
    }
}

/// Forwards a notification, if ntfy is set up (and you're away, when that's asked for).
pub fn forward(app: &AppHandle, title: &str, body: &str, kind: Kind) {
    let Some(prefs) = PREFS.lock().unwrap().clone() else { return };
    if prefs.only_away && !away(app, prefs.away_after_secs) {
        return;
    }
    let (new_message, meeting) = {
        let state = app.state::<AppState>();
        let engine = state.engine.lock().unwrap();
        (engine.texts().get("ntfy.newMessage", &[]), engine.texts().get("ntfy.meeting", &[]))
    };
    let (message, priority, tag) = match kind {
        Kind::Message(NotificationKind::Call) => (body.to_owned(), 5, "telephone_receiver"),
        Kind::Message(k) => (
            if prefs.include_text { body.to_owned() } else { new_message },
            if k == NotificationKind::Mention { 4 } else { 3 },
            "speech_balloon",
        ),
        Kind::Reminder => (body.to_owned(), 4, "calendar"),
    };
    let title = match kind {
        Kind::Reminder if !prefs.include_text => meeting,
        _ => title.to_owned(),
    };
    tauri::async_runtime::spawn(async move {
        if let Err(e) = publish(&prefs, &title, &message, priority, tag).await {
            log::warn!("ntfy: {e}");
        }
    });
}

/// A test message, whether you're away or not.
pub async fn test() -> Result<(), String> {
    let prefs = PREFS.lock().unwrap().clone().ok_or("set a server and topic first")?;
    publish(&prefs, "Trixcomm", "✓ ntfy works", 3, "white_check_mark").await
}

async fn publish(prefs: &Prefs, title: &str, message: &str, priority: u8, tag: &str) -> Result<(), String> {
    // Published as JSON to the server's root, so titles in any language need no header encoding.
    let body = serde_json::json!({ "topic": prefs.topic.trim(), "title": title, "message": message, "priority": priority, "tags": [tag] });
    let mut request = client().post(prefs.server.trim_end_matches('/')).header("Content-Type", "application/json").body(body.to_string());
    if let Some(token) = token() {
        // An access token ("tk_…"), or user:password.
        request = match token.split_once(':') {
            Some((user, password)) => request.basic_auth(user, Some(password)),
            None => request.bearer_auth(token),
        };
    }
    let response = request.send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("the server answered {}", response.status()));
    }
    Ok(())
}

fn client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().timeout(std::time::Duration::from_secs(10)).build().expect("http client"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "needs the internet (publishes to a throwaway topic on ntfy.sh)"]
    fn publishes_to_ntfy() {
        let topic = format!("trixcomm-test-{}", rand::random::<u64>());
        let prefs = Prefs { server: "https://ntfy.sh".into(), topic, only_away: false, away_after_secs: 0, include_text: true };
        tauri::async_runtime::block_on(publish(&prefs, "Ünïcode tïtle", "hello from the test", 3, "speech_balloon")).expect("published");
    }
}
