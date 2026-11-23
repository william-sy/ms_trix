// Updates from GitHub Releases: checked a little after the app starts and then every six hours
// (Settings → About, on by default), or with "Check for updates". You pick when to install;
// installing restarts the app, so it waits while you're in a call.
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { backend, isLive, type UpdateInfo } from "./backend";
import { t } from "./i18n";
import { currentSettings } from "./settings";

const RELEASES = "https://github.com/william-sy/trixcomm/releases";
const FIRST = 15_000;
const EVERY = 6 * 3600_000;

export interface UpdateState {
  available?: UpdateInfo;
  checking: boolean;
  /** The last check found nothing newer. */
  upToDate: boolean;
  /** Downloading and installing: percent done. */
  installing?: number;
  error?: string;
  /** "Later": no banner until the next start. */
  dismissed: boolean;
  /** In a call: installing would end it. */
  blocked: boolean;
}

let state: UpdateState = { checking: false, upToDate: false, dismissed: false, blocked: false };
const listeners = new Set<(s: UpdateState) => void>();
const set = (patch: Partial<UpdateState>) => { state = { ...state, ...patch }; listeners.forEach((l) => l(state)); };

export async function checkForUpdate() {
  if (!isLive || state.checking || state.installing !== undefined) return;
  set({ checking: true, error: undefined });
  try {
    const available = (await backend.checkUpdate()) ?? undefined;
    set({ available, upToDate: !available, checking: false });
  } catch (e) {
    set({ error: String(e), checking: false });
  }
}

export async function installUpdate() {
  if (!state.available || state.blocked || state.installing !== undefined) return;
  set({ installing: 0, error: undefined });
  // Restarts the app when it's done.
  await backend.installUpdate().catch((e) => set({ installing: undefined, error: String(e) }));
}

export function setUpdateBlocked(blocked: boolean) {
  if (state.blocked !== blocked) set({ blocked });
}

export const releasePage = (version: string) => `${RELEASES}/tag/v${version}`;

export function useUpdates(): UpdateState {
  const [s, setS] = useState(state);
  useEffect(() => {
    listeners.add(setS);
    setS(state);
    return () => void listeners.delete(setS);
  }, []);
  return s;
}

/** In the main window: checks now and then while Settings → About allows it, and follows the download. */
export function useAutoUpdateCheck() {
  useEffect(() => {
    if (!isLive) return;
    const off = listen<number>("trix://update-progress", (e) => set({ installing: e.payload }));
    const tick = () => { if (currentSettings().autoUpdate) void checkForUpdate(); };
    const first = window.setTimeout(tick, FIRST);
    const timer = window.setInterval(tick, EVERY);
    return () => { window.clearTimeout(first); window.clearInterval(timer); void off.then((f) => f()); };
  }, []);
}

/** The new version's name, "Downloading … %" while it installs. */
export const updateText = (s: UpdateState) =>
  s.installing !== undefined ? t("update.installing", { percent: s.installing }) : t("update.available", { version: s.available?.version ?? "" });

/** Under the title bar when a new version is out: what's new (its release page), restart, later. */
export function UpdateBanner() {
  const s = useUpdates();
  if (!s.available || s.dismissed) return null;
  const version = s.available.version;
  return (
    <div className="notice" role="status">
      <span>{updateText(s)}</span>
      {s.error && <span className="error">{s.error}</span>}
      <button className="link" onClick={() => void backend.openUrl(releasePage(version)).catch(() => {})}>{t("update.whatsNew")}</button>
      <button className="btn primary small" disabled={s.blocked || s.installing !== undefined} title={s.blocked ? t("update.afterCall") : undefined} onClick={() => void installUpdate()}>{t("update.restart")}</button>
      {s.installing === undefined && <button className="link" onClick={() => set({ dismissed: true })}>{t("update.later")}</button>}
    </div>
  );
}
