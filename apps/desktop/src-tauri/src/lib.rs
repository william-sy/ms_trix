mod audio_out;
mod links;
mod ntfy;
mod scheduled;
mod spell;
mod accounts;
mod search;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use futures::StreamExt;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_opener::OpenerExt;
use trix_core::adapter::SecurityStatus;
use trix_core::engine::{ActivityItem, NotificationKind, NotifyPrefs, SearchHit, TeamView};
use trix_core::{Account, AccountId, VerificationAction, DeviceAuth, DeviceInfo, SignOutDevice, CommandOutput, ConversationId, DirectoryRoom, Member, Presence, Profile, RoomDetails, ConversationView, Effect, Engine, MessageId, MessageView, Outcome, Outgoing, ProtocolAdapter};
use trix_matrix::{Credentials, LoginMethods, MatrixAdapter};

struct AppState {
    engine: Mutex<Engine>,
    data_dir: PathBuf,
    sounds: Mutex<Sounds>,
    /// (share read receipts, share typing), applied to every account.
    privacy: Mutex<(bool, bool)>,
    /// Closing the main window hides it to the tray instead of quitting.
    close_to_tray: std::sync::atomic::AtomicBool,
    /// Encrypted local full-text index; None when the keychain isn't available.
    search: Option<Arc<trix_search::SearchIndex>>,
    /// The chat list changed since it was last saved (see `save_chat_list`).
    chat_list_dirty: std::sync::atomic::AtomicBool,
    /// Unread count and tooltip for the tray icon, kept for when it's (re)built.
    tray_unread: Mutex<(u32, String)>,
    /// Do not disturb until this time (ms since 1970; 0: off): no system notifications or sounds.
    dnd_until: std::sync::atomic::AtomicU64,
}

/// Notification sound per kind: "none", "default" (the OS sound) or, on
/// macOS, a system sound name like "Glass".
#[derive(Clone, serde::Deserialize)]
struct Sounds {
    message: String,
    mention: String,
    call: String,
}

impl Default for Sounds {
    fn default() -> Self {
        Self { message: "default".into(), mention: "default".into(), call: "default".into() }
    }
}

fn do_not_disturb(app: &AppHandle) -> bool {
    now() < app.state::<AppState>().dnd_until.load(std::sync::atomic::Ordering::Relaxed)
}

fn show_notification(app: &AppHandle, title: &str, body: &str, kind: NotificationKind) {
    if !do_not_disturb(app) {
        present_notification(app, title, body, kind);
        ntfy::forward(app, title, body, ntfy::Kind::Message(kind));
    }
}

/// A system notification with its sound, also during do not disturb (a test from Settings).
fn present_notification(app: &AppHandle, title: &str, body: &str, kind: NotificationKind) {
    use tauri_plugin_notification::NotificationExt;
    let sounds = app.state::<AppState>().sounds.lock().unwrap().clone();
    let sound = match kind {
        NotificationKind::Message => sounds.message,
        NotificationKind::Mention => sounds.mention,
        NotificationKind::Call => sounds.call,
    };
    let mut builder = app.notification().builder().title(title).body(body);
    match sound.as_str() {
        "none" => {}
        // macOS notifications don't reliably play their sound (not at all for
        // unsigned/dev builds), so ms_trix plays it itself.
        name if cfg!(target_os = "macos") => play_mac_sound(name),
        "default" => {
            builder = builder.sound(if cfg!(target_os = "macos") {
                "NSUserNotificationDefaultSoundName"
            } else if cfg!(target_os = "windows") {
                "Default"
            } else {
                "message-new-instant"
            })
        }
        name => builder = builder.sound(name),
    }
    if let Err(e) = builder.show() {
        log::warn!("notification failed: {e}");
    }
}

type CmdResult<T> = Result<T, String>;

const SHARE_BORDER: &str = "share-border";
const SHARE_BAR: &str = "share-bar";
/// Drawing on the shared screen: unlike the border and bar this layer is captured, so others see it.
const SHARE_DRAW: &str = "share-draw";

/// While sharing your screen: a red border around the shared screen (when a whole screen is
/// shared) and a small "Stop sharing" bar at its top. Both are kept out of screen captures,
/// so the people watching don't see them. `width`/`height` (the capture's size) find the screen;
/// otherwise the one the app is on.
#[tauri::command]
async fn share_overlay(app: AppHandle, border: bool, width: u32, height: u32) -> CmdResult<()> {
    close_share_overlay(&app);
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let fits = |m: &tauri::Monitor| {
        let (size, scale) = (m.size(), m.scale_factor());
        (size.width, size.height) == (width, height)
            || ((size.width as f64 / scale).round() as u32, (size.height as f64 / scale).round() as u32) == (width, height)
    };
    let current = app.get_webview_window("main").and_then(|w| w.current_monitor().ok().flatten());
    let monitor = monitors.iter().find(|m| fits(m)).cloned().or(current).or_else(|| monitors.first().cloned()).ok_or("no screen")?;
    let scale = monitor.scale_factor();
    let pos = monitor.position().to_logical::<f64>(scale);
    let size = monitor.size().to_logical::<f64>(scale);
    let overlay = |label: &str, hash: &str| {
        tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::App(format!("index.html#{hash}").into()))
            .title("ms_trix")
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .resizable(false)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .skip_taskbar(true)
            .focused(false)
            .accept_first_mouse(true)
            .content_protected(label != SHARE_DRAW)
    };
    // Made in this order so the bar sits above the drawing layer, and that above the border.
    if border {
        for label in [SHARE_BORDER, SHARE_DRAW] {
            let window = overlay(label, label).position(pos.x, pos.y).inner_size(size.width, size.height).build().map_err(|e| e.to_string())?;
            let _ = window.set_ignore_cursor_events(true);
        }
    }
    // Drawing needs the whole screen (we don't know where a shared window is).
    let (bar_w, bar_h, hash) = if border { (600.0, 52.0, "share-bar:draw") } else { (360.0, 52.0, "share-bar") };
    overlay(SHARE_BAR, hash)
        .position(pos.x + (size.width - bar_w) / 2.0, pos.y + 40.0)
        .inner_size(bar_w, bar_h)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

const REMINDER_WINDOW: &str = "reminder";
const REMINDER_WIDTH: f64 = 480.0;
/// The window's height for one meeting, and for each one more (double booked).
const REMINDER_ROW: (f64, f64) = (84.0, 52.0);

/// Meeting reminders in a small window in the corner of the screen, on top of other windows
/// (also when ms_trix is hidden or behind them). `reminders` (JSON) is the whole list, `count`
/// rows; an open window gets the new list and grows or shrinks to fit.
#[tauri::command]
async fn open_reminder(app: AppHandle, reminders: String, count: u32) -> CmdResult<()> {
    let monitor = app
        .get_webview_window("main")
        .and_then(|w| w.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
        .ok_or("no screen")?;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let (pos, size) = (area.position.to_logical::<f64>(scale), area.size.to_logical::<f64>(scale));
    let (w, h) = (REMINDER_WIDTH, REMINDER_ROW.0 + REMINDER_ROW.1 * f64::from(count.clamp(1, 8) - 1));
    let position = tauri::LogicalPosition::new(pos.x + size.width - w - 16.0, pos.y + size.height - h - 16.0);
    if let Some(window) = app.get_webview_window(REMINDER_WINDOW) {
        let _ = window.set_size(tauri::LogicalSize::new(w, h));
        let _ = window.set_position(position);
        let _ = app.emit_to(REMINDER_WINDOW, "trix://reminders", reminders);
        return Ok(());
    }
    let hash: String = url::form_urlencoded::byte_serialize(reminders.as_bytes()).collect();
    tauri::WebviewWindowBuilder::new(&app, REMINDER_WINDOW, tauri::WebviewUrl::App(format!("index.html#reminder={hash}").into()))
        .title("ms_trix")
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .focused(false)
        .accept_first_mouse(true)
        .position(position.x, position.y)
        .inner_size(w, h)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn close_reminder(app: AppHandle) {
    if let Some(window) = app.get_webview_window(REMINDER_WINDOW) {
        let _ = window.destroy();
    }
}

/// A button in the reminder window: the app acts on it (and updates or closes the window);
/// Join / Open chat bring the app to the front.
#[tauri::command]
async fn reminder_action(app: AppHandle, action: String, key: String) {
    if action == "join" || action == "chat" {
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.unminimize();
            let _ = main.show();
            let _ = main.set_focus();
        }
    }
    let _ = app.emit_to("main", "trix://reminder", serde_json::json!({ "action": action, "key": key }));
}

fn close_share_overlay(app: &AppHandle) {
    for label in [SHARE_BORDER, SHARE_DRAW, SHARE_BAR] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.destroy();
        }
    }
}

#[tauri::command]
async fn hide_share_overlay(app: AppHandle) {
    close_share_overlay(&app);
}

/// Drawing on the shared screen: `tool` (pen, highlighter, arrow, laser) turns it on and catches
/// the mouse; none hands the mouse back to what's below. The bar and the layer follow "trix://draw".
#[tauri::command]
async fn share_draw(app: AppHandle, tool: Option<String>, color: String) {
    let Some(layer) = app.get_webview_window(SHARE_DRAW) else { return };
    let _ = layer.set_ignore_cursor_events(tool.is_none());
    if tool.is_some() {
        let _ = layer.set_focus();
    }
    raise_share_bar(&app);
    let payload = serde_json::json!({ "tool": tool, "color": color });
    let _ = app.emit_to(SHARE_DRAW, "trix://draw", payload.clone());
    let _ = app.emit_to(SHARE_BAR, "trix://draw", payload);
}

/// Focusing or clicking the drawing layer brings it in front of the bar (same level); put the
/// bar back on top so its buttons stay clickable.
fn raise_share_bar(app: &AppHandle) {
    if let Some(bar) = app.get_webview_window(SHARE_BAR) {
        let _ = bar.show();
    }
}

#[tauri::command]
async fn share_raise_bar(app: AppHandle) {
    raise_share_bar(&app);
}

#[tauri::command]
async fn share_draw_clear(app: AppHandle) {
    let _ = app.emit_to(SHARE_DRAW, "trix://draw-clear", ());
}

/// "Stop sharing" on the bar: the call that is sharing (main window or call window) stops.
#[tauri::command]
async fn stop_sharing(app: AppHandle) {
    close_share_overlay(&app);
    let _ = app.emit("trix://stop-sharing", ());
}

/// A Talk call runs in a webview of its own, so it can move between the app and a window of
/// its own without hanging up: docked in the main window (filling it, or a small card in the
/// corner while minimised) or moved into CALL_POPOUT.
const CALL_WINDOW: &str = "talk-call";
const CALL_POPOUT: &str = "talk-call-window";
const MINI_WIDTH: f64 = 300.0;
const MINI_MARGIN: f64 = 20.0;

struct CallDock {
    popped: bool,
    /// Docked and minimised: the card's height.
    mini: Option<f64>,
    title: String,
}
static CALL_DOCK: Mutex<CallDock> = Mutex::new(CallDock { popped: false, mini: None, title: String::new() });

/// The size of `window`'s content. On macOS read from its content view: Tauri measures a window
/// it thinks has no child webviews (one the call was moved into) by its first webview, so the call
/// would be told to keep the size it came with.
fn content_size(window: &tauri::Window) -> Option<tauri::LogicalSize<f64>> {
    #[cfg(target_os = "macos")]
    {
        let view = window.ns_view().ok()? as usize;
        let (tx, rx) = std::sync::mpsc::channel();
        window
            .run_on_main_thread(move || {
                // SAFETY: the window's own content view, read on the main thread.
                let view = unsafe { &*(view as *const objc2_app_kit::NSView) };
                let _ = tx.send(view.frame().size);
            })
            .ok()?;
        let size = rx.recv().ok()?;
        Some(tauri::LogicalSize::new(size.width, size.height))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let size = window.inner_size().ok()?;
        Some(size.to_logical(window.scale_factor().unwrap_or(1.0)))
    }
}

/// Where the call belongs: filling its own window, or docked in the main window (filling it, or
/// the card in the corner).
fn call_bounds(app: &AppHandle) -> Option<(tauri::Webview, tauri::LogicalPosition<f64>, tauri::LogicalSize<f64>)> {
    let (popped, mini) = {
        let dock = CALL_DOCK.lock().unwrap();
        (dock.popped, dock.mini)
    };
    let window = app.get_window(if popped { CALL_POPOUT } else { "main" })?;
    let webview = app.get_webview(CALL_WINDOW)?;
    let size = content_size(&window)?;
    Some(match mini.filter(|_| !popped) {
        Some(height) => (
            webview,
            tauri::LogicalPosition::new((size.width - MINI_WIDTH - MINI_MARGIN).max(0.0), (size.height - height - MINI_MARGIN).max(0.0)),
            tauri::LogicalSize::new(MINI_WIDTH, height),
        ),
        None => (webview, tauri::LogicalPosition::new(0.0, 0.0), size),
    })
}

/// Puts the call where it belongs (call_bounds). Also after either window is resized.
fn place_call(app: &AppHandle) {
    if let Some((webview, position, size)) = call_bounds(app) {
        let _ = webview.set_bounds(tauri::Rect { position: position.into(), size: size.into() });
    }
}

/// The call's page says how big it is laid out, after a move. WebKit can keep the size it had in
/// the other window although the webview has its new size, and setting that same size again
/// changes nothing: then it's nudged a pixel and back, as resizing the window by hand would.
/// (The page is a little less tall than its place: WebKit keeps it clear of the title bar.)
#[tauri::command]
async fn call_page_size(app: AppHandle, width: f64, height: f64) {
    let Some((webview, position, size)) = call_bounds(&app) else { return };
    if (width - size.width).abs() <= 2.0 && height <= size.height + 2.0 {
        return;
    }
    log::info!("call page is {width:.0}×{height:.0} instead of {:.0}×{:.0}; refitting", size.width, size.height);
    let nudged = tauri::LogicalSize::new(size.width - 1.0, size.height - 1.0);
    let _ = webview.set_bounds(tauri::Rect { position: position.into(), size: nudged.into() });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    place_call(&app);
}

fn call_popout_window(app: &AppHandle, title: &str) -> tauri::Result<tauri::Window> {
    if let Some(window) = app.get_window(CALL_POPOUT) {
        return Ok(window);
    }
    tauri::window::WindowBuilder::new(app, CALL_POPOUT)
        .title(title)
        .inner_size(1000.0, 680.0)
        .min_inner_size(420.0, 320.0)
        .build()
}

/// After moving the call to another window: placed now, and again once the window has settled
/// (a window that was just made can still report its size before macOS has laid it out).
fn place_call_soon(app: &AppHandle) {
    place_call(app);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        place_call(&app);
    });
}

/// Starts a Talk call (`params`, JSON: conversation, name, picture, video, join right away,
/// mic/camera, docked) in the app or in its own window; focuses it if one is running.
#[tauri::command]
async fn open_call_window(app: AppHandle, params: String, title: String, docked: bool) -> CmdResult<()> {
    if app.get_webview(CALL_WINDOW).is_some() {
        focus_call_window(app).await;
        return Ok(());
    }
    let hash: String = url::form_urlencoded::byte_serialize(params.as_bytes()).collect();
    let builder = tauri::webview::WebviewBuilder::new(CALL_WINDOW, tauri::WebviewUrl::App(format!("index.html#talk-call={hash}").into())).transparent(true);
    *CALL_DOCK.lock().unwrap() = CallDock { popped: !docked, mini: None, title: title.clone() };
    let origin = tauri::LogicalPosition::new(0.0, 0.0);
    if docked {
        let main = app.get_window("main").ok_or("no main window")?;
        main.add_child(builder, origin, tauri::LogicalSize::new(800.0, 600.0)).map_err(|e| e.to_string())?;
    } else {
        let window = call_popout_window(&app, &title).map_err(|e| e.to_string())?;
        window.add_child(builder, origin, tauri::LogicalSize::new(1000.0, 680.0)).map_err(|e| e.to_string())?;
    }
    place_call_soon(&app);
    Ok(())
}

/// The running call moves into a window of its own; the connection stays.
#[tauri::command]
async fn pop_out_call(app: AppHandle) -> CmdResult<()> {
    let webview = app.get_webview(CALL_WINDOW).ok_or("no call")?;
    let title = CALL_DOCK.lock().unwrap().title.clone();
    let window = call_popout_window(&app, &title).map_err(|e| e.to_string())?;
    webview.reparent(&window).map_err(|e| e.to_string())?;
    CALL_DOCK.lock().unwrap().popped = true;
    place_call_soon(&app);
    let _ = window.set_focus();
    let _ = app.emit_to(CALL_WINDOW, "trix://call-docked", false);
    Ok(())
}

/// The call's window goes; the call moves back into the app, still connected.
#[tauri::command]
async fn pop_in_call(app: AppHandle) -> CmdResult<()> {
    let webview = app.get_webview(CALL_WINDOW).ok_or("no call")?;
    let main = app.get_window("main").ok_or("no main window")?;
    webview.reparent(&main).map_err(|e| e.to_string())?;
    CALL_DOCK.lock().unwrap().popped = false;
    place_call_soon(&app);
    if let Some(window) = app.get_window(CALL_POPOUT) {
        let _ = window.destroy();
    }
    let _ = main.unminimize();
    let _ = main.show();
    let _ = main.set_focus();
    let _ = app.emit_to(CALL_WINDOW, "trix://call-docked", true);
    Ok(())
}

/// The call screen was minimised or restored: docked, it becomes the card in the corner (of
/// `height`) or fills the app again; in its own window, the window is minimised (while you
/// share your screen) or comes back.
#[tauri::command]
async fn dock_call_window(app: AppHandle, minimized: bool, height: f64) {
    let popped = {
        let mut dock = CALL_DOCK.lock().unwrap();
        dock.mini = minimized.then_some(height);
        dock.popped
    };
    if !popped {
        return place_call(&app);
    }
    if let Some(window) = app.get_window(CALL_POPOUT) {
        let _ = if minimized { window.minimize() } else { window.unminimize() };
    }
}

#[tauri::command]
async fn focus_call_window(app: AppHandle) {
    let popped = CALL_DOCK.lock().unwrap().popped;
    if let Some(window) = app.get_window(if popped { CALL_POPOUT } else { "main" }) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    if !popped {
        let _ = app.emit_to(CALL_WINDOW, "trix://call-expand", ());
    }
}

/// The call ended: its webview (and window) go, and the app hears about it.
#[tauri::command]
async fn close_call_window(app: AppHandle) {
    let _ = app.emit_to("main", "trix://call-window", Option::<String>::None);
    if let Some(webview) = app.get_webview(CALL_WINDOW) {
        let _ = webview.close();
    }
    if let Some(window) = app.get_window(CALL_POPOUT) {
        let _ = window.destroy();
    }
    *CALL_DOCK.lock().unwrap() = CallDock { popped: false, mini: None, title: String::new() };
}

/// Which conversation the call is in, so the app shows it as busy / in a call.
#[tauri::command]
async fn call_window_state(app: AppHandle, conversation: Option<String>) {
    let _ = app.emit_to("main", "trix://call-window", conversation);
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn conv(key: &str) -> CmdResult<ConversationId> {
    ConversationId::from_key(key).ok_or_else(|| format!("bad conversation key {key}"))
}

const ACTIVITY_FILE: &str = "activity.json";
const CHAT_LIST_FILE: &str = "chat-list.bin";

fn save_chat_list(app: &AppHandle) {
    let state = app.state::<AppState>();
    if !state.chat_list_dirty.swap(false, std::sync::atomic::Ordering::Relaxed) {
        return;
    }
    let Some(index) = state.search.clone() else { return };
    let views = state.engine.lock().unwrap().conversations();
    let Ok(json) = serde_json::to_value(&views) else { return };
    match index.seal(&json) {
        Ok(data) => {
            if let Err(e) = std::fs::write(state.data_dir.join(CHAT_LIST_FILE), data) {
                log::warn!("could not save the chat list: {e}");
            }
        }
        Err(e) => log::warn!("could not encrypt the chat list: {e}"),
    }
}

/// The accounts and chat list from the previous run, shown while the accounts reconnect.
#[tauri::command]
async fn cached_chat_list(app: AppHandle) -> Option<(Vec<Account>, serde_json::Value)> {
    let state = app.state::<AppState>();
    let index = state.search.clone()?;
    let data = std::fs::read(state.data_dir.join(CHAT_LIST_FILE)).ok()?;
    Some((accounts::load(&state.data_dir), index.unseal(&data).ok()?))
}

/// The Activity feed survives restarts; it's small, so rewrite it whole.
fn save_activity(data_dir: &std::path::Path, items: &[ActivityItem]) {
    match serde_json::to_vec(items) {
        Ok(json) => {
            if let Err(e) = std::fs::write(data_dir.join(ACTIVITY_FILE), json) {
                log::warn!("could not save activity: {e}");
            }
        }
        Err(e) => log::warn!("could not save activity: {e}"),
    }
}

fn load_activity(data_dir: &std::path::Path) -> Vec<ActivityItem> {
    std::fs::read(data_dir.join(ACTIVITY_FILE)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
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
            let activity = engine.activity();
            save_activity(&state.data_dir, &activity);
            let _ = app.emit("trix://activity", activity);
        }
        if !out.changed.is_empty() || !out.removed.is_empty() {
            state.chat_list_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
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
        search::index_views(app, &out.new_messages);
        let _ = app.emit("trix://messages", &out.new_messages);
    }
    for n in &out.notifications {
        show_notification(app, &n.title, &n.body, n.kind);
    }
    for (account, session) in &out.sessions {
        // Refreshed tokens replace the stored ones; the old refresh token no longer works.
        if let Err(e) = accounts::update_session(account, session) {
            log::warn!("could not store the refreshed session: {e}");
        }
    }
    for (conversation, poll) in &out.poll_changes {
        let _ = app.emit("trix://poll", (conversation, poll));
    }
    for c in &out.call_signals {
        let _ = app.emit("trix://call", c);
    }
    for p in &out.uploads {
        let _ = app.emit("trix://upload", p);
    }
    for v in &out.verifications {
        // The dialog opens in the app; tell the user in case it's in the background.
        if matches!(v.state, trix_core::VerificationState::Requested) {
            let (title, body) = {
                let state = app.state::<AppState>();
                let engine = state.engine.lock().unwrap();
                (engine.texts().get("notify.verifyTitle", &[]), engine.texts().get("notify.verifyBody", &[("user", &v.user_id)]))
            };
            show_notification(app, &title, &body, NotificationKind::Mention);
        }
        let _ = app.emit("trix://verification", v);
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


async fn start(app: AppHandle, adapter: Arc<dyn ProtocolAdapter>) -> CmdResult<()> {
    app.state::<AppState>().engine.lock().unwrap().add_adapter(adapter.clone());
    let stream = adapter.start().await.map_err(|e| e.to_string())?;
    let (receipts, typing) = *app.state::<AppState>().privacy.lock().unwrap();
    if !(receipts && typing) {
        let adapter = adapter.clone();
        tauri::async_runtime::spawn(async move { let _ = adapter.set_privacy(receipts, typing).await; });
    }
    let _ = app.emit("trix://accounts", app.state::<AppState>().engine.lock().unwrap().accounts());
    tauri::async_runtime::spawn(search::crawl(app.clone(), adapter.clone()));
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
                    combined.merge(engine.handle(ev, now()));
                }
            }
            apply(&app, combined);
        }
    });
    Ok(())
}

#[tauri::command]
async fn accounts(app: AppHandle) -> Vec<Account> {
    let state = app.state::<AppState>();
    state.engine.lock().unwrap().accounts()
}

#[tauri::command]
async fn login_methods(homeserver: String) -> CmdResult<LoginMethods> {
    trix_matrix::login_methods(homeserver.trim()).await.map_err(|e| e.to_string())
}

async fn finish_login<A: ProtocolAdapter + 'static>(app: &AppHandle, result: trix_core::adapter::Result<(Arc<A>, Vec<u8>)>) -> CmdResult<Account> {
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

/// Matrix servers with OAuth 2.0 (Matrix Authentication Service): sign in on the server's page in the browser.
#[tauri::command]
async fn login_oauth(app: AppHandle, homeserver: String) -> CmdResult<Account> {
    let data_dir = app.state::<AppState>().data_dir.clone();
    let opener = app.clone();
    let open_url = Box::new(move |url: String| {
        opener.opener().open_url(url, None::<&str>).map_err(|e| trix_core::adapter::AdapterError::Other(e.to_string()))
    });
    let result = MatrixAdapter::login(&data_dir, homeserver.trim(), Credentials::OAuth { open_url }).await;
    finish_login(&app, result).await
}

/// Nextcloud Talk: sign in through the browser (Login Flow v2).
#[tauri::command]
async fn login_talk(app: AppHandle, server: String) -> CmdResult<Account> {
    let opener = app.clone();
    let open_url = Box::new(move |url: String| {
        opener.opener().open_url(url, None::<&str>).map_err(|e| trix_core::adapter::AdapterError::Other(e.to_string()))
    });
    let result = trix_talk::login(&server, open_url).await;
    finish_login(&app, result).await
}

/// ntfy: watch topics on a server (ntfy.sh or your own), with an optional access token.
#[tauri::command]
async fn login_ntfy(app: AppHandle, server: String, topics: Vec<String>, token: Option<String>) -> CmdResult<Account> {
    let result = trix_ntfy::login(&server, &topics, token.as_deref()).await;
    finish_login(&app, result).await
}

#[tauri::command]
async fn sign_out(app: AppHandle, account: String) -> CmdResult<()> {
    let account = AccountId(account);
    let state = app.state::<AppState>();
    let (adapter, out) = state.engine.lock().unwrap().remove_account(&account);
    if let Some(adapter) = adapter {
        let _ = adapter.stop().await;
        // Revoke the session on the server; remove it locally even if that fails.
        if let Err(e) = adapter.logout().await {
            log::warn!("server-side sign out failed: {e}");
        }
    }
    accounts::remove(&state.data_dir, &account)?;
    if let Some(index) = state.search.clone() {
        let _ = index.remove_account(&account.0);
    }
    apply(&app, out);
    let _ = app.emit("trix://accounts", state.engine.lock().unwrap().accounts());
    Ok(())
}

#[tauri::command]
async fn teams(app: AppHandle) -> Vec<TeamView> {
    let state = app.state::<AppState>();
    state.engine.lock().unwrap().teams()
}

#[tauri::command]
async fn search_messages(app: AppHandle, query: String, conversation: Option<String>, match_case: Option<bool>) -> Vec<SearchHit> {
    tauri::async_runtime::spawn_blocking(move || search::search(&app, &query, match_case.unwrap_or(false), conversation.as_deref(), 50)).await.unwrap_or_default()
}

/// The Shared tab: "media", "files" or "links" of a conversation, newest first.
#[tauri::command]
async fn shared(app: AppHandle, key: String, kind: String, before: Option<u64>) -> CmdResult<Vec<search::SharedItem>> {
    let kind = match kind.as_str() {
        "media" => trix_search::Kind::Media,
        "files" => trix_search::Kind::Files,
        "links" => trix_search::Kind::Links,
        other => return Err(format!("unknown kind {other}")),
    };
    search::shared(&app, &key, kind, before, 60).await
}

/// How many messages the local index holds, for the "searching N messages" hint.
#[tauri::command]
fn search_status(state: State<AppState>) -> Option<u64> {
    state.search.as_ref().and_then(|i| i.len().ok())
}

#[tauri::command]
async fn activity(app: AppHandle) -> Vec<ActivityItem> {
    let state = app.state::<AppState>();
    state.engine.lock().unwrap().activity()
}

#[tauri::command]
async fn conversations(app: AppHandle) -> Vec<ConversationView> {
    let state = app.state::<AppState>();
    state.engine.lock().unwrap().conversations()
}

#[tauri::command]
async fn messages(app: AppHandle, key: String) -> CmdResult<Vec<MessageView>> {
    let state = app.state::<AppState>();
    Ok(state.engine.lock().unwrap().messages(&conv(&key)?))
}

#[tauri::command]
/// Sends a message; returns its id, so the UI can swap its "sending" copy for the real one.
async fn send(state: State<'_, AppState>, key: String, text: String, emote: bool, reply_to: Option<String>, thread_root: Option<String>, mentions: Vec<String>, html: Option<String>, msgtype: Option<String>, emotes: Option<Vec<(String, String)>>) -> CmdResult<String> {
    let id = conv(&key)?;
    let adapter = state.engine.lock().unwrap().adapter(&id.account).ok_or("account not signed in")?;
    let message = Outgoing { text, emote, reply_to: reply_to.map(MessageId), thread_root: thread_root.map(MessageId), mentions, html, msgtype, emotes: emotes.unwrap_or_default() };
    let sent = adapter.send(&id, message).await.map_err(|e| e.to_string())?;
    Ok(sent.0)
}

/// Fetches the page before the oldest loaded message; the UI re-reads `messages`.
/// Messages around one message, for previewing an old search result.
#[tauri::command]
async fn message_context(state: State<'_, AppState>, key: String, message: String) -> CmdResult<Vec<MessageView>> {
    let id = conv(&key)?;
    let adapter = state.engine.lock().unwrap().adapter(&id.account).ok_or("account not signed in")?;
    let messages = adapter.context(&id, &MessageId(message), 6).await.map_err(|e| e.to_string())?;
    Ok(messages.iter().map(MessageView::standalone).collect())
}

/// The pinned messages, the latest pinned first.
#[tauri::command]
async fn pinned_messages(state: State<'_, AppState>, key: String) -> CmdResult<Vec<MessageView>> {
    let id = conv(&key)?;
    let adapter = state.engine.lock().unwrap().adapter(&id.account).ok_or("account not signed in")?;
    let messages = adapter.pinned(&id).await.map_err(|e| e.to_string())?;
    Ok(messages.iter().map(MessageView::standalone).collect())
}

#[tauri::command]
async fn set_pinned(state: State<'_, AppState>, key: String, message: String, pinned: bool) -> CmdResult<()> {
    let id = conv(&key)?;
    let adapter = state.engine.lock().unwrap().adapter(&id.account).ok_or("account not signed in")?;
    adapter.set_pinned(&id, &MessageId(message), pinned).await.map_err(|e| e.to_string())
}

/// /jumptodate: first loaded message at or after `ts`, and the oldest loaded time.
#[tauri::command]
async fn message_at(app: AppHandle, key: String, ts: u64) -> CmdResult<(Option<String>, Option<u64>)> {
    let state = app.state::<AppState>();
    let (first, oldest) = state.engine.lock().unwrap().message_at(&conv(&key)?, ts);
    Ok((first.map(|m| m.0), oldest))
}

#[tauri::command]
async fn load_older(app: AppHandle, key: String, limit: Option<u32>) -> CmdResult<bool> {
    let id = conv(&key)?;
    let adapter = app.state::<AppState>().engine.lock().unwrap().adapter(&id.account).ok_or("account not signed in")?;
    // Bigger pages when jumping far back (search results, /jumptodate).
    let history = adapter.load_older(&id, limit.unwrap_or(40).clamp(10, 250)).await.map_err(|e| e.to_string())?;
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

async fn send_path(state: &AppState, key: &str, path: &std::path::Path, caption: Option<&str>, thumb: Option<trix_core::VideoThumb>, thread_root: Option<&str>, reply_to: Option<&str>) -> CmdResult<()> {
    let id = conv(key)?;
    let adapter = state.engine.lock().unwrap().adapter(&id.account).ok_or("account not signed in")?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
    let data = std::fs::read(path).map_err(|e| format!("could not read {name}: {e}"))?;
    let (thread_root, reply_to) = (thread_root.map(|r| MessageId(r.to_owned())), reply_to.map(|r| MessageId(r.to_owned())));
    match (thread_root.is_some() || reply_to.is_some(), thumb) {
        (true, thumb) => adapter.send_file_related(&id, thread_root.as_ref(), reply_to.as_ref(), &name, None, data, caption, thumb).await,
        (false, Some(thumb)) => adapter.send_video(&id, &name, None, data, caption, thumb).await,
        (false, None) => adapter.send_file(&id, &name, None, data, caption).await,
    }
    .map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct PickedFile {
    path: String,
    name: String,
    size: u64,
    /// Serves the file to the webview as trixmedia://localhost/picked/<token> (for video stills).
    token: String,
}

/// Files the user picked or dropped, by token; only these can be read through "picked/".
fn picked_files() -> &'static Mutex<std::collections::HashMap<String, PathBuf>> {
    static PICKED: std::sync::OnceLock<Mutex<std::collections::HashMap<String, PathBuf>>> = std::sync::OnceLock::new();
    PICKED.get_or_init(Default::default)
}

fn describe(path: std::path::PathBuf) -> PickedFile {
    let token = format!("{:016x}{:016x}", rand::random::<u64>(), rand::random::<u64>());
    let file = PickedFile {
        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into()),
        size: std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
        path: path.to_string_lossy().into_owned(),
        token: token.clone(),
    };
    picked_files().lock().unwrap().insert(token, path);
    file
}

/// A byte range of a picked file, read from disk (videos can be large).
fn serve_picked(token: &str, range: Option<&str>) -> tauri::http::Response<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    use tauri::http::{header, Response, StatusCode};

    let fail = |status: StatusCode| Response::builder().status(status).body(Vec::new()).unwrap();
    let Some(path) = picked_files().lock().unwrap().get(token).cloned() else { return fail(StatusCode::NOT_FOUND) };
    let Ok(mut file) = std::fs::File::open(&path) else { return fail(StatusCode::NOT_FOUND) };
    let len = file.metadata().map(|m| m.len() as usize).unwrap_or(0);
    let mime = mime_guess::from_path(&path).first_or_octet_stream().to_string();
    // At most 8 MB per answer; the player asks for the rest.
    let (start, end) = range.and_then(|r| parse_range(r, len)).unwrap_or((0, len.saturating_sub(1)));
    let end = end.min(start + 8 * 1024 * 1024 - 1);
    let mut buf = vec![0u8; end + 1 - start];
    if len == 0 || file.seek(SeekFrom::Start(start as u64)).is_err() || file.read_exact(&mut buf).is_err() {
        return fail(StatusCode::RANGE_NOT_SATISFIABLE);
    }
    Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
        .body(buf)
        .unwrap()
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
#[allow(clippy::too_many_arguments)]
async fn send_file_paths(state: State<'_, AppState>, key: String, paths: Vec<String>, caption: Option<String>, thumb: Option<trix_core::VideoThumb>, thread_root: Option<String>, reply_to: Option<String>) -> CmdResult<()> {
    let last = paths.len().saturating_sub(1);
    let mut thumb = thumb.filter(|_| paths.len() == 1);
    for (i, path) in paths.iter().enumerate() {
        // One caption for the batch, on the last file.
        let caption = if i == last { caption.as_deref() } else { None };
        // The reply goes with the last file, which carries the caption.
        let reply = if i == last { reply_to.as_deref() } else { None };
        send_path(&state, &key, std::path::Path::new(path), caption, thumb.take(), thread_root.as_deref(), reply).await?;
    }
    Ok(())
}

/// Forwards a message to another chat, on any account: text as it is, a file downloaded and
/// sent again (so it also works between Matrix and Talk). `note` goes first, like Teams' "Add a message".
#[tauri::command]
async fn forward_message(app: AppHandle, key: String, message: String, target: String, note: Option<String>) -> CmdResult<()> {
    let (from, to) = (conv(&key)?, conv(&target)?);
    let (view, source, dest) = {
        let state = app.state::<AppState>();
        let engine = state.engine.lock().unwrap();
        let view = engine.messages(&from).into_iter().find(|m| m.id == message).ok_or("message not found")?;
        let source = engine.adapter(&from.account).ok_or("account not signed in")?;
        let dest = engine.adapter(&to.account).ok_or("account not signed in")?;
        (view, source, dest)
    };
    if let Some(note) = note.filter(|n| !n.trim().is_empty()) {
        dest.send(&to, Outgoing { text: note, ..Default::default() }).await.map_err(|e| e.to_string())?;
    }
    match view.media {
        Some(media) => {
            let data = source.fetch_media(&media.id, None).await.map_err(|e| e.to_string())?;
            dest.send_file(&to, &media.name, media.mime.as_deref(), data, media.caption.as_deref()).await
        }
        None => dest.send(&to, Outgoing { text: view.body, html: view.html, ..Default::default() }).await.map(drop),
    }
    .map_err(|e| e.to_string())
}

/// Pasted images (the clipboard gives bytes, not a path).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn send_file_bytes(state: State<'_, AppState>, key: String, name: String, mime: Option<String>, data: Vec<u8>, caption: Option<String>, thumb: Option<trix_core::VideoThumb>, thread_root: Option<String>, reply_to: Option<String>) -> CmdResult<()> {
    let id = conv(&key)?;
    let adapter = state.engine.lock().unwrap().adapter(&id.account).ok_or("account not signed in")?;
    let (thread_root, reply_to) = (thread_root.map(MessageId), reply_to.map(MessageId));
    match (thread_root.is_some() || reply_to.is_some(), thumb) {
        (true, thumb) => adapter.send_file_related(&id, thread_root.as_ref(), reply_to.as_ref(), &name, mime.as_deref(), data, caption.as_deref(), thumb).await,
        (false, Some(thumb)) => adapter.send_video(&id, &name, mime.as_deref(), data, caption.as_deref(), thumb).await,
        (false, None) => adapter.send_file(&id, &name, mime.as_deref(), data, caption.as_deref()).await,
    }
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn send_call_event(state: State<'_, AppState>, key: String, event_type: String, content: String) -> CmdResult<()> {
    let id = conv(&key)?;
    let adapter = state.engine.lock().unwrap().adapter(&id.account).ok_or("account not signed in")?;
    adapter.send_call_event(&id, &event_type, &content).await.map_err(|e| e.to_string())
}

/// Talk call engine (in the UI) talking to Talk's call/signalling endpoints.
#[tauri::command]
async fn call_api(state: State<'_, AppState>, account: String, method: String, path: String, form: Vec<(String, String)>, timeout: Option<u64>) -> CmdResult<(String, String)> {
    adapter_for(&state, &account)?.call_api(&method, &path, &form, timeout.unwrap_or(30)).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn call_api_upload(state: State<'_, AppState>, account: String, path: String, field: String, file_name: String, mime: String, data: Vec<u8>) -> CmdResult<String> {
    adapter_for(&state, &account)?.call_api_upload(&path, &field, &file_name, &mime, data).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn cloud_file_bytes(state: State<'_, AppState>, account: String, path: String) -> CmdResult<Vec<u8>> {
    adapter_for(&state, &account)?.cloud_file_bytes(&path).await.map_err(|e| e.to_string())
}

/// Lets the UI write to the app log (call diagnostics end up next to the Rust logs).
#[tauri::command]
fn log_ui(message: String) {
    log::info!("[ui] {message}");
}

#[tauri::command]
async fn turn_servers(state: State<'_, AppState>, account: String) -> CmdResult<Option<trix_core::TurnServers>> {
    adapter_for(&state, &account)?.turn_servers().await.map_err(|e| e.to_string())
}

/// A folder of a Nextcloud account's Files.
#[tauri::command]
async fn cloud_files(state: State<'_, AppState>, account: String, path: String) -> CmdResult<Vec<trix_core::CloudFile>> {
    adapter_for(&state, &account)?.cloud_files(&path).await.map_err(|e| e.to_string())
}

/// Attaches a stored file to a chat: shared into the conversation when it's on the same
/// Nextcloud, otherwise returns a public link for the UI to send as a message.
#[tauri::command]
async fn attach_cloud_file(state: State<'_, AppState>, account: String, path: String, key: String, caption: Option<String>) -> CmdResult<Option<String>> {
    let id = conv(&key)?;
    let adapter = adapter_for(&state, &account)?;
    if id.account.0 == account {
        adapter.share_cloud_file(&id, &path, caption.as_deref()).await.map_err(|e| e.to_string())?;
        return Ok(None);
    }
    adapter.cloud_link(&path).await.map(Some).map_err(|e| e.to_string())
}

#[tauri::command]
async fn notes(state: State<'_, AppState>, account: String, content: Option<bool>) -> CmdResult<Vec<trix_core::Note>> {
    adapter_for(&state, &account)?.notes(content.unwrap_or(false)).await.map_err(|e| {
        log::info!("notes for {account}: {e}");
        e.to_string()
    })
}

#[tauri::command]
async fn note(state: State<'_, AppState>, account: String, id: u64) -> CmdResult<trix_core::Note> {
    adapter_for(&state, &account)?.note(id).await.map_err(|e| e.to_string())
}

/// Creates (no id) or saves a note; `etag` keeps a change made elsewhere from being overwritten.
#[tauri::command]
async fn save_note(state: State<'_, AppState>, account: String, id: Option<u64>, etag: Option<String>, change: trix_core::NoteChange) -> CmdResult<trix_core::Note> {
    adapter_for(&state, &account)?.save_note(id, etag.as_deref(), &change).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_note(state: State<'_, AppState>, account: String, id: u64) -> CmdResult<()> {
    adapter_for(&state, &account)?.delete_note(id).await.map_err(|e| e.to_string())
}

/// The conversation a link points to on one of our accounts (a Talk call link), so it opens here
/// instead of in the browser; None for other links.
#[tauri::command]
fn link_target(state: State<'_, AppState>, url: String) -> Option<String> {
    let engine = state.engine.lock().unwrap();
    engine.accounts().iter().filter_map(|a| engine.adapter(&a.id)).find_map(|adapter| adapter.link_target(&url))
}

/// The apps the account's server offers (Nextcloud navigation ids, e.g. "calendar").
#[tauri::command]
async fn cloud_apps(state: State<'_, AppState>, account: String) -> CmdResult<Vec<String>> {
    adapter_for(&state, &account)?.cloud_apps().await.map_err(|e| e.to_string())
}

/// Markdown as HTML (as messages render it), for the notes preview.
#[tauri::command]
fn render_markdown(text: String) -> Option<String> {
    trix_matrix::markdown_html(&text)
}

#[tauri::command]
async fn calendars(state: State<'_, AppState>, account: String) -> CmdResult<Vec<trix_core::Calendar>> {
    adapter_for(&state, &account)?.calendars().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn calendar_events(state: State<'_, AppState>, account: String, from: String, to: String) -> CmdResult<Vec<trix_core::CalendarEvent>> {
    adapter_for(&state, &account)?.calendar_events(&from, &to).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_event(state: State<'_, AppState>, account: String, event: trix_core::NewEvent) -> CmdResult<()> {
    adapter_for(&state, &account)?.create_event(&event).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn update_event(state: State<'_, AppState>, account: String, href: String, etag: Option<String>, event: trix_core::NewEvent) -> CmdResult<()> {
    adapter_for(&state, &account)?.update_event(&href, etag.as_deref(), &event).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_event(state: State<'_, AppState>, account: String, href: String, etag: Option<String>, occurrence: Option<String>) -> CmdResult<()> {
    adapter_for(&state, &account)?.delete_event(&href, etag.as_deref(), occurrence.as_deref()).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn respond_event(state: State<'_, AppState>, account: String, href: String, etag: Option<String>, status: String) -> CmdResult<()> {
    adapter_for(&state, &account)?.respond_event(&href, etag.as_deref(), &status).await.map_err(|e| e.to_string())
}

/// System notification from the UI (meeting reminders).
#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) {
    use tauri_plugin_notification::NotificationExt;
    if do_not_disturb(&app) {
        return;
    }
    ntfy::forward(&app, &title, &body, ntfy::Kind::Reminder);
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        log::warn!("notification failed: {e}");
    }
}

const RINGTONE_FILE: &str = "ringtone";
const RINGTONE_MAX: usize = 5 * 1024 * 1024;

/// Your own ringtone (a sound file, sent as the request body), kept in the app's data folder.
#[tauri::command]
async fn save_ringtone(state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> CmdResult<()> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else { return Err("no sound file".into()) };
    if data.len() > RINGTONE_MAX {
        return Err("the sound file is too big".into());
    }
    std::fs::write(state.data_dir.join(RINGTONE_FILE), data).map_err(|e| e.to_string())
}

#[tauri::command]
async fn ringtone(state: State<'_, AppState>) -> CmdResult<tauri::ipc::Response> {
    std::fs::read(state.data_dir.join(RINGTONE_FILE)).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

const BACKGROUND_FILE: &str = "camera-background";
const BACKGROUND_MAX: usize = 60 * 1024 * 1024;

/// Your own moving camera background (a video or GIF, sent as the request body), kept in the
/// app's data folder: too big for the webview's local storage.
#[tauri::command]
async fn save_background_video(state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> CmdResult<()> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else { return Err("no video".into()) };
    if data.len() > BACKGROUND_MAX {
        return Err("the video is too big".into());
    }
    std::fs::write(state.data_dir.join(BACKGROUND_FILE), data).map_err(|e| e.to_string())
}

#[tauri::command]
async fn background_video(state: State<'_, AppState>) -> CmdResult<tauri::ipc::Response> {
    std::fs::read(state.data_dir.join(BACKGROUND_FILE)).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

#[tauri::command]
async fn calendar_people(state: State<'_, AppState>, account: String, term: String) -> CmdResult<Vec<trix_core::Attendee>> {
    adapter_for(&state, &account)?.calendar_people(&term).await.map_err(|e| e.to_string())
}

/// The threads in a conversation (all, or only those you're part of).
#[tauri::command]
async fn threads(state: State<'_, AppState>, key: String, mine: bool) -> CmdResult<Vec<trix_core::ThreadInfo>> {
    let id = conv(&key)?;
    adapter_for(&state, &id.account.0)?.threads(&id, mine).await.map_err(|e| e.to_string())
}

/// People in the conversation whose encryption identity changed (invisible crypto).
#[tauri::command]
async fn identity_warnings(state: State<'_, AppState>, key: String) -> CmdResult<Vec<trix_core::IdentityWarning>> {
    let id = conv(&key)?;
    adapter_for(&state, &id.account.0)?.identity_warnings(&id).await.map_err(|e| e.to_string())
}

/// Accepts someone's new identity, clearing the warning.
#[tauri::command]
async fn accept_identity(state: State<'_, AppState>, account: String, user_id: String) -> CmdResult<()> {
    adapter_for(&state, &account)?.accept_identity(&user_id).await.map_err(|e| e.to_string())
}

/// Web address to join a conversation (e.g. a Talk meeting link for a calendar event).
#[tauri::command]
async fn conversation_link(state: State<'_, AppState>, key: String) -> CmdResult<String> {
    let id = conv(&key)?;
    adapter_for(&state, &id.account.0)?.conversation_link(&id).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn image_packs(state: State<'_, AppState>, key: String) -> CmdResult<Vec<trix_core::ImagePack>> {
    let id = conv(&key)?;
    adapter_for(&state, &id.account.0)?.image_packs(Some(&id)).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn own_pack(state: State<'_, AppState>, account: String) -> CmdResult<trix_core::ImagePack> {
    adapter_for(&state, &account)?.own_pack().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_own_pack(state: State<'_, AppState>, account: String, pack: trix_core::ImagePack) -> CmdResult<()> {
    adapter_for(&state, &account)?.save_own_pack(&pack).await.map_err(|e| e.to_string())
}

/// Uploads a picture (base64) and returns its URL, e.g. for a new custom emoji.
#[tauri::command]
async fn upload_image(state: State<'_, AppState>, account: String, mime: String, data: String) -> CmdResult<String> {
    adapter_for(&state, &account)?.upload_image(&mime, decode_png(&data)?).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn poll(state: State<'_, AppState>, key: String, poll: String) -> CmdResult<trix_core::PollView> {
    let id = conv(&key)?;
    adapter_for(&state, &id.account.0)?.poll(&id, &poll).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn vote(state: State<'_, AppState>, key: String, poll: String, answers: Vec<String>) -> CmdResult<()> {
    let id = conv(&key)?;
    adapter_for(&state, &id.account.0)?.vote(&id, &poll, &answers).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn end_poll(state: State<'_, AppState>, key: String, poll: String) -> CmdResult<()> {
    let id = conv(&key)?;
    adapter_for(&state, &id.account.0)?.end_poll(&id, &poll).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_poll(state: State<'_, AppState>, key: String, question: String, answers: Vec<String>, max_selections: u32, disclosed: bool) -> CmdResult<()> {
    let id = conv(&key)?;
    adapter_for(&state, &id.account.0)?.create_poll(&id, &question, &answers, max_selections, disclosed).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn send_sticker(state: State<'_, AppState>, key: String, url: String, body: String) -> CmdResult<()> {
    let id = conv(&key)?;
    adapter_for(&state, &id.account.0)?.send_sticker(&id, &url, &body).await.map_err(|e| e.to_string())
}

/// A recorded voice message (base64 audio, as the browser recorded it).
#[tauri::command]
async fn send_voice(state: State<'_, AppState>, key: String, mime: String, data: String, duration_ms: u64, waveform: Vec<f32>) -> CmdResult<()> {
    let id = conv(&key)?;
    let adapter = state.engine.lock().unwrap().adapter(&id.account).ok_or("account not signed in")?;
    adapter.send_voice(&id, &mime, decode_png(&data)?, duration_ms, waveform).await.map_err(|e| e.to_string())
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

#[tauri::command]
async fn create_room(state: State<'_, AppState>, account: String, room: trix_core::NewRoom) -> CmdResult<CommandOutput> {
    if room.name.trim().is_empty() {
        return Err("a room needs a name".into());
    }
    adapter_for(&state, &account)?.create_room(&room).await.map_err(|e| e.to_string())
}

/// Join by address or id, e.g. from the New chat or Browse dialogs.
#[tauri::command]
async fn room_preview(state: State<'_, AppState>, account: String, address: String, via: Vec<String>) -> CmdResult<DirectoryRoom> {
    adapter_for(&state, &account)?.room_preview(&address, &via).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn knock(state: State<'_, AppState>, account: String, address: String, via: Option<String>) -> CmdResult<()> {
    adapter_for(&state, &account)?.knock(&address, via.as_deref()).await.map_err(|e| e.to_string())
}

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
async fn can_translate(state: State<'_, AppState>, account: String) -> CmdResult<bool> {
    adapter_for(&state, &account)?.can_translate().await.map_err(|e| e.to_string())
}

/// A message's text in the language `to`, translated by the account's Nextcloud.
#[tauri::command]
async fn translate(state: State<'_, AppState>, account: String, text: String, to: String) -> CmdResult<trix_core::Translation> {
    adapter_for(&state, &account)?.translate(&text, &to).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn security_page(state: State<AppState>, account: String) -> CmdResult<Option<String>> {
    Ok(adapter_for(&state, &account)?.security_page())
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
/// Data the UI's cropper sends: a base64 PNG (no data: prefix).
fn decode_png(png: &str) -> CmdResult<Vec<u8>> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.decode(png).map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_room_avatar(state: State<'_, AppState>, key: String, png: String) -> CmdResult<()> {
    let id = conv(&key)?;
    adapter_for(&state, &id.account.0)?.set_room_avatar(&id, Some("image/png"), decode_png(&png)?).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_room_member_avatar(state: State<'_, AppState>, key: String, png: String) -> CmdResult<()> {
    let id = conv(&key)?;
    adapter_for(&state, &id.account.0)?.set_room_member_avatar(&id, Some("image/png"), decode_png(&png)?).await.map_err(|e| e.to_string())
}

/// Lets the user pick a picture and hands it to the UI (as a data URL) to crop.
#[tauri::command]
async fn pick_image_file(app: AppHandle) -> CmdResult<Option<String>> {
    use base64::Engine as _;
    Ok(pick_image(&app).await?.map(|(mime, data)| format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(data))))
}

/// Asks for a picture file; None when the user cancels.
async fn pick_image(app: &AppHandle) -> CmdResult<Option<(&'static str, Vec<u8>)>> {
    use tauri_plugin_dialog::DialogExt;

    let dialog = app.dialog().file().add_filter("Images", &["png", "jpg", "jpeg", "gif", "webp"]);
    let Some(path) = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_file()).await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|e| e.to_string())?;
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    let mime = match path.extension().and_then(|e| e.to_str()).map(str::to_lowercase).as_deref() {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        _ => "image/png",
    };
    Ok(Some((mime, data)))
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

/// Opens the protocol's own call screen (e.g. Talk's) in its own window,
/// or focuses it if that call is already open. The window loads a remote page
/// and gets no access to the app's commands.
/// Strips Talk's page down to the call: no Nextcloud top bar, conversation list
/// or chat sidebar, since ms_trix already shows those next to the call window.
/// Selectors are Nextcloud's own layout classes; if a Talk update renames them
/// the window just shows the full page again.
const CALL_WINDOW_SCRIPT: &str = r#"
(() => {
  const css = `
    #header, header#header, .app-navigation, #app-navigation-vue, .app-sidebar, #app-sidebar-vue { display: none !important; }
    :root, body { --header-height: 0px !important; --body-container-margin: 0px !important; --body-container-radius: 0px !important; }
    #content, #content-vue { margin: 0 !important; padding: 0 !important; width: 100% !important; height: 100% !important; max-width: none !important; border-radius: 0 !important; }
    #app-content-vue, .app-content { margin: 0 !important; }
  `;
  const add = () => {
    const style = document.createElement("style");
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add);
  else add();
})();
"#;

/// Plays a macOS system sound; "default" is the user's alert sound.
fn play_mac_sound(name: &str) {
    let path = if name == "default" {
        std::process::Command::new("defaults")
            .args(["read", "-g", "com.apple.sound.beep.sound"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|p| p.trim().to_owned())
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| "/System/Library/Sounds/Tink.aiff".into())
    } else if name.chars().all(|c| c.is_ascii_alphanumeric()) {
        format!("/System/Library/Sounds/{name}.aiff")
    } else {
        return;
    };
    // Wait on a thread so the finished player doesn't linger as a zombie.
    std::thread::spawn(move || {
        if let Err(e) = std::process::Command::new("afplay").arg(path).status() {
            log::warn!("sound failed: {e}");
        }
    });
}

#[tauri::command]
async fn open_call(app: AppHandle, key: String, title: String) -> CmdResult<()> {
    use std::hash::{Hash, Hasher};

    let id = conv(&key)?;
    let link = adapter_for(&app.state::<AppState>(), &id.account.0)?.call_link(&id).await.map_err(|e| e.to_string())?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    key.hash(&mut hasher);
    let label = format!("call-{:x}", hasher.finish());
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.unminimize();
        return window.set_focus().map_err(|e| e.to_string());
    }
    let url = link.parse().map_err(|e: url::ParseError| e.to_string())?;
    let builder = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(url));
    // Talk checks the user agent and rejects the bare WebKit one the macOS and
    // Linux webviews send; it is the same engine as Safari, so say so.
    // (WebView2 on Windows already identifies as Edge.)
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let builder = builder.user_agent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    );
    builder
        .initialization_script(CALL_WINDOW_SCRIPT)
        .title(title)
        .inner_size(1100.0, 760.0)
        .min_inner_size(480.0, 360.0)
        .build()
        .map_err(|e| e.to_string())?;
    watch_call(app, id, label);
    Ok(())
}

/// Closes the call window shortly after the user leaves the call: once the
/// server has seen us in the call and then no longer does. Stops when the
/// window is closed by hand or the protocol can't tell.
fn watch_call(app: AppHandle, id: ConversationId, label: String) {
    tauri::async_runtime::spawn(async move {
        let mut joined = false;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            let Some(window) = app.get_webview_window(&label) else { return };
            let Ok(adapter) = adapter_for(&app.state::<AppState>(), &id.account.0) else { return };
            match adapter.in_call(&id).await {
                Ok(true) if !joined => {
                    eprintln!("call window {label}: in the call");
                    joined = true;
                }
                Ok(true) => {}
                Ok(false) if joined => {
                    let _ = window.close();
                    return;
                }
                Ok(false) => {}
                Err(trix_core::adapter::AdapterError::Unsupported(_)) => return,
                // Network hiccup: try again next round.
                Err(e) => eprintln!("call window {label}: {e}"),
            }
        }
    });
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
    if account == "picked" {
        return serve_picked(media, request.headers().get(header::RANGE).and_then(|v| v.to_str().ok()));
    }
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
        // Talk's default group pictures are SVG (shown in <img>, where SVG can't run scripts).
        _ if is_svg(bytes) => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

fn is_svg(bytes: &[u8]) -> bool {
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]);
    let head = head.trim_start_matches('\u{feff}').trim_start();
    head.starts_with("<svg") || (head.starts_with("<?xml") && head.contains("<svg"))
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
    for adapter in all_adapters(&app) {
        adapter.set_focus(id.as_ref().filter(|c| c.account == adapter.account().id));
    }
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

#[tauri::command]
async fn set_history_visibility(state: State<'_, AppState>, key: String, visibility: String) -> CmdResult<()> {
    let id = conv(&key)?;
    adapter_for(&state, &id.account.0)?.set_history_visibility(&id, &visibility).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_permission(state: State<'_, AppState>, key: String, permission: String, level: i64) -> CmdResult<()> {
    let id = conv(&key)?;
    adapter_for(&state, &id.account.0)?.set_permission(&id, &permission, level).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_server_acl(state: State<'_, AppState>, key: String, allow: Vec<String>, deny: Vec<String>) -> CmdResult<()> {
    let id = conv(&key)?;
    adapter_for(&state, &id.account.0)?.set_server_acl(&id, allow, deny).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_team_room(state: State<'_, AppState>, team: String, room: String, add: bool) -> CmdResult<()> {
    let id = conv(&team)?;
    adapter_for(&state, &id.account.0)?.set_team_room(&id, &room, add).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_team_order(state: State<'_, AppState>, team: String, order: Option<String>) -> CmdResult<()> {
    let id = conv(&team)?;
    adapter_for(&state, &id.account.0)?.set_team_order(&id, order.as_deref()).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn enable_encryption(state: State<'_, AppState>, key: String) -> CmdResult<()> {
    let id = conv(&key)?;
    adapter_for(&state, &id.account.0)?.enable_encryption(&id).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_join_rule(state: State<'_, AppState>, key: String, rule: String) -> CmdResult<()> {
    let id = conv(&key)?;
    adapter_for(&state, &id.account.0)?.set_join_rule(&id, &rule).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_room_alias(state: State<'_, AppState>, key: String, name: String) -> CmdResult<String> {
    let id = conv(&key)?;
    adapter_for(&state, &id.account.0)?.set_room_alias(&id, &name).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_archived(state: State<'_, AppState>, key: String, value: bool) -> CmdResult<()> {
    let id = conv(&key)?;
    let adapter = state.engine.lock().unwrap().adapter(&id.account).ok_or("account not signed in")?;
    adapter.set_archived(&id, value).await.map_err(|e| e.to_string())
}

fn adapter_for(state: &AppState, account: &str) -> CmdResult<Arc<dyn ProtocolAdapter>> {
    state.engine.lock().unwrap().adapter(&AccountId(account.to_owned())).ok_or_else(|| "account not signed in".to_owned())
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

const TRAY_ID: &str = "main";

/// Turns closing-to-tray on or off; the tray icon only exists while it's on.
#[tauri::command]
fn set_close_to_tray(app: AppHandle, enabled: bool, open_label: String, quit_label: String) -> CmdResult<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    app.state::<AppState>().close_to_tray.store(enabled, std::sync::atomic::Ordering::Relaxed);
    if !enabled {
        app.remove_tray_by_id(TRAY_ID);
        return Ok(());
    }
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }
    let open = MenuItem::with_id(&app, "open", open_label, true, None::<&str>).map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(&app, "quit", quit_label, true, None::<&str>).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(&app, &[&open, &quit]).map_err(|e| e.to_string())?;
    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("ms_trix")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(&app).map_err(|e| e.to_string())?;
    update_tray(&app);
    Ok(())
}

/// Shows the unread count on the tray icon: next to it on macOS, in the tooltip everywhere.
#[tauri::command]
fn set_tray_unread(app: AppHandle, count: u32, tooltip: String) {
    *app.state::<AppState>().tray_unread.lock().unwrap() = (count, tooltip);
    update_tray(&app);
}

fn update_tray(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    let (count, tooltip) = app.state::<AppState>().tray_unread.lock().unwrap().clone();
    let _ = tray.set_tooltip(Some(if tooltip.is_empty() { "ms_trix".to_owned() } else { tooltip }));
    #[cfg(target_os = "macos")]
    let _ = tray.set_title((count > 0).then(|| count.to_string()));
    #[cfg(not(target_os = "macos"))]
    let _ = count;
}

#[tauri::command]
fn autostart(app: AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> CmdResult<()> {
    use tauri_plugin_autostart::ManagerExt;
    let launcher = app.autolaunch();
    if enabled { launcher.enable() } else { launcher.disable() }.map_err(|e| e.to_string())
}

/// Seconds since the last keyboard/mouse input anywhere on the system, for
/// auto-away. None where we can't tell; the UI then watches its own window.
#[tauri::command]
fn idle_seconds() -> Option<u64> {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("ioreg").args(["-c", "IOHIDSystem", "-d", "4"]).output().ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        let line = text.lines().find(|l| l.contains("\"HIDIdleTime\""))?;
        let nanos: u64 = line.rsplit('=').next()?.trim().parse().ok()?;
        Some(nanos / 1_000_000_000)
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::SystemInformation::GetTickCount;
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
        let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        // SAFETY: `info` is a properly sized LASTINPUTINFO that outlives the call.
        if unsafe { GetLastInputInfo(&mut info) } == 0 {
            return None;
        }
        Some(u64::from(unsafe { GetTickCount() }.wrapping_sub(info.dwTime)) / 1000)
    }
    #[cfg(target_os = "linux")]
    {
        // GNOME (also on Wayland), then KDE, then X11 with xprintidle installed.
        let run = |cmd: &str, args: &[&str]| std::process::Command::new(cmd).args(args).output().ok().filter(|o| o.status.success());
        // gdbus prints "(uint64 12345,)": the second run of digits is the value (milliseconds).
        let gdbus = |dest: &str, path: &str, method: &str| {
            run("gdbus", &["call", "--session", "--dest", dest, "--object-path", path, "--method", method])
                .and_then(|o| String::from_utf8_lossy(&o.stdout).split(|c: char| !c.is_ascii_digit()).filter(|s| !s.is_empty()).nth(1).and_then(|n| n.parse::<u64>().ok()))
        };
        let millis = gdbus("org.gnome.Mutter.IdleMonitor", "/org/gnome/Mutter/IdleMonitor/Core", "org.gnome.Mutter.IdleMonitor.GetIdletime")
            .or_else(|| gdbus("org.freedesktop.ScreenSaver", "/ScreenSaver", "org.freedesktop.ScreenSaver.GetSessionIdleTime"))
            .or_else(|| run("xprintidle", &[]).and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok()))?;
        Some(millis / 1000)
    }
    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    None
}

/// Translations for texts made in Rust (previews, notifications); previews are redone at once.
#[tauri::command]
fn set_texts(app: AppHandle, texts: std::collections::HashMap<String, String>) {
    let views = {
        let state = app.state::<AppState>();
        let mut engine = state.engine.lock().unwrap();
        engine.set_texts(texts);
        engine.conversations()
    };
    let _ = app.emit("trix://conversations", views);
}

#[tauri::command]
fn set_notify_prefs(state: State<'_, AppState>, prefs: NotifyPrefs, sounds: Sounds) {
    state.engine.lock().unwrap().set_notify_prefs(prefs);
    *state.sounds.lock().unwrap() = sounds;
}

/// A link's preview (title, description, picture), fetched by this app; None when it has none.
#[tauri::command]
async fn link_preview(url: String) -> Option<links::LinkPreview> {
    links::preview(&url).await
}

/// Send later: the message goes out at `at` (ms since 1970), sent by this app. Its id.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn schedule_message(app: AppHandle, key: String, at: u64, text: String, emote: bool, reply_to: Option<String>, thread_root: Option<String>, mentions: Vec<String>, html: Option<String>, msgtype: Option<String>, emotes: Option<Vec<(String, String)>>) -> CmdResult<String> {
    conv(&key)?;
    let id = format!("s{}-{}", now(), rand::random::<u32>());
    scheduled::add(&app, scheduled::Scheduled { id: id.clone(), conversation: key, at, text, emote, reply_to, thread_root, mentions, html, msgtype, emotes: emotes.unwrap_or_default(), error: None, retry_at: 0 });
    Ok(id)
}

#[tauri::command]
fn scheduled_messages() -> Vec<scheduled::Scheduled> {
    scheduled::list()
}

/// Takes a scheduled message off the list (deleted, or back in the composer to edit); returns it.
#[tauri::command]
fn cancel_scheduled(app: AppHandle, id: String) -> Option<scheduled::Scheduled> {
    scheduled::remove(&app, &id)
}

#[tauri::command]
async fn send_scheduled_now(app: AppHandle, id: String) {
    scheduled::due_now(&app, &id);
    scheduled::send_due(&app).await;
}

/// An incoming call: the Dock icon bounces (the taskbar button flashes on Windows) until the app
/// is brought to the front, so it's noticed with another app in front too.
#[tauri::command]
fn request_attention(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.request_user_attention(Some(tauri::UserAttentionType::Critical));
    }
}

/// An incoming Matrix call's notification (not during do not disturb; also to ntfy).
#[tauri::command]
fn notify_call(app: AppHandle, title: String, body: String) {
    show_notification(&app, &title, &body, NotificationKind::Call);
}

/// The ntfy add-on's settings (None: off); the token is set apart, into the keychain.
#[tauri::command]
fn set_ntfy(prefs: Option<ntfy::Prefs>) {
    ntfy::set_prefs(prefs);
}

#[tauri::command]
fn set_ntfy_token(token: Option<String>) -> CmdResult<()> {
    ntfy::set_token(token)
}

#[tauri::command]
fn has_ntfy_token() -> bool {
    ntfy::has_token()
}

#[tauri::command]
async fn test_ntfy() -> CmdResult<()> {
    ntfy::test().await
}

/// Do not disturb until `until` (ms since 1970), or off.
#[tauri::command]
fn set_dnd(state: State<'_, AppState>, until: Option<u64>) {
    state.dnd_until.store(until.unwrap_or(0), std::sync::atomic::Ordering::Relaxed);
}

/// Shows a sample notification so the user hears the chosen sound.
#[tauri::command]
fn test_notification(app: AppHandle, kind: NotificationKind, title: String, body: String) {
    present_notification(&app, &title, &body, kind);
}

#[tauri::command]
async fn set_privacy(app: AppHandle, share_receipts: bool, share_typing: bool) -> CmdResult<()> {
    let state = app.state::<AppState>();
    *state.privacy.lock().unwrap() = (share_receipts, share_typing);
    let adapters: Vec<_> = { let engine = state.engine.lock().unwrap(); engine.accounts().iter().filter_map(|a| engine.adapter(&a.id)).collect() };
    let mut errors = vec![];
    for adapter in adapters {
        if let Err(e) = adapter.set_privacy(share_receipts, share_typing).await {
            errors.push(format!("{}: {e}", adapter.account().display_name));
        }
    }
    if errors.is_empty() { Ok(()) } else { Err(errors.join("; ")) }
}

fn all_adapters(app: &AppHandle) -> Vec<Arc<dyn ProtocolAdapter>> {
    let state = app.state::<AppState>();
    let engine = state.engine.lock().unwrap();
    engine.accounts().iter().filter_map(|a| engine.adapter(&a.id)).collect()
}

/// Keywords kept on the server (Matrix push rules) for every account, so the UI can merge them in.
#[tauri::command]
async fn server_keywords(app: AppHandle) -> Vec<String> {
    let adapters = all_adapters(&app);
    let mut all: Vec<String> = vec![];
    for adapter in adapters {
        for k in adapter.keywords().await.unwrap_or_default() {
            if !all.iter().any(|x| x.eq_ignore_ascii_case(&k)) {
                all.push(k);
            }
        }
    }
    all
}

/// Makes every account's server-side keywords match the list in Settings.
#[tauri::command]
async fn sync_keywords(app: AppHandle, keywords: Vec<String>) -> CmdResult<()> {
    let adapters = all_adapters(&app);
    let mut errors = vec![];
    for adapter in adapters {
        if let Err(e) = adapter.set_keywords(&keywords).await {
            errors.push(format!("{}: {e}", adapter.account().display_name));
        }
    }
    if errors.is_empty() { Ok(()) } else { Err(errors.join("; ")) }
}

/// Re-reads the profile after an own change and tells the UI.
async fn profile_changed(app: &AppHandle, adapter: &Arc<dyn ProtocolAdapter>) {
    if let Ok(account) = adapter.refresh_profile().await {
        let _ = accounts::update_profile(&app.state::<AppState>().data_dir, &account);
    }
    let _ = app.emit("trix://accounts", app.state::<AppState>().engine.lock().unwrap().accounts());
}

#[tauri::command]
async fn set_display_name(app: AppHandle, account: String, name: String) -> CmdResult<()> {
    let adapter = adapter_for(&app.state::<AppState>(), &account)?;
    adapter.set_display_name(&name).await.map_err(|e| e.to_string())?;
    profile_changed(&app, &adapter).await;
    Ok(())
}

#[tauri::command]
async fn set_avatar(app: AppHandle, account: String, png: String) -> CmdResult<()> {
    let adapter = adapter_for(&app.state::<AppState>(), &account)?;
    adapter.set_avatar(Some("image/png"), decode_png(&png)?).await.map_err(|e| e.to_string())?;
    profile_changed(&app, &adapter).await;
    Ok(())
}

#[tauri::command]
async fn devices(state: State<'_, AppState>, account: String) -> CmdResult<Vec<DeviceInfo>> {
    adapter_for(&state, &account)?.devices().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn rename_device(state: State<'_, AppState>, account: String, device_id: String, name: String) -> CmdResult<()> {
    adapter_for(&state, &account)?.rename_device(&device_id, &name).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn user_devices(state: State<'_, AppState>, account: String, user_id: String) -> CmdResult<Vec<DeviceInfo>> {
    adapter_for(&state, &account)?.user_devices(&user_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_ignored(state: State<'_, AppState>, account: String, user_id: String, ignored: bool) -> CmdResult<()> {
    adapter_for(&state, &account)?.set_ignored(&user_id, ignored).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn start_verification(state: State<'_, AppState>, account: String, user_id: String, device_id: Option<String>) -> CmdResult<()> {
    adapter_for(&state, &account)?.start_verification(&user_id, device_id.as_deref()).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn verification_action(state: State<'_, AppState>, account: String, user_id: String, flow_id: String, action: VerificationAction) -> CmdResult<()> {
    adapter_for(&state, &account)?.verification_action(&user_id, &flow_id, action).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn scan_verification_qr(state: State<'_, AppState>, account: String, user_id: String, flow_id: String, data: Vec<u8>) -> CmdResult<()> {
    adapter_for(&state, &account)?.scan_verification_qr(&user_id, &flow_id, data).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn contact_infos(state: State<'_, AppState>, account: String) -> CmdResult<Vec<trix_core::ContactInfo>> {
    adapter_for(&state, &account)?.contact_infos().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn remove_contact_info(state: State<'_, AppState>, account: String, medium: String, address: String) -> CmdResult<()> {
    adapter_for(&state, &account)?.remove_contact_info(&medium, &address).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn add_email_start(state: State<'_, AppState>, account: String, email: String) -> CmdResult<String> {
    adapter_for(&state, &account)?.add_email_start(&email).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn add_email_finish(state: State<'_, AppState>, account: String, token: String, auth: DeviceAuth) -> CmdResult<SignOutDevice> {
    adapter_for(&state, &account)?.add_email_finish(&token, auth).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn sign_out_device(state: State<'_, AppState>, account: String, device_id: String, auth: DeviceAuth) -> CmdResult<SignOutDevice> {
    adapter_for(&state, &account)?.sign_out_device(&device_id, auth).await.map_err(|e| e.to_string())
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

// Commands that touch the engine or disk are async: Tauri runs plain commands on the
// main thread, where waiting (for the engine lock during sync, or decrypting the cached
// chat list) freezes the window.

/// Brings back every saved account; failures are reported to the UI per account.
async fn restore_all(app: AppHandle) {
    let data_dir = app.state::<AppState>().data_dir.clone();
    for account in accounts::load(&data_dir) {
        let result = async {
            let blob = accounts::session(&account.id)?;
            let adapter: Arc<dyn ProtocolAdapter> = match account.protocol.0.as_str() {
                trix_talk::PROTOCOL => trix_talk::TalkAdapter::restore(account.clone(), &blob).map_err(|e| e.to_string())?,
                trix_ntfy::PROTOCOL => trix_ntfy::NtfyAdapter::restore(account.clone(), &blob).map_err(|e| e.to_string())?,
                _ => MatrixAdapter::restore(&data_dir, account.clone(), &blob).await.map_err(|e| e.to_string())?,
            };
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
async fn restored(app: AppHandle) -> bool {
    let state = app.state::<AppState>();
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
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(
            tauri_plugin_log::Builder::default()
                // Libraries only warn: matrix-sdk/ruma log tens of thousands of lines per sync at
                // info, which filled 5 MB in seconds and slowed start-up. Our own crates log info.
                .level(log::LevelFilter::Warn)
                .level_for("ms_trix_lib", log::LevelFilter::Info)
                .level_for("trix_core", log::LevelFilter::Info)
                .level_for("trix_matrix", log::LevelFilter::Info)
                .level_for("trix_talk", log::LevelFilter::Info)
                .level_for("trix_search", log::LevelFilter::Info)
                // Keep a few MB so problems can still be traced afterwards.
                .max_file_size(5_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(3))
                .build(),
        )
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let mut engine = Engine::new();
            engine.restore_activity(load_activity(&data_dir));
            let search = search::open(&data_dir);
            app.manage(AppState { engine: Mutex::new(engine), search, data_dir, sounds: Default::default(), privacy: Mutex::new((true, true)), close_to_tray: Default::default(), tray_unread: Default::default(), chat_list_dirty: Default::default(), dnd_until: Default::default() });
            // Save the chat list (encrypted) now and then, so the next start can show it at once.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(20)).await;
                    save_chat_list(&handle);
                }
            });
            tauri::async_runtime::spawn(restore_all(app.handle().clone()));
            // macOS: no App Nap (as chat apps do), so messages keep coming in while the screen is
            // locked or the window hidden; the display and the computer still sleep as usual.
            #[cfg(target_os = "macos")]
            {
                use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};
                let activity = NSProcessInfo::processInfo().beginActivityWithOptions_reason(NSActivityOptions::UserInitiatedAllowingIdleSystemSleep, &NSString::from_str("Receiving messages"));
                // For as long as the app runs.
                std::mem::forget(activity);
            }
            // The computer slept: a jump in the clock. Every account reconnects at once rather
            // than waiting out a connection that died meanwhile (up to a minute for Matrix).
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut last = SystemTime::now();
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    let time = SystemTime::now();
                    if let Ok(gap) = time.duration_since(last) {
                        if gap > std::time::Duration::from_secs(20) {
                            log::info!("woke up after {} s: reconnecting", gap.as_secs());
                            let state = handle.state::<AppState>();
                            let engine = state.engine.lock().unwrap();
                            engine.accounts().iter().filter_map(|a| engine.adapter(&a.id)).for_each(|adapter| adapter.wake());
                        }
                    }
                    last = time;
                }
            });
            // Send later: what's due goes out (also what came due while the app was closed).
            scheduled::load(app.handle());
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                    scheduled::send_due(&handle).await;
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::Focused(focused) => {
                let app = window.app_handle();
                let out = app.state::<AppState>().engine.lock().unwrap().set_window_focused(*focused, now());
                apply(app, out);
            }
            WindowEvent::CloseRequested { api, .. } if window.label() == "main" && window.app_handle().state::<AppState>().close_to_tray.load(std::sync::atomic::Ordering::Relaxed) => {
                api.prevent_close();
                let _ = window.hide();
            }
            // Closing the call window leaves the call first (it closes itself afterwards);
            // if it doesn't answer, it's closed anyway.
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } if window.label() == "main" || window.label() == CALL_POPOUT => place_call(window.app_handle()),
            WindowEvent::CloseRequested { api, .. } if window.label() == CALL_POPOUT => {
                api.prevent_close();
                let _ = window.emit_to(CALL_WINDOW, "trix://leave-call", ());
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(4)).await;
                    close_call_window(app).await;
                });
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            accounts,
            login_methods,
            login_oauth,
            login_password,
            login_sso,
            login_talk,
            login_ntfy,
            sign_out,
            conversations,
            teams,
            activity,
            search_messages,
            search_status,
            shared,
            messages,
            send,
            focus,
            mark_unread,
            mark_read,
            set_favourite,
            set_archived,
            message_at,
            message_context,
            pinned_messages,
            set_pinned,
            create_room,
            enable_encryption,
            set_team_room,
            set_team_order,
            set_history_visibility,
            set_permission,
            set_server_acl,
            set_join_rule,
            set_room_alias,
            restored,
            share_overlay,
            forward_message,
            call_api_upload,
            cloud_file_bytes,
            share_draw,
            share_draw_clear,
            share_raise_bar,
            open_call_window,
            audio_out::audio_outputs,
            spell::spell_suggestion,
            audio_out::set_audio_output,
            focus_call_window,
            close_call_window,
            call_window_state,
            pop_out_call,
            open_reminder,
            threads,
            identity_warnings,
            accept_identity,
            close_reminder,
            save_ringtone,
            ringtone,
            reminder_action,
            pop_in_call,
            dock_call_window,
            call_page_size,
            save_background_video,
            background_video,
            hide_share_overlay,
            stop_sharing,
            cached_chat_list,
            security_status,
            recover,
            set_typing,
            load_older,
            load_thread,
            open_url,
            open_call,
            toggle_reaction,
            set_presence,
            profile,
            room_details,
            update_room,
            set_room_avatar,
            pick_image_file,
            set_notify_prefs,
            set_dnd,
            notify_call,
            request_attention,
            set_ntfy,
            set_ntfy_token,
            has_ntfy_token,
            test_ntfy,
            link_preview,
            schedule_message,
            scheduled_messages,
            cancel_scheduled,
            send_scheduled_now,
            set_close_to_tray,
            set_tray_unread,
            set_texts,
            autostart,
            set_autostart,
            idle_seconds,
            test_notification,
            set_privacy,
            set_display_name,
            set_avatar,
            devices,
            rename_device,
            sign_out_device,
            contact_infos,
            remove_contact_info,
            add_email_start,
            add_email_finish,
            set_notification_level,
            invite_user,
            accept_invite,
            leave,
            search_users,
            create_chat,
            join_room,
            knock,
            room_preview,
            start_verification,
            set_ignored,
            user_devices,
            set_room_member_avatar,
            server_keywords,
            sync_keywords,
            verification_action,
            scan_verification_qr,
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
            send_voice,
            image_packs,
            send_sticker,
            poll,
            vote,
            end_poll,
            create_poll,
            own_pack,
            save_own_pack,
            upload_image,
            send_call_event,
            turn_servers,
            cloud_files,
            attach_cloud_file,
            calendars,
            notes,
            note,
            save_note,
            delete_note,
            render_markdown,
            link_target,
            cloud_apps,
            calendar_events,
            create_event,
            update_event,
            delete_event,
            calendar_people,
            respond_event,
            notify,
            conversation_link,
            security_page,
            can_translate,
            translate,
            call_api,
            log_ui,
            edit_message,
            delete_message,
            save_media,
            open_media,
        ])
        .build(tauri::generate_context!())
        .expect("error while running ms_trix")
        .run(|app, event| {
            // macOS: clicking the Dock icon brings a window hidden to the tray back.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                show_main(app);
            }
            let _ = (app, event);
        });
}
