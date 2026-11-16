# ms_trix architecture

A Teams-style chat client that is protocol-open and multi-org.

## Decisions

| Topic | Decision |
|---|---|
| Core protocol | Matrix first; other networks via mautrix bridges |
| Other protocols | Plugin adapters implementing `trix_core::ProtocolAdapter` (XMPP, IRC later) |
| Multi-org | One signed-in account = one org. All accounts sync simultaneously |
| Rail items | Driven by protocol capabilities: Teams = Matrix spaces; Calls hidden until MatrixRTC; no Calendar (would need CalDAV/Exchange integration) |
| Org switching | Org switcher in the top tile of the app rail (where Teams shows the org logo); "All organizations" combined view; ⌘0 / ⌘1-9 |
| E2EE | Required. Matrix via matrix-rust-sdk crypto |
| Unread | Client-owned state machine in `trix-core/src/unread.rs`; server counts are inputs only |
| Stack | Tauri 2 (Rust core) + React/TypeScript UI. Mobile later via Tauri mobile or UniFFI |

## Layout

```
crates/
  trix-core/      protocol-agnostic model, adapter trait, unread state machine
  trix-matrix/    Matrix adapter (matrix-sdk 0.19, classic sync for now)
  trix-xmpp/      XMPP adapter                                [later]
  trix-irc/       IRC adapter                                 [later]
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
  falls back to classic `/sync` otherwise; `MS_TRIX_CLASSIC_SYNC=1` forces classic.
  Both feed the same `room_changed` path. Sliding sync has no presence, so 1:1
  contacts' presence is polled every minute in that mode.
* Each room's recent history and read state (main and per-thread receipts) are
  loaded once per session, at startup or when a room first shows up.
* Login: the server is asked for its login types; password and SSO (browser +
  local redirect server) are supported. Native OAuth (MAS) is a later step.
* Sessions live in the OS keychain (service `ms_trix`); `accounts.json` in the
  app data dir holds only the non-secret account list.

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
