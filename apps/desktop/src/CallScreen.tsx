import { useEffect, useRef, useState } from "react";
import { playRingtone } from "./ringtone";
import { Avatar } from "./Avatar";
import { CallIcon, CameraIcon, CameraOffIcon, ExpandIcon, MicIcon, MicOffIcon, PopInIcon, ShareScreenIcon } from "./Icons";
import { useCallWindow } from "./callWindow";
import type { Calls, CallState } from "./calls";
import { t } from "./i18n";
import { currentSettings, onSettingsChanged } from "./settings";
import type { Conversation } from "./types";
import { formatDuration } from "./voice";
import { BackgroundButton, SpeakerButton } from "./TalkCallScreen";

/** Plays a stream; uses the speaker chosen in Settings where the webview allows it. */
function Media({ stream, muted, className, audioOnly }: { stream?: MediaStream; muted?: boolean; className?: string; audioOnly?: boolean }) {
  const ref = useRef<HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> }>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream ?? null;
    const speaker = currentSettings().speakerId;
    if (!muted && speaker && el.setSinkId) void el.setSinkId(speaker).catch(() => {});
  }, [stream, muted]);
  // A speaker picked during the call applies at once.
  useEffect(() => onSettingsChanged((st) => { const el = ref.current; if (!muted && st.speakerId && el?.setSinkId) void el.setSinkId(st.speakerId).catch(() => {}); }), [muted]);
  if (audioOnly) return <audio ref={ref as React.RefObject<HTMLAudioElement>} autoPlay muted={muted} />;
  return <video ref={ref} className={className} autoPlay playsInline muted={muted} />;
}

/** Ringing (in and out) as a repeating two-tone, generated so there's no sound file. */
export function useRingtone(on: boolean, incoming: boolean) {
  useEffect(() => {
    if (!on) return;
    // Ringing for you: your ringtone. Calling out: the ringback tone below.
    if (incoming) return playRingtone();
    const ctx = new AudioContext();
    const ring = () => {
      for (const freq of [440, 480]) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        const start = ctx.currentTime;
        const length = 1.2;
        gain.gain.setValueAtTime(0.06, start);
        gain.gain.exponentialRampToValueAtTime(0.001, start + length);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + length);
      }
    };
    ring();
    const timer = window.setInterval(ring, 3500);
    return () => { window.clearInterval(timer); void ctx.close(); };
  }, [on, incoming]);
}

const endText = (reason?: string) =>
  reason === "missed" ? t("mxcall.ended.missed")
    : reason === "rejected" ? t("mxcall.ended.rejected")
    : reason === "invite_timeout" ? t("mxcall.ended.noAnswer")
    : reason === "answered_elsewhere" ? t("mxcall.ended.elsewhere")
    : reason === "user_busy" ? t("mxcall.ended.busy")
    : reason === "ice_failed" ? t("mxcall.ended.failed")
    : reason === "error" ? t("mxcall.ended.error")
    : t("mxcall.ended.done");

interface Props {
  calls: Calls;
  conversation?: Conversation;
}

/** Ringing toast, full call screen, or a small floating panel while you keep chatting. */
export function CallScreen({ calls, conversation }: Props) {
  const call = calls.call;
  const [now, setNow] = useState(Date.now());
  const win = useCallWindow();
  useRingtone(!!call && call.phase === "ringing", call?.direction === "in");
  useEffect(() => {
    if (call?.phase !== "connected") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [call?.phase]);
  // An ended call shows its outcome briefly, then goes away.
  useEffect(() => {
    if (call?.phase !== "ended") return;
    const timer = window.setTimeout(calls.dismiss, 2500);
    return () => window.clearTimeout(timer);
  }, [call?.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!call) return null;
  const name = conversation?.name ?? call.peer;
  const avatar = <Avatar account={call.account} media={conversation?.avatar} name={name} className="big" />;
  const status = statusText(call, now);

  if (call.direction === "in" && call.phase === "ringing") {
    return (
      <div className="call-ring" role="alertdialog" aria-label={t("mxcall.incoming", { name })}>
        {avatar}
        <div className="call-ring-text">
          <b>{name}</b>
          <span>{call.video ? t("mxcall.incomingVideo") : t("mxcall.incomingVoice")}</span>
        </div>
        <button className="call-btn decline" title={t("mxcall.decline")} onClick={calls.hangup}><CallIcon /></button>
        <button className="call-btn accept" title={t("mxcall.acceptVoice")} onClick={() => calls.accept(false)}><CallIcon /></button>
        {call.video && <button className="call-btn accept" title={t("mxcall.acceptVideo")} onClick={() => calls.accept(true)}><CameraIcon /></button>}
      </div>
    );
  }

  const camera = call.remote && call.remote.getVideoTracks().some((tr) => tr.readyState === "live");
  const controls = (
    <div className="call-controls">
      <button className={`call-btn ${call.muted ? "off" : ""}`} title={call.muted ? t("mxcall.unmute") : t("mxcall.mute")} onClick={() => calls.setMuted(!call.muted)}>{call.muted ? <MicOffIcon /> : <MicIcon />}</button>
      <button className={`call-btn ${call.cameraOn ? "" : "off"}`} title={call.cameraOn ? t("mxcall.cameraOff") : t("mxcall.cameraOn")} disabled={call.phase !== "connected" && !call.cameraOn}
        onClick={() => calls.setCamera(!call.cameraOn)}>{call.cameraOn ? <CameraIcon /> : <CameraOffIcon />}</button>
      {!call.minimized && <BackgroundButton onPick={calls.setBackground} disabled={!call.local?.getVideoTracks().length} />}
      <button className={`call-btn ${call.sharing ? "on" : ""}`} title={call.sharing ? t("mxcall.stopShare") : t("mxcall.share")} disabled={call.phase !== "connected"}
        onClick={() => calls.setSharing(!call.sharing)}><ShareScreenIcon /></button>
      <button className="call-btn decline" title={t("mxcall.hangup")} disabled={call.phase === "ended"} onClick={calls.hangup}><CallIcon /></button>
    </div>
  );

  if (call.minimized) {
    return (
      <div className="call-mini">
        <Media stream={call.remote} audioOnly={!camera} className="call-mini-video" />
        {!camera && avatar}
        <div className="call-mini-text"><b>{name}</b><span>{status}</span></div>
        {controls}
        <button className="icon-btn" title={t("mxcall.expand")} onClick={() => calls.setMinimized(false)}><ExpandIcon /></button>
      </div>
    );
  }

  // Teams-like: a shared screen fills the stage, the camera becomes a tile next to it.
  const stage = call.remoteScreen ?? (camera ? call.remote : undefined);
  return (
    <div ref={win.ref} className={`call-screen ${win.className}`} style={win.style}>
      <header className="call-head" onPointerDown={win.onHeadPointerDown}>
        <b>{name}</b>
        <span className="muted">{status}</span>
        {call.sharing && <button className="sharing-pill" onClick={() => void calls.setSharing(false)}><ShareScreenIcon /> {t("share.youreSharing")} · <b>{t("mxcall.stopShare")}</b></button>}
        <span className="spacer" />
        <SpeakerButton />
        {stage && pipSupported() && <button className="icon-btn" title={t("mxcall.pip")} onClick={pictureInPicture}>⧉</button>}
        <button className="icon-btn" title={win.floating ? t("call.fullSize") : t("call.smallWindow")} onClick={win.toggle}>{win.floating ? <ExpandIcon /> : <PopInIcon />}</button>
        <button className="icon-btn" title={t("mxcall.minimize")} onClick={() => calls.setMinimized(true)}>⤡</button>
      </header>
      <div className="call-stage">
        {stage ? <Media stream={stage} className="call-main" /> : <div className="call-avatar">{avatar}{call.remoteMuted && <span className="call-muted-tag"><MicOffIcon size={16} /></span>}</div>}
        {/* Audio of the other side always plays, also when the stage shows their screen. */}
        {call.remote && stage !== call.remote && <Media stream={call.remote} audioOnly={!call.remoteScreen || !camera} className="call-tile remote" />}
        {call.local && call.cameraOn && <Media key={call.local.getVideoTracks()[0]?.id} stream={call.local} muted className="call-tile self" />}
      </div>
      {controls}
    </div>
  );
}

type PipVideo = HTMLVideoElement & { webkitSupportsPresentationMode?: (mode: string) => boolean; webkitSetPresentationMode?: (mode: string) => void };

/** The system's floating video window (stays on top of other apps), where the webview supports it. */
function pictureInPicture() {
  const video = document.querySelector<PipVideo>(".call-main, .call-mini-video");
  if (!video) return;
  if (document.pictureInPictureEnabled && video.requestPictureInPicture) void video.requestPictureInPicture().catch(() => {});
  else video.webkitSetPresentationMode?.("picture-in-picture");
}

const pipSupported = () =>
  !!document.pictureInPictureEnabled || typeof (HTMLVideoElement.prototype as PipVideo).webkitSetPresentationMode === "function";

function statusText(call: CallState, now: number) {
  if (call.phase === "ended") return endText(call.endReason);
  if (call.phase === "ringing") return t("mxcall.ringing");
  if (call.phase === "connecting") return t("mxcall.connecting");
  if (call.onHold) return t("mxcall.onHold");
  return formatDuration(now - (call.connectedAt ?? now));
}
