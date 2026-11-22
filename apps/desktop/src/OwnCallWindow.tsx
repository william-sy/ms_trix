import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { backend } from "./backend";
import { warmUpEffects } from "./cameraEffects";
import { t } from "./i18n";
import { callLog as log, setCallsInOwnWindow, useTalkCallEngine, type CallWindowParams } from "./talkCalls";
import { TalkCallScreen } from "./TalkCallScreen";
import type { Conversation } from "./types";

// A Talk call in a webview of its own (started by useTalkCallHost): the main entry point renders
// this instead of the app when the webview was opened as #talk-call=<params>. The host docks it
// in the app window or moves it into a window of its own; the call stays connected either way.

const PREFIX = "#talk-call=";
export const isCallWindow = location.hash.startsWith(PREFIX);

// See-through around the minimised card in the corner of the app.
if (isCallWindow) document.documentElement.classList.add("call-page");

/** Logged once (in development React mounts twice). */
let shownLogged = false;

function params(): CallWindowParams | null {
  try { return JSON.parse(decodeURIComponent(location.hash.slice(PREFIX.length).replace(/\+/g, " "))); } catch { return null; }
}

export function CallWindow() {
  const [p] = useState(params);
  const [docked, setDocked] = useState(() => p?.docked !== false);
  const [notice, setNotice] = useState<string | null>(null);
  const calls = useTalkCallEngine((e) => setNotice(e));
  const call = calls.call;
  const callsRef = useRef(calls);
  callsRef.current = calls;

  useEffect(() => {
    const offs = [
      // Its window's close button: leave the call properly first.
      listen("trix://leave-call", () => {
        const c = callsRef.current;
        if (!c.call || c.call.phase === "ended") void backend.closeCallWindow().catch(() => {});
        else if (c.call.phase === "prejoin") c.cancel();
        else c.leave();
      }),
      listen<boolean>("trix://call-docked", (e) => setDocked(e.payload)),
      // "Show" in the app while minimised.
      listen("trix://call-expand", () => callsRef.current.setMinimized(false)),
    ];
    return () => offs.forEach((off) => void off.then((f) => f()));
  }, []);

  // Started a moment after mounting: in development React mounts, unmounts and mounts again,
  // and that unmount would end a call started right away (and close this webview). The
  // background's person detection loads side by side with the camera, once the screen is shown.
  useEffect(() => {
    if (!p) return;
    if (!shownLogged) log(`call page shown after ${Math.round(performance.now())} ms`);
    shownLogged = true;
    const timer = window.setTimeout(() => { calls.start(p.conversation, p.video, p.silent); warmUpEffects(); }, 0);
    return () => window.clearTimeout(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The app shows this conversation as in a call while there is one.
  useEffect(() => {
    if (p && call && call.phase !== "ended") void backend.callWindowState(p.conversation).catch(() => {});
  }, [call?.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // Minimised: in the app the webview shrinks to the card (as tall as it is), in its own
  // window the window is minimised (it is while you share your screen).
  const minimized = !!call?.minimized;
  useEffect(() => {
    if (!call) return;
    const card = docked && minimized ? document.querySelector<HTMLElement>(".call-mini") : null;
    if (!card) return void backend.dockCallWindow(minimized, 0).catch(() => {});
    const report = () => void backend.dockCallWindow(true, Math.ceil(card.getBoundingClientRect().height)).catch(() => {});
    report();
    const observer = new ResizeObserver(report);
    observer.observe(card);
    return () => observer.disconnect();
  }, [minimized, docked, !!call]); // eslint-disable-line react-hooks/exhaustive-deps

  // After a move: tells the app how big this page is laid out, so it can fix a page that kept
  // its size from the other window.
  useEffect(() => {
    const report = () => void backend.callPageSize(window.innerWidth, window.innerHeight).catch(() => {});
    const timers = [300, 1200].map((ms) => window.setTimeout(report, ms));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [docked]);

  // Call over (or cancelled before joining): the webview goes too.
  useEffect(() => {
    if (call?.phase !== "ended") return;
    const timer = window.setTimeout(() => void backend.closeCallWindow().catch(() => {}), call.connectedAt ? 1500 : 0);
    return () => window.clearTimeout(timer);
  }, [call?.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!p) return <p className="empty">{t("call.windowBroken")}</p>;
  const conversation = { id: p.conversation, orgId: p.account, name: p.name, avatar: p.avatar, kind: "group" } as Conversation;
  const popOut = () => {
    calls.setMinimized(false);
    setCallsInOwnWindow(true);
    void backend.popOutCall().catch((e) => setNotice(String(e)));
  };
  const popIn = () => {
    setCallsInOwnWindow(false);
    void backend.popInCall().catch((e) => setNotice(String(e)));
  };
  return (
    <>
      <TalkCallScreen calls={calls} conversation={conversation} docked={docked} onPopOut={docked ? popOut : undefined} onPopIn={docked ? undefined : popIn} />
      {notice && <div className="notice call-window-notice" role="alert" onClick={() => setNotice(null)}>{notice}</div>}
    </>
  );
}
