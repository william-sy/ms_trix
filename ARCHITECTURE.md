# Trixcomm architecture

A Teams-style chat, meetings and calendar client that is protocol-open and multi-org.
Licensed GPL-3.0-or-later.

## Decisions

| Topic | Decision |
|---|---|
| Core protocol | Matrix first; other networks via mautrix bridges |
| Other protocols | Adapters implementing `trix_core::ProtocolAdapter`: Nextcloud Talk and ntfy now; Zulip and Mattermost next (see ROADMAP.md); XMPP and IRC skipped |
| Multi-org | One signed-in account = one org. All accounts sync simultaneously |
| Rail items | Driven by protocol capabilities: Teams = Matrix spaces; Calls = Matrix 1:1 and Talk calls (Matrix group calls wait for MatrixRTC); Calendar = Nextcloud over CalDAV |
| Org switching | Org switcher in the top tile of the app rail (where Teams shows the org logo); "All organizations" combined view; ⌘0 / ⌘1-9 |
| E2EE | Required. Matrix via matrix-rust-sdk crypto |
| Unread | Client-owned state machine in `trix-core/src/unread.rs`; server counts are inputs only |
| Stack | Tauri 2 (Rust core) + React/TypeScript UI. Mobile later via Tauri mobile or UniFFI |
| Name | Trixcomm (ms_trix until 1.5.1). Kept under the first name, as users' data lives there: the app identifier `nl.mstrix.app` (data, logs and web storage folders), the keychain service `ms_trix`, the settings key `ms_trix.settings`, Matrix's sliding sync id; also the crate/binary names `ms-trix-desktop` and `ms_trix_lib` (a development build's web storage is named after the binary) |

## Layout

```
crates/
  trix-core/      protocol-agnostic model, adapter trait, unread state machine
  trix-matrix/    Matrix adapter (matrix-sdk 0.19, sliding sync with classic fallback)
  trix-talk/      Nextcloud Talk adapter (OCS REST, Login Flow v2, polling, CalDAV, Notes)
  trix-ntfy/      ntfy adapter: topics as rooms, one streaming JSON connection, publish
  trix-search/    encrypted local full-text index (all history, the Shared tab)
  trix-zulip/     Zulip adapter                               [next]
  trix-mattermost/ Mattermost adapter                         [next]
apps/
  desktop/        Tauri app; React UI in src/, Rust host in src-tauri/
```

The UI never talks to a protocol directly: adapters emit `AdapterEvent`s into
the core, the core owns state (including unread), and the Tauri host exposes
that state to the UI through commands and events.

## Adding a protocol

1. New crate `crates/trix-<name>` depending on `trix-core`.
2. Implement `ProtocolAdapter` (one instance per account) and `AdapterFactory`.
3. Declare honest `Capabilities`; the UI hides what a protocol can't do.
4. Register the factory in the Tauri host's `AdapterRegistry`.

## Unread rules

* Marking unread while a conversation is open sticks until you leave and come back.
* Your read receipt from another device clears the flag only if it is newer than the mark.
* A stale synced `m.marked_unread` cannot overwrite a local change not yet echoed by the server.
* Threads are tracked separately and roll up into the conversation summary.
* Sending a message reads everything before it.

## Matrix notes

* Receipts and `m.marked_unread` are sent as raw requests: matrix-sdk's
  `send_single_receipt` silently clears the marked-unread flag, and
  `set_unread_flag` skips writes when its cache matches. Both decisions belong
  to `UnreadState`.
* Both `m.marked_unread` and the older `com.famedly.marked_unread` are read.
* Sync uses sliding sync (MSC4186, like Element X) when the server offers it and
  falls back to classic `/sync` otherwise; `TRIXCOMM_CLASSIC_SYNC=1` forces classic.
  Both feed the same `room_changed` path. Sliding sync has no presence, so 1:1
  contacts' presence is polled every minute in that mode.
* Each room's recent history and read state (main and per-thread receipts) are
  loaded once per session, at startup or when a room first shows up.
* Login: the server is asked for its login types; password and SSO (browser +
  local redirect server) are supported. Native OAuth (MAS) is a later step.
* Sessions live in the OS keychain (service `Trixcomm`); `accounts.json` in the
  app data dir holds only the non-secret account list.
* Invisible crypto (MSC4153, like Element X): the client shares room keys with
  `CollectStrategy::IdentityBasedStrategy`, so sending encrypted messages needs this
  device cross-signed. Decryption keeps the default trust requirement (any device):
  `CrossSignedOrLegacy` also refused history from devices that were since removed.
  Should a stricter setting come back, those messages become `MessageBody::Untrusted`.
  Identity changes come from `Room::subscribe_to_identity_status_changes` (first
  item = current state) and are accepted with `UserIdentity::pin`.

## UI text (i18n)

* Every user-visible string goes through `t()` from `apps/desktop/src/i18n.ts`.
  English (`src/locales/en.json`) is the source and fallback; other languages
  sit next to it (`nl.json`). Keys are type-checked against `en.json`.
* Placeholders use `{name}`; plurals use `key_one` / `key_other` (resolved with
  `Intl.PluralRules`), called as `t("key", { count })`.
* `npm run check:locales` (also part of `npm run build`) fails when a language
  misses a key or has different placeholders.
* Strings produced in Rust (chat previews, notifications, command results,
  errors) are still English; they move to structured data the UI translates.

## Nextcloud Talk notes

* Login Flow v2 (browser) gives an app password, kept in the keychain like a
  Matrix session and revoked (`DELETE /ocs/v2.php/core/apppassword`) on sign-out.
* Talk message ids only grow, so the id is the timeline position; read markers
  (`lastReadMessage`) map onto it directly.
* Updates: the conversation list is polled every 5 s (`modifiedSince`, full list
  every 30 s to notice removals such as deleted meetings); new messages are
  fetched where `lastMessage` moved. Typing and push are still to come.
* Room settings (notifications, lobby, permissions, password, recording consent,
  message expiry, picture, …) go through `call_api`, which allows only Talk's own
  room endpoints; Meet now creates a public room (`roomType` 3).
* Reactions arrive as counts (`ReactionsReplaced`); edits/deletes/reactions come
  as system messages carrying the updated parent. Other system messages are
  shown with the server's own (translated) wording (`RoomEventKind::Other`).
* Files are uploaded to the user's `Talk/` folder over WebDAV and shared into
  the conversation (share type 10), with the caption in `talkMetaData`.

## Calls

* Talk calls run in the webview (WebRTC, `apps/desktop/src/talkCalls.ts`) over
  Talk's signalling: the high-performance backend (WebSocket, with or without an
  MCU, a video server) or Talk's internal signalling (polling) when there is none.
  Offers carry the display name, so tiles and raised hands show names.
* Each Talk call gets a webview of its own (`talk-call`, `OwnCallWindow.tsx`).
  The host docks it in the main window (filling it, or a card in the corner when
  minimised) or reparents it into a window of its own (`talk-call-window`);
  moving between the two keeps the connection. This uses Tauri's `unstable`
  multi-webview feature. The main window only sees which conversation is in a
  call (`trix://call-window`).
* Matrix 1:1 calls (legacy `m.call.*` events) run in the main webview.
* Screen sharing opens click-through overlay windows: a red border, a bar with
  Stop and drawing tools, and a see-through drawing layer that is captured with
  the screen. Sharing minimises the call so it doesn't film itself.
* Background blur and pictures use MediaPipe's segmenter, bundled with the app. Moving
  backgrounds are drawn in code each frame (`movingBackgrounds.ts`); your own video or GIF is
  kept in the app's data folder (too big for the webview's local storage).
* Send later is done by the app (`scheduled.rs`): the list is sealed with the search index's key
  in the data folder, and a timer sends what's due through the normal adapter `send`.
* Link previews are fetched by the app (`links.rs`), never through the homeserver; the phishing
  check (`linkCheck.ts`) runs in the UI on this computer only.
* Speaker choice: WebView2 (Windows) supports `setSinkId`; WebKit doesn't, so on
  macOS the call switches the system output through CoreAudio (`audio_out.rs`).

## Updates

* Tauri's updater plugin, driven from Rust (`src-tauri/src/updates.rs`: `check_update`,
  `install_update`); the UI is `src/updates.tsx` (banner under the title bar, Settings → About).
* The app reads `latest.json` from the latest GitHub Release and installs only files signed with
  the update key whose public half is in `tauri.conf.json` (`plugins.updater.pubkey`).
* `.github/workflows/build.yml` signs the update files when the `TAURI_SIGNING_PRIVATE_KEY` and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets are set (without them, e.g. in forks, it builds
  without update files); on a tag, `apps/desktop/scripts/update-manifest.mjs` writes
  `latest.json` with an entry per installer kind (`darwin-aarch64-app`, `windows-x86_64-nsis`,
  `windows-x86_64-msi`, `linux-x86_64-appimage`, `linux-x86_64-deb`), which the updater picks by
  how the app was installed.
* Development builds don't update (`check_update` fails on purpose).

## Calendar

* Nextcloud calendars over CalDAV (`crates/trix-talk/src/dav.rs`). Repeating
  events keep their RRULE; editing one occurrence writes a `RECURRENCE-ID`
  override, deleting one adds an `EXDATE`, and editing the series shifts it while
  keeping its time zone.

## Search

* `trix-search` keeps a full-text index of all history on this device. It holds
  decrypted messages, so it is encrypted on disk with a key in the OS keychain;
  older history is indexed in the background.
