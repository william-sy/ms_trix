import { createContext, useContext, useEffect, useRef, useState } from "react";
import { backend } from "./backend";
import { parseIcal, toIcalUtc } from "./CalendarPane";
import { fromToday, longDate, parseIsoDay } from "./dates";
import { useClickOutside, useEscape } from "./hooks";
import { locale, t } from "./i18n";
import type { Org } from "./types";

// A date in a message, clicked: that month with the day marked, what's in your calendar that day,
// and a way to plan something then.

export interface DateRefInfo {
  /** "2026-12-09". */
  date: string;
  /** "14:00" when the message gave a time. */
  time?: string;
  /** A starting point for a meeting's title (the message's first line). */
  title: string;
  /** Where it was clicked. */
  x: number;
  y: number;
}

export const DateRefContext = createContext<(info: DateRefInfo) => void>(() => {});
export const useOpenDate = () => useContext(DateRefContext);

const WIDTH = 280;

export function DatePopover({ info, calendarOrgs, onOpenCalendar, onAdd, onClose }: {
  info: DateRefInfo;
  /** Accounts with a calendar; without any there's nothing to open or add to. */
  calendarOrgs: Org[];
  onOpenCalendar: (date: Date) => void;
  onAdd: (date: Date, time: string | undefined, title: string) => void;
  onClose: () => void;
}) {
  const date = parseIsoDay(info.date)!;
  const ref = useRef<HTMLDivElement>(null);
  useEscape(onClose);
  useClickOutside(ref, true, onClose);
  const [events, setEvents] = useState<{ start: Date; allDay: boolean; summary: string }[] | null>(null);
  const ids = calendarOrgs.map((o) => o.id).join("|");
  useEffect(() => {
    if (!calendarOrgs.length) return;
    let live = true;
    const from = toIcalUtc(date), to = toIcalUtc(new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1));
    void Promise.allSettled(calendarOrgs.map((o) => backend.calendarEvents(o.id, from, to))).then((results) => {
      if (!live) return;
      const list = results.flatMap((r) => (r.status === "fulfilled" ? r.value : [])).map((e) => {
        const s = parseIcal(e.start);
        return { start: s.date, allDay: s.allDay, summary: e.summary };
      });
      setEvents(list.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.getTime() - b.start.getTime()));
    });
    return () => { live = false; };
  }, [info.date, ids]); // eslint-disable-line react-hooks/exhaustive-deps

  // The month, weeks from Monday.
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  const length = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const cells = Array.from({ length: Math.ceil((offset + length) / 7) * 7 }, (_, i) => new Date(date.getFullYear(), date.getMonth(), 1 - offset + i));
  // 1 January 2024 was a Monday.
  const weekdays = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(locale(), { weekday: "narrow" }));
  const today = new Date().toDateString();
  const time = (d: Date) => d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });

  // Below the click, or above it near the bottom of the window.
  const left = Math.max(8, Math.min(info.x - WIDTH / 2, window.innerWidth - WIDTH - 8));
  const place = info.y > window.innerHeight - 380 ? { bottom: window.innerHeight - info.y + 10 } : { top: info.y + 14 };

  return (
    <div ref={ref} className="date-popover" style={{ left, width: WIDTH, ...place }} role="dialog">
      <b className="date-popover-day">{longDate(date, locale())}{info.time && ` · ${info.time}`}</b>
      <span className="date-popover-when">{fromToday(date, locale())}</span>
      <div className="date-popover-month">
        <span className="date-popover-title">{date.toLocaleDateString(locale(), { month: "long", year: "numeric" })}</span>
        <div className="date-popover-grid">
          {weekdays.map((w, i) => <span key={`w${i}`} className="wd">{w}</span>)}
          {cells.map((d) => (
            <span key={d.toISOString()} className={`${d.getMonth() !== date.getMonth() ? "other" : ""} ${d.toDateString() === date.toDateString() ? "on" : ""} ${d.toDateString() === today ? "today" : ""}`}>{d.getDate()}</span>
          ))}
        </div>
      </div>
      {calendarOrgs.length > 0 && (
        <>
          <div className="date-popover-events">
            {events === null ? <span className="muted">{t("common.loading")}</span>
              : events.length === 0 ? <span className="muted">{t("dates.nothingPlanned")}</span>
              : events.slice(0, 5).map((e, i) => <span key={i}><b>{e.allDay ? t("dates.allDay") : time(e.start)}</b> {e.summary}</span>)}
            {events && events.length > 5 && <span className="muted">{t("dates.more", { count: events.length - 5 })}</span>}
          </div>
          <div className="date-popover-actions">
            <button className="btn small" onClick={() => onOpenCalendar(date)}>{t("dates.openCalendar")}</button>
            <button className="btn small primary" onClick={() => onAdd(date, info.time, info.title)}>{t("dates.addToCalendar")}</button>
          </div>
        </>
      )}
    </div>
  );
}
