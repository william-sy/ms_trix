# Release notes

## 1.6.0 (2026-11-23)

### New
- **New name: Trixcomm** (it was ms_trix). Your accounts, settings, search index and encryption
  keys carry over. Installing 1.6 adds Trixcomm next to the old app: on macOS delete
  ms_trix.app from Applications, on Windows uninstall ms_trix, on Linux remove the old package.
- **Copy link to this chat** (chat header ⋯): a matrix.to link for Matrix (the room's address if
  it has one), the conversation link for Talk, the topic's page for ntfy.
- **Translate a message** (message ⋯ → Translate) through your own Nextcloud, when it has a
  translation provider (its translation API, or Task Processing on Nextcloud 30 and later). Works
  for Matrix messages too, through your Nextcloud account. Into the app's language; the
  translation shows under the message.
- **Out of office** (Nextcloud 28 and later): a Talk user's profile card shows that they're away,
  until when, their message and who to ask instead.
- **In a meeting:** while a meeting in your Nextcloud calendar runs, your Matrix accounts show you
  as busy, "In a meeting until 15:00" (only while you're available; Settings → General → Status
  to turn it off). Nextcloud does this itself for Talk.
- **Talk sessions:** Settings → Accounts has a button to Nextcloud's Security settings, where your
  devices and app passwords are listed and can be revoked (Nextcloud has no API for that list).
- **Updates by themselves:** when a new version is out, a bar under the title says so, with
  What's new and *Restart to update* (not during a call). Settings → About shows the version, has
  *Check for updates* and a switch for checking automatically (at start and every six hours, on
  by default). Only updates signed with Trixcomm's own key are installed, so after this version
  nobody needs macOS's quarantine command or Windows' "Run anyway" again. Works for every
  installer: the macOS app, Windows setup and MSI, Linux AppImage and .deb (asks for your
  password).

### Fixed
- **Talk calls without a camera:** people on Talk saw you muted and never speaking, and you
  couldn't hear people who had no video. Trixcomm now tells everyone about its microphone,
  camera, speaking and name the way Talk's own apps do (and reads theirs), and plays each
  person's sound in a player of its own, whatever their tile shows. On macOS call sound follows
  the Mac's sound output.
- Your speaking ring didn't show in speaker view (your tile is the small one there).
- A problem drawing the call screen no longer ends the call: the screen shows the error and the
  call carries on.
- The call screen's dropdowns and menus were light in the light theme; they're dark like the
  call screen now.
- A meeting with many people: the list showed everyone crammed together. It now says how many
  answered what, lists everyone on a line of their own and scrolls.

### Other
- No more references to one organisation in the docs, the demo data and the tests: Trixcomm is
  for anyone on Matrix and Nextcloud Talk. The phishing check's list of well-known sites is
  general now; your own accounts' domains are still added to it.

## 1.5.1 (2026-11-23)

### Fixed
- In a Talk call, people using Talk in their browser saw you but didn't hear you. Talk's web app
  keeps a participant silent until told their microphone is on; Trixcomm now tells everyone who
  joins, as Talk's own apps do (it also shows your camera as off when it is).

## 1.5 (2026-11-22)

### New
- **Share several Nextcloud files at once:** tick files and folders in the Nextcloud picker (also
  from different folders) and share them together; a folder is shared as a whole.
- **Colours in code blocks:** a block written as ```yaml (or json, bash, python, rust, sql, …:
  all of highlight.js's roughly 190 languages) shows in that language's colours, in Matrix and
  Talk messages and in the notes preview. Rarely used languages load the first time they appear.
- **Tables:** the format bar's Table button picks a size on a grid and inserts an empty table.
- **Pictures sent together** show as one message with a small grid (Matrix and Talk send each
  picture separately); deleting it deletes all of them.
- **Talk threads** (Talk 22 and later): replies in a thread show in the thread pane instead of
  the chat, replying there stays in the thread, and the Threads list works for Talk chats.
- **Pinned messages** (Matrix, and Talk 23 and later): pin or unpin from a message's ⋯ menu. The
  latest pinned shows under the chat header (a click goes to it and on to the next), with
  "All pinned" for the list. Pins are for everyone in the chat: in Matrix they sync to Element and
  Element X.
- **Dates in messages** (2026-12-09, 9-12-2026, "9 december", "December 9", with a time too) get a
  dotted underline: hover for the weekday and how far away it is, click for that month with the
  day marked, what's in your calendar then, and Open in calendar / Add to calendar (day and time
  filled in, the message in its details). A weekday that doesn't fit ("Thursday 9 December" on a
  Wednesday) gets a wavy line, and the composer says so before you send.
- **Activity:** Clear empties the feed (with Undo), and ✕ on an item removes just that one. Only on
  this computer; new activity still shows up.
- **Notes:** search looks in the text of your notes too (with the same search syntax as messages),
  showing the line that matched; the format bar has the Table button.
- **Talk messages show their formatting** (tables, bold, lists, code), as in Talk itself.
- **Silent calls:** start a Talk call silently (▾ next to the call buttons), so nobody is rung.
  Calls others start silently don't ring you either, unless you turn on "Ring for silent calls
  too" (Settings → Notifications), the Teams way where nothing is silent.

### Fixed
- Starting the first call after a restart or sleep showed nothing for seconds: the call screen now
  says "Starting the call…" at once, then "Starting your camera and microphone…" until they're on,
  and the camera system is warmed up after the app starts (first camera start ~3.5 s → under 1 s).
- A wide picture made its bubble stretch across the chat; bubbles now fit their picture.
- Home and End typed a box in text fields on macOS: they move to the start or end of the line now
  (with ⌘ of the whole text, with Shift selecting).
- Talk calls: someone whose app sends sound and picture separately could be seen but not heard.
  The log now also notes, a few seconds in, how much sound goes each way.
- Web links inside formatted messages (with bold, a list, …) weren't clickable.
- After the computer was locked or asleep, messages took a while to come in (up to a minute):
  the app now reconnects every account as soon as the computer wakes, and on macOS it isn't
  napped while the screen is locked, so messages keep coming in meanwhile.
- Speaker layout jumped from person to person in quick back-and-forth: someone now takes the big
  picture after talking for a moment (1.5 s) and keeps it at least 3 s unless they stop; short
  sounds don't move it, and a change fades in.
- Talk calls in group chats rang only as a quiet pop-up; they ring now too (muted conversations
  stay quiet), and on an incoming call the Dock icon bounces (the taskbar button flashes on
  Windows) so it's noticed with another app in front.
- Replying with a file (a GIF, a picture): the reply was lost on sending; the file now goes as
  the reply (Matrix; on Talk where the server supports it).

### Other
- Downloads from GitHub: one per installer (macOS .dmg; Windows setup or .msi; Linux .deb or
  AppImage) instead of the app twice in one zip, so they're about half the size; kept 30 days.
  The README explains installing on each system (macOS quarantine, Windows SmartScreen).

## 1.4 (2026-11-19)

### Fixed
- The buttons in someone's profile card no longer break over two lines ("Copy user ID").
- The calendar (and meeting reminders) only cover Nextcloud accounts with the Calendar app; a
  Nextcloud without it no longer offers its calendar for new meetings, which then failed.
- A meeting invitation's answers (Accept, Maybe, Decline) stay together on one line.
- Pictures shared in Nextcloud Talk showed as a question mark instead of the picture.
- Settings → Audio & video: the camera list showed only "Device 1" (which did nothing) until the
  camera was tested. Clicking a list now asks for access and shows the real devices, and your
  saved camera shows by name meanwhile.
- Calls start faster with a camera background: the person detection loads as the call opens.
- The format bar's buttons no longer break over two lines and its help text stays on one line
  (shortened with … when there's no room), also in the narrow thread reply box.
- Pictures and files can be pasted, attached or dropped (on the open thread) in a thread's reply
  box too; they go into the thread.
- Verifying someone by emoji could stay at "Waiting for … to accept" until it timed out: the
  room the verification runs in is now followed closely, so the other side's answers aren't
  cut short by sliding sync.

## 1.3 (2026-11-19)

### New
- **Notifications on your phone (ntfy):** Settings → Notifications can also send notifications
  to an ntfy topic, for the ntfy app on your phone: only while you're away from the computer, or
  always, and never during do not disturb. By default just who and where ("New message"); the
  message text only if you turn that on. Works with ntfy.sh or your own server (access token
  kept in the keychain).
- **Watch ntfy topics:** add ntfy as an account (Add account → ntfy) to follow topics from
  ntfy.sh or your own server, for backups, servers or your own scripts. Each topic is a chat with
  notifications (urgent ones even with "mentions only"); writing in it publishes to the topic.
  Add more topics with New room; leave the chat to stop watching.
- **Notes:** your Nextcloud Notes in the app (Notes in the left rail, when your Nextcloud has the
  Notes app): by category, favourites first, searchable; write in Markdown with a preview, saved
  as you type, with a format bar (⌘B / ⌘I); categories can be filtered, made, renamed and
  removed. If a note was changed elsewhere meanwhile, you choose which version to keep.
- **Talk links open here:** a link to a Talk conversation on your own Nextcloud opens it in the
  app (joining it first if needed); a call going on there opens its pre-join screen.
- **Hide your own video** in a call, only on your own screen (layout menu, or ✕ on your tile).
- **Advanced search:** "exact phrases" in quotes, wildcards within a word (*part*, part*, *ing)
  and an Aa switch to match capitals, in the main search and in a chat's search.

## 1.2 (2026-11-19)

### New
- **Do not disturb** (account menu): no notifications or sounds for 30 minutes, 1 or 2 hours,
  the rest of the day, until a time you choose, or until you turn it off. Calls and meeting
  reminders still show, silently. You show as busy, with when it ends as your status.
- **#hashtags:** tags in messages are highlighted; click one to see every message with that tag,
  in this chat or in all chats. Searching for "#tag" finds only that tag.
- **Link previews:** a card with the page's title, description and picture under messages with
  a link. This app fetches them itself, so your server never sees links from encrypted chats;
  turn them off in Settings → Privacy.
- **Phishing check:** links whose text shows another address than where they go, look-alike
  letters, names that imitate your own or well-known domains (paypal-login.com, paypa1.com), and
  address tricks are marked with ⚠ and ask before they open. The preview also shows where a short
  link really leads. All checked on this computer.
- **Repeating meetings:** every day, every weekday, every week on the days you pick, every two
  weeks, every month (on a date or e.g. the third Tuesday) or every year, ending never, on a
  date or after a number of times. They keep their local time when summer time starts or ends.
- **Send later:** 🕓 next to Send schedules a message for later today, tomorrow morning, Monday
  morning or a time you choose. This app sends it, so leave it running; if it's closed then, the
  message goes out when you next open it. Waiting messages show at the bottom of the chat, where
  you can send them now, edit or delete them.

## 1.1 (2026-11-18)

### New
- **Moving backgrounds** for your camera in calls: leaves in the wind, drifting clouds, fireflies
  and misty mountains (drawn by the app), or your own video (MP4, MOV, WebM) or GIF up to 60 MB.
- **Change devices during a call:** the ⚙ menu switches microphone, speaker and camera without
  rejoining. Devices picked before joining are remembered for the next call, and joining a
  running call starts with your camera on or off as you last had it.
- **Messages show at once:** ⏱ while sending, ✓ when the server has it, ✓✓ when someone has read
  it. A message that couldn't be sent offers Try again or Delete. Message status (right-click on
  your message) shows who has read it in a group chat.
- **Teams and channels:** create a team, and add channels to it that team members (or anyone)
  can join.
- **Threads list:** all threads in a room, or only the ones you're part of.
- **Invisible crypto (Matrix):** room keys only go to devices their owner has verified; a warning
  above the chat when someone's identity changes; a clear message when your device needs
  verifying before you can send.
- **Spelling suggestions on macOS:** press Tab to accept one, Esc to dismiss it. Follows the
  language you type in.
- **Send with Enter or ⌘ Enter:** a setting, which also applies with the format bar open.

### Fixed
- No sound in a call that runs in its own window, or after switching to a Bluetooth headset.
- A call moved out of the app a second time came out too large for its window.
- The microphone and camera chosen before joining were forgotten; choices made in a call could
  be overwritten by the app.
- "Join now" pressed before the preview was ready joined without the camera; switching devices
  quickly before joining could fail with "NotAllowedError".
- "Loading older messages…" flickering in a group chat.
- Messages that couldn't be decrypted now really ask your key backup again.

### Other
- macOS builds are for Apple Silicon only.

## 1.0 (2026-11-18)

- Nextcloud Talk next to Matrix: chat, room settings, Meet now, forwarding between the two.
- Talk group calls: layouts, screen sharing with drawing, camera backgrounds, calls in their own
  window without rejoining; Matrix 1:1 calls.
- Nextcloud calendar with recurring meetings, meeting reminders and ringtones.
- Encrypted search through your full history, and the Shared tab; Matrix sliding sync.
- Settings (About, notifications, audio output), in English and Dutch.
- Licensed GPL-3.0-or-later.
