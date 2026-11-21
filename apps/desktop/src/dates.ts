// Dates written in messages: 2026-12-09, 9-12-2026, 9/12/2026, "9 december", "December 9th",
// optionally with a weekday before and a time after ("donderdag 9 december om 14:00"). Dutch and
// English month names. A date without a year is the first one on or after the day the message
// was sent. Numbers that only look like dates (versions, phone numbers, impossible days) aren't.

const MONTHS: Record<string, number> = {
  januari: 1, january: 1, jan: 1, februari: 2, february: 2, feb: 2, maart: 3, march: 3, mrt: 3, mar: 3,
  april: 4, apr: 4, mei: 5, may: 5, juni: 6, june: 6, jun: 6, juli: 7, july: 7, jul: 7,
  augustus: 8, august: 8, aug: 8, september: 9, sept: 9, sep: 9, oktober: 10, october: 10, okt: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12,
};
/** Weekday names, Sunday = 0 as in Date.getDay(). */
const WEEKDAYS: Record<string, number> = {
  zondag: 0, sunday: 0, sun: 0, maandag: 1, monday: 1, mon: 1, dinsdag: 2, tuesday: 2, tue: 2, tues: 2,
  woensdag: 3, wednesday: 3, wed: 3, donderdag: 4, thursday: 4, thu: 4, thur: 4, thurs: 4,
  vrijdag: 5, friday: 5, fri: 5, zaterdag: 6, saturday: 6, sat: 6,
};
const names = (o: Record<string, number>) => Object.keys(o).sort((a, b) => b.length - a.length).join("|");
const MONTH = names(MONTHS);
const WEEKDAY = names(WEEKDAYS);

const DATE_RE = new RegExp(
  // Not inside a word, a number, a version or a path.
  String.raw`(?<![\p{L}\p{N}_./:-])(?:(${WEEKDAY})\.?,?\s+)?(?:` +
    String.raw`(\d{4})-(\d{1,2})-(\d{1,2})` + // 2026-12-09
    String.raw`|(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})` + // 9-12-2026, 9/12/2026, 09.12.2026
    String.raw`|(\d{1,2})(?:st|nd|rd|th|ste|de|e)?\s+(${MONTH})\.?(?:\s+(\d{4}))?` + // 9 december (2026)
    String.raw`|(${MONTH})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?` + // December 9(th)(, 2026)
    String.raw`)(?![\p{L}\p{N}_]|[./:-]\d)` +
    // An optional time: "14:00", "om 14.00", "at 9:30".
    String.raw`(?:,?\s+(?:om|at|@|vanaf|from)?\s*([01]?\d|2[0-3])[:.]([0-5]\d)(?!\d))?`,
  "giu",
);

export interface FoundDate {
  /** Where it is in the text, and how long. */
  index: number;
  length: number;
  /** The day, at midnight local time. */
  date: Date;
  /** "14:00" when a time was written after it. */
  time?: string;
  /** A weekday was written before it that isn't that date's weekday. */
  wrongWeekday?: boolean;
}

const real = (y: number, m: number, d: number) => {
  if (y < 1970 || y > 2100 || m < 1 || m > 12 || d < 1) return null;
  const date = new Date(y, m - 1, d);
  return date.getMonth() === m - 1 && date.getDate() === d ? date : null;
};

/** Without a year: the first time that day comes on or after `from`. */
const nextOccurrence = (m: number, d: number, from: Date) => {
  const day = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  for (let y = from.getFullYear(); y <= from.getFullYear() + 8; y++) {
    const date = real(y, m, d);
    if (date && date >= day) return date;
  }
  return null;
};

/** The dates in `text`; `sent` decides the year where none is written. */
export function findDates(text: string, sent: Date): FoundDate[] {
  const found: FoundDate[] = [];
  for (const m of text.matchAll(DATE_RE)) {
    const n = (i: number) => (m[i] ? Number(m[i]) : NaN);
    let date: Date | null = null;
    if (m[2]) date = real(n(2), n(3), n(4));
    // Day first, as in Dutch; month first only where day first can't be (12/25/2026).
    else if (m[5]) date = real(n(7), n(6), n(5)) ?? real(n(7), n(5), n(6));
    else if (m[8]) date = m[10] ? real(n(10), MONTHS[m[9]!.toLowerCase()]!, n(8)) : nextOccurrence(MONTHS[m[9]!.toLowerCase()]!, n(8), sent);
    else if (m[11]) date = m[13] ? real(n(13), MONTHS[m[11]!.toLowerCase()]!, n(12)) : nextOccurrence(MONTHS[m[11]!.toLowerCase()]!, n(12), sent);
    if (!date) continue;
    const weekday = m[1] ? WEEKDAYS[m[1].toLowerCase()] : undefined;
    found.push({
      index: m.index!,
      length: m[0].length,
      date,
      time: m[14] ? `${m[14].padStart(2, "0")}:${m[15]}` : undefined,
      wrongWeekday: weekday !== undefined && weekday !== date.getDay(),
    });
  }
  return found;
}

/** "2026-12-09", for data attributes and the calendar. */
export const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function parseIsoDay(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? real(+m[1]!, +m[2]!, +m[3]!) : null;
}

/** How far a day is from today, in words: "today", "tomorrow", "in 19 days", "3 weeks ago". */
export function fromToday(date: Date, locale: string, today = new Date()): string {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.round((date.getTime() - start.getTime()) / 86_400_000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (Math.abs(days) <= 31) return rtf.format(days, "day");
  if (Math.abs(days) <= 91) return rtf.format(Math.round(days / 7), "week");
  return rtf.format(Math.round(days / 30.44), "month");
}

/** "Thursday 9 December 2026". */
export const longDate = (date: Date, locale: string) =>
  date.toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
