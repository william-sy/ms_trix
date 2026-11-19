// Repeating meetings: the RRULE for a choice in the meeting dialog, and the time zone they repeat
// in. A repeating meeting is stored in local time with this computer's time zone (not UTC), so
// "every Monday at 9" stays at 9 when summer time starts or ends.

export type Repeat = "none" | "daily" | "weekdays" | "weekly" | "biweekly" | "monthlyDate" | "monthlyWeekday" | "yearly";

export type RepeatEnd = { kind: "never" } | { kind: "until"; date: string } | { kind: "count"; count: number };

/** iCalendar's day names, by JavaScript's day number (0 = Sunday). */
export const ICAL_DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

const pad = (n: number) => String(n).padStart(2, "0");
const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate(); // month 1-12

/** Which of its weekday in the month `d` is: 1-4, or 5 for a fifth (the last). */
export const weekOfMonth = (d: Date) => Math.ceil(d.getDate() / 7);

/** Whether `d` is the last of its weekday in its month. */
export const lastOfMonth = (d: Date) => d.getDate() + 7 > daysIn(d.getFullYear(), d.getMonth() + 1);

/** Local date and time in iCalendar form, without a zone ("20261117T090000"). */
export const icalLocal = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

const icalUtc = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;

/**
 * The RRULE for a repeat choice starting at `start` (null: doesn't repeat). `days` are the
 * weekdays of a weekly meeting (JavaScript numbers); the start's own day is always one of them.
 */
export function rrule(repeat: Repeat, start: Date, days: number[], end: RepeatEnd, allDay: boolean): string | null {
  const day = ICAL_DAYS[start.getDay()]!;
  const weekly = [...new Set([start.getDay(), ...days])].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => ICAL_DAYS[d]).join(",");
  const parts: Record<Repeat, string | null> = {
    none: null,
    daily: "FREQ=DAILY",
    weekdays: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
    weekly: `FREQ=WEEKLY;BYDAY=${weekly}`,
    biweekly: `FREQ=WEEKLY;INTERVAL=2;BYDAY=${day}`,
    monthlyDate: `FREQ=MONTHLY;BYMONTHDAY=${start.getDate()}`,
    monthlyWeekday: `FREQ=MONTHLY;BYDAY=${weekOfMonth(start) >= 5 ? -1 : weekOfMonth(start)}${day}`,
    yearly: "FREQ=YEARLY",
  };
  const rule = parts[repeat];
  if (!rule) return null;
  if (end.kind === "count") return `${rule};COUNT=${Math.max(1, Math.round(end.count))}`;
  if (end.kind === "until" && end.date) {
    const [y, m, d] = end.date.split("-").map(Number) as [number, number, number];
    // UNTIL is a date for all-day meetings, else UTC (the end of that day here).
    return `${rule};UNTIL=${allDay ? `${y}${pad(m)}${pad(d)}` : icalUtc(new Date(y, m - 1, d, 23, 59, 59))}`;
  }
  return rule;
}

/** This computer's time zone name (an IANA id such as "Europe/Amsterdam"). */
export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** Minutes east of UTC on this computer at `ms`. */
const offsetAt = (ms: number) => -new Date(ms).getTimezoneOffset();
const formatOffset = (m: number) => `${m < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(m) / 60))}${pad(Math.abs(m) % 60)}`;

/** The day of the month that is the `n`th (or last, -1) `weekday` of a month (1-12). */
function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  if (n > 0) return 1 + ((weekday - new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 7) % 7) + (n - 1) * 7;
  const last = daysIn(year, month);
  return last - ((new Date(Date.UTC(year, month - 1, last)).getUTCDay() - weekday + 7) % 7);
}

/**
 * This computer's time zone as a VTIMEZONE (which iCalendar wants next to a TZID): its summer-time
 * changes in `year`, written as yearly rules ("the last Sunday of March").
 */
export function vtimezone(tzid: string, year = new Date().getFullYear()): string {
  const lines = ["BEGIN:VTIMEZONE", `TZID:${tzid}`];
  const day = 86_400_000;
  const from = Date.UTC(year, 0, 1);
  let changes = 0;
  for (let t = from; t < from + 366 * day; t += day) {
    const before = offsetAt(t), after = offsetAt(t + day);
    if (before === after) continue;
    // The minute it changes.
    let lo = t, hi = t + day;
    while (hi - lo > 60_000) {
      const mid = Math.floor((lo + hi) / 2 / 60_000) * 60_000;
      if (offsetAt(mid) === before) lo = mid; else hi = mid;
    }
    // On the clock as it was: 02:00 when it jumps to 03:00 in spring, 03:00 going back in autumn.
    const wall = new Date(hi + before * 60_000);
    const month = wall.getUTCMonth() + 1, weekday = wall.getUTCDay(), date = wall.getUTCDate();
    const n = date + 7 > daysIn(wall.getUTCFullYear(), month) ? -1 : Math.ceil(date / 7);
    const kind = after > before ? "DAYLIGHT" : "STANDARD";
    lines.push(
      `BEGIN:${kind}`,
      `TZOFFSETFROM:${formatOffset(before)}`,
      `TZOFFSETTO:${formatOffset(after)}`,
      `DTSTART:1970${pad(month)}${pad(nthWeekday(1970, month, weekday, n))}T${pad(wall.getUTCHours())}${pad(wall.getUTCMinutes())}00`,
      `RRULE:FREQ=YEARLY;BYMONTH=${month};BYDAY=${n}${ICAL_DAYS[weekday]}`,
      `END:${kind}`,
    );
    changes++;
  }
  if (!changes) {
    const offset = formatOffset(offsetAt(from));
    lines.push("BEGIN:STANDARD", `TZOFFSETFROM:${offset}`, `TZOFFSETTO:${offset}`, "DTSTART:19700101T000000", "END:STANDARD");
  }
  lines.push("END:VTIMEZONE");
  return lines.join("\r\n");
}
