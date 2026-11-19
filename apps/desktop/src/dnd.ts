// Do not disturb: no notifications or sounds until a chosen time, or until switched off. Calls
// and meeting reminders still show, silently. Kept in the settings, so every window of the app
// (a call's own page too) knows it.
import { useEffect, useState } from "react";
import { backend, isLive } from "./backend";
import { locale, t } from "./i18n";
import { currentSettings, onSettingsChanged, updateSettings } from "./settings";

/** Until switched off. */
export const DND_FOREVER = Number.MAX_SAFE_INTEGER;

/** When do not disturb ends, while it's on. */
export const dndUntil = (): number | null => {
  const until = currentSettings().dndUntil;
  return until && until > Date.now() ? until : null;
};

export const dndActive = () => dndUntil() !== null;

export const setDnd = (until: number | null) => updateSettings({ dndUntil: until });

/** "until 15:00", or with the day when that isn't today; empty for until switched off. */
export function dndEnd(until: number): string {
  if (until === DND_FOREVER) return "";
  const d = new Date(until);
  const time = d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString(locale(), { weekday: "short" })} ${time}`;
}

/** The status message while it's on (for people who haven't set one of their own). */
export const dndStatus = (until: number) => (until === DND_FOREVER ? t("dnd.status") : t("dnd.statusUntil", { time: dndEnd(until) }));

/** When do not disturb ends while it's on; tells the core, and switches it off on time. */
export function useDnd(): number | null {
  const [until, setUntil] = useState(dndUntil);
  useEffect(() => onSettingsChanged(() => setUntil(dndUntil())), []);
  useEffect(() => {
    if (isLive) void backend.setDnd(until).catch(() => {});
    if (!until || until === DND_FOREVER) return;
    // Checked every few seconds rather than one long timer, which a sleeping computer delays.
    const timer = window.setInterval(() => {
      if (Date.now() < until) return;
      setUntil(null);
      if (currentSettings().dndUntil) setDnd(null);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [until]);
  return until;
}
