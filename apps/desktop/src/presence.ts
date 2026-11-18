// Own presence helpers: re-apply the remembered status after a restart, and
// switch "available" accounts to away while the computer is idle.
import { useEffect, useRef, useState } from "react";
import { backend, isLive } from "./backend";
import type { PresenceState } from "./types";

export const PRESENCE_KEY = "ms_trix.presence";
const CHECK_EVERY_MS = 30_000;

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
