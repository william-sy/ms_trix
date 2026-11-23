//! Updates: new versions come from GitHub Releases (`latest.json` next to the installers, made
//! by the release workflow), checked against the update key in tauri.conf.json before they're
//! installed. Only in release builds: a development build isn't an installed app to replace.

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    /// The release's notes (Markdown), if it has any.
    pub notes: Option<String>,
}

async fn find(app: &AppHandle) -> Result<Option<Update>, String> {
    if cfg!(debug_assertions) {
        return Err("updates only work in an installed app, not in a development build".into());
    }
    app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())
}

/// A newer version than this one, if there is one.
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let update = find(&app).await?;
    if let Some(u) = &update {
        log::info!("update available: {} (running {})", u.version, u.current_version);
    }
    Ok(update.map(|u| UpdateInfo { version: u.version, notes: u.body }))
}

/// Downloads and installs the newest version, then starts it. Progress (0–100) goes out as
/// "trix://update-progress". On Windows the installer closes the app and starts it again itself.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let update = find(&app).await?.ok_or("no update available")?;
    log::info!("installing update {}", update.version);
    let progress = app.clone();
    let (mut received, mut shown) = (0u64, u64::MAX);
    update
        .download_and_install(
            move |chunk, total| {
                received += chunk as u64;
                if let Some(total) = total.filter(|t| *t > 0) {
                    let percent = received * 100 / total;
                    if percent != shown {
                        shown = percent;
                        let _ = progress.emit("trix://update-progress", percent);
                    }
                }
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    log::info!("update installed; restarting");
    app.restart();
}
