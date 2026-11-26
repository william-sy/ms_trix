# Roadmap

## Decisions (2026-11-17)
- Done: full-history search and the Shared tab
- Search index: encrypted on disk, key in the OS keychain (it holds decrypted messages)
- Archive: Matrix tags, both an own "archived" tag and the standard m.lowpriority, so other
  clients (Element, mobile) also move archived chats out of the way
- GIF picker: skipped for now; keep as an idea (needs a third-party service + privacy notice)
- Calls/verification are tested with a colleague on a real homeserver
- No signing certificates yet: unsigned builds (GitHub Releases since 1.5.1, updates by themselves
  since 1.6)
- First users: an organisation on Matrix + Nextcloud Talk. Next protocols: Zulip and Mattermost (own roadmaps
  below); XMPP and IRC skipped. Languages: English + Dutch for now
- Microsoft Teams chats (2026-11-20): not pursued. Through Microsoft Graph there are no calls,
  organisations' admins must approve the app (verified publisher), and messages can only be
  polled; Teams' web version inside the app would work but isn't integrated. Neither is worth it
- Releases: GitHub repo + unsigned builds for all OSes first (acceptable for v1); signing follows
  once certificates are sorted (Apple fee waiver for education, GÉANT TCS / SignPath for Windows)

## Next versions (ideas from 2026-11-19)
1.2 (released 2026-11-19):
- [x] Do not disturb until a chosen time (account menu): no notifications or sounds; calls and
      reminders still show, silently; you show as busy, with when it ends as your status
- [x] #hashtags highlighted and clickable: every message with that tag, in this chat or all chats;
      searching "#tag" only finds that tag (not the word elsewhere)
- [x] Link previews (fetched by the app itself, not the homeserver; Settings → Privacy to turn
      them off; nothing on the local network, no cookies, size/time limits), with a phishing check
      on this computer only: link text vs. destination, look-alike letters (punycode, Cyrillic/Greek),
      names close to your own and well-known domains, user@host and IP addresses, where redirects
      really lead. Suspicious links are marked and ask before they open
- [x] Repeating meetings in the calendar: daily, weekdays, weekly on chosen days, every two weeks,
      monthly (date or "3rd Tuesday"), yearly; ends never, on a date or after N times. Stored in
      local time with the computer's time zone (VTIMEZONE), so they keep their time through summer time
- [x] Send later (🕓 next to Send): later today, tomorrow or Monday morning, or a chosen time; sent
      by this app (Matrix has no server-side scheduling yet), a message whose time passed while
      the app was closed goes out at start. Waiting messages show at the bottom of the chat with
      Send now / Edit / Delete; kept encrypted on disk like the search index. Not for files

1.3 (released 2026-11-19):
- [x] ntfy add-on (Settings → Notifications): notifications also to an ntfy topic (ntfy.sh or your
      own server), only while away (auto-away idle time) or always, never during do not disturb;
      without the message text unless you turn it on; access token in the keychain; test button
- [x] ntfy as an account (Add account → ntfy): watch topics on ntfy.sh or your own server; each
      topic is a room with notifications (priority 4–5 count as mentions), writing in it publishes;
      New room adds a topic, leaving stops watching; one streaming connection, resumes after drops
- [x] Talk links to your own Nextcloud open the conversation in the app (joined if needed); a call
      going on there opens the pre-join screen (no call is started by a link)
- [x] Calls: hide your own video, only for you (layout menu or ✕ on your tile); remembered
- [x] Notes categories: new (with a first note), rename (subfolders move along), remove (notes stay)
- [x] Advanced search: "exact phrases", wildcards within a word (*part*, part*, *ing), match case (Aa);
      one query rule in the core for the index and loaded messages (and a TypeScript twin for
      in-chat search); a query of only leading wildcards reads the newest 20,000 messages
- [x] Nextcloud Notes (rail → Notes, for Nextcloud accounts with the Notes app): list by category
      with favourites and search, Markdown editor with preview, saves as you type; a change made
      elsewhere in between isn't overwritten (keep mine / load theirs)

1.4 (released 2026-11-19): fixes (see RELEASE_NOTES.md).

1.5 (released 2026-11-22), besides what's in RELEASE_NOTES.md:
- [x] Activity: a way to clear it (empty the feed, or remove single items)
- [x] Tables in the composer (size grid, 6 × 6 at most); Talk messages rendered from Markdown;
      links in formatted messages clickable
- [x] Dates in messages (idea 2026-11-20): 2026-12-09, 9-12-2026, "9 december", "December 9"
      (nl/en; without a year: the first one after the message was sent) get a subtle underline;
      hover shows the weekday ("Thursday 9 December 2026, in 19 days"), click a mini month calendar
      with that day's meetings, "Open in calendar" and "Add to calendar" (date and time filled
      in). Maybe a weekday hint while typing. Words like "tomorrow" or "next Thursday": skipped
- [x] Pinned messages (Matrix; Talk 23+), Talk threads (Talk 22+), pictures sent together in one
      bubble, notes search in the text, Home/End, a loading screen and camera warm-up for calls

1.6 (released 2026-11-23): see RELEASE_NOTES.md. Renamed to Trixcomm; updates by themselves.

1.7 (released 2026-11-24): see RELEASE_NOTES.md. Files, Find a time, offline accounts, camera quality.

Next release (1.7.1 or 1.8, not released yet): small things from daily use (see RELEASE_NOTES.md):
drafts, a wider thread pane, zoom into a shared screen, quick edit (Arrow Up), Talk call tiles
with pictures, the call's start time and an hourly break hint, a time format setting (24-hour),
noise suppression in calls (Standard: RNNoise, High: DeepFilterNet 3; asked for by a board weighing
a move from Teams), backgrounds under the pre-join preview.

To do, from low to high effort (ordered 2026-11-22; the 1.6 plan and the later ideas together,
plus the open items further down). S: a few hours, M: a day or two, L: several days, XL: weeks.
1.6 ("easy to get and keep, and usable by everyone") takes from the top.
1. [x] S. "Copy link to this chat" in the chat header ⋯ menu (Matrix matrix.to, Talk the
       conversation link, ntfy the topic page) (2026-11-22)
2. [x] S. Devices for Talk accounts: a button to Nextcloud's Security settings (no API for the list
       of app passwords) (2026-11-22)
3. [x] S. Translate a message through your own Nextcloud (translation API, or Task Processing on
       Nextcloud 30+), Matrix messages too through a Nextcloud account (2026-11-22)
4. [x] S–M. Status from your calendar: Matrix accounts busy, "In a meeting until …", while you're
       available (setting, on by default); Nextcloud does it for Talk itself. Out of office on
       Talk profile cards (Nextcloud 28+) (2026-11-22)
5. [x] S–M. Call layout (idea 2026-11-23, done 2026-11-26): the strip of faces (beside a shared screen, under the
       speaker) made bigger or smaller by dragging its edge, remembered; one or two rows (columns
       beside a shared screen) in the layout menu, so less scrolling through participants. Not
       per-tile resizing (Teams doesn't either); the gallery already fills the window
6. [ ] M. High contrast and motion (the visual half of accessibility): a light and a dark
       high-contrast theme (strong borders, no faint grey text, no see-through surfaces), switched
       on by macOS "Increase contrast" (prefers-contrast) and Windows contrast themes
       (forced-colors, system colours); "reduce motion" respected (moving backgrounds, effects,
       fades); an extra-large text size with the layout holding up; a clear focus outline for
       keyboard use; contrast of both normal themes checked
7. [x] M. Releases and auto-update (2026-11-23): a tag vX.Y.Z builds a GitHub Release with that
       version's notes, the installers and latest.json (first release 1.5.1; hotfixes on a
       release/X.Y branch). The app checks at start and every six hours (switch in Settings →
       About, with Check for updates), "Restart to update" (not during a call), installs only
       updates signed with our own key (Tauri updater; secrets TAURI_SIGNING_PRIVATE_KEY and
       _PASSWORD). First real update: from 1.6.0 to the version after it
8. [x] M. Links to chats (done 2026-11-26; Matrix links by room id, so links with a room address
       stay plain links) (clicking room links works already): typing # suggests your chats after a
       letter or two (like @mentions), picking one inserts a link shown as the chat's name (Matrix:
       matrix.to, a pill in Element and Element X too, others are offered to join; Talk: the
       conversation link on the same Nextcloud, a card in Talk). No pick: it stays a #hashtag. Room
       links show as a pill with name and picture for chats you know. Only chats of the same
       platform are suggested
9. [ ] M. Saved messages and "remind me about this": Save in a message's ⋯ menu, a Saved list;
       Matrix in your account data (syncs between your own devices), reminders by the app (like
       send later); Talk through its own reminder API (so Talk's other clients remind you too)
10. [ ] M. Messages in an offline chat (idea 2026-11-24): an account whose server can't be
       reached keeps its chat list (done in 1.7), but a Talk chat opened then is empty until the
       server is back. Show the messages kept in the local (encrypted) search index instead,
       marked as saved, until the server answers again
11. [ ] M–L. Chat beside the call (idea 2026-11-23, like Teams' meeting chat): 💬 in the call's
       header opens the conversation's chat as a panel on the right (the stage narrows; its own
       window grows if there's room), with an unread count while closed; docked and in its own
       window. Messages already reach every webview (trix://messages); the work is moving sending,
       editing and reactions out of App.tsx (`act`) into a hook both windows use, then ChatView and
       Composer as they are. Files by drag and drop can follow. Talk calls only for now
12. [x] L. Find a time (requested 2026-11-23, Teams' scheduling assistant; done 2026-11-24, to be
       verified on a real Nextcloud): in New meeting (and
       Edit), everyone's free and busy times for the chosen day under People: a row per person, you
       included, the chosen time framed, click a free spot to move there; a dot on each person
       (free, busy, unknown); "Suggest a time" lists the next slots of the same length when
       everyone is free, within working hours, picked with one click. Nextcloud answers free/busy
       itself (CalDAV scheduling outbox, VFREEBUSY): across all their calendars, repeats expanded,
       outside their working hours marked unavailable if they set them; busy blocks only, no
       titles. Only for people on the same Nextcloud; email guests show as unknown. Check first
       that the Nextcloud in use answers it (one request)
13. [x] L. Files in the rail (Nextcloud, like OneDrive in Teams): folders (browsing exists for the
       📎 menu), recent files and search; upload by drag and drop; open, download, share a link or
       into a chat; documents open in Nextcloud Office (done 2026-11-24, to be verified on a real
       Nextcloud); delete (to Nextcloud's deleted files), rename and move (2026-11-24). Later:
       favourites, shared with you, copy, chunked upload for very large files
       - [x] S–M. Gallery (idea 2026-11-24, done the same day for 1.7): pictures and videos in Files open in the app's own
             viewer instead of the browser, with ‹ › (and arrow keys) through the other pictures
             and videos of the folder, recent list or search results; videos play there. Builds
             on the chat's Lightbox (single picture today); full size through the existing
             `file:<id>:<path>` media, previews for the strip. Maybe a grid view for folders of
             photos. Other files keep opening in Nextcloud
       - [x] M. Show in Files (idea 2026-11-24, done the same day for 1.7): a Nextcloud file in a chat (a Talk file message,
             or a link to your own Nextcloud: `/f/<id>`, or one of your own share links `/s/…`)
             gets "Show in Files" and opens there, the Files tab at its folder with the file
             highlighted, instead of the browser. Talk file messages know the path in your
             storage; a file id is found with a SEARCH on oc:fileid, a share link through your
             own shares (OCS files_sharing). Links to other servers keep opening in the browser
14. [ ] L. Accessibility for screen readers and keyboard: a label on every icon button (about 440
       buttons, a third have a tooltip now); the message list as a list, new messages announced;
       arrow keys through messages, F6 between panes; focus kept in dialogs and given back after;
       tested with VoiceOver (and NVDA on Windows if possible)
15. [ ] L. Matrix 1:1 calls in their own window (signalling lives in the main window; needs a
       hand-over, as Talk calls have)
16. [ ] L. Tabs in chats: Matrix room widgets (a website, a shared notepad, a dashboard) as tabs that
       sync with Element, "Add website tab"; for Talk a linked note or a Nextcloud Deck board
17. [ ] L. Mini games, not during calls; our own designs. Matrix: two players in a direct chat with
       moves as our own (encrypted, invisible) event type, only the invite and result as normal
       messages; both need Trixcomm (a room widget would make it playable in Element Desktop/Web too).
       Talk: not for two players (every move would be a visible chat line). Single-player puzzles
       work for everyone. L for the first game with its frame, each next one smaller
18. [ ] S per language. More languages: quick to translate, but each needs someone who speaks it to
       check the result
19. [ ] XL each. Zulip and Mattermost (own lists below)
20. [ ] XL. Mobile (Tauri mobile or UniFFI)

Dropped 2026-11-22 (not needed for now; back on the list if someone asks): export a chat,
phishing list (OpenPhish), calendar on other CalDAV servers and on Exchange, email add-on (unread
count and notifications, later a Mail view), pop out a chat into its own window.

Dropped 2026-11-25: a Talk call history (Talk keeps no call log to ask for; it would mean digging
through the chats' call messages), a lock against running the app twice (only bites when the dev
build and the installed app run side by side, which broke Matrix encryption once).

To test (from 1.7 and the next release): Find a time and documents in Nextcloud Office on a real
Nextcloud; upload progress in Files (tested 2026-11-26: pinch zoom, quick edit, pre-join layout);
the call's start time (Talk 17+) and the break hint after an hour; pictures on call tiles; the time format on System (24-hour on a Mac set to a European region); noise suppression
(Hear yourself in Settings, then a real call: do the others still hear you, is the noise gone?
If so, make it on by default before the release).
macOS menu-bar things (Video effects, Mic Mode, the Dock) only work in the installed app, not
the dev build.
To test (from 1.6): Translate in a message's ⋯ menu (only shows when the Nextcloud has a
translation provider); out of office on a Talk profile card; "In a meeting" on Matrix during a
meeting; whether Nextcloud shows "In a meeting" on Talk by itself; Copy link to this chat.
To test (from 1.5 and before): emoji verification with a colleague; a silent call started from
Talk; replying with a file in Talk; Talk group calls and screen sharing on a real server; whether the
Talk in use has threads (22+) and pinning (23+); Talk 1:1 call sound (the log's sound check); away status
on Windows and Linux; signing in through the browser on a server that offers it.

Waiting on others: Matrix group calls and calls with Element X users (MatrixRTC: needs LiveKit
on the homeserver), OS code signing (certificates; also clicking a notification to open the chat),
Talk call recording (needs the recording server), status messages other clients show (Matrix
extended profile fields), Talk typing (skipped: see Talk follow-ups).

Ordered by what makes Trixcomm usable as a daily driver first. Anything not
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
- [x] Talk calls (step A): Start / Join call opens Talk's own call screen in an Trixcomm window
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
- [ ] macOS: no notifications arrive (2026-11-25, macOS 27): the notification plugin still uses
      Apple's old API (NSUserNotification) and Trixcomm isn't in Notification Center's list; the
      Test button in Settings → Notifications shows nothing. Fixed by the modern API with signing
      (see Signing below); Windows and Linux are not affected. Details: _notes/notifications.md

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
- [ ] S (~½ day). Click a notification to open that chat (planned 2026-11-25): the notification
      plugin (2.8.1) now reports clicks on desktop (`on_action`, the chat key in its data), so a
      click brings Trixcomm forward on that chat, without signing. Windows: while the toast is on
      screen (from the Action Center needs a registered COM activator, later); Linux: the default
      action; macOS: once notifications arrive there at all (see Known issues)
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
- [x] Devices: Talk app passwords (a button to Nextcloud's Security settings; no API for the list)
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
- [x] Calls step B: Talk calls in Trixcomm's own call screen (1:1 video with a Talk client works on a real server).
      Talk REST for membership + signalling settings; signalling over the HPB (WebSocket, MCU or
      mesh) or Talk's built-in signalling; WebRTC here. Teams-like grid with speaker ring, own tile
      in the corner, shared screen large with a strip of faces, mute/camera/share/leave, minimise.
      Every step logged ("talk call:" in the log); Talk's own window stays in the ⋯ menu.
      Pre-join screen (preview, mic level, device choice, join muted / camera off); devices picked
      there are remembered for the next call, and can be switched during the call (⚙ menu);
      joining a running call starts with the camera as you last had it
- [ ] Talk calls: test group calls (grid layout) and screen sharing on a real server
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
- [ ] Matrix group calls via MatrixRTC / Element Call widget (matrix-sdk widget driver is ready; it needs
      MatrixRTC/LiveKit on the homeserver, which our test server doesn't have yet). Also 1:1 calls
      over MatrixRTC: Element X only calls that way, so our legacy 1:1 calls can't reach Element X users
- [x] Native OAuth login (MAS): "Sign in with your browser" when the server offers it; loopback
      redirect, dynamic client registration, refreshed tokens saved to the keychain (to be tested on
      a server with MAS)
- [ ] Nextcloud integration:
  - [x] Talk: the open conversation gets new messages instantly (long poll, like Talk's web app);
        the rest of the list keeps its 5 s round
  - [x] Polls, Matrix (Element's format) and Talk: poll card with live results, vote (single or
        multiple choice), hidden results until the end, end your own poll, /poll to create one
  - [x] Talk: "Meet now" in the Calendar (title → create and copy link, or start the meeting)
  - [x] Talk conversation settings, as in Talk's web app (screenshots 2026-11-18), in the room panel:
        Basic info: name, description, picture (emoji / upload / from Files);
        Personal: notifications all / @-mentions / off, call notifications, important (ignores DND),
        sensitive (no preview); Moderation: open to registered users (listable), allow @all;
        Guest access: guests via link, password, copy link, resend invitations;
        Recording consent; message expiration; banned users; Meeting: lobby, import email
        participants (CSV), poll drafts; Permissions: all / restricted / advanced;
        Danger zone: lock, archive, leave, delete conversation, delete chat messages
  - [ ] Talk: start/stop call recording (backlog; needs the recording server)
  - [x] Camera quality (2026-11-24, 1.7): Automatic (Talk's rule: full while you speak and below
        20 cameras, lower in very big calls; HD at most with a background effect) or High 1080p,
        HD 720p, Standard 480p, Low 360p, in the audio & video settings; Talk calls change it
        live, Matrix calls at the next camera. Details of what Talk does: _notes/talk-calls.md
  - [ ] S–M. Incoming video quality (Talk, ~1 day): ask the video server for the right layer
        per tile (`selectStream {substream, temporal}`: the speaker high, small tiles low) and
        no video from people not on screen (`selectStream {video: false}`: another gallery
        page, the minimised card); a setting Automatic / Always best / Data saver / Off (audio
        only). Choosing a layer works for publishers that send simulcast (Talk's web app does
        when the server has the "simulcast" feature, as ours has); turning video off for all
  - [ ] M. Send simulcast ourselves (Talk, 1–2 days): three layers (full, ½, ¼ at 0.9 / 0.3 /
        0.1 Mbit/s, as Talk's web app) so viewers in big grids get a small one and Janus can fall
        back for slow connections; RID sendEncodings in WebKit with Janus to be tested with a
        Talk web user
- [ ] Talk follow-ups: threads (Talk 22+) done 2026-11-21. Typing skipped for now (2026-11-21): it
      needs Talk's signaling with the chat joined, and then the phone gets no notifications for it
  - [x] Talk: verify against a production Nextcloud (in daily use since 1.1)
  - [x] Attach from Nextcloud Files (📎 menu): browse folders; in a Talk chat on the same Nextcloud
        the file is shared into the conversation, elsewhere a read-only public link is sent
        (to be tested on a real server)
  - [x] Nextcloud Calendar via CalDAV: Calendar rail item, Teams-like week (overlaps side by side,
        all-day row, now line), show/hide calendars, event details with Join for Talk meetings,
        New meeting (optionally with a new Talk conversation as the online meeting) (to be tested on a real server)
  - [x] Calendar: invite people (Nextcloud users by name, or any email address; Nextcloud mails
        the invitations), edit (reschedule) and delete your own meetings, accept/decline status
  - [x] Calendar: answer invitations (accept / maybe / decline; unanswered ones look tentative,
        declined ones struck through), reminder 5 minutes before (notification + Join pop-up),
        work week / week
  - [x] Calendar: day / work week / week / month views; repeating meetings: change or delete this
        occurrence (own copy / EXDATE) or the whole series (moves in its own time zone)
- [ ] Mobile (Tauri mobile or UniFFI)
- [x] GitHub releases with a download page, and auto-update (own update key, free); the repo and CI
      builds for macOS, Windows and Linux exist since 1.0
- [ ] Signing: Developer ID + notarisation (macOS), code signing (Windows). On macOS it also
      unlocks the modern notifications (UNUserNotificationCenter, M, 1–1.5 days after signing):
      a permission prompt, Trixcomm in Notification Center, notifications grouped per chat,
      clicking opens the chat also from Notification Center, a chat's notifications cleared once
      it's read

## Matrix client listing (matrix.org/ecosystem/clients)
Submit once the repo has three months of commit history (first commit 2026-11-16, so from about
2027-02-16): a PR to matrix-org/matrix.org with the client page, an SVG logo + REUSE licence file,
screenshots and a project Matrix room. Maturity: Beta until it has been used in production for a while.

Their feature list, and where Trixcomm stands:
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

