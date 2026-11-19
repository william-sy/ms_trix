# Release notes

## 1.2 (not released yet)

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
  letters, names that imitate your own or well-known domains (surf-nl.com, paypa1.com), and
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
