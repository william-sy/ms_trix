mod accounts;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use futures::StreamExt;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_opener::OpenerExt;
use trix_core::adapter::SecurityStatus;
use trix_core::engine::{ActivityItem, SearchHit, TeamView};
use trix_core::{Account, AccountId, CommandOutput, ConversationId, DirectoryRoom, Member, Presence, Profile, RoomDetails, ConversationView, Effect, Engine, MessageId, MessageView, Outcome, Outgoing, ProtocolAdapter};
use trix_matrix::{Credentials, LoginMethods, MatrixAdapter};

struct AppState {
    engine: Mutex<Engine>,
    data_dir: PathBuf,
}

type CmdResult<T> = Result<T, String>;

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn conv(key: &str) -> CmdResult<ConversationId> {
    ConversationId::from_key(key).ok_or_else(|| format!("bad conversation key {key}"))
}

/// Pushes changed state to the UI and runs adapter side effects.
fn apply(app: &AppHandle, out: Outcome) {
    let state = app.state::<AppState>();
    let (views, adapters): (Vec<ConversationView>, Vec<_>) = {
        let engine = state.engine.lock().unwrap();
        // A team's channel list depends on which rooms we're in, so refresh on any change.
        if out.teams_changed || !out.removed.is_empty() || !out.changed.is_empty() && !engine.teams().is_empty() {
            let _ = app.emit("trix://teams", engine.teams());
        }
        if out.activity_changed {
            let _ = app.emit("trix://activity", engine.activity());
        }
        let views = out.changed.iter().filter_map(|id| engine.view(id)).collect();
        let adapters = out
            .effects
            .iter()
            .map(|fx| {
                let account = match fx {
                    Effect::SendReceipt { conversation, .. } | Effect::SyncMarkedUnread { conversation, .. } => &conversation.account,
                };
                engine.adapter(account)
            })
            .collect();
        (views, adapters)
    };
    if !views.is_empty() {
        let _ = app.emit("trix://conversations", views);
    }
    if !out.removed.is_empty() {
        let _ = app.emit("trix://removed", out.removed.iter().map(|id| id.key()).collect::<Vec<_>>());
    }
    if !out.new_messages.is_empty() {
        let _ = app.emit("trix://messages", &out.new_messages);
    }
    for n in &out.notifications {
        use tauri_plugin_notification::NotificationExt;
        if let Err(e) = app.notification().builder().title(&n.title).body(&n.body).show() {
            log::warn!("notification failed: {e}");
        }
    }
    for (effect, adapter) in out.effects.into_iter().zip(adapters) {
        let Some(adapter) = adapter else { continue };
        tauri::async_runtime::spawn(async move {
            let result = match &effect {
                Effect::SendReceipt { conversation, thread_root, up_to } => adapter.send_read_receipt(conversation, thread_root.as_ref(), up_to).await,
                Effect::SyncMarkedUnread { conversation, value } => adapter.set_marked_unread(conversation, *value).await,
            };
            if let Err(e) = result {
                log::warn!("{effect:?} failed: {e}");
            }
        });
    }
}

fn merge(into: &mut Outcome, out: Outcome) {
    for id in out.changed {
        if !into.changed.contains(&id) {
            into.changed.push(id);
        }
    }
    into.removed.extend(out.removed);
    into.new_messages.extend(out.new_messages);
    into.effects.extend(out.effects);
}

async fn start(app: AppHandle, adapter: Arc<dyn ProtocolAdapter>) -> CmdResult<()> {
    app.state::<AppState>().engine.lock().unwrap().add_adapter(adapter.clone());
    let stream = adapter.start().await.map_err(|e| e.to_string())?;
    let _ = app.emit("trix://accounts", app.state::<AppState>().engine.lock().unwrap().accounts());
    // Pick up name/avatar changes made elsewhere since the last run.
    {
        let (app, adapter) = (app.clone(), adapter.clone());
        tauri::async_runtime::spawn(async move {
            if let Ok(account) = adapter.refresh_profile().await {
                let _ = accounts::update_profile(&app.state::<AppState>().data_dir, &account);
                let _ = app.emit("trix://accounts", app.state::<AppState>().engine.lock().unwrap().accounts());
            }
        });
    }
    tauri::async_runtime::spawn(async move {
        // Batch whatever is ready so an initial sync doesn't flood the UI.
        let mut chunks = stream.ready_chunks(512);
        while let Some(events) = chunks.next().await {
            let mut combined = Outcome::default();
            {
                let state = app.state::<AppState>();
                let mut engine = state.engine.lock().unwrap();
                for ev in events {
                    merge(&mut combined, engine.handle(ev, now()));
                }
            }
            apply(&app, combined);
        }
    });
    Ok(())
}

#[tauri::command]
fn accounts(state: State<AppState>) -> Vec<Account> {
    state.engine.lock().unwrap().accounts()
}

#[tauri::command]
async fn login_methods(homeserver: String) -> CmdResult<LoginMethods> {
    trix_matrix::login_methods(homeserver.trim()).await.map_err(|e| e.to_string())
}

async fn finish_login(app: &AppHandle, result: trix_core::adapter::Result<(Arc<MatrixAdapter>, Vec<u8>)>) -> CmdResult<Account> {
    let (adapter, blob) = result.map_err(|e| e.to_string())?;
    let account = adapter.account().clone();
    accounts::add(&app.state::<AppState>().data_dir, &account, &blob)?;
    start(app.clone(), adapter).await?;
    Ok(account)
}

#[tauri::command]
async fn login_password(app: AppHandle, homeserver: String, username: String, password: String) -> CmdResult<Account> {
    let data_dir = app.state::<AppState>().data_dir.clone();
    let result = MatrixAdapter::login(&data_dir, homeserver.trim(), Credentials::Password { username: username.trim(), password: &password }).await;
    finish_login(&app, result).await
}

#[tauri::command]
async fn login_sso(app: AppHandle, homeserver: String, identity_provider: Option<String>) -> CmdResult<Account> {
    let data_dir = app.state::<AppState>().data_dir.clone();
    let opener = app.clone();
    let open_url = Box::new(move |url: String| {
        opener.opener().open_url(url, None::<&str>).map_err(|e| trix_core::adapter::AdapterError::Other(e.to_string()))
    });
    let result = MatrixAdapter::login(&data_dir, homeserver.trim(), Credentials::Sso { identity_provider, open_url }).await;
    finish_login(&app, result).await
}

#[tauri::command]
async fn sign_out(app: AppHandle, account: String) -> CmdResult<()> {
    let account = AccountId(account);
    let state = app.state::<AppState>();
    let (adapter, out) = state.engine.lock().unwrap().remove_account(&account);
    if let Some(adapter) = adapter {
        let _ = adapter.stop().await;
    }
    accounts::remove(&state.data_dir, &account)?;
    apply(&app, out);
    let _ = app.emit("trix://accounts", state.engine.lock().unwrap().accounts());
    Ok(())
}

#[tauri::command]
fn teams(state: State<AppState>) -> Vec<TeamView> {
    state.engine.lock().unwrap().teams()
}

#[tauri::command]
fn search_messages(state: State<AppState>, query: String) -> Vec<SearchHit> {
    state.engine.lock().unwrap().search(&query, 30)
}

#[tauri::command]
fn activity(state: State<AppState>) -> Vec<ActivityItem> {
    state.engine.lock().unwrap().activity()
}

#[tauri::command]
fn conversations(state: State<AppState>) -> Vec<ConversationView> {
    state.engine.lock().unwrap().conversations()
}

#[tauri::command]
fn messages(state: State<AppState>, key: String) -> CmdResult<Vec<MessageView>> {
    Ok(state.engine.lock().unwrap().messages(&conv(&key)?))
}

#[tauri::command]
async fn send(state: State<'_, AppState>, key: String, text: String, emote: bool, reply_to: Option<String>, thread_root: Option<String>, mentions: Vec<String>) -> CmdResult<()> {
    let id = conv(&key)?;
    let adapter = state.engine.lock().unwrap().adapter(&id.account).ok_or("account not signed in")?;
    let message = Outgoing { text, emote, reply_to: reply_to.map(MessageId), thread_root: thread_root.map(MessageId), mentions };
    adapter.send(&id, message).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Fetches the page before the oldest loaded message; the UI re-reads `messages`.
#[tauri::command]
async fn load_older(app: AppHandle, key: String) -> CmdResult<bool> {
    let id = conv(&key)?;
    let adapter = app.state::<AppState>().engine.lock().unwrap().adapter(&id.account).ok_or("account not signed in")?;
    let history = adapter.load_older(&id, 40).await.map_err(|e| e.to_string())?;
    let has_more = history.has_more;
    let out = app.state::<AppState>().engine.lock().unwrap().add_history(&id, history);
    apply(&app, out);
    Ok(has_more)
}

#[tauri::command]
async fn load_thread(app: AppHandle, key: String, root: String) -> CmdResult<()> {
    let id = conv(&key)?;
    let adapter = app.state::<AppState>().engine.lock().unwrap().adapter(&id.account).ok_or("account not signed in")?;
    let history = adapter.load_thread(&id, &MessageId(root)).await.map_err(|e| e.to_string())?;
    let out = app.state::<AppState>().engine.lock().unwrap().add_history(&id, history);
    apply(&app, out);
    Ok(())
}

/// Adds our reaction, or removes it if we already reacted with this emoji.
#[tauri::command]
async fn toggle_reaction(state: State<'_, AppState>, key: String, target: String, emoji: String) -> CmdResult<()> {
    let id = conv(&key)?;
    let target = MessageId(target);
    let (adapter, existing) = {
        let engine = state.engine.lock().unwrap();
        (engine.adapter(&id.account).ok_or("account not signed in")?, engine.own_reaction(&id, &target, &emoji))
    };
    match existing {
        Some(reaction) => adapter.redact(&id, &reaction).await,
        None => adapter.react(&id, &target, &emoji).await,
    }
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn edit_message(state: State<'_, AppState>, key: String, target: String, text: String) -> CmdResult<()> {
    let id = conv(&key)?;
    let adapter = state.engine.lock().unwrap().adapter(&id.account).ok_or("account not signed in")?;
    adapter.edit(&id, &MessageId(target), &text).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_message(state: State<'_, AppState>, key: String, target: String) -> CmdResult<()> {
    let id = conv(&key)?;
    let adapter = state.engine.lock().unwrap().adapter(&id.account).ok_or("account not signed in")?;
    adapter.redact(&id, &MessageId(target)).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn members(state: State<'_, AppState>, key: String) -> CmdResult<Vec<Member>> {
    let id = conv(&key)?;
    let adapter = state.engine.lock().unwrap().adapter(&id.account).ok_or("account not signed in")?;
    adapter.members(&id).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn run_command(state: State<'_, AppState>, key: String, name: String, args: String) -> CmdResult<CommandOutput> {
    let id = conv(&key)?;
    let adapter = state.engine.lock().unwrap().adapter(&id.account).ok_or("account not signed in")?;
    adapter.command(&id, &name, &args).await.map_err(|e| e.to_string())
}

async fn send_path(state: &AppState, key: &str, path: &std::path::Path, caption: Option<&str>) -> CmdResult<()> {
    let id = conv(key)?;
    let adapter = state.engine.lock().unwrap().adapter(&id.account).ok_or("account not signed in")?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
    let data = std::fs::read(path).map_err(|e| format!("could not read {name}: {e}"))?;
    adapter.send_file(&id, &name, None, data, caption).await.map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct PickedFile {
    path: String,
    name: String,
    size: u64,
}

fn describe(path: std::path::PathBuf) -> PickedFile {
    PickedFile {
        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into()),
        size: std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
        path: path.to_string_lossy().into_owned(),
    }
}

/// Attach button: native picker. Files are only staged; nothing is sent yet.
#[tauri::command]
async fn pick_files(app: AppHandle) -> CmdResult<Vec<PickedFile>> {
    use tauri_plugin_dialog::DialogExt;

    let dialog = app.dialog().file();
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_files()).await.map_err(|e| e.to_string())?;
    Ok(picked.unwrap_or_default().into_iter().filter_map(|p| p.into_path().ok()).map(describe).collect())
}

/// Size/name for dropped paths, so they can be staged like picked ones.
#[tauri::command]
fn describe_files(paths: Vec<String>) -> Vec<PickedFile> {
    paths.into_iter().map(|p| describe(p.into())).collect()
}

/// Small image previews for staged files (the webview can't read local paths).
#[tauri::command]
fn file_preview(path: String) -> CmdResult<Vec<u8>> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 15 * 1024 * 1024 {
        return Err("too large to preview".into());
    }
    std::fs::read(&path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn send_file_paths(state: State<'_, AppState>, key: String, paths: Vec<String>, caption: Option<String>) -> CmdResult<()> {
    let last = paths.len().saturating_sub(1);
    for (i, path) in paths.iter().enumerate() {
        // One caption for the batch, on the last file.
        let caption = if i == last { caption.as_deref() } else { None };
        send_path(&state, &key, std::path::Path::new(path), caption).await?;
    }
    Ok(())
}

/// Pasted images (the clipboard gives bytes, not a path).
#[tauri::command]
async fn send_file_bytes(state: State<'_, AppState>, key: String, name: String, mime: Option<String>, data: Vec<u8>, caption: Option<String>) -> CmdResult<()> {
    let id = conv(&key)?;
    let adapter = state.engine.lock().unwrap().adapter(&id.account).ok_or("account not signed in")?;
    adapter.send_file(&id, &name, mime.as_deref(), data, caption.as_deref()).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_presence(state: State<'_, AppState>, account: String, presence: Presence, status: Option<String>) -> CmdResult<()> {
    adapter_for(&state, &account)?.set_presence(presence, status.filter(|s| !s.trim().is_empty())).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn accept_invite(state: State<'_, AppState>, key: String) -> CmdResult<()> {
    let id = conv(&key)?;
    adapter_for(&state, &id.account.0)?.accept_invite(&id).await.map_err(|e| e.to_string())
}

/// Leaves a room or chat, or declines an invite (the same thing in Matrix).
#[tauri::command]
async fn leave(state: State<'_, AppState>, key: String) -> CmdResult<()> {
    let id = conv(&key)?;
    adapter_for(&state, &id.account.0)?.leave(&id).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn search_users(state: State<'_, AppState>, account: String, term: String) -> CmdResult<Vec<Member>> {
    adapter_for(&state, &account)?.search_users(term.trim()).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_chat(state: State<'_, AppState>, account: String, users: Vec<String>, name: Option<String>) -> CmdResult<CommandOutput> {
    adapter_for(&state, &account)?.create_chat(&users, name.as_deref()).await.map_err(|e| e.to_string())
}

/// Join by address or id, e.g. from the New chat or Browse dialogs.
#[tauri::command]
async fn join_room(state: State<'_, AppState>, account: String, address: String, via: Option<String>) -> CmdResult<CommandOutput> {
    adapter_for(&state, &account)?.join_room(&address, via.as_deref()).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn directory(state: State<'_, AppState>, account: String, server: Option<String>, term: String, spaces: bool) -> CmdResult<Vec<DirectoryRoom>> {
    adapter_for(&state, &account)?.directory(server.as_deref(), &term, spaces).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn space_rooms(state: State<'_, AppState>, account: String, space: String) -> CmdResult<Vec<DirectoryRoom>> {
    adapter_for(&state, &account)?.space_rooms(&space).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn home_server(state: State<AppState>, account: String) -> CmdResult<Option<String>> {
    Ok(adapter_for(&state, &account)?.home_server())
}

#[tauri::command]
async fn profile(state: State<'_, AppState>, account: String, user_id: String) -> CmdResult<Profile> {
    adapter_for(&state, &account)?.profile(&user_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn room_details(state: State<'_, AppState>, key: String) -> CmdResult<RoomDetails> {
    let id = conv(&key)?;
    adapter_for(&state, &id.account.0)?.room_details(&id).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn update_room(state: State<'_, AppState>, key: String, name: Option<String>, topic: Option<String>) -> CmdResult<()> {
    let id = conv(&key)?;
    let adapter = adapter_for(&state, &id.account.0)?;
    if let Some(name) = name {
        adapter.set_room_name(&id, &name).await.map_err(|e| e.to_string())?;
    }
    if let Some(topic) = topic {
        adapter.set_room_topic(&id, &topic).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Picks an image and makes it the room picture.
#[tauri::command]
async fn pick_room_avatar(app: AppHandle, key: String) -> CmdResult<bool> {
    use tauri_plugin_dialog::DialogExt;

    let id = conv(&key)?;
    let adapter = adapter_for(&app.state::<AppState>(), &id.account.0)?;
    let dialog = app.dialog().file().add_filter("Images", &["png", "jpg", "jpeg", "gif", "webp"]);
    let Some(path) = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_file()).await.map_err(|e| e.to_string())? else {
        return Ok(false);
    };
    let path = path.into_path().map_err(|e| e.to_string())?;
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    let mime = match path.extension().and_then(|e| e.to_str()).map(str::to_lowercase).as_deref() {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        _ => "image/png",
    };
    adapter.set_room_avatar(&id, Some(mime), data).await.map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
async fn set_notification_level(state: State<'_, AppState>, key: String, level: String) -> CmdResult<()> {
    let id = conv(&key)?;
    adapter_for(&state, &id.account.0)?.set_notification_level(&id, &level).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn invite_user(state: State<'_, AppState>, key: String, user_id: String) -> CmdResult<()> {
    let id = conv(&key)?;
    adapter_for(&state, &id.account.0)?.invite(&id, &user_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> CmdResult<()> {
    // Only web and mail links; never file:// or custom schemes from message content.
    if !(url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:")) {
        return Err("unsupported link".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_typing(state: State<'_, AppState>, key: String, typing: bool) -> CmdResult<()> {
    let id = conv(&key)?;
    let adapter = state.engine.lock().unwrap().adapter(&id.account).ok_or("account not signed in")?;
    adapter.set_typing(&id, typing).await.map_err(|e| e.to_string())
}

/// Asks where to save and writes the (decrypted) file there.
#[tauri::command]
async fn save_media(app: AppHandle, account: String, media: String, name: String) -> CmdResult<bool> {
    use tauri_plugin_dialog::DialogExt;

    let adapter = adapter_for(&app.state::<AppState>(), &account)?;
    let dialog = app.dialog().file().set_file_name(&name);
    let Some(path) = tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file()).await.map_err(|e| e.to_string())? else {
        return Ok(false); // cancelled
    };
    let path = path.into_path().map_err(|e| e.to_string())?;
    let bytes = adapter.fetch_media(&media, None).await.map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Opens the file in the default app (Preview, Photos, ...) via a temp copy.
#[tauri::command]
async fn open_media(app: AppHandle, account: String, media: String, name: String) -> CmdResult<()> {
    let adapter = adapter_for(&app.state::<AppState>(), &account)?;
    let bytes = adapter.fetch_media(&media, None).await.map_err(|e| e.to_string())?;
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("opened");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Keep only the file name part so a hostile name can't escape the folder.
    let safe = std::path::Path::new(&name).file_name().map(|n| n.to_owned()).unwrap_or_else(|| "file".into());
    let path = dir.join(safe);
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    app.opener().open_path(path.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

/// Serves `trixmedia://localhost/<account>/<media id>?w=&h=` so the UI can use
/// plain <img> tags for avatars and (encrypted) images.
async fn serve_media(app: AppHandle, request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Response, StatusCode};

    let fail = |status: StatusCode| Response::builder().status(status).body(Vec::new()).unwrap();
    let path = percent_encoding::percent_decode_str(request.uri().path().trim_start_matches('/')).decode_utf8_lossy().into_owned();
    let Some((account, media)) = path.split_once('/') else { return fail(StatusCode::BAD_REQUEST) };
    let param = |name: &str| {
        request.uri().query()?.split('&').find_map(|kv| kv.strip_prefix(name)?.strip_prefix('=')?.parse::<u32>().ok())
    };
    let thumbnail = param("w").zip(param("h"));
    let Some(adapter) = app.state::<AppState>().engine.lock().unwrap().adapter(&AccountId(account.to_owned())) else {
        return fail(StatusCode::NOT_FOUND);
    };
    // The message's own mime type (passed as ?type=) beats sniffing, e.g. for audio.
    let declared = request.uri().query().and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("type="))).map(|m| percent_encoding::percent_decode_str(m).decode_utf8_lossy().into_owned());
    match adapter.fetch_media(media, thumbnail).await {
        Ok(bytes) => {
            let mime = declared.unwrap_or_else(|| sniff_mime(&bytes).to_owned());
            // Video/audio players ask for byte ranges (WebKit won't play video otherwise).
            let range = request.headers().get(header::RANGE).and_then(|v| v.to_str().ok()).and_then(|v| parse_range(v, bytes.len()));
            match range {
                Some((start, end)) => Response::builder()
                    .status(StatusCode::PARTIAL_CONTENT)
                    .header(header::CONTENT_TYPE, mime)
                    .header(header::ACCEPT_RANGES, "bytes")
                    .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{}", bytes.len()))
                    .body(bytes[start..=end].to_vec())
                    .unwrap(),
                None => Response::builder()
                    .header(header::CONTENT_TYPE, mime)
                    .header(header::ACCEPT_RANGES, "bytes")
                    .header(header::CACHE_CONTROL, "max-age=86400")
                    .body(bytes)
                    .unwrap(),
            }
        }
        Err(e) => {
            log::warn!("media {media}: {e}");
            fail(StatusCode::BAD_GATEWAY)
        }
    }
}

fn sniff_mime(bytes: &[u8]) -> &'static str {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => "image/png",
        [0xFF, 0xD8, 0xFF, ..] => "image/jpeg",
        [b'G', b'I', b'F', b'8', ..] => "image/gif",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "image/webp",
        [_, _, _, _, b'f', b't', b'y', b'p', b'M', b'4', b'A', ..] => "audio/mp4",
        [_, _, _, _, b'f', b't', b'y', b'p', b'q', b't', ..] => "video/quicktime",
        [_, _, _, _, b'f', b't', b'y', b'p', ..] => "video/mp4",
        [0x1A, 0x45, 0xDF, 0xA3, ..] => "video/webm",
        [b'O', b'g', b'g', b'S', ..] => "audio/ogg",
        [b'I', b'D', b'3', ..] | [0xFF, 0xFB, ..] | [0xFF, 0xF3, ..] => "audio/mpeg",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'A', b'V', b'E', ..] => "audio/wav",
        _ => "application/octet-stream",
    }
}

/// `bytes=start-end` / `bytes=start-` / `bytes=-suffix` -> inclusive range within `len`.
fn parse_range(header: &str, len: usize) -> Option<(usize, usize)> {
    let spec = header.strip_prefix("bytes=")?.split(',').next()?.trim();
    let (start, end) = spec.split_once('-')?;
    if len == 0 {
        return None;
    }
    let (start, end) = match (start.parse::<usize>().ok(), end.parse::<usize>().ok()) {
        (Some(s), Some(e)) => (s, e.min(len - 1)),
        (Some(s), None) => (s, len - 1),
        (None, Some(suffix)) => (len.saturating_sub(suffix), len - 1),
        (None, None) => return None,
    };
    (start <= end).then_some((start, end))
}

#[tauri::command]
fn focus(app: AppHandle, key: Option<String>) -> CmdResult<()> {
    let id = key.as_deref().map(conv).transpose()?;
    let out = app.state::<AppState>().engine.lock().unwrap().focus(id, now());
    apply(&app, out);
    Ok(())
}

#[tauri::command]
fn mark_unread(app: AppHandle, key: String) -> CmdResult<()> {
    let out = app.state::<AppState>().engine.lock().unwrap().mark_unread(&conv(&key)?, now());
    apply(&app, out);
    Ok(())
}

#[tauri::command]
fn mark_read(app: AppHandle, key: String) -> CmdResult<()> {
    let out = app.state::<AppState>().engine.lock().unwrap().mark_read(&conv(&key)?, now());
    apply(&app, out);
    Ok(())
}

#[tauri::command]
async fn set_favourite(state: State<'_, AppState>, key: String, value: bool) -> CmdResult<()> {
    let id = conv(&key)?;
    let adapter = state.engine.lock().unwrap().adapter(&id.account).ok_or("account not signed in")?;
    adapter.set_favourite(&id, value).await.map_err(|e| e.to_string())
}

fn adapter_for(state: &AppState, account: &str) -> CmdResult<Arc<dyn ProtocolAdapter>> {
    state.engine.lock().unwrap().adapter(&AccountId(account.to_owned())).ok_or_else(|| "account not signed in".to_owned())
}

#[tauri::command]
async fn security_status(state: State<'_, AppState>, account: String) -> CmdResult<SecurityStatus> {
    adapter_for(&state, &account)?.security_status().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn recover(state: State<'_, AppState>, account: String, recovery_key: String) -> CmdResult<SecurityStatus> {
    let adapter = adapter_for(&state, &account)?;
    adapter.recover(&recovery_key).await.map_err(|e| e.to_string())?;
    adapter.security_status().await.map_err(|e| e.to_string())
}

/// Brings back every saved account; failures are reported to the UI per account.
async fn restore_all(app: AppHandle) {
    let data_dir = app.state::<AppState>().data_dir.clone();
    for account in accounts::load(&data_dir) {
        let result = async {
            let blob = accounts::session(&account.id)?;
            let adapter = MatrixAdapter::restore(&data_dir, account.clone(), &blob).await.map_err(|e| e.to_string())?;
            start(app.clone(), adapter).await
        }
        .await;
        if let Err(e) = result {
            log::error!("could not restore {}: {e}", account.user_id);
            let _ = app.emit("trix://account-error", (account.user_id.clone(), e));
        }
    }
    let _ = app.emit("trix://restored", ());
}

#[tauri::command]
fn restored(state: State<AppState>) -> bool {
    state.engine.lock().unwrap().accounts().len() == accounts::load(&state.data_dir).len()
}

#[cfg(test)]
mod tests {
    use super::parse_range;

    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=0-1", 10), Some((0, 1)));
        assert_eq!(parse_range("bytes=5-", 10), Some((5, 9)));
        assert_eq!(parse_range("bytes=-3", 10), Some((7, 9)));
        assert_eq!(parse_range("bytes=8-100", 10), Some((8, 9)));
        assert_eq!(parse_range("bytes=11-12", 10), None);
        assert_eq!(parse_range("items=0-1", 10), None);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("trixmedia", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn(async move { responder.respond(serve_media(app, request).await) });
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            app.manage(AppState { engine: Mutex::new(Engine::new()), data_dir });
            tauri::async_runtime::spawn(restore_all(app.handle().clone()));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(focused) = event {
                let app = window.app_handle();
                let out = app.state::<AppState>().engine.lock().unwrap().set_window_focused(*focused, now());
                apply(app, out);
            }
        })
        .invoke_handler(tauri::generate_handler![
            accounts,
            login_methods,
            login_password,
            login_sso,
            sign_out,
            conversations,
            teams,
            activity,
            search_messages,
            messages,
            send,
            focus,
            mark_unread,
            mark_read,
            set_favourite,
            restored,
            security_status,
            recover,
            set_typing,
            load_older,
            load_thread,
            open_url,
            toggle_reaction,
            set_presence,
            profile,
            room_details,
            update_room,
            pick_room_avatar,
            set_notification_level,
            invite_user,
            accept_invite,
            leave,
            search_users,
            create_chat,
            join_room,
            directory,
            space_rooms,
            home_server,
            members,
            run_command,
            pick_files,
            describe_files,
            file_preview,
            send_file_paths,
            send_file_bytes,
            edit_message,
            delete_message,
            save_media,
            open_media,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ms_trix");
}
