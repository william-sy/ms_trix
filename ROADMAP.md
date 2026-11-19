# Roadmap

## Decisions (2026-11-17)
- Done: full-history search and the Shared tab
- Search index: encrypted on disk, key in the OS keychain (it holds decrypted messages)
- Archive: Matrix tags, both an own "archived" tag and the standard m.lowpriority, so other
  clients (Element, mobile) also move archived chats out of the way
- GIF picker: skipped for now; keep as an idea (needs a third-party service + privacy notice)
- Calls/verification are tested with a colleague on matrix.surf.nl
- No signing certificates or GitHub repo yet: unsigned dev builds for now
- First users: SURF (Matrix + Nextcloud Talk). Next protocols: Zulip and Mattermost (own roadmaps
  below); XMPP and IRC skipped. Languages: English + Dutch for now
- Releases: GitHub repo + unsigned builds for all OSes first (acceptable for v1); signing follows
  once certificates are sorted (Apple fee waiver for education, GÉANT TCS / SignPath for Windows)

## Next versions (ideas from 2026-11-19)
1.2 (in progress):
- [x] Do not disturb until a chosen time (account menu): no notifications or sounds; calls and
      reminders still show, silently; you show as busy, with when it ends as your status
- [ ] #hashtags highlighted and clickable: every message with that tag, in this chat or all chats
- [ ] Link previews (fetched by the app itself, not the homeserver; setting to turn them off),
      with a phishing check on this computer only: link text vs. destination, lookalike and
      mixed-script domains, URL tricks (user@host, IP addresses), where redirects really lead
- [ ] Repeating meetings in the calendar (RRULE, as Nextcloud Calendar supports)
- [ ] Send later: write now, sent at a chosen time by this app (Matrix has no server-side
      scheduling yet; a message whose time passed while the app was closed goes out at start)

1.3 (candidates):
- [ ] ntfy add-on: forward notifications to an ntfy topic (a webhook), e.g. to your phone while
      you're away from the computer
- [ ] Nextcloud Notes, if the account's Nextcloud has the Notes app (its REST API)
- [ ] Phishing check against a downloaded list of known phishing sites (e.g. OpenPhish), checked
      locally, if the built-in checks turn out too limited

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
- [x] Read receipts (ticks on your messages; who read it under Message status), typing indicators (both directions)
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
- [x] Own colour per account (Settings → Accounts, click the account tile)
- [x] Settings → Audio & video: choose microphone / speaker / camera, mic test with level meter,
      speaker test sound, camera preview; voice messages use the chosen microphone
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
- [x] Nextcloud Talk adapter: browser sign-in, conversations, messages, replies, edits, deletes,
      reactions, files (send + view), read markers, mark unread, favourites, notification level,
      presence, members, invite, new chats, open conversations to join; polling every 5 s
- [x] Build pipeline: GitHub Actions job per OS (macOS Apple Silicon only, Windows, Linux) with installers as artifacts
- [x] Talk calls (step A): Start / Join call opens Talk's own call screen in an ms_trix window
      (video, screen sharing, HPB); "call in progress" 📞 in the chat list; notification when a call starts
- [x] Captions under images/files (Matrix `filename` + `body`, Talk text with a shared file)
- [x] Chat header ⋯ menu: room info / people, notification level, favourite, leave
- [x] Room info panel: picture, name and topic (editable with permission), encryption, notifications,
      members with roles and search, invite people
- [x] Presence: dots on 1:1 chats + status in the header (when the server shares it);
      set your own Available / Away / Appear offline per account

## Known issues
- [x] Hover actions overlay covered the previous message when tightly grouped
- [x] Wide code blocks didn't wrap when the window got narrower

## 1. Daily driver
- [x] Full-history search: encrypted local index (trix-search: SQLite + the Matrix SDK store
      cipher; text encrypted, words only as keyed prefix hashes; key in the OS keychain).
      Live messages indexed as they arrive, history crawled in the background (Matrix + Talk),
      title bar search and "search in this chat" (older matches list) use it; picking a hit
      pages back until the message is loaded
- [x] Search follow-ups: undecryptable messages from the crawl are retried (every 10 min) and
      indexed once their key has arrived; rooms joined later are crawled without a restart
- [x] "Jump to latest" button when scrolled up more than a screen
- [x] New room (New dialog: Chat | Room): name, topic, invited / anyone, address, encryption,
      invite people; Matrix and Talk
- [x] Rooms section: named rooms outside a team (unnamed group chats stay under Chats)
- [x] /help opens a scrollable command list above the composer; the "/" suggestions scroll
- [x] Faster jumps to old messages (250-message pages while seeking, up to 25,000 back); /jumptodate
- [x] Old search results open as a preview with the surrounding messages (one request, Matrix /context
      and Talk context); "Show in chat" still pages back to it
- [x] Shared tab per chat: Media (grid, lightbox), Files (open / save), Links; "Show in chat"
      jumps to the message. Built on the search index (hidden kind markers), so it covers the
      crawled history; encrypted pictures get their key looked up on demand
- [x] Click a room link (#room:server, matrix.to, matrix: URIs, Element links) to open it, at the linked
      message, or see a preview and join; Matrix links in Talk chats go through a Matrix account
- [x] "Waiting for key" messages link to verifying this session or entering the recovery key
      (key requests to other sessions are sent automatically by the SDK)
- [x] Upload progress (Matrix)
- [x] Voice messages: mic button when nothing is typed, recording bar with timer, sent like Element's
      (voice + duration + waveform; Opus where possible, AAC in the macOS webview); live level meter
      while recording; silent recordings aren't sent (hint about microphone access)
- [x] Videos show their first frame; voice messages play in a waveform player (Element's format)
- [x] Send a thumbnail with videos (still made in the app; Matrix gets thumbnail + size + length)
- [x] Per-chat notification settings in the UI (chat header ⋯ menu)
- [ ] Click a notification to open that chat (needs click events from the notification plugin on macOS)
- [x] Notify on new invites (not for invites already waiting at startup)
- [x] Rooms inside teams: all pages of the hierarchy, "Team members" rooms, "Ask to join" (knock), "Invite only" shown as such
- [x] More slash commands (see the checklist below)
- [x] Chat list from the previous run shows at once on start (encrypted cache), replaced by the live list
- [x] Sliding sync: list grows in batches of 50 with 5 events per room; the open chat gets its own
      subscription with 30 events

## 2. Profiles, settings and polish
- [x] Emoji verification (SAS): verify someone from their profile card, verify your other sessions
      (or this one) from Settings → Accounts; incoming requests open a dialog (+ OS notification);
      in-chat requests show as a grey line instead of the "client does not support" fallback
- [x] Profile: ignore / stop ignoring (Matrix ignore list)
- [x] Verification emoji names in Dutch
- [x] Profile: their sessions, signed by them or not
- [x] QR verification: show a QR code for the other device (Element mobile) to scan, next to emoji
- [x] Scan someone else's QR code with the camera (verification: "Scan their code")
- [x] Room settings, advanced: who can join (invited / anyone; Talk: public link), address
      (#name on your server), turn on encryption, roles (admin / moderator / member), remove and ban
      with reason, banned list with unban; only for people below your own level
- [x] Room settings: who can read history, permissions per action (send, invite, remove, ban,
      delete, name/topic/picture, other settings, new members' level), server ACL (allow/deny)
- [x] Settings window with tabs: General, Accounts, Notifications, Privacy
- [x] Devices (Matrix): list sessions with last seen/IP and verified state, rename, sign out others
      (password, or the browser confirmation step for SSO accounts)
- [ ] Devices: Talk app passwords
- [x] Account: change profile picture and display name (Matrix and Talk); picture cropper
      (drag + zoom, round preview), also used for room pictures
- [ ] Account: status (see extended profile fields)
- [x] Email addresses and phone numbers linked to the account: list, remove, add an email
      (confirmation mail, then password or browser step)
- [x] Notification sounds per type (message, mention/keyword, call): system default, none, or a
      macOS system sound; test button
- [x] Notification rules: chats and channels each all / mentions / off, call notifications,
      keywords (whole word, count as mentions; kept on this device for all accounts)
- [x] Keyword hits in the Activity feed (own filter)
- [x] Keywords synced as Matrix push rules (keywords set in Element are taken in, changes pushed to every Matrix account)
- [x] Privacy: read receipts off (Matrix private receipts, Talk read_status_privacy), typing off
- [x] App settings: start at login, close to tray (tray icon with Open/Quit; Dock click reopens
      on macOS), spell check in the composer
- [x] Keyboard shortcuts: list in Settings (⌘/), ⌘, ⌘N ⌘F ⌘⇧U, ⌘⇧1-3 for Activity/Chat/Teams,
      ⌥↑/⌥↓ previous/next chat (with ⇧: unread only)
- [x] Unread count on the tray icon (next to it on macOS, in the tooltip everywhere)
- [x] Customise keyboard shortcuts (Settings → Shortcuts: click, press keys; clash warning, reset)
- [x] Texts made in Rust follow the UI language: chat previews, system notifications, command
      results (core text table with English fallback; the UI sends its "rust.*" translations)
- [x] Common server/network errors in plain words in the UI language (code kept in brackets)
- [ ] i18n: more languages
- [x] Clean-up: leaving also forgets the room; leave a whole team at once (right-click a team)
- [x] Archive (chat list right-click): Matrix "u.archived" tag + m.lowpriority (Element's Low
      priority also counts as archived), Talk's own archive; collapsed Archived section, archived
      chats with unread messages come back into the list until read

## 3. Teams feel
- [x] Teams: nested spaces as sub-teams; pin and move teams up/down (kept on this device)
- [x] Teams: team invites (top of Teams and in the chat list), Team info panel (picture, name,
      description, members, roles, who can join) via right-click
- [x] Teams: add rooms (picker) / remove a room (right-click a channel), also setting the room's
      link back; team order synced with Element (MSC3230 space order)
- [x] Activity: feed kept across restarts; read state remembered; mark single items read/unread;
      keyword hits
- [x] Presence: remember your chosen status across restarts; auto-away after 5 min idle
      (system idle time on macOS, activity in the window elsewhere) and back when you return
- [x] Presence: system idle time on Windows (GetLastInputInfo) and Linux (GNOME idle monitor,
      or xprintidle on X11); "away after" 5–60 minutes or never
- [x] Presence: idle time on KDE (org.freedesktop.ScreenSaver)
- [ ] Presence: test the Windows/Linux idle paths on real machines (macOS tested 2026-11-18)
- [ ] Status messages that other clients actually show (Matrix extended profile
      fields); Element ignores presence status_msg, so the option is hidden for now
- [x] More settings: Enter sends on/off, compact layout, own colours (chat background, chat list,
      side bar, bubbles)
- [x] Emoji search by name and keyword, English + Dutch (emojibase data, loaded on first search)
- [x] Custom emoji (MSC2545 packs: own, linked rooms, this room): ★ tab, :name: sends an inline
      image, received ones show inline; Settings → Emoji & stickers to manage your own pack
- [x] Send stickers from your packs (+ button in the composer)
- [x] Click someone's custom emoji to add it to your own pack; emoji-only messages (also custom
      emoji) shown big, size small / medium / large in Settings
- [x] App icon: two chat bubbles with typing dots (apps/desktop/assets/logo.svg → `tauri icon`)
- [ ] Idea, parked: GIF picker with search (opt-in: needs a third-party GIF service such as
      Klipy or Giphy, privacy notice); sending/receiving GIF files already works and animates

## 4. Beyond
- [x] Calls step B: Talk calls in ms_trix's own call screen (1:1 video with a Talk client works on SURF).
      Talk REST for membership + signalling settings; signalling over the HPB (WebSocket, MCU or
      mesh) or Talk's built-in signalling; WebRTC here. Teams-like grid with speaker ring, own tile
      in the corner, shared screen large with a strip of faces, mute/camera/share/leave, minimise.
      Every step logged ("talk call:" in the log); Talk's own window stays in the ⋯ menu.
      Pre-join screen (preview, mic level, device choice, join muted / camera off); devices picked
      there are remembered for the next call, and can be switched during the call (⚙ menu);
      joining a running call starts with the camera as you last had it
- [ ] Talk calls: test group calls (grid layout) and screen sharing on SURF
- [x] Screen sharing: red border around the shared screen + floating "Stop sharing" bar (both kept
      out of the capture), "You're sharing · Stop sharing" in the call header; Talk (video server):
      screen offered with "sendoffer" like Talk's web app, also to people joining later; own name sent
      as nick (Talk showed the user id for raised hands)
- [x] Calls as a window inside the app: floats over the chats (move by the header, resize from the
      corner, size remembered), or fill the app; minimise to the small panel as before
- [x] Speaker choice before joining and during calls (🔊): the webview's own output choice where it
      exists (Windows); on macOS the Mac's sound output via CoreAudio (WebKit has no setSinkId)
- [x] Talk calls in their own window (for a second screen): ⧉ in the call moves it there (rejoins),
      "Back to the app" moves it back; remembered for the next call; closing the window leaves the call
- [ ] Matrix 1:1 calls in their own window (signalling lives in the main window; needs a hand-over)
- [x] Forward a message (message ⋯ menu): any chat or channel on any account, optional note first;
      files are downloaded and sent again, so Matrix ↔ Talk works too
- [x] Draw on your shared screen (whole screen only): ✎ Draw on the share bar; pen, highlighter, arrow,
      laser pointer (fades), five colours, Clear, Done/Esc; the drawing layer is captured so others see
      it, the bar is not
- [x] Talk calls: raise hand (✋ on tiles), reactions floating over the call, ringing pop-up when
      someone starts a Talk call (rings for 1:1, quiet for groups)
- [x] Talk calls: "Recording" notice in the call bar when Talk's recording server records the call
- [x] Calls: camera background (blur, strong blur, built-in pictures, your own picture) for Talk and
      Matrix calls; on-device person detection (MediaPipe, served locally); pick it before joining,
      during a call (✨) or in Settings → Audio & video
- [x] Talk call layouts: automatic / gallery / speaker, pin someone to the stage (📌 or double-click),
      own camera small in the corner
- [x] Talk call layouts like Teams: large gallery (49 a page) and pages of 9/49 in the gallery;
      a shared screen with people beside it, above it, or content only (sound keeps playing)
- [x] Meeting reminders in a small window on top of other windows (with Join), or inside the
      app (Settings → Notifications); 1–30 minutes before or never; meetings made or changed in
      the app are picked up at once, moved or cancelled ones lose their old reminder; double
      booked: one pop-up with a row per meeting and one sound
- [x] Moving camera backgrounds: leaves in the wind, drifting clouds, fireflies, misty mountains
      with depth (drawn in code, no video files), or your own video (MP4/MOV/WebM) or GIF up to 60 MB
- [x] Ringtones: Tide, Lantern, Sparkle, Old telephone, 90s mobile, Classic beeps (made in code,
      no sound files), or your own sound file, for incoming calls; meeting reminders have their
      own sound (a short chime by default, or any ringtone)
- [x] Talk calls run in a webview of their own, docked in the app or moved into a window of
      their own: moving between the two keeps the call connected (no rejoin); sharing your
      screen minimises the call's own window too
- [x] Talk: group conversations without their own picture (Talk sends SVG) show it now
- [x] Matrix 1:1 calls (VoIP v1, Element-compatible): voice/video buttons in direct chats,
      ringing pop-up + system notification, call screen (shared screen large, camera tile, own
      preview), mute / camera / screen share (renegotiation + stream metadata), minimise to a
      floating panel, TURN from the homeserver, chosen mic/camera/speaker; ends on missed /
      declined / answered elsewhere
- [x] Matrix calls: lines in the chat (started a voice/video call, ended, missed, declined; also in
      history), Calls rail with recent calls + missed-call badge + call back, glare handling
- [x] Matrix calls: picture-in-picture (system floating video window) where the webview supports it
- [ ] Matrix group calls via MatrixRTC / Element Call widget (matrix-sdk widget driver is ready; matrix.surf.nl
      has no MatrixRTC/LiveKit configured yet, so this waits for SURF's server side). Also 1:1 calls
      over MatrixRTC: Element X only calls that way, so our legacy 1:1 calls can't reach Element X users
- [x] Native OAuth login (MAS): "Sign in with your browser" when the server offers it; loopback
      redirect, dynamic client registration, refreshed tokens saved to the keychain (to be tested on
      a server with MAS)
- [ ] Calendar via Exchange / other CalDAV servers (Nextcloud's is done)
- [ ] Nextcloud integration:
  - [x] Talk: the open conversation gets new messages instantly (long poll, like Talk's web app);
        the rest of the list keeps its 5 s round
  - [x] Polls, Matrix (Element's format) and Talk: poll card with live results, vote (single or
        multiple choice), hidden results until the end, end your own poll, /poll to create one
  - [x] Talk: "Meet now" in the Calendar (title → create and copy link, or start the meeting)
  - [x] Talk conversation settings, as in SURF's Talk (screenshots 2026-11-18), in the room panel:
        Basic info: name, description, picture (emoji / upload / from Files);
        Personal: notifications all / @-mentions / off, call notifications, important (ignores DND),
        sensitive (no preview); Moderation: open to registered users (listable), allow @all;
        Guest access: guests via link, password, copy link, resend invitations;
        Recording consent; message expiration; banned users; Meeting: lobby, import email
        participants (CSV), poll drafts; Permissions: all / restricted / advanced;
        Danger zone: lock, archive, leave, delete conversation, delete chat messages
  - [ ] Talk: start/stop call recording (backlog; needs the recording server)
- [ ] Talk follow-ups: typing (needs Talk's signaling), threads (Talk 22+), verify against SURF
  - [ ] Talk: verify against the Nextcloud SURF uses (only tested sign-in start against a public server)
  - [x] Attach from Nextcloud Files (📎 menu): browse folders; in a Talk chat on the same Nextcloud
        the file is shared into the conversation, elsewhere a read-only public link is sent
        (to be tested on SURF)
  - [x] Nextcloud Calendar via CalDAV: Calendar rail item, Teams-like week (overlaps side by side,
        all-day row, now line), show/hide calendars, event details with Join for Talk meetings,
        New meeting (optionally with a new Talk conversation as the online meeting) (to be tested on SURF)
  - [x] Calendar: invite people (Nextcloud users by name, or any email address; Nextcloud mails
        the invitations), edit (reschedule) and delete your own meetings, accept/decline status
  - [x] Calendar: answer invitations (accept / maybe / decline; unanswered ones look tentative,
        declined ones struck through), reminder 5 minutes before (notification + Join pop-up),
        work week / week
  - [x] Calendar: day / work week / week / month views; repeating meetings: change or delete this
        occurrence (own copy / EXDATE) or the whole series (moves in its own time zone)
- [ ] Mobile (Tauri mobile or UniFFI)
- [ ] GitHub repo + CI builds for macOS, Windows, Linux on every tag; GitHub releases; auto-update
      (own update key, free) — next up once the repo exists
- [ ] Signing: Developer ID + notarisation (macOS), code signing (Windows); also unlocks clicking a
      notification to open the chat on macOS/Windows
- [ ] Email add-on (idea): step 1 unread count + new-mail notifications + open in your mail app;
      step 2 a Mail view (IMAP/SMTP; Microsoft 365 / Google need OAuth and may block IMAP)

## Matrix client listing (matrix.org/ecosystem/clients)
Submit once the repo has three months of commit history (first commit 2026-11-16, so from about
2027-02-16): a PR to matrix-org/matrix.org with the client page, an SVG logo + REUSE licence file,
screenshots and a project Matrix room. Maturity: Beta until SURF has used it in production for a while.

Their feature list, and where ms_trix stands:
- Supported: end-to-end encryption, spaces (view, browse, join), 1:1 calls (legacy), SSO, OAuth 2.0
  (MAS), multiple accounts, multiple languages, image packs (emoji, stickers, own pack), sliding sync
- [x] Invisible crypto (MSC4153): room keys only go to cross-signed devices (incoming messages are
      still decrypted from any device, like Element X: the strict rule also hid history from
      removed devices); a warning above the chat
      when someone's identity changes (OK accepts it; for someone you verified: withdraw the
      verification); clear messages when sending needs this device verified or recovery set up.
      Also fixed: undecryptable messages now really ask key backup again
- [x] Spaces: create a team (space); new channel in a team (team members can join, or anyone);
      "Team members" as who can join in room settings; adding existing rooms was already there
- [x] Threads: a list of all threads in a room (All / Mine) next to the thread panel
- [x] Sending feels instant: your message shows at once with ⏱, then ✓ once the server has it and
      ✓✓ when someone has read it (Matrix and Talk have read receipts, no "delivered"); a failed
      send stays with "Not sent · Try again · Delete". The "Seen" line and the read markers in the
      margin made way for Message status (⋯ or right-click on your message): who read it, who not yet
- [ ] Group calls (MatrixRTC): see "Beyond" above
- [ ] Jitsi conferences (legacy Element group calls via a Jitsi widget): probably skip in favour of
      MatrixRTC; decide when someone asks for it

## Zulip (backlog)
- [ ] Sign in (API key / password; server's auth methods), adapter in its own crate
- [ ] Streams as teams/channels, topics as threads; direct messages and group DMs as chats
- [ ] Live events (event queue long poll), unread counts, read markers
- [ ] Send / edit / delete, reactions, mentions, Markdown both ways
- [ ] Files (upload + view), avatars, presence, typing
- [ ] Notifications and mute per stream/topic; search via the server

## Mattermost (backlog)
- [ ] Sign in (password, personal access token; SSO via browser), adapter in its own crate
- [ ] Teams and channels as teams/channels; direct and group messages as chats
- [ ] Live events (WebSocket), unread counts, read state
- [ ] Send / edit / delete, reactions, threads (collapsed reply threads), mentions, Markdown
- [ ] Files (upload + view), avatars, presence/status, typing
- [ ] Notifications and mute per channel; search via the server

## Slash commands (parity with Element)
Reference: `Reference+pictures/commands`.

Done
- [x] /me, /shrug, /tableflip, /unflip, /lenny (prepend, like Element), /plain, /help

Messages
- [x] /spoiler <message> (blurred until clicked, also for received spoilers)
- [x] /html <message>: send raw HTML
- [x] /rainbow, /rainbowme
- [x] Effects: /confetti, /fireworks, /rainfall, /snowfall, /spaceinvaders, /hearts
      (Element's effect msgtypes; animation for new messages with the effect's emoji, like Element)
- [x] /jumptodate <YYYY-MM-DD>

Rooms and profile
- [x] /join, /goto, /part, /invite, /query, /msg, /topic, /roomname, /nick, /whois
- [x] /myroomnick
- [x] /roomavatar, /myavatar (open the picture cropper)
- [x] /myroomavatar
- [x] /converttodm, /converttoroom, /upgraderoom

Moderation
- [x] /remove, /ban, /unban <user> [reason]
- [x] /op <user> [level], /deop <user>
- [x] /ignore, /unignore <user>

Later or not planned
- [x] /holdcall, /unholdcall
- [x] /verify (fingerprint check), /discardsession
- [ ] /devtools, /addwidget, /rageshake: Element-specific, probably skip

