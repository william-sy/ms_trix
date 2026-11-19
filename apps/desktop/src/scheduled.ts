// Send later: messages the core sends at their time (see scheduled.rs), kept in step with it here.
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { backend, isLive, type ScheduledMessage } from "./backend";
import { locale, t } from "./i18n";

let all: ScheduledMessage[] = [];
const subscribers = new Set<(list: ScheduledMessage[]) => void>();
let started = false;

function start() {
  if (started || !isLive) return;
  started = true;
  const set = (list: ScheduledMessage[]) => { all = list; subscribers.forEach((s) => s(all)); };
  void backend.scheduledMessages().then(set).catch(() => {});
  void listen<ScheduledMessage[]>("trix://scheduled", (e) => set(e.payload));
}

/** The messages scheduled in a conversation, soonest first. */
export function useScheduled(conversation: string): ScheduledMessage[] {
  const [list, setList] = useState(all);
  useEffect(() => {
    start();
    subscribers.add(setList);
    setList(all);
    return () => void subscribers.delete(setList);
  }, []);
  return list.filter((m) => m.conversation === conversation).sort((a, b) => a.at - b.at);
}

const clock = (d: Date) => d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "Today at 17:00", "Tomorrow at 09:00", or the day and date. */
export function whenLabel(at: number): string {
  const d = new Date(at);
  const days = Math.round((dayStart(d) - dayStart(new Date())) / 86_400_000);
  if (days === 0) return t("schedule.todayAt", { time: clock(d) });
  if (days === 1) return t("schedule.tomorrowAt", { time: clock(d) });
  return t("schedule.dayAt", { day: d.toLocaleDateString(locale(), { weekday: "long", day: "numeric", month: "short" }), time: clock(d) });
}

/** Quick choices: later today (till mid-afternoon), tomorrow morning, and Monday morning. */
export function sendLaterChoices(now = new Date()): { at: number; label: string }[] {
  const at = (days: number, hour: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour).getTime();
  const out: number[] = [];
  if (now.getHours() < 16) out.push(at(0, 17));
  out.push(at(1, 9));
  const toMonday = (8 - now.getDay()) % 7 || 7;
  if (toMonday > 1) out.push(at(toMonday, 9));
  return out.map((a) => ({ at: a, label: whenLabel(a) }));
}
