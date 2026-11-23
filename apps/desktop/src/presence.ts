// Own presence helpers: re-apply the remembered status after a restart, switch "available"
// accounts to away while the computer is idle, and know when you're in a meeting.
import { useEffect, useRef, useState } from "react";
import { backend, CALENDAR_CHANGED, isLive } from "./backend";
import { parseIcal, toIcalUtc } from "./CalendarPane";
import type { PresenceState } from "./types";

export const PRESENCE_KEY = "Trixcomm.presence";
const CHECK_EVERY_MS = 30_000;
const MEETINGS_EVERY_MS = 5 * 60_000;

type Chosen = Record<string, { presence: PresenceState; status?: string }>;

/** Returns the accounts currently shown as away because of idleness; 0 minutes turns it off. */
export function useAutoAway(orgIds: string[], chosen: Chosen, awayAfterMin: number): Set<string> {
  const [idle, setIdle] = useState(false);
  const applied = useRef(new Set<string>());
  const lastInput = useRef(Date.now());

  // Restore the remembered status once per account as it comes online.
  useEffect(() => {
    if (!isLive) return;
    for (const id of orgIds) {
      if (applied.current.has(id)) continue;
      applied.current.add(id);
      const c = chosen[id];
      if (c && c.presence !== "available") backend.setPresence(id, c.presence, c.status ?? null).catch(() => {});
    }
  }, [orgIds.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  // System idle time where the host knows it, otherwise input in our window.
  useEffect(() => {
    setIdle(false);
    if (!isLive || awayAfterMin <= 0) return;
    const touch = () => (lastInput.current = Date.now());
    const events = ["mousemove", "keydown", "mousedown", "wheel"] as const;
    events.forEach((e) => window.addEventListener(e, touch, { passive: true }));
    const timer = window.setInterval(async () => {
      const system = await backend.idleSeconds().catch(() => null);
      const seconds = system ?? (Date.now() - lastInput.current) / 1000;
      setIdle(seconds >= awayAfterMin * 60);
    }, CHECK_EVERY_MS);
    return () => {
      events.forEach((e) => window.removeEventListener(e, touch));
      window.clearInterval(timer);
    };
  }, [awayAfterMin]);

  const affected = new Set(idle ? orgIds.filter((id) => (chosen[id]?.presence ?? "available") === "available") : []);
  const key = [...affected].sort().join("|");
  const sent = useRef(new Set<string>());
  useEffect(() => {
    if (!isLive) return;
    for (const id of affected) if (!sent.current.has(id)) backend.setPresence(id, "away", chosen[id]?.status ?? null).catch(() => {});
    for (const id of sent.current) if (!affected.has(id)) backend.setPresence(id, chosen[id]?.presence ?? "available", chosen[id]?.status ?? null).catch(() => {});
    sent.current = affected;
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return affected;
}

/**
 * When the meeting going on now ends (Unix ms), from the calendars of `accounts`; null between
 * meetings. All-day events and meetings you declined or haven't answered don't count.
 */
export function useMeetingNow(accounts: string[]): number | null {
  const meetings = useRef<{ start: number; end: number }[]>([]);
  const [until, setUntil] = useState<number | null>(null);
  const key = accounts.join("|");
  useEffect(() => {
    meetings.current = [];
    const update = () => {
      const now = Date.now();
      const running = meetings.current.filter((m) => m.start <= now && now < m.end);
      setUntil(running.length ? Math.max(...running.map((m) => m.end)) : null);
    };
    update();
    if (!isLive || !accounts.length) return;
    let live = true;
    // What runs from now until the next look (and a little after).
    const load = async () => {
      const from = new Date(), to = new Date(from.getTime() + MEETINGS_EVERY_MS + 60_000);
      const results = await Promise.allSettled(accounts.map((a) => backend.calendarEvents(a, toIcalUtc(from), toIcalUtc(to))));
      // Offline: what was known stays.
      if (!live || results.every((r) => r.status === "rejected")) return;
      meetings.current = results.flatMap((r) => (r.status === "fulfilled" ? r.value : [])).flatMap((e) => {
        const start = parseIcal(e.start);
        if (start.allDay || e.myStatus === "DECLINED" || e.myStatus === "NEEDS-ACTION") return [];
        const end = e.end ? parseIcal(e.end).date.getTime() : start.date.getTime() + 30 * 60_000;
        return [{ start: start.date.getTime(), end }];
      });
      update();
    };
    void load();
    const loading = window.setInterval(() => void load(), MEETINGS_EVERY_MS);
    const ticking = window.setInterval(update, CHECK_EVERY_MS);
    const onChange = () => void load();
    window.addEventListener(CALENDAR_CHANGED, onChange);
    return () => {
      live = false;
      window.clearInterval(loading);
      window.clearInterval(ticking);
      window.removeEventListener(CALENDAR_CHANGED, onChange);
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return until;
}
