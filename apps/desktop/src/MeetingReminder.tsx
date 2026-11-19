import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { dndActive } from "./dnd";
import { backend, CALENDAR_CHANGED, isLive } from "./backend";
import { firstUrl, meetingChat, parseIcal, toIcalUtc } from "./CalendarPane";
import { locale, t } from "./i18n";
import { playRingtone } from "./ringtone";
import { currentSettings } from "./settings";
import type { CalendarEvent, Conversation, Org } from "./types";

const LOOK = 30 * 60_000; // events fetched this far beyond the reminder time
const EVERY = 5 * 60_000; // and looked at again this often (and after changes made in the app)
const STAY = 10 * 60_000; // a reminder stays until the meeting has been going this long
const QUIET = 5_000; // reminders this close together share one sound

/** One meeting in the reminder (also what the reminder window shows). */
interface Reminder {
  key: string;
  summary: string;
  at: string;
  location?: string;
  /** The meeting's conversation (Open chat / Join), or a web link to open. */
  chat?: string;
  url?: string;
  /** When the meeting started plus STAY: its row goes away then. */
  until: number;
}

type Action = "dismiss" | "chat" | "join" | "link";

/**
 * Reminds you of meetings in your Nextcloud calendars a few minutes before they start: a system
 * notification plus a pop-up with Join for Talk meetings, in a small window on top of other
 * windows (so you see it while working elsewhere) or inside the app (Settings → Notifications).
 * Meetings due at the same time (double booked) share one pop-up, a row each, and one sound.
 */
export function MeetingReminder({ orgs, convs, minutes, onJoin, onOpenChat }: {
  orgs: Org[]; convs: Conversation[];
  /** How long before a meeting; 0 = no reminders. */
  minutes: number;
  onJoin: (key: string) => void; onOpenChat: (key: string) => void;
}) {
  const [due, setDue] = useState<Reminder[]>([]);
  const reminded = useRef(new Set<string>());
  const timers = useRef(new Map<string, number>());
  const lastSound = useRef(0);
  const accounts = orgs.map((o) => o.id).join(",");
  const convsRef = useRef(convs);
  convsRef.current = convs;
  const actions = useRef({ onJoin, onOpenChat });
  actions.current = { onJoin, onOpenChat };
  const inWindow = isLive && currentSettings().meetingReminder === "window";

  const act = (r: Reminder, action: Action) => {
    setDue((list) => list.filter((x) => x.key !== r.key));
    if (action === "join" && r.chat) actions.current.onJoin(r.chat);
    else if (action === "chat" && r.chat) actions.current.onOpenChat(r.chat);
    else if (action === "link" && r.url) void backend.openUrl(r.url).catch(() => {});
  };
  const actRef = useRef(act);
  actRef.current = act;
  const dueRef = useRef(due);
  dueRef.current = due;

  // A button pressed in the reminder window.
  useEffect(() => {
    if (!isLive) return;
    const off = listen<{ action: Action; key: string }>("trix://reminder", (e) => {
      const r = dueRef.current.find((x) => x.key === e.payload.key);
      if (r) actRef.current(r, e.payload.action);
    });
    return () => void off.then((f) => f());
  }, []);

  // The reminder window shows the current list (and goes when it's empty).
  useEffect(() => {
    if (!isLive) return;
    if (inWindow && due.length) void backend.openReminder(JSON.stringify(due), due.length).catch(() => {});
    else void backend.closeReminder().catch(() => {});
  }, [due, inWindow]);

  // Each row goes once its meeting has been going for a while.
  useEffect(() => {
    if (!due.length) return;
    const next = Math.min(...due.map((r) => r.until));
    const timer = window.setTimeout(() => setDue((list) => list.filter((r) => r.until > Date.now())), Math.max(0, next - Date.now()));
    return () => window.clearTimeout(timer);
  }, [due]);

  useEffect(() => {
    if (!orgs.length || !minutes) return;
    const ahead = minutes * 60_000;
    let live = true;
    const remind = (key: string, event: CalendarEvent, start: Date) => {
      if (reminded.current.has(key)) return;
      reminded.current.add(key);
      const at = start.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
      const url = firstUrl(event.location) ?? firstUrl(event.description);
      const summary = event.summary || t("calendar.noTitle");
      const r: Reminder = { key, summary, at, location: url ? undefined : event.location || undefined, chat: meetingChat(event, convsRef.current)?.id, url, until: start.getTime() + STAY };
      setDue((list) => [...list.filter((x) => x.key !== key), r].sort((a, b) => a.until - b.until));
      // The reminder sound, once for meetings due together: the chime once, a ringtone twice
      // (at most ten seconds of a sound file).
      if (Date.now() - lastSound.current > QUIET && !dndActive()) {
        lastSound.current = Date.now();
        const sound = currentSettings().reminderSound;
        window.setTimeout(playRingtone(sound === "chime" ? 1 : 2, sound), 10_000);
      }
      void backend.notify(summary, t("calendar.startsAt", { time: at })).catch(() => {});
    };
    const check = async () => {
      const now = Date.now();
      const from = toIcalUtc(new Date(now)), to = toIcalUtc(new Date(now + ahead + LOOK));
      const results = await Promise.allSettled(orgs.map((o) => backend.calendarEvents(o.id, from, to)));
      if (!live) return;
      const found = new Set<string>();
      for (const event of results.flatMap((r) => (r.status === "fulfilled" ? r.value : []))) {
        const s = parseIcal(event.start);
        if (s.allDay || event.myStatus === "DECLINED") continue;
        const key = `${event.uid}|${event.start}`;
        found.add(key);
        const wait = s.date.getTime() - ahead - now;
        if (reminded.current.has(key) || timers.current.has(key) || s.date.getTime() < now) continue;
        if (wait <= 0) remind(key, event, s.date);
        else timers.current.set(key, window.setTimeout(() => { timers.current.delete(key); remind(key, event, s.date); }, wait));
      }
      // Moved, cancelled or declined since: no reminder at the old time. (Only when every
      // calendar answered, so a network hiccup doesn't drop reminders.)
      if (results.every((r) => r.status === "fulfilled")) {
        for (const [key, id] of timers.current) if (!found.has(key)) { window.clearTimeout(id); timers.current.delete(key); }
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), EVERY);
    // A meeting made or changed in the app gets its reminder right away, even if it's soon.
    const onChange = () => void check();
    window.addEventListener(CALENDAR_CHANGED, onChange);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener(CALENDAR_CHANGED, onChange);
      timers.current.forEach((id) => window.clearTimeout(id));
      timers.current.clear();
    };
  }, [accounts, minutes]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!due.length || inWindow) return null;
  return <ReminderCard reminders={due} onAction={act} />;
}

/** The pop-up: a row per meeting, each with its own buttons. */
function ReminderCard({ reminders, onAction, drag }: { reminders: Reminder[]; onAction: (r: Reminder, a: Action) => void; drag?: boolean }) {
  const region = drag ? { "data-tauri-drag-region": true } : {};
  return (
    <div className="call-ring meeting-reminder" role="alertdialog" aria-label={reminders.map((r) => r.summary).join(", ")} {...region}>
      {reminders.map((r) => (
        <div key={r.key} className="reminder-row" {...region}>
          <span className="meeting-reminder-icon" {...region}>📅</span>
          <div className="call-ring-text" {...region}>
            <b>{r.summary}</b>
            <span>{t("calendar.startsAt", { time: r.at })}{r.location ? ` · ${r.location}` : ""}</span>
          </div>
          <button className="btn small" onClick={() => onAction(r, "dismiss")}>{t("talkcall.dismiss")}</button>
          {r.chat ? (
            <>
              <button className="btn small" onClick={() => onAction(r, "chat")}>{t("calendar.openChat")}</button>
              <button className="btn primary small" onClick={() => onAction(r, "join")}>{t("calendar.join")}</button>
            </>
          ) : r.url && <button className="btn primary small" onClick={() => onAction(r, "link")}>{t("calendar.openLink")}</button>}
        </div>
      ))}
    </div>
  );
}

// ---- The reminder window: the main entry point renders this for #reminder=<json> ----

const PREFIX = "#reminder=";
export const isReminderWindow = location.hash.startsWith(PREFIX);
if (isReminderWindow) document.documentElement.classList.add("reminder-page");

/** The pop-up on top of other windows; the app keeps the list and handles the buttons. */
export function ReminderWindow() {
  const [list, setList] = useState<Reminder[]>(() => {
    try { return JSON.parse(decodeURIComponent(location.hash.slice(PREFIX.length).replace(/\+/g, " "))); } catch { return []; }
  });
  useEffect(() => {
    const off = listen<string>("trix://reminders", (e) => { try { setList(JSON.parse(e.payload)); } catch { /* keep the old list */ } });
    return () => void off.then((f) => f());
  }, []);
  return <ReminderCard reminders={list} drag onAction={(r, action) => void backend.reminderAction(action, r.key).catch(() => {})} />;
}
