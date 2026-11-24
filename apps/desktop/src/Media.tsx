import { useEffect, useRef, useState } from "react";
import { ContextMenu } from "./ContextMenu";
import { showInFiles } from "./filesNav";
import { formatDuration } from "./voice";
import { backend, isLive, mediaUrl } from "./backend";
import type { Message } from "./types";
import { t } from "./i18n";
import { useEscape } from "./hooks";

type Media = NonNullable<Message["media"]>;

export interface MediaActions {
  view: (media: Media) => void;
  menu: (media: Media, x: number, y: number) => void;
}

/** The most a picture takes in a bubble. */
const MAX_W = 360, MAX_H = 320;

/** Pictures that failed to load (deleted, gone from the server), by address, and when; the app
 *  answers them as missing for ten minutes too, so they aren't fetched on every redraw. */
const missing = new Map<string, number>();
const isMissing = (src: string) => Date.now() - (missing.get(src) ?? 0) < 600_000;

/** Image, sticker or file chip inside a message bubble; `cell`: one picture in a gallery. */
export function MediaBody({ media, account, actions, cell }: { media: Media; account: string; actions: MediaActions; cell?: boolean }) {
  const src = mediaUrl(account, media.id);
  // Once loaded, its own width (scaled to fit): the bubble then wraps the picture, instead of
  // stretching to the full size of, say, a wide screenshot.
  const [width, setWidth] = useState<number | null>(null);
  const [failed, setFailed] = useState(() => !!src && isMissing(src));
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    actions.menu(media, e.clientX, e.clientY);
  };
  if ((media.kind === "image" || media.kind === "sticker") && src && failed) {
    return (
      <span className="msg-missing" title={media.name} onContextMenu={onContextMenu}>
        <MissingPictureIcon />
        {t("media.missing")}
      </span>
    );
  }
  if ((media.kind === "image" || media.kind === "sticker") && src) {
    return (
      <img className={media.kind === "sticker" ? "msg-sticker" : "msg-image"} src={src} alt={media.name} loading="lazy"
        style={!cell && width ? { width } : undefined}
        onLoad={(e) => {
          const img = e.currentTarget;
          if (!cell && media.kind === "image" && img.naturalWidth) setWidth(Math.round(img.naturalWidth * Math.min(1, MAX_W / img.naturalWidth, MAX_H / img.naturalHeight)));
        }}
        onError={() => { missing.set(src, Date.now()); setFailed(true); }}
        onClick={() => actions.view(media)} onContextMenu={onContextMenu} />
    );
  }
  if (media.kind === "video" && src) {
    return <video className="msg-video" src={`${mediaUrl(account, media.id, undefined, media.mime)}#t=0.1`} controls preload="metadata" onContextMenu={onContextMenu} />;
  }
  if (media.kind === "audio" && src && media.voice) {
    return <VoicePlayer src={mediaUrl(account, media.id, undefined, media.mime)!} voice={media.voice} onContextMenu={onContextMenu} />;
  }
  if (media.kind === "audio" && src) {
    return (
      <span className="msg-audio" onContextMenu={onContextMenu}>
        <span className="audio-name">🎵 {media.name}</span>
        <audio src={mediaUrl(account, media.id, undefined, media.mime)} controls preload="metadata" />
      </span>
    );
  }
  return (
    <button className="file-chip" title={t("media.open")} onClick={() => isLive && backend.openMedia(account, media.id, media.name)} onContextMenu={onContextMenu}>
      📎 {media.name}
    </button>
  );
}

export function Lightbox({ media, account, onClose, onNotice }: { media: Media; account: string; onClose: () => void; onNotice: (m: string) => void }) {
  useEscape(onClose);

  return (
    <div className="lightbox" onClick={onClose}>
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span className="lightbox-name">{media.name}</span>
        <button className="btn small" onClick={() => save(account, media, onNotice)}>{t("media.saveAs")}</button>
        <button className="btn small" onClick={() => backend.openMedia(account, media.id, media.name).catch((e) => onNotice(String(e)))}>{t("media.openInApp")}</button>
        <button className="icon-btn" title={t("common.closeEsc")} onClick={onClose}>✕</button>
      </div>
      <img src={mediaUrl(account, media.id)} alt={media.name} onClick={(e) => e.stopPropagation()} />
    </div>
  );
}

export function MediaMenu({ media, account, x, y, onView, onClose, onNotice }: {
  media: Media; account: string; x: number; y: number; onView: () => void; onClose: () => void; onNotice: (m: string) => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [onClose]);

  const isImage = media.kind === "image" || media.kind === "sticker";
  const place = cloudPath(media.id);
  return (
    <ContextMenu x={x} y={y}>
      {isImage && <button className="menu-item" onClick={() => { onView(); onClose(); }}>{t("media.view")}</button>}
      <button className="menu-item" onClick={() => { save(account, media, onNotice); onClose(); }}>{t("media.saveAs")}</button>
      <button className="menu-item" onClick={() => { backend.openMedia(account, media.id, media.name).catch((e) => onNotice(String(e))); onClose(); }}>{t("media.openDefault")}</button>
      {place && <button className="menu-item" onClick={() => { showInFiles(account, place); onClose(); }}>{t("files.showInFiles")}</button>}
    </ContextMenu>
  );
}

/** A Talk file message's place in your own files ("file:<id>:<path>"), for Show in Files. */
function cloudPath(id: string): string | null {
  const rest = id.startsWith("file:") ? id.slice(5) : null;
  const path = rest?.slice(rest.indexOf(":") + 1).replace(/^\/+/, "");
  return isLive && rest?.includes(":") && path ? `/${path}` : null;
}

function save(account: string, media: Media, onNotice: (m: string) => void) {
  if (!isLive) return onNotice(t("desktopOnly.saveFiles"));
  backend.saveMedia(account, media.id, media.name).catch((e) => onNotice(String(e)));
}

/** Which media is in the lightbox / context menu, shared by main chat and thread panel. */
export function useMediaUi() {
  const [viewing, setViewing] = useState<Media | null>(null);
  const [menu, setMenu] = useState<{ media: Media; x: number; y: number } | null>(null);
  const actions: MediaActions = { view: setViewing, menu: (media, x, y) => setMenu({ media, x, y }) };
  return { viewing, setViewing, menu, setMenu, actions };
}

/** Voice message: play/pause, waveform bars that fill as it plays (click to jump), time. */
function VoicePlayer({ src, voice, onContextMenu }: { src: string; voice: { durationMs: number; waveform: number[] }; onContextMenu: (e: React.MouseEvent) => void }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const duration = voice.durationMs / 1000 || audio.current?.duration || 0;
  // Older clients send no waveform; draw a flat line of bars then.
  const bars = voice.waveform.length ? resample(voice.waveform, 48) : Array.from({ length: 48 }, () => 0.3);
  const progress = duration ? at / duration : 0;
  const toggle = () => {
    const el = audio.current;
    if (!el) return;
    if (el.paused) void el.play(); else el.pause();
  };
  const seek = (e: React.MouseEvent<HTMLSpanElement>) => {
    const el = audio.current;
    if (!el || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    el.currentTime = ((e.clientX - rect.left) / rect.width) * duration;
    setAt(el.currentTime);
  };
  return (
    <span className="voice-player" onContextMenu={onContextMenu}>
      <button className="voice-play" title={playing ? t("voice.pause") : t("voice.play")} onClick={toggle}>{playing ? "❚❚" : "▶"}</button>
      <span className="voice-bars" onClick={seek} role="slider" aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(at)}>
        {bars.map((v, i) => <span key={i} className={i / bars.length < progress ? "played" : ""} style={{ height: `${Math.max(12, v * 100)}%` }} />)}
      </span>
      <span className="voice-time">{formatDuration((playing || at ? at : duration) * 1000)}</span>
      <audio ref={audio} src={src} preload="metadata" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setAt(0); }} onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)} />
    </span>
  );
}

function resample(values: number[], n: number): number[] {
  return Array.from({ length: n }, (_, i) => {
    const from = Math.floor((i / n) * values.length);
    const to = Math.max(from + 1, Math.floor(((i + 1) / n) * values.length));
    const slice = values.slice(from, to);
    return slice.reduce((a, b) => Math.max(a, b), 0);
  });
}

/** A picture frame with a slash through it. */
function MissingPictureIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="M21 16l-5-5-8 8" />
      <path d="M3 3l18 18" />
    </svg>
  );
}
