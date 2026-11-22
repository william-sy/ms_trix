import { useEffect, useRef, useState } from "react";
import { SpeakerPicker } from "./SpeakerPicker";
import { BackgroundPicker } from "./BackgroundPicker";
import { rawCamera } from "./cameraEffects";
import { useRingtone } from "./CallScreen";
import { Avatar } from "./Avatar";
import { backend } from "./backend";
import { dndActive } from "./dnd";
import { CallIcon, CameraIcon, CameraOffIcon, EmojiIcon, ExpandIcon, GearIcon, HandIcon, LayoutIcon, MicIcon, MicOffIcon, PinIcon, ShareScreenIcon, SparkleIcon, NewWindowIcon } from "./Icons";
import { t } from "./i18n";
import { currentSettings, onSettingsChanged, updateSettings } from "./settings";
import { callLog, type TalkCalls, type TalkPeerView } from "./talkCalls";
import type { Conversation } from "./types";
import { formatDuration } from "./voice";

function Video({ stream, muted, mirror, className }: { stream?: MediaStream; muted?: boolean; mirror?: boolean; className?: string }) {
  const ref = useRef<HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> }>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream ?? null;
    const speaker = currentSettings().speakerId;
    if (!muted && speaker && el.setSinkId) void el.setSinkId(speaker).catch(() => {});
    if (!stream || muted) return;
    // Sound that may not start on its own (no click on this page yet) plays on the next click.
    const play = () => void el.play().catch((e) => {
      // Aborted: this element got another stream or left the screen; not a block worth logging.
      if (e?.name !== "AbortError") callLog(`playback blocked (${String(e)}); retrying on the next click`);
      window.addEventListener("pointerdown", play, { once: true, capture: true });
    });
    play();
    // macOS: another speaker was picked (the system output); reconnect so the sound follows.
    const reattach = () => { el.srcObject = null; el.srcObject = stream; play(); };
    window.addEventListener("trix:audio-output", reattach);
    return () => { window.removeEventListener("pointerdown", play, { capture: true }); window.removeEventListener("trix:audio-output", reattach); };
  }, [stream, muted]);
  // A speaker picked during the call applies at once.
  useEffect(() => onSettingsChanged((st) => { const el = ref.current; if (!muted && st.speakerId && el?.setSinkId) void el.setSinkId(st.speakerId).catch(() => {}); }), [muted]);
  return <video ref={ref} className={`${className ?? ""} ${mirror ? "mirror" : ""}`} autoPlay playsInline muted={muted} />;
}

/** The speaker choice during a call (headphones plugged in halfway, …). */
export function SpeakerButton() {
  const [open, setOpen] = useState(false);
  return (
    <span className="bg-anchor">
      <button className={`icon-btn ${open ? "on" : ""}`} title={t("av.speaker")} onClick={() => setOpen(!open)}><GearIcon /></button>
      {open && <div className="menu speaker-menu" onMouseLeave={() => setOpen(false)}><b>{t("av.speaker")}</b><SpeakerPicker /></div>}
    </span>
  );
}

/** The device a microphone or camera track comes from (behind a background effect, too). */
const inUse = (track?: MediaStreamTrack) => (track && rawCamera(track).getSettings().deviceId) ?? null;

/** Microphone or camera list; a device picked is saved, so the next call starts with it. */
function DeviceSelect({ kind, devices, value, onPick }: {
  kind: "audioinput" | "videoinput"; devices: MediaDeviceInfo[]; value: string | null; onPick: (id: string | null) => void;
}) {
  return (
    <select value={value ?? ""} onChange={(e) => {
      const id = e.target.value || null;
      const label = devices.find((d) => d.deviceId === id)?.label ?? "";
      updateSettings({ [kind === "audioinput" ? "micId" : "cameraId"]: id, deviceLabels: { ...currentSettings().deviceLabels, [kind]: label } });
      callLog(`${kind === "audioinput" ? "microphone" : "camera"} saved for next time: ${label || "system default"}`);
      onPick(id);
    }}>
      <option value="">{t("av.systemDefault")}</option>
      {devices.filter((d) => d.kind === kind && d.deviceId !== "default").map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || t("av.unnamed", { n: i + 1 })}</option>)}
    </select>
  );
}

/** In a Talk call: microphone, speaker and camera, switched without leaving. */
function DeviceButton({ calls }: { calls: TalkCalls }) {
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => { if (open) void navigator.mediaDevices.enumerateDevices().then(setDevices); }, [open]);
  const mic = calls.call?.local?.getAudioTracks()[0];
  const camera = calls.call?.local?.getVideoTracks()[0];
  return (
    <span className="bg-anchor">
      <button className={`icon-btn ${open ? "on" : ""}`} title={t("talkcall.devices")} onClick={() => setOpen(!open)}><GearIcon /></button>
      {open && (
        <div className="menu speaker-menu" onMouseLeave={() => setOpen(false)}>
          {mic && <><b>{t("av.microphone")}</b><DeviceSelect kind="audioinput" devices={devices} value={inUse(mic)} onPick={(id) => calls.switchDevice("audioinput", id)} /></>}
          <b>{t("av.speaker")}</b><SpeakerPicker />
          {camera && <><b>{t("av.camera")}</b><DeviceSelect kind="videoinput" devices={devices} value={inUse(camera)} onPick={(id) => calls.switchDevice("videoinput", id)} /></>}
        </div>
      )}
    </span>
  );
}

/** One person: their camera, or picture and name; a ring while they speak. */
function Tile({ account, name, stream, videoOn, audioOn, speaking, self, small, pinned, onPin, onHide, hand }: {
  account: string; name: string; stream?: MediaStream; videoOn: boolean; audioOn: boolean; speaking: boolean; self?: boolean; small?: boolean;
  /** Your own tile: hide it (only for you). */
  onHide?: () => void;
  pinned?: boolean; onPin?: () => void; hand?: boolean;
}) {
  const hasVideo = videoOn && !!stream?.getVideoTracks().some((tr) => tr.readyState === "live" && tr.enabled !== false);
  // Keyed by the camera track: a background effect swaps it within the same stream.
  const videoKey = stream?.getVideoTracks()[0]?.id;
  return (
    <div className={`talk-tile ${speaking ? "speaking" : ""} ${small ? "small" : ""} ${pinned ? "pinned" : ""}`} onDoubleClick={onPin}>
      {onPin && <button className="talk-pin" title={pinned ? t("talkcall.unpin") : t("talkcall.pin")} onClick={onPin}><PinIcon size={16} /></button>}
      {onHide && <button className="talk-pin" title={t("talkcall.hideSelf")} onClick={onHide}>✕</button>}
      {hasVideo ? <Video key={videoKey} stream={stream} muted={self} mirror={self} className="talk-tile-video" /> : (
        <div className="talk-tile-avatar">
          <Avatar account={account} name={name} className="big" />
          {/* Sound still has to play without a picture. */}
          {!self && stream && <Video stream={stream} className="hidden-audio" />}
        </div>
      )}
      {hand && <span className="talk-hand" title={t("talkcall.handRaised")}>✋</span>}
      <span className="talk-tile-name">{!audioOn && <MicOffIcon size={14} />}{self ? t("talkcall.you") : name}</span>
    </div>
  );
}

type Layout = "auto" | "gallery" | "large" | "speaker";
const LAYOUT = "trix.callLayout";
/** How a shared screen is shown: faces beside it, above it, or hidden (sound keeps playing). */
type ShareView = "side" | "top" | "content";
const SHARE_VIEW = "trix.callShareView";
/** Your own video hidden from your screen (the others still see it). */
const HIDE_SELF = "trix.callHideSelf";
/** How long someone talks before taking the stage, and how long whoever has it keeps it (ms). */
const TAKE_STAGE = 1500;
const KEEP_STAGE = 3000;
/** Tiles per page: Teams' gallery and large gallery. */
const PER_PAGE = { gallery: 9, large: 49 };

const remembered = <T extends string>(key: string, fallback: T): T => { try { return (localStorage.getItem(key) as T) || fallback; } catch { return fallback; } };
const remember = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* not remembered */ } };

/** Background choice in a small panel above the controls. */
export function BackgroundButton({ onPick, disabled }: { onPick: (effect: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="bg-anchor">
      <button className={`call-btn ${open ? "on" : ""}`} title={t("bg.title")} disabled={disabled} onClick={() => setOpen(!open)}><SparkleIcon /></button>
      {open && (
        <div className="bg-popover" onMouseLeave={() => setOpen(false)}>
          <b>{t("bg.title")}</b>
          <BackgroundPicker onPick={onPick} />
        </div>
      )}
    </span>
  );
}

/**
 * Talk group call, Teams-like. Gallery: everyone in a grid, 9 to a page (large gallery: 49).
 * Speaker: one person large (who's talking, or who you pinned) with the others in a strip.
 * Auto: speaker for 1:1, gallery for groups. A shared screen fills the stage with a strip of
 * faces beside or above it, or on its own.
 */
export function TalkCallScreen({ calls, conversation, docked, onPopOut, onPopIn }: {
  calls: TalkCalls; conversation?: Conversation;
  /** In the app (minimising makes it the card in the corner) or in a window of its own. */
  docked: boolean;
  /** In the app: move the call into its own window. */
  onPopOut?: () => void;
  /** In its own window: move the call back into the app. */
  onPopIn?: () => void;
}) {
  const call = calls.call;
  const [now, setNow] = useState(Date.now());
  const [layout, setLayoutState] = useState<Layout>(() => remembered(LAYOUT, "auto"));
  const [shareView, setShareViewState] = useState<ShareView>(() => remembered(SHARE_VIEW, "side"));
  const [hideSelf, setHideSelfState] = useState(() => remembered<string>(HIDE_SELF, "") === "1");
  const setHideSelf = (hide: boolean) => { setHideSelfState(hide); setLayoutMenu(false); remember(HIDE_SELF, hide ? "1" : ""); };
  const [layoutMenu, setLayoutMenu] = useState(false);
  const [page, setPage] = useState(0);
  const [pinned, setPinned] = useState<string | null>(null);
  // Who's on stage, and since when; and since when each person has been talking (see below).
  const stageOwner = useRef<{ sid: string; since: number } | null>(null);
  const talkingSince = useRef(new Map<string, number>());
  const setLayout = (l: Layout) => { setLayoutState(l); setLayoutMenu(false); setPage(0); remember(LAYOUT, l); };
  const setShareView = (v: ShareView) => { setShareViewState(v); setLayoutMenu(false); remember(SHARE_VIEW, v); };
  useEffect(() => {
    if (call?.phase !== "connected") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [call?.phase]);
  useEffect(() => {
    if (call?.phase !== "ended") return;
    const timer = window.setTimeout(calls.dismiss, 2000);
    return () => window.clearTimeout(timer);
  }, [call?.phase]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!call) return null;
  if (call.phase === "prejoin") return <PreJoin calls={calls} name={conversation?.name ?? ""} onPopOut={onPopOut} />;

  const name = conversation?.name ?? "";
  const status = call.phase === "joining" ? t("talkcall.joining") : call.phase === "ended" ? t("talkcall.ended") : formatDuration(now - (call.connectedAt ?? now));
  const sharer = call.peers.find((p) => p.screen);
  // The stage moves calmly in banter: someone takes it after talking for a moment (TAKE_STAGE),
  // and whoever has it keeps it a while (KEEP_STAGE) unless they've stopped talking. Short sounds
  // ("mm", a laugh) don't move it at all. Checked on every update (at least once a second).
  const clock = Date.now();
  for (const p of call.peers) {
    if (!p.speaking) talkingSince.current.delete(p.sid);
    else if (!talkingSince.current.has(p.sid)) talkingSince.current.set(p.sid, clock);
  }
  if (stageOwner.current && !call.peers.some((p) => p.sid === stageOwner.current!.sid)) stageOwner.current = null;
  const challenger = [...talkingSince.current].filter(([sid]) => sid !== stageOwner.current?.sid).sort((a, b) => a[1] - b[1])[0];
  if (challenger) {
    const onStageTalking = call.peers.some((p) => p.sid === stageOwner.current?.sid && p.speaking);
    const settled = !stageOwner.current || clock - stageOwner.current.since >= KEEP_STAGE || !onStageTalking;
    if (!stageOwner.current || (clock - challenger[1] >= TAKE_STAGE && settled)) stageOwner.current = { sid: challenger[0], since: clock };
  }
  const pinnedPeer = call.peers.find((p) => p.sid === pinned);
  const self = { name: "", stream: call.local, videoOn: call.cameraOn, audioOn: !call.muted, speaking: call.speakingSelf };
  const pin = (sid: string) => setPinned(pinned === sid ? null : sid);
  const tile = (p: TalkPeerView, small?: boolean) => (
    <Tile key={p.sid} account={call.account} name={p.name} stream={p.stream} videoOn={p.videoOn} audioOn={p.audioOn} speaking={p.speaking} small={small}
      pinned={pinned === p.sid} onPin={() => pin(p.sid)} hand={!!p.handRaised} />
  );
  const selfTile = (small?: boolean) => <Tile key="self" account={call.account} self small={small} hand={call.handRaised} onHide={() => setHideSelf(true)} {...self} />;
  // Hidden only from your own screen; while minimised you still see yourself when no one else is on.
  const selfShown = !hideSelf;
  // People who aren't on screen (another page, content only, minimised) must still be heard.
  const sound = (peers: TalkPeerView[]) => peers.map((p) => p.stream && <Video key={`sound-${p.sid}`} stream={p.stream} className="hidden-audio" />);
  const effective = layout === "auto" ? (call.peers.length <= 1 || pinnedPeer ? "speaker" : "gallery") : layout;
  const onStage = pinnedPeer ?? call.peers.find((p) => p.sid === stageOwner.current?.sid) ?? call.peers[0];
  const perPage = effective === "large" ? PER_PAGE.large : PER_PAGE.gallery;
  const pages = Math.max(1, Math.ceil(call.peers.length / perPage));
  const shownPage = Math.min(page, pages - 1);
  const paged = !sharer && effective !== "speaker" && pages > 1;

  const controls = (
    <div className="call-controls">
      <button className={`call-btn ${call.muted ? "off" : ""}`} title={call.muted ? t("mxcall.unmute") : t("mxcall.mute")} onClick={() => calls.setMuted(!call.muted)}>{call.muted ? <MicOffIcon /> : <MicIcon />}</button>
      <button className={`call-btn ${call.cameraOn ? "" : "off"}`} title={call.cameraOn ? t("mxcall.cameraOff") : t("mxcall.cameraOn")} disabled={!call.local?.getVideoTracks().length} onClick={() => calls.setCamera(!call.cameraOn)}>{call.cameraOn ? <CameraIcon /> : <CameraOffIcon />}</button>
      {!call.minimized && <BackgroundButton onPick={calls.setBackground} disabled={!call.local?.getVideoTracks().length} />}
      <button className={`call-btn ${call.sharing ? "on" : ""}`} title={call.sharing ? t("mxcall.stopShare") : t("mxcall.share")} disabled={call.phase !== "connected"} onClick={() => calls.setSharing(!call.sharing)}><ShareScreenIcon /></button>
      <button className={`call-btn ${call.handRaised ? "on" : ""}`} title={call.handRaised ? t("talkcall.lowerHand") : t("talkcall.raiseHand")} disabled={call.phase !== "connected"} onClick={() => calls.setHand(!call.handRaised)}><HandIcon /></button>
      {!call.minimized && <ReactButton onReact={calls.react} disabled={call.phase !== "connected"} />}
      <button className="call-btn decline" title={t("talkcall.leave")} disabled={call.phase === "ended"} onClick={calls.leave}><CallIcon /></button>
    </div>
  );

  if (call.minimized && docked) {
    const speaker = onStage;
    return (
      <div className="call-mini">
        {speaker ? tile(speaker) : selfTile()}
        {sound(call.peers.filter((p) => p !== speaker))}
        <div className="call-mini-text"><b>{name}</b><span>{status} · {t("talkcall.people", { count: call.peers.length + 1 })}</span></div>
        {controls}
        <button className="icon-btn" title={t("mxcall.expand")} onClick={() => calls.setMinimized(false)}><ExpandIcon /></button>
      </div>
    );
  }

  const stage = (() => {
    if (sharer) {
      return (
        <div className={`talk-stage-share ${shareView}`}>
          {shareView === "content" ? sound(call.peers) : (
            <div className={`talk-strip ${shareView === "top" ? "row" : ""}`}>
              {call.peers.map((p) => tile(p, true))}
              {selfShown && selfTile(true)}
            </div>
          )}
          <Video stream={sharer.screen} className="talk-screen" />
        </div>
      );
    }
    if (effective === "speaker" && onStage) {
      const others = call.peers.filter((p) => p !== onStage);
      return (
        <div className="talk-speaker">
          <div className="talk-speaker-main">
            {tile(onStage)}
            {/* You, small in the corner. */}
            {selfShown && selfTile(true)}
          </div>
          {others.length > 0 && <div className="talk-strip row">{others.map((p) => tile(p, true))}</div>}
        </div>
      );
    }
    // Gallery: you get an equal tile once there's more than one other person and room for you.
    const visible = call.peers.slice(shownPage * perPage, (shownPage + 1) * perPage);
    const selfInGrid = selfShown && call.peers.length !== 1 && pages === 1 && visible.length < perPage;
    const count = Math.max(visible.length + (selfInGrid ? 1 : 0), 1);
    const columns = count <= 2 ? 1 : Math.ceil(Math.sqrt(count));
    return (
      <div className={`talk-grid ${columns > 3 ? "dense" : ""}`} style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
        {call.peers.length === 0 && call.phase === "connected" && <p className="talk-alone">{t("talkcall.alone")}</p>}
        {visible.map((p) => tile(p))}
        {(selfShown || call.peers.length === 0) && selfTile(!selfInGrid)}
        {sound(call.peers.filter((p) => !visible.includes(p)))}
      </div>
    );
  })();

  return (
    <div className="call-screen talk own-window">
      <header className="call-head">
        <b>{name}</b>
        <span className="muted">{status} · {t("talkcall.people", { count: call.peers.length + 1 })}</span>
        {call.sharing && <button className="sharing-pill" onClick={() => void calls.setSharing(false)}><ShareScreenIcon /> {t("share.youreSharing")} · <b>{t("mxcall.stopShare")}</b></button>}
        {call.recording && <span className="talk-recording" role="status">● {call.recording === "on" ? t("talkcall.recording") : t("talkcall.recordingStarting")}</span>}
        <span className="spacer" />
        {paged && (
          <span className="talk-pager">
            <button className="icon-btn" title={t("talkcall.prevPage")} disabled={shownPage === 0} onClick={() => setPage(shownPage - 1)}>‹</button>
            {t("talkcall.page", { page: shownPage + 1, pages })}
            <button className="icon-btn" title={t("talkcall.nextPage")} disabled={shownPage === pages - 1} onClick={() => setPage(shownPage + 1)}>›</button>
          </span>
        )}
        <DeviceButton calls={calls} />
        <span className="bg-anchor">
          <button className="icon-btn" title={t("talkcall.layout")} onClick={() => setLayoutMenu(!layoutMenu)}><LayoutIcon /></button>
          {layoutMenu && (
            <div className="menu layout-menu" onMouseLeave={() => setLayoutMenu(false)}>
              {(["auto", "gallery", "large", "speaker"] as Layout[]).map((l) => (
                <button key={l} className="menu-item" onClick={() => setLayout(l)}>{layout === l ? "✓ " : ""}{t(`talkcall.layout.${l}`)}</button>
              ))}
              <div className="menu-sep" />
              <div className="menu-label">{t("talkcall.shareView")}</div>
              {(["side", "top", "content"] as ShareView[]).map((v) => (
                <button key={v} className="menu-item" onClick={() => setShareView(v)}>{shareView === v ? "✓ " : ""}{t(`talkcall.shareView.${v}`)}</button>
              ))}
              {pinned && <button className="menu-item" onClick={() => { setPinned(null); setLayoutMenu(false); }}>{t("talkcall.unpin")}</button>}
              <div className="menu-sep" />
              <button className="menu-item" onClick={() => setHideSelf(!hideSelf)}>{hideSelf ? t("talkcall.showSelf") : t("talkcall.hideSelf")}</button>
            </div>
          )}
        </span>
        {onPopOut && <button className="icon-btn" title={t("call.ownWindow")} onClick={onPopOut}><NewWindowIcon /></button>}
        {onPopIn && <button className="btn small" title={t("call.backToAppHint")} onClick={onPopIn}>{t("call.backToApp")}</button>}
        {docked && <button className="icon-btn" title={t("mxcall.minimize")} onClick={() => calls.setMinimized(true)}>⤡</button>}
      </header>
      {stage}
      <div className="talk-reactions" aria-live="polite">
        {call.reactions.map((r, i) => (
          <span key={r.id} className="talk-reaction" style={{ left: `${8 + ((r.id * 37) % 60)}%`, animationDelay: `${(i % 3) * 0.05}s` }}>
            {r.emoji}{r.name && <small>{r.name}</small>}
          </span>
        ))}
      </div>
      {controls}
    </div>
  );
}

const REACTIONS = ["👍", "❤️", "😂", "👏", "😮", "🎉"];

function ReactButton({ onReact, disabled }: { onReact: (emoji: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="bg-anchor">
      <button className={`call-btn ${open ? "on" : ""}`} title={t("talkcall.react")} disabled={disabled} onClick={() => setOpen(!open)}><EmojiIcon /></button>
      {open && (
        <div className="react-popover" onMouseLeave={() => setOpen(false)}>
          {REACTIONS.map((e) => <button key={e} onClick={() => { onReact(e); setOpen(false); }}>{e}</button>)}
        </div>
      )}
    </span>
  );
}

/** Before joining: see yourself, hear your mic level, pick devices, choose mic/camera on or off. */
function PreJoin({ calls, name, onPopOut }: { calls: TalkCalls; name: string; onPopOut?: () => void }) {
  const call = calls.call!;
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [micId, setMicId] = useState<string | null>(null);
  const [cameraId, setCameraId] = useState<string | null>(null);
  useEffect(() => { void navigator.mediaDevices.enumerateDevices().then(setDevices); }, [call.local]);
  const hasCamera = !!call.local?.getVideoTracks().length;
  return (
    <div className="call-screen talk prejoin">
      <header className="call-head"><b>{name}</b><span className="muted">{t("talkcall.prejoin")}</span><span className="spacer" />
        {onPopOut && <button className="icon-btn" title={t("call.ownWindow")} onClick={onPopOut}><NewWindowIcon /></button>}</header>
      <div className="prejoin-body">
        <div className={`prejoin-preview ${call.speakingSelf && !call.muted ? "speaking" : ""}`}>
          {call.starting ? (
            // The first time (after a restart or sleep) the camera can take a few seconds.
            <span className="prejoin-starting"><i className="spinner" />{t(call.starting === "video" ? "talkcall.startingCamera" : "talkcall.startingMic")}</span>
          ) : hasCamera && call.cameraOn ? <Video key={call.local?.getVideoTracks()[0]?.id} stream={call.local} muted mirror className="talk-tile-video" /> : <span className="muted">{t("talkcall.cameraOff")}</span>}
        </div>
        <div className="prejoin-side">
          {/* The device in use (saved in Settings, or the system's) until another is picked. */}
          <label>{t("av.microphone")}<DeviceSelect kind="audioinput" devices={devices} value={micId ?? inUse(call.local?.getAudioTracks()[0])} onPick={(id) => { setMicId(id); calls.reprepare(hasCamera, id, cameraId); }} /></label>
          <label>{t("av.speaker")}<SpeakerPicker /></label>
          <label>{t("av.camera")}<DeviceSelect kind="videoinput" devices={devices} value={cameraId ?? inUse(call.local?.getVideoTracks()[0])} onPick={(id) => { setCameraId(id); calls.reprepare(true, micId, id); }} /></label>
          <div className="call-controls">
            <button className={`call-btn ${call.muted ? "off" : ""}`} title={call.muted ? t("mxcall.unmute") : t("mxcall.mute")} onClick={() => calls.setMuted(!call.muted)}>{call.muted ? <MicOffIcon /> : <MicIcon />}</button>
            <button className={`call-btn ${call.cameraOn ? "" : "off"}`} title={call.cameraOn ? t("mxcall.cameraOff") : t("mxcall.cameraOn")}
              onClick={() => (hasCamera ? calls.setCamera(!call.cameraOn) : calls.reprepare(true, micId, cameraId))}>{hasCamera && call.cameraOn ? <CameraIcon /> : <CameraOffIcon />}</button>
          </div>
          {hasCamera && (
            <div className="prejoin-bg">
              <span>{t("bg.title")}</span>
              <BackgroundPicker onPick={calls.setBackground} />
            </div>
          )}
          <div className="prejoin-actions">
            <button className="btn" onClick={calls.cancel}>{t("common.cancel")}</button>
            <button className="btn primary" onClick={calls.join}>{t("talkcall.joinNow")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}


/**
 * Someone started a Talk call: a ringing pop-up (in group chats too; muted conversations stay
 * quiet), and the Dock icon bounces. Talk has no "decline"; dismissing just stops the ringing here.
 */
export function TalkRing({ convs, talkOrgs, busy, onJoin }: { convs: Conversation[]; talkOrgs: Set<string>; busy: string | null; onJoin: (key: string) => void }) {
  const known = useRef<Map<string, boolean> | null>(null);
  const [ringing, setRinging] = useState<string | null>(null);
  useEffect(() => {
    const now = new Map(convs.filter((c) => talkOrgs.has(c.orgId)).map((c) => [c.id, !!c.callActive]));
    const before = known.current;
    // The first list (calls already going at start-up) doesn't ring.
    known.current = now.size ? now : before;
    if (!before) return;
    // A call started silently doesn't ring, unless silent calls should ring too (Settings).
    const started = convs.find((c) => now.get(c.id) && before.get(c.id) === false && c.id !== busy && !c.muted && (!c.callSilent || currentSettings().notify.silentCalls));
    if (started && currentSettings().notify.calls) {
      setRinging(started.id);
      if (!dndActive()) void backend.requestAttention().catch(() => {});
    }
    if (ringing && !now.get(ringing)) setRinging(null);
  }, [convs]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!ringing) return;
    const timer = window.setTimeout(() => setRinging(null), 45_000);
    return () => window.clearTimeout(timer);
  }, [ringing]);
  useEffect(() => { if (busy && busy === ringing) setRinging(null); }, [busy, ringing]);
  const conv = convs.find((c) => c.id === ringing);
  useRingtone(!!conv, true);
  if (!conv) return null;
  return (
    <div className="call-ring" role="alertdialog" aria-label={t("talkcall.incoming", { name: conv.name })}>
      <Avatar account={conv.orgId} media={conv.avatar} name={conv.name} className="big" />
      <div className="call-ring-text">
        <b>{conv.name}</b>
        <span>{conv.kind === "direct" ? t("talkcall.incomingDirect") : t("talkcall.incomingGroup")}</span>
      </div>
      <button className="call-btn decline" title={t("talkcall.dismiss")} onClick={() => setRinging(null)}><CallIcon /></button>
      <button className="call-btn accept" title={t("talkcall.joinNow")} onClick={() => { setRinging(null); onJoin(conv.id); }}><CallIcon /></button>
    </div>
  );
}
