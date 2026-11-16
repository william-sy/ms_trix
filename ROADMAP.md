# Roadmap

Ordered by what makes ms_trix usable as a daily driver first. Anything not
built yet is visibly disabled in the UI with a "coming soon" tooltip.

## Done
- [x] Teams-style shell, org switcher (⌘0 / ⌘1-9), multi-account
- [x] Matrix login (password + SSO), sessions in OS keychain
- [x] Client-owned unread model with sticky "mark as unread"
- [x] Send/receive text, favourites
- [x] Recovery key: verify this device + enable key backup
- [x] Last 30 messages per chat on startup, keys pulled from backup when needed
- [x] Profile/room pictures (incl. DM fallback, own avatar refresh)
- [x] Inline images (incl. encrypted), image viewer, save/open files, incoming stickers
- [x] Replies, thread panel (for threads within the loaded messages)
- [x] Slash commands (/me /shrug /tableflip /unflip /lenny /plain /help) with suggestions
- [x] Markdown sending (renders for recipients), format bar incl. code block, sticky format mode
- [x] Emoji picker (categories + recent), big emoji-only messages
- [x] Read receipts ("Seen" / "Seen by"), typing indicators (both directions)
- [x] Chat list search (⌘E) by chat/channel name and last message
- [x] Rich text rendering (sanitized HTML: code blocks, lists, quotes, tables, links, mention pills)
- [x] Search inside a chat (loaded messages, ↑/↓, "search older messages")
- [x] Infinite scrollback, full threads loaded when opened
- [x] Emoticon (:P → 😛) and :shortcode: auto-replace while typing
- [x] Reactions (quick bar + any emoji, toggle, who reacted), edit own messages, delete
- [x] Desktop notifications (chats; channels only on mention; muted never) + Dock badge
- [x] Mute / mentions-only read from Matrix notification settings
- [x] @mention autocomplete; mentions show as one pill in the composer and delete in one go
- [x] Send files and images: attach, paste, drag & drop go to a tray first; text becomes the caption
- [x] Format bar: Quote/List prefix the current or selected lines (toggle), smart code blocks
- [x] Settings: theme (system/light/dark), accent colour (presets + custom), text size
- [x] Read markers in the right margin (Element-style): who read up to which message
- [x] Invites: listed at the top of the chat list with Accept / Decline, invite screen in the chat pane
- [x] New chat: search people, start a DM (reuses an existing one) or an encrypted group chat, join by #address
- [x] Browse rooms & spaces: public rooms / public spaces / people, your own server by default (any server
      possible), open a space to see and join its rooms
- [x] Chat list: separate Chats and Channels sections; name filter (🔍); dropped "Meeting chats" (returns with calls)
- [x] Teams view: your spaces as teams with their channels, unread per team, "N more channels" opens the space
- [x] Channels as posts: each message a card, always-visible Reply (thread), "Start a new post"
- [x] Activity feed: mentions, replies and reactions to you; filters; unread badge; jump to the message; mark all as read
- [x] i18n: all UI text in JSON locales (English + Dutch), language setting, typed keys, locale check in the build
- [x] Leave a chat or room (chat list right-click → Leave)
- [x] Profile pop-up: click an avatar, name or @mention; presence, verified, shared rooms, Chat / copy ID
- [x] Room events in the timeline: joined / left / invited / removed / banned, name and picture
      changes, room name / topic / picture, encryption; runs of 3+ collapse ("Anna and 3 others joined")
- [x] Inline video and audio players (byte-range streaming through the media protocol)
- [x] Undecryptable messages show "waiting for key" and fill in once the key arrives (other device or key backup)
- [x] Search across all chats from the top bar (messages loaded on this device), jump to the result
- [x] Sliding sync (fast startup like Element X) with automatic fallback to classic sync
- [x] Thread read receipts loaded at startup; muted chats show no unread count
- [x] Chat header ⋯ menu: room info / people, notification level, favourite, leave
- [x] Room info panel: picture, name and topic (editable with permission), encryption, notifications,
      members with roles and search, invite people
- [x] Presence: dots on 1:1 chats + status in the header (when the server shares it);
      set your own Available / Away / Appear offline per account

## Known issues
- [ ] Hover actions overlay may cover the previous message when tightly grouped

## 1. Daily driver
- [ ] Persistent local search index (SQLite FTS / tantivy) so search covers full history,
      not just loaded messages; server-side search can't read encrypted rooms
- [ ] Click a room link (#room / matrix.to room) to open or join it
- [ ] Ask other devices for missing keys (key requests); "verify this device to decrypt" hints
- [ ] Upload progress; video thumbnails/poster frames; voice messages with waveform
- [ ] Click a notification to open that chat (needs click events from the notification plugin on macOS); per-chat notification settings in the UI
- [ ] Notify on new invites; non-public rooms inside spaces you're in
- [ ] More slash commands, see the checklist below
- [ ] Shared tab: files, images and links per chat (filtered /messages)
- [ ] Sliding sync follow-ups: cache the room list between runs; tune list size and timeline limits

## 2. Profiles, settings and polish
- [ ] Profile: verify someone (SAS), ignore / block, see their devices
- [ ] Room settings, advanced: address, enable encryption, permissions/roles, kick/ban, banned users
- [ ] Devices: list your sessions, rename / sign out, verify (ties in with SAS verification)
- [ ] Account: change profile picture, display name, status (see extended profile fields)
- [ ] Personal info: email addresses and phone numbers linked to the account (3PIDs)
- [ ] Notification sounds: OS default or pick a sound; per-type (message, mention, call)
- [ ] Notification settings: all messages / mentions / people / keywords, per chat and global
- [ ] Usual app settings: start at login, close-to-tray, spell check, language, shortcuts
- [ ] i18n follow-up: translate text generated in Rust (previews, notifications, command
      results, errors) by sending structured data to the UI; more languages
- [ ] Clean-up: "forget" left rooms, delete/hide old chats, leave a whole team at once,
      archive instead of leave

## 3. Teams feel
- [ ] Teams: space invites, nested spaces as sub-teams, reorder/pin teams, team settings
- [ ] Activity: keep the feed across restarts; mark items read individually; keyword alerts
- [ ] Presence: remember your chosen status across restarts; auto-away when idle
- [ ] Status messages that other clients actually show (Matrix extended profile
      fields); Element ignores presence status_msg, so the option is hidden for now
- [ ] More settings: notifications, composer mode, accounts, devices; custom theme colours beyond accent
- [ ] Emoji verification with another session (SAS), device list
- [ ] Emoji search by name, custom emoji
- [ ] Send stickers (MSC2545 image packs)
- [ ] GIF picker with search (opt-in: needs a third-party GIF service, privacy
      notice); sending/receiving GIF files already works and animates

## 4. Beyond
- [ ] Calls via MatrixRTC / Element Call (enables Calls rail item)
- [ ] Native OAuth login (MAS)
- [ ] XMPP adapter, IRC adapter
- [ ] Calendar via CalDAV/Exchange (optional integration)
- [ ] Nextcloud integration:
  - [ ] Nextcloud Talk as a protocol adapter (same plugin slot as XMPP/IRC)
  - [ ] Attach from Nextcloud Files: pick a file and send a share link instead of uploading
  - [ ] Nextcloud Calendar via CalDAV (fills the Calendar rail item)
- [ ] Mobile (Tauri mobile or UniFFI)
- [ ] Signed release builds (single keychain prompt, auto-update)

## Slash commands (parity with Element)
Reference: `Reference+pictures/commands`.

Done
- [x] /me, /shrug, /tableflip, /unflip, /lenny (prepend, like Element), /plain, /help

Messages
- [ ] /spoiler <message>
- [ ] /html <message>: send raw HTML
- [ ] /rainbow, /rainbowme
- [ ] Effects: /confetti, /fireworks, /rainfall, /snowfall, /spaceinvaders, /hearts
      (send Element's effect msgtypes; show the animation when received)
- [ ] /jumptodate <YYYY-MM-DD>

Rooms and profile
- [x] /join, /goto, /part, /invite, /query, /msg, /topic, /roomname, /nick, /whois
- [ ] /roomavatar, /myroomnick, /myavatar, /myroomavatar
- [ ] /converttodm, /converttoroom, /upgraderoom

Moderation
- [ ] /remove, /ban, /unban <user> [reason]
- [ ] /op <user> [level], /deop <user>
- [ ] /ignore, /unignore <user>

Later or not planned
- [ ] /holdcall, /unholdcall (with calls)
- [ ] /verify, /discardsession (with device verification)
- [ ] /devtools, /addwidget, /rageshake: Element-specific, probably skip

