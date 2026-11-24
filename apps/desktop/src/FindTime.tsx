import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { backend } from "./backend";
import { toIcalUtc } from "./CalendarPane";
import { locale, t } from "./i18n";
import type { Attendee, BusyTime, FreeBusy } from "./types";

// Find a time (like Teams' scheduling assistant): under People in New meeting, everyone's busy
// times on the meeting's day, the chosen time framed; click a free spot to move the meeting
// there, or let it suggest the next times when everyone is free. Nextcloud answers free/busy
// itself, across all of someone's calendars, for the people on the same Nextcloud.

/** For the chosen time: free, busy, tentatively busy, outside working hours, or unknown. */
export type Availability = "free" | "busy" | "tentative" | "away" | "unknown";

const DAYS = 7; // looked up at once: the day shown, and the week for suggestions
const STEP = 30 * 60_000;
const WORK = [8, 18]; // suggestions fall within these hours, on weekdays
const SUGGESTIONS = 5;

const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function dayOf(date: string) {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, (m || 1) - 1, d || 1);
}

function at(day: Date, time: string) {
  const [h, m] = time.split(":").map(Number) as [number, number];
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h || 0, m || 0);
}

/** Busy blocks without the meeting being edited (everyone invited is busy then because of it). */
function without(busy: BusyTime[], skip?: { start: Date; end: Date }): BusyTime[] {
  if (!skip) return busy;
  const [s, e] = [skip.start.getTime(), skip.end.getTime()];
  return busy.flatMap((b) => {
    if (b.end <= s || b.start >= e) return [b];
    return [b.start < s ? { ...b, end: s } : null, b.end > e ? { ...b, start: e } : null].filter((x): x is BusyTime => !!x);
  });
}

export function availability(busy: BusyTime[] | null | undefined, start: number, end: number): Availability {
  if (!busy) return "unknown";
  const over = busy.filter((b) => b.start < end && b.end > start);
  if (over.some((b) => b.kind === "BUSY")) return "busy";
  if (over.some((b) => b.kind === "BUSY-UNAVAILABLE")) return "away";
  return over.length ? "tentative" : "free";
}

export function FindTime({ account, people, date, from, to, editing, onPick, onAvailability }: {
  account: string;
  people: Attendee[];
  /** The meeting's day ("2026-11-24") and times ("09:30"). */
  date: string; from: string; to: string;
  /** The meeting being edited: its own time doesn't count as busy. */
  editing?: { start: Date; end: Date };
  onPick: (date: string, from: string, to: string) => void;
  /** Each person's availability at the chosen time, by email address (lower case). */
  onAvailability: (byEmail: Record<string, Availability>) => void;
}) {
  const day = dayOf(date);
  const emails = people.map((p) => p.email.trim().toLowerCase());
  const key = `${account}|${date}|${[...emails].sort().join(",")}`;
  const [answer, setAnswer] = useState<{ key: string; list: FreeBusy[] } | { key: string; error: string } | null>(null);
  const [suggesting, setSuggesting] = useState(false);

  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + DAYS);
      backend.calendarFreeBusy(account, emails, toIcalUtc(day), toIcalUtc(end))
        .then((list) => live && setAnswer({ key, list }))
        .catch((e) => live && setAnswer({ key, error: String(e) }));
    }, 300);
    return () => { live = false; window.clearTimeout(timer); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // While another answer is on its way, the last one stays (dimmed), so the grid doesn't flicker.
  const list = answer && "list" in answer ? answer.list : null;
  const error = answer?.key === key && "error" in answer ? answer.error : null;
  const stale = answer?.key !== key;
  // You (first in the answer), then the people in the order they were added.
  const rows = useMemo(() => {
    if (!list) return [];
    const [me, ...others] = list;
    const busyOf = (f?: FreeBusy) => (f?.busy ? without(f.busy, editing) : null);
    return [
      { email: me?.email.toLowerCase() ?? "", name: t("findTime.you"), busy: busyOf(me) },
      ...people.map((p) => ({ email: p.email.trim().toLowerCase(), name: p.name || p.email, busy: busyOf(others.find((o) => o.email.toLowerCase() === p.email.trim().toLowerCase())) })),
    ];
  }, [list, people, editing?.start.getTime()]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = at(day, from), end = at(day, to) > start ? at(day, to) : new Date(start.getTime() + STEP);
  const length = end.getTime() - start.getTime();

  useEffect(() => {
    if (!stale) onAvailability(Object.fromEntries(rows.slice(1).map((r) => [r.email, availability(r.busy, start.getTime(), end.getTime())])));
  }, [rows, stale, start.getTime(), end.getTime()]); // eslint-disable-line react-hooks/exhaustive-deps

  // The hours shown: 7 to 20, or wider to fit the meeting.
  const firstHour = Math.min(7, start.getHours());
  const lastHour = Math.max(20, end.getDate() !== day.getDate() ? 24 : Math.ceil(end.getHours() + end.getMinutes() / 60));
  const viewFrom = at(day, `${firstHour}:00`).getTime();
  const span = (lastHour - firstHour) * 3_600_000;
  const pct = (ms: number) => `${Math.max(0, Math.min(100, ((ms - viewFrom) / span) * 100))}%`;
  const hours = Array.from({ length: lastHour - firstHour }, (_, i) => firstHour + i);

  const pickAt = (time: number) => {
    const snapped = Math.floor(time / STEP) * STEP;
    const next = new Date(Math.min(snapped, viewFrom + span - length));
    onPick(ymd(next), hhmm(next), hhmm(new Date(next.getTime() + length)));
  };
  const onTimelineClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    pickAt(viewFrom + ((e.clientX - box.left) / box.width) * span);
  };

  // The next times of the same length when everyone known is free, within working hours on weekdays.
  const suggestions = useMemo(() => {
    if (!list || !suggesting) return [];
    const known = rows.filter((r) => r.busy);
    const out: Date[] = [];
    const now = Math.ceil(Date.now() / STEP) * STEP;
    const until = new Date(day.getFullYear(), day.getMonth(), day.getDate() + DAYS).getTime();
    for (let t0 = Math.max(day.getTime(), now); t0 + length <= until && out.length < SUGGESTIONS; t0 += STEP) {
      const s = new Date(t0), e = new Date(t0 + length);
      const weekday = s.getDay() !== 0 && s.getDay() !== 6;
      const inHours = s.getHours() >= WORK[0]! && (e.getHours() < WORK[1]! || (e.getHours() === WORK[1] && e.getMinutes() === 0)) && e.getDate() === s.getDate();
      if (!weekday || !inHours || t0 === start.getTime()) continue;
      if (known.every((r) => availability(r.busy, t0, t0 + length) === "free")) out.push(s);
    }
    return out;
  }, [list, rows, suggesting, length, start.getTime()]); // eslint-disable-line react-hooks/exhaustive-deps

  const dayLabel = (d: Date) => d.toLocaleDateString(locale(), { weekday: "short", day: "numeric", month: "short" });
  const shift = (days: number) => {
    const d = new Date(day.getFullYear(), day.getMonth(), day.getDate() + days);
    onPick(ymd(d), from, to);
  };

  return (
    <div className="find-time">
      <div className="find-time-head">
        <button type="button" className="icon-btn" title={t("findTime.previousDay")} onClick={() => shift(-1)}>‹</button>
        <b>{dayLabel(day)}</b>
        <button type="button" className="icon-btn" title={t("findTime.nextDay")} onClick={() => shift(1)}>›</button>
        {stale && <span className="muted small">{t("findTime.loading")}</span>}
        <span className="spacer" />
        <button type="button" className={`btn small ${suggesting ? "on" : ""}`} disabled={!list || stale} onClick={() => setSuggesting(!suggesting)}>{t("findTime.suggest")}</button>
      </div>
      {error && <p className="muted small">{t("findTime.unavailable", { error })}</p>}
      {suggesting && list && !stale && (
        <div className="find-time-suggestions">
          {suggestions.length === 0 && <span className="muted small">{t("findTime.noSuggestions")}</span>}
          {suggestions.map((s) => (
            <button type="button" key={s.getTime()} className="btn small" onClick={() => { onPick(ymd(s), hhmm(s), hhmm(new Date(s.getTime() + length))); setSuggesting(false); }}>
              {dayLabel(s)}, {hhmm(s)}–{hhmm(new Date(s.getTime() + length))}
            </button>
          ))}
        </div>
      )}
      {list && !error && (
        <div className={`find-time-grid ${stale ? "stale" : ""}`}>
          <div className="find-time-rows">
          <div className="find-time-row hours">
            <span className="find-time-name" />
            <div className="find-time-line">
              {hours.map((h) => <span key={h} className="find-time-hour" style={{ left: pct(at(day, `${h}:00`).getTime()) }}>{h}</span>)}
            </div>
          </div>
          {rows.map((r, i) => {
            const state = availability(r.busy, start.getTime(), end.getTime());
            return (
              <div key={r.email || i} className="find-time-row">
                <span className="find-time-name" title={r.email}>
                  <span className={`availability ${state}`} title={t(`findTime.${state}`)} />
                  {r.name}
                </span>
                <div className={`find-time-line ${r.busy ? "" : "unknown"}`} onClick={onTimelineClick} title={r.busy ? undefined : t("findTime.unknown")}>
                  {hours.map((h) => <span key={h} className="find-time-tick" style={{ left: pct(at(day, `${h}:00`).getTime()) }} />)}
                  {r.busy?.filter((b) => b.end > viewFrom && b.start < viewFrom + span).map((b, j) => (
                    <span key={j} className={`find-time-busy ${b.kind.toLowerCase()}`} style={{ left: pct(b.start), width: `calc(${pct(b.end)} - ${pct(b.start)})` }} />
                  ))}
                </div>
              </div>
            );
          })}
          {/* The chosen time, over all rows. */}
          <div className="find-time-frame-track">
            <span className="find-time-frame" style={{ left: pct(start.getTime()), width: `calc(${pct(end.getTime())} - ${pct(start.getTime())})` }} />
          </div>
          </div>
        </div>
      )}
      {list && !error && <p className="muted small find-time-legend">
        <span><i className="find-time-busy busy" /> {t("findTime.busy")}</span>
        <span><i className="find-time-busy busy-tentative" /> {t("findTime.tentative")}</span>
        <span><i className="find-time-busy busy-unavailable" /> {t("findTime.away")}</span>
        <span><i className="find-time-busy unknown" /> {t("findTime.unknown")}</span>
      </p>}
    </div>
  );
}
