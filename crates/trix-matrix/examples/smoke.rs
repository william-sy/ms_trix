//! Signs in to a real homeserver and prints what the adapter emits.
//!
//!   MATRIX_HS=matrix.org MATRIX_USER=alice MATRIX_PASSWORD=... \
//!     cargo run -p trix-matrix --example smoke
//!
//! Dev only: the session blob is saved in plain text under ./.smoke so reruns
//! reuse the same device instead of creating a new one each time. The real
//! app keeps it in the OS keychain.

use std::path::Path;

use futures::StreamExt;
use trix_core::{Account, AdapterEvent, MessageBody, ProtocolAdapter};
use trix_matrix::{Credentials, MatrixAdapter};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = Path::new(".smoke");
    let blob_path = data_dir.join("session.json");
    let account_path = data_dir.join("account.json");

    let adapter = if blob_path.exists() {
        let account: Account = serde_json::from_slice(&std::fs::read(&account_path)?)?;
        MatrixAdapter::restore(data_dir, account, &std::fs::read(&blob_path)?).await?
    } else {
        let hs = std::env::var("MATRIX_HS")?;
        let user = std::env::var("MATRIX_USER")?;
        let password = std::env::var("MATRIX_PASSWORD")?;
        let (adapter, blob) = MatrixAdapter::login(data_dir, &hs, Credentials::Password { username: &user, password: &password }).await?;
        std::fs::write(&blob_path, blob)?;
        std::fs::write(&account_path, serde_json::to_vec(&adapter.account())?)?;
        adapter
    };

    if let Ok(key) = std::env::var("MATRIX_RECOVERY_KEY") {
        adapter.recover(&key).await?;
        println!("history keys recovered");
    }

    let a = adapter.account();
    println!("signed in as {} ({}) on org {}", a.display_name, a.user_id, a.org_name);

    let mut events = adapter.start().await?;
    while let Some(ev) = events.next().await {
        match ev {
            AdapterEvent::ConversationUpserted(c) => println!("[room]    {:?} {} {}", c.kind, c.name, if c.encrypted { "🔒" } else { "" }),
            AdapterEvent::Message(m) => {
                let text = match &m.body {
                    MessageBody::Text { plain, .. } | MessageBody::Notice { plain } => plain.clone(),
                    MessageBody::File { name, .. } => format!("📎 {name}"),
                    MessageBody::Redacted => "(deleted)".to_owned(),
                    MessageBody::Encrypted => "(waiting for key)".to_owned(),
                    MessageBody::Event { kind, actor, .. } => format!("({actor}: {kind:?})"),
                };
                let thread = if m.thread_root.is_some() { " (thread)" } else { "" };
                println!("[msg]     #{} {}: {}{}", m.pos, m.sender_name, text.lines().next().unwrap_or(""), thread);
            }
            AdapterEvent::OwnReadReceipt { conversation, pos, thread_root, .. } => {
                println!("[receipt] {} up to #{pos}{}", conversation.remote, if thread_root.is_some() { " (thread)" } else { "" })
            }
            AdapterEvent::MarkedUnread { conversation, value, .. } => println!("[marked]  {} = {value}", conversation.remote),
            other => println!("[other]   {other:?}"),
        }
    }
    Ok(())
}
