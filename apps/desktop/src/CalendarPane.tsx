import { useEffect, useMemo, useRef, useState } from "react";
import { MeetNow } from "./MeetNow";
import { Avatar } from "./Avatar";
import { backend } from "./backend";
import { locale, t } from "./i18n";
import type { Attendee, Calendar, CalendarEvent, Conversation, Org } from "./types";

interface Props {
  /** Nextcloud accounts in view. */
  orgs: Org[];
  convs: Conversation[];
  onOpenChat: (key: string) => void;
  onJoinCall: (key: string) => void;
}

interface Item {
  account: string;
  event: CalendarEvent;
  start: Date;
  end: Date;
  allDay: boolean;
  color: string;
  calendarName: string;
}

const HOUR = 48; // px per hour in the grid
const HIDDEN = "trix.hiddenCalendars";
const WORK_WEEK = "trix.calendarWorkWeek";
const VIEW = "trix.calendarView";

type Span = "day" | "workweek" | "week" | "month";
const SPANS: Span[] = ["day", "workweek", "week", "month"];

function storedSpan(): Span {
  try {
    const v = localStorage.getItem(VIEW) as Span | null;
    if (v && SPANS.includes(v)) return v;
    return localStorage.getItem(WORK_WEEK) === "1" ? "workweek" : "week";
  } catch { return "week"; }
}

/** The days a view shows around `anchor`: one day, a (work) week, or the weeks covering a month. */
function visibleDays(span: Span, anchor: Date): Date[] {
  if (span === "day") return [new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())];
  if (span !== "month") return Array.from({ length: span === "workweek" ? 5 : 7 }, (_, i) => addDays(startOfWeek(anchor), i));
  const first = startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const weeks = Math.ceil((Math.round((last.getTime() - first.getTime()) / 86_400_000) + 1) / 7);
  return Array.from({ length: weeks * 7 }, (_, i) => addDays(first, i));
}

/** iCalendar time ("20261117T090000Z", local "20261117T090000", or all-day "20261117") to a Date. */
export function parseIcal(v: string): { date: Date; allDay: boolean } {
  const y = +v.slice(0, 4), m = +v.slice(4, 6) - 1, d = +v.slice(6, 8);
  if (v.length === 8) return { date: new Date(y, m, d), allDay: true };
  const h = +v.slice(9, 11), mi = +v.slice(11, 13), s = +v.slice(13, 15);
  return { date: v.endsWith("Z") ? new Date(Date.UTC(y, m, d, h, mi, s)) : new Date(y, m, d, h, mi, s), allDay: false };
}

export const toIcalUtc = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const icalDate = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

const startOfWeek = (d: Date) => {
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7)); // weeks start on Monday
  return day;
};
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
const time = (d: Date) => d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
/** The hour down the side of the day/week grid: "1 PM" or "13:00", short enough for the gutter. */
const hourLabel = (h: number) => {
  const d = new Date(2000, 0, 1, h);
  const twelveHour = new Intl.DateTimeFormat(locale(), { hour: "numeric" }).resolvedOptions().hour12;
  return twelveHour ? d.toLocaleTimeString(locale(), { hour: "numeric" }) : d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
};

/** The Talk conversation an event's meeting link points to, if it's one of ours. */
export function meetingChat(event: CalendarEvent, convs: Conversation[]): Conversation | undefined {
  const text = `${event.location ?? ""} ${event.description ?? ""}`;
  for (const match of text.matchAll(/\/call\/([a-z0-9]{4,})/gi)) {
    const conv = convs.find((c) => c.id.endsWith(`|${match[1]}`));
    if (conv) return conv;
  }
  return undefined;
}

/** Invitations you haven't answered look tentative; declined ones are struck through (like Teams). */
const statusClass = (e: CalendarEvent) =>
  e.mine ? "" : e.myStatus === "DECLINED" ? "declined" : e.myStatus === "NEEDS-ACTION" || e.myStatus === "TENTATIVE" ? "unanswered" : "";

export const firstUrl = (text?: string) => text?.match(/https?:\/\/[^\s<>"]+/)?.[0];

/** Teams-like week view of the Nextcloud calendars. */
export function CalendarPane({ orgs, convs, onOpenChat, onJoinCall }: Props) {
  // The day the view is built around (the week, or month, that contains it).
  const [week, setWeek] = useState(() => new Date());
  const [calendars, setCalendars] = useState<Record<string, Calendar[]>>({});
  const [events, setEvents] = useState<{ account: string; event: CalendarEvent }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem(HIDDEN) ?? "[]")); } catch { return new Set(); } });
  const [open, setOpen] = useState<Item | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Item | null>(null);
  // Editing a repeating meeting: the whole series, or just the occurrence that was opened.
  const [series, setSeries] = useState(false);
  const [showCalendars, setShowCalendars] = useState(false);
  const [reload, setReload] = useState(0);
  const [span, setSpanState] = useState<Span>(storedSpan);
  const setSpan = (v: Span) => { setSpanState(v); try { localStorage.setItem(VIEW, v); } catch { /* not remembered */ } };
  const [now, setNow] = useState(new Date());
  const scroller = useRef<HTMLDivElement>(null);
  const accounts = orgs.map((o) => o.id).join(",");

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  // Start the day at 8:00, like Teams.
  useEffect(() => { scroller.current?.scrollTo({ top: HOUR * 7.5 }); }, []);

  useEffect(() => {
    let live = true;
    setError(null);
    for (const o of orgs) backend.calendars(o.id).then((list) => live && setCalendars((c) => ({ ...c, [o.id]: list }))).catch(() => {});
    const shown = visibleDays(span, week);
    const from = toIcalUtc(shown[0]!), to = toIcalUtc(addDays(shown[shown.length - 1]!, 1));
    Promise.allSettled(orgs.map((o) => backend.calendarEvents(o.id, from, to).then((list) => list.map((event) => ({ account: o.id, event })))))
      .then((results) => {
        if (!live) return;
        setEvents(results.flatMap((r) => (r.status === "fulfilled" ? r.value : [])));
        const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
        if (failed) setError(String(failed.reason));
      });
    return () => { live = false; };
  }, [week.toDateString(), span, accounts, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id: string) => {
    const next = new Set(hidden);
    if (!next.delete(id)) next.add(id);
    setHidden(next);
    try { localStorage.setItem(HIDDEN, JSON.stringify([...next])); } catch { /* not remembered */ }
  };

  const items: Item[] = useMemo(() => (events ?? []).flatMap(({ account, event }) => {
    if (hidden.has(event.calendar)) return [];
    const cal = calendars[account]?.find((c) => c.id === event.calendar);
    const s = parseIcal(event.start);
    const end = event.end ? parseIcal(event.end).date : s.allDay ? addDays(s.date, 1) : new Date(s.date.getTime() + 3600_000);
    return [{ account, event, start: s.date, end, allDay: s.allDay, color: cal?.color ?? "var(--accent)", calendarName: cal?.name ?? "" }];
  }), [events, calendars, hidden]);

  const days = visibleDays(span, week);
  const range = span === "month" ? week.toLocaleDateString(locale(), { month: "long", year: "numeric" })
    : span === "day" ? week.toLocaleDateString(locale(), { weekday: "long", day: "numeric", month: "long", year: "numeric" })
    : `${days[0]!.toLocaleDateString(locale(), { day: "numeric", month: "short" })} – ${days[days.length - 1]!.toLocaleDateString(locale(), { day: "numeric", month: "short", year: "numeric" })}`;
  const step = (n: number) => setWeek(span === "month" ? new Date(week.getFullYear(), week.getMonth() + n, 1) : addDays(week, span === "day" ? n : 7 * n));
  const openDay = (d: Date) => { setWeek(d); setSpan("day"); };
  const allCalendars = Object.values(calendars).flat();
  const cols = { gridTemplateColumns: `56px repeat(${days.length}, 1fr)` };

  return (
    <div className="calendar-pane">
      <header className="calendar-head">
        <h2>{t("calendar.title")}</h2>
        <button className="btn small" onClick={() => setWeek(new Date())}>{t("calendar.today")}</button>
        <button className="icon-btn" title={t("calendar.prev")} onClick={() => step(-1)}>‹</button>
        <button className="icon-btn" title={t("calendar.next")} onClick={() => step(1)}>›</button>
        <span className="calendar-range">{range}</span>
        <span className="spacer" />
        {!events && <span className="muted">{t("common.loading")}</span>}
        <div className="segmented calendar-span" role="radiogroup">
          {SPANS.map((v) => (
            <button key={v} role="radio" aria-checked={span === v} className={span === v ? "on" : ""} onClick={() => setSpan(v)}>{t(`calendar.view.${v}`)}</button>
          ))}
        </div>
        <span className="emoji-anchor">
          <button className="btn small" onClick={() => setShowCalendars(!showCalendars)}>{t("calendar.calendars")} ▾</button>
          {showCalendars && (
            <div className="menu calendar-list" onMouseLeave={() => setShowCalendars(false)}>
              {allCalendars.length === 0 && <p className="empty">{t("calendar.none")}</p>}
              {allCalendars.map((c) => (
                <label key={c.id} className="menu-item">
                  <input type="checkbox" checked={!hidden.has(c.id)} onChange={() => toggle(c.id)} />
                  <span className="calendar-dot" style={{ background: c.color ?? "var(--accent)" }} />{c.name}
                </label>
              ))}
            </div>
          )}
        </span>
        <MeetNow orgs={orgs} onStart={onJoinCall} onNotice={setError} />
        <button className="btn primary small" disabled={!allCalendars.some((c) => c.writable)} onClick={() => setCreating(true)}>＋ {t("calendar.newMeeting")}</button>
      </header>
      {error && <div className="notice" role="alert">{error}</div>}
      {span === "month" ? <MonthGrid days={days} month={week.getMonth()} items={items} now={now} onOpen={setOpen} onDay={openDay} /> : <>
      <div className="calendar-days" style={cols}>
        <div className="calendar-gutter" />
        {days.map((d) => (
          <div key={d.toISOString()} className={`calendar-day-head ${sameDay(d, now) ? "today" : ""}`}>
            <b>{d.getDate()}</b> {d.toLocaleDateString(locale(), { weekday: "short" })}
          </div>
        ))}
      </div>
      <div className="calendar-days all-day" style={cols}>
        <div className="calendar-gutter" />
        {days.map((d) => (
          <div key={d.toISOString()} className="calendar-all-day">
            {items.filter((it) => it.allDay ? it.start <= d && it.end > d : it.start < d && it.end > addDays(d, 1)).map((it) => (
              <button key={it.event.uid + it.event.start} className={`calendar-chip ${statusClass(it.event)}`} style={{ "--cal": it.color } as React.CSSProperties} onClick={() => setOpen(it)}>{it.event.summary}</button>
            ))}
          </div>
        ))}
      </div>
      <div className="calendar-scroll" ref={scroller}>
        <div className="calendar-days grid" style={{ ...cols, height: HOUR * 24 }}>
          <div className="calendar-gutter">
            {Array.from({ length: 23 }, (_, h) => <span key={h} style={{ top: HOUR * (h + 1) }}>{hourLabel(h + 1)}</span>)}
          </div>
          {days.map((d) => (
            <div key={d.toISOString()} className={`calendar-day ${sameDay(d, now) ? "today" : ""}`}>
              {layoutDay(items, d).map(({ item, top, height, lane, lanes }) => (
                <button key={item.event.uid + item.event.start} className={`calendar-event ${item.end < now ? "past" : ""} ${statusClass(item.event)}`}
                  style={{ top, height, left: `calc(${(lane / lanes) * 100}% + 2px)`, width: `calc(${100 / lanes}% - 4px)`, "--cal": item.color } as React.CSSProperties}
                  onClick={() => setOpen(item)}>
                  <b>{item.event.summary || t("calendar.noTitle")}</b>
                  {height > 30 && <span>{time(item.start)} – {time(item.end)}{item.event.location && !firstUrl(item.event.location) ? ` · ${item.event.location}` : ""}</span>}
                </button>
              ))}
              {sameDay(d, now) && <div className="calendar-now" style={{ top: (now.getHours() + now.getMinutes() / 60) * HOUR }} />}
            </div>
          ))}
        </div>
      </div>
      </>}
      {open && <EventDialog item={open} chat={meetingChat(open.event, convs)} onClose={() => setOpen(null)}
        writable={!!calendars[open.account]?.find((c) => c.id === open.event.calendar)?.writable}
        onEdit={(wholeSeries) => { setSeries(wholeSeries); setEditing(open); setOpen(null); }} onDeleted={() => { setOpen(null); setReload((r) => r + 1); }}
        onOpenChat={(key) => { setOpen(null); onOpenChat(key); }} onJoinCall={(key) => { setOpen(null); onJoinCall(key); }} />}
      {(creating || editing) && <MeetingDialog orgs={orgs} calendars={calendars} editing={editing ?? undefined} series={series} onClose={() => { setCreating(false); setEditing(null); }}
        onSaved={(start) => { setCreating(false); setEditing(null); setWeek(start); setReload((r) => r + 1); }} />}
    </div>
  );
}

/** A month: one cell per day with its meetings (up to a few, then "+N more", which opens the day). */
function MonthGrid({ days, month, items, now, onOpen, onDay }: { days: Date[]; month: number; items: Item[]; now: Date; onOpen: (it: Item) => void; onDay: (d: Date) => void }) {
  const MAX = 3;
  return (
    <div className="calendar-month">
      {days.slice(0, 7).map((d) => <div key={`h${d.getDay()}`} className="calendar-month-head">{d.toLocaleDateString(locale(), { weekday: "short" })}</div>)}
      {days.map((d) => {
        const next = addDays(d, 1);
        const list = items
          .filter((it) => it.start < next && it.end > d && !(it.allDay && it.end <= d))
          .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.getTime() - b.start.getTime());
        return (
          <div key={d.toISOString()} className={`calendar-month-day ${d.getMonth() !== month ? "other" : ""} ${sameDay(d, now) ? "today" : ""}`}>
            <button className="calendar-month-date" onClick={() => onDay(d)}>{d.getDate()}</button>
            {list.slice(0, MAX).map((it) => (
              <button key={it.event.uid + it.event.start} className={`calendar-chip ${statusClass(it.event)}`} style={{ "--cal": it.color } as React.CSSProperties} onClick={() => onOpen(it)}>
                {!it.allDay && <span className="chip-time">{time(it.start)} </span>}{it.event.summary || t("calendar.noTitle")}
              </button>
            ))}
            {list.length > MAX && <button className="link calendar-more" onClick={() => onDay(d)}>{t("calendar.more", { count: list.length - MAX })}</button>}
          </div>
        );
      })}
    </div>
  );
}

/** Timed events of one day with their position; overlapping events share the width. */
function layoutDay(items: Item[], day: Date) {
  const dayStart = day.getTime(), dayEnd = addDays(day, 1).getTime();
  const timed = items
    .filter((it) => !it.allDay && it.start.getTime() < dayEnd && it.end.getTime() > dayStart && !(it.start.getTime() < dayStart && it.end.getTime() > dayEnd))
    .sort((a, b) => a.start.getTime() - b.start.getTime() || b.end.getTime() - a.end.getTime());
  const out: { item: Item; top: number; height: number; lane: number; lanes: number }[] = [];
  let cluster: typeof out = [];
  let clusterEnd = 0;
  const flush = () => {
    const lanes = Math.max(1, ...cluster.map((c) => c.lane + 1));
    cluster.forEach((c) => (c.lanes = lanes));
    out.push(...cluster);
    cluster = [];
  };
  for (const item of timed) {
    const s = Math.max(item.start.getTime(), dayStart), e = Math.min(item.end.getTime(), dayEnd);
    if (cluster.length && s >= clusterEnd) flush();
    const laneEnds: number[] = [];
    for (const c of cluster) laneEnds[c.lane] = Math.max(laneEnds[c.lane] ?? 0, Math.min(c.item.end.getTime(), dayEnd));
    let lane = 0;
    while (laneEnds[lane] !== undefined && laneEnds[lane]! > s) lane++;
    cluster.push({ item, top: ((s - dayStart) / 3600_000) * HOUR, height: Math.max(20, ((e - s) / 3600_000) * HOUR - 2), lane, lanes: 1 });
    clusterEnd = Math.max(clusterEnd, e);
  }
  flush();
  return out;
}

const STATUS_ICON: Record<string, string> = { ACCEPTED: "✅", DECLINED: "❌", TENTATIVE: "❔" };

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
}

function EventDialog({ item, chat, writable, onClose, onEdit, onDeleted, onOpenChat, onJoinCall }: {
  item: Item; chat?: Conversation; writable: boolean; onClose: () => void; onEdit: (series: boolean) => void; onDeleted: () => void;
  onOpenChat: (key: string) => void; onJoinCall: (key: string) => void;
}) {
  useEscape(onClose);
  const [error, setError] = useState<string | null>(null);
  const { event } = item;
  const url = firstUrl(event.location) ?? firstUrl(event.description);
  const when = item.allDay
    ? item.start.toLocaleDateString(locale(), { weekday: "long", day: "numeric", month: "long" })
    : `${item.start.toLocaleDateString(locale(), { weekday: "long", day: "numeric", month: "long" })}, ${time(item.start)} – ${time(item.end)}`;
  const canChange = writable && event.mine;
  const reply = (status: "ACCEPTED" | "TENTATIVE" | "DECLINED") =>
    backend.respondEvent(item.account, event.href, event.etag ?? null, status).then(onDeleted).catch((e) => setError(String(e)));
  // A repeating meeting asks first: this occurrence or the whole series (like Teams).
  const [choosing, setChoosing] = useState<"edit" | "delete" | null>(null);
  const occurrence = event.recurring ? event.recurrenceId ?? null : null;
  const remove = (wholeSeries: boolean) => {
    const question = !event.recurring ? t("calendar.deleteConfirm", { title: event.summary })
      : wholeSeries || !occurrence ? t("calendar.deleteSeries", { title: event.summary }) : t("calendar.deleteOccurrence", { title: event.summary });
    if (!confirm(question)) return;
    backend.deleteEvent(item.account, event.href, event.etag ?? null, wholeSeries ? null : occurrence).then(onDeleted).catch((e) => setError(String(e)));
  };
  return (
    <div className="login-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="login-card calendar-detail" style={{ "--cal": item.color } as React.CSSProperties}>
        <button className="icon-btn close" onClick={onClose} title={t("common.closeEsc")}>✕</button>
        <h1>{event.summary || t("calendar.noTitle")}</h1>
        <p className="muted">{when}{event.recurring ? ` · 🔁 ${t("calendar.repeats")}` : ""}</p>
        <p className="calendar-meta"><span className="calendar-dot" style={{ background: item.color }} />{item.calendarName}</p>
        {event.location && <p className="calendar-meta">📍 {firstUrl(event.location) ? <button className="link" onClick={() => backend.openUrl(firstUrl(event.location)!).catch(() => {})}>{event.location}</button> : event.location}</p>}
        {event.organizer && <p className="calendar-meta">👤 {t("calendar.organizer", { name: event.organizer })}</p>}
        {event.attendees.length > 0 && (
          <ul className="calendar-attendees">
            {event.attendees.map((a) => (
              <li key={a.email} title={a.email}>{STATUS_ICON[a.status ?? ""] ?? "⏳"} {a.name || a.email}</li>
            ))}
          </ul>
        )}
        {event.description && <p className="calendar-description">{event.description}</p>}
        {event.myStatus && !event.mine && (
          <div className="calendar-reply">
            <span>{t("calendar.yourAnswer")}</span>
            {(["ACCEPTED", "TENTATIVE", "DECLINED"] as const).map((s) => (
              <button key={s} className={`btn small ${event.myStatus === s ? "primary" : ""}`} onClick={() => reply(s)}>{t(`calendar.reply.${s}`)}</button>
            ))}
          </div>
        )}
        {error && <p className="error">{error}</p>}
        {choosing && (
          <div className="calendar-choice">
            <span>{choosing === "edit" ? t("calendar.editWhich") : t("calendar.deleteWhich")}</span>
            <button className="btn small" onClick={() => (choosing === "edit" ? onEdit(false) : remove(false))}>{t("calendar.thisOccurrence")}</button>
            <button className="btn small" onClick={() => (choosing === "edit" ? onEdit(true) : remove(true))}>{t("calendar.wholeSeries")}</button>
          </div>
        )}
        <div className="edit-actions">
          {canChange && <button className="btn small danger" onClick={() => (occurrence ? setChoosing("delete") : remove(true))}>{t("calendar.delete")}</button>}
          {canChange && <button className="btn small" disabled={event.recurring && !occurrence} title={event.recurring && !occurrence ? t("calendar.editSeriesHint") : undefined}
            onClick={() => (occurrence ? setChoosing("edit") : onEdit(false))}>{t("calendar.edit")}</button>}
          <span className="spacer" />
          {chat && <button className="btn small" onClick={() => onOpenChat(chat.id)}>{t("calendar.openChat")}</button>}
          {chat ? <button className="btn primary small" onClick={() => onJoinCall(chat.id)}>{t("calendar.join")}</button>
            : url && <button className="btn primary small" onClick={() => backend.openUrl(url).catch(() => {})}>{t("calendar.openLink")}</button>}
        </div>
      </div>
    </div>
  );
}

/** People to invite: chips, with suggestions from the Nextcloud user directory; any email address works too. */
function AttendeePicker({ account, value, onChange }: { account: string; value: Attendee[]; onChange: (v: Attendee[]) => void }) {
  const [term, setTerm] = useState("");
  const [found, setFound] = useState<Attendee[]>([]);
  useEffect(() => {
    if (term.trim().length < 2) return setFound([]);
    const timer = window.setTimeout(() => backend.calendarPeople(account, term).then(setFound).catch(() => setFound([])), 250);
    return () => window.clearTimeout(timer);
  }, [account, term]);
  const add = (a: Attendee) => {
    if (!value.some((v) => v.email.toLowerCase() === a.email.toLowerCase())) onChange([...value, a]);
    setTerm("");
    setFound([]);
  };
  const typedEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(term.trim());
  return (
    <div className="attendee-picker">
      <div className="attendee-chips">
        {value.map((a) => (
          <span key={a.email} className="attendee-chip" title={a.email}>
            {a.name || a.email}
            <button type="button" aria-label={t("calendar.removePerson")} onClick={() => onChange(value.filter((v) => v !== a))}>✕</button>
          </span>
        ))}
        <input value={term} placeholder={value.length ? "" : t("calendar.peoplePlaceholder")} onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (found[0] || typedEmail)) { e.preventDefault(); add(found[0] ?? { email: term.trim() }); }
            if (e.key === "Backspace" && !term && value.length) onChange(value.slice(0, -1));
          }} />
      </div>
      {(found.length > 0 || typedEmail) && (
        <div className="menu attendee-suggestions">
          {found.map((a) => (
            <button type="button" key={a.email} className="menu-item person" onClick={() => add(a)}>
              <Avatar account={account} media={a.user ? `user:${a.user}` : undefined} name={a.name ?? a.email} />
              <span className="person-text"><b>{a.name ?? a.email}</b><span className="muted">{a.email}</span></span>
            </button>
          ))}
          {typedEmail && !found.some((a) => a.email === term.trim()) && (
            <button type="button" className="menu-item" onClick={() => add({ email: term.trim() })}>{t("calendar.inviteEmail", { email: term.trim() })}</button>
          )}
        </div>
      )}
    </div>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");
const dateField = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeField = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** A new event (optionally with a Talk conversation as its online meeting, like Teams' "New meeting"), or an edit of one. */
function MeetingDialog({ orgs, calendars, editing, series = false, onClose, onSaved }: {
  orgs: Org[]; calendars: Record<string, Calendar[]>; editing?: Item; series?: boolean; onClose: () => void; onSaved: (start: Date) => void;
}) {
  useEscape(onClose);
  const writable = orgs.flatMap((o) => (calendars[o.id] ?? []).filter((c) => c.writable).map((c) => ({ account: o.id, calendar: c })));
  const next = new Date();
  next.setMinutes(next.getMinutes() < 30 ? 30 : 60, 0, 0);
  const startAt = editing?.start ?? next;
  // All-day events end the next day (exclusive); the form shows the start date only.
  const endAt = editing?.end ?? new Date(next.getTime() + 30 * 60_000);
  const [title, setTitle] = useState(editing?.event.summary ?? "");
  const [date, setDate] = useState(dateField(startAt));
  const [from, setFrom] = useState(editing?.allDay ? timeField(next) : timeField(startAt));
  const [to, setTo] = useState(editing?.allDay ? timeField(new Date(next.getTime() + 30 * 60_000)) : timeField(endAt));
  const [allDay, setAllDay] = useState(editing?.allDay ?? false);
  const [calendar, setCalendar] = useState(editing?.event.calendar ?? writable[0]?.calendar.id ?? "");
  const [online, setOnline] = useState(!editing);
  const [location, setLocation] = useState(editing?.event.location ?? "");
  const [description, setDescription] = useState(editing?.event.description ?? "");
  const [attendees, setAttendees] = useState<Attendee[]>(editing?.event.attendees ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = writable.find((w) => w.calendar.id === calendar);

  const save = async () => {
    if (!target || !title.trim()) return;
    const [y, m, d] = date.split("-").map(Number) as [number, number, number];
    const at = (hm: string) => { const [h, mi] = hm.split(":").map(Number) as [number, number]; return new Date(y, m - 1, d, h, mi); };
    const start = allDay ? new Date(y, m - 1, d) : at(from);
    let end = allDay ? addDays(start, 1) : at(to);
    if (end <= start) end = new Date(start.getTime() + 30 * 60_000);
    setBusy(true);
    setError(null);
    try {
      let place = location.trim();
      if (online) {
        // The meeting is a Talk conversation people can join by link (as Nextcloud Calendar makes them);
        // the link goes in the location.
        const room = await backend.createRoom(target.account, { name: title.trim(), topic: null, public: true, encrypted: false, alias: null, invite: [] });
        if (room.open) place = await backend.conversationLink(room.open);
      }
      const event = {
        calendar,
        summary: title.trim(),
        start: allDay ? icalDate(start) : toIcalUtc(start),
        end: allDay ? icalDate(end) : toIcalUtc(end),
        location: place || undefined,
        description: description.trim() || undefined,
        attendees,
        ...(editing?.event.recurrenceId ? { occurrence: editing.event.recurrenceId, series } : {}),
      };
      if (editing) await backend.updateEvent(editing.account, editing.event.href, editing.event.etag ?? null, event);
      else await backend.createEvent(target.account, event);
      onSaved(start);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="login-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="login-card new-meeting">
        <button className="icon-btn close" onClick={onClose} title={t("common.closeEsc")}>✕</button>
        <h1>{editing ? t("calendar.editMeeting") : t("calendar.newMeeting")}</h1>
        {editing?.event.recurrenceId && <p className="muted">🔁 {series ? t("calendar.editingSeries") : t("calendar.editingOccurrence")}</p>}
        <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <label>{t("calendar.titleLabel")}<input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <div className="new-meeting-row">
            <label>{t("calendar.date")}<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
            {!allDay && <label>{t("calendar.from")}<input type="time" value={from} onChange={(e) => setFrom(e.target.value)} /></label>}
            {!allDay && <label>{t("calendar.to")}<input type="time" value={to} onChange={(e) => setTo(e.target.value)} /></label>}
          </div>
          <label className="toggle-row"><input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /><span>{t("calendar.allDay")}</span></label>
          {!editing && writable.length > 1 && (
            <label>{t("calendar.calendar")}
              <select value={calendar} onChange={(e) => setCalendar(e.target.value)}>
                {writable.map((w) => <option key={w.calendar.id} value={w.calendar.id}>{w.calendar.name}{orgs.length > 1 ? ` (${orgs.find((o) => o.id === w.account)?.name})` : ""}</option>)}
              </select>
            </label>
          )}
          <label>{t("calendar.people")}{target && <AttendeePicker account={target.account} value={attendees} onChange={setAttendees} />}</label>
          {!editing && <label className="toggle-row"><input type="checkbox" checked={online} onChange={(e) => setOnline(e.target.checked)} /><span>{t("calendar.online")}</span></label>}
          {!online && <label>{t("calendar.location")}<input value={location} onChange={(e) => setLocation(e.target.value)} /></label>}
          <label>{t("calendar.description")}<textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
          {attendees.length > 0 && <p className="muted small">{t("calendar.inviteHint")}</p>}
          {error && <p className="error">{error}</p>}
          <div className="edit-actions">
            <button type="button" className="btn small" onClick={onClose}>{t("common.cancel")}</button>
            <button type="submit" className="btn primary small" disabled={busy || !title.trim() || !target}>
              {busy ? t("calendar.saving") : attendees.length ? t("calendar.send") : t("calendar.save")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
