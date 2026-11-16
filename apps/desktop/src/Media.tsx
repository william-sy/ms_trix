import { useEffect, useState } from "react";
import { backend, isLive, mediaUrl } from "./backend";
import type { Message } from "./types";
import { t } from "./i18n";

type Media = NonNullable<Message["media"]>;

export interface MediaActions {
  view: (media: Media) => void;
  menu: (media: Media, x: number, y: number) => void;
}

/** Image, sticker or file chip inside a message bubble. */
export function MediaBody({ media, account, actions }: { media: Media; account: string; actions: MediaActions }) {
  const src = mediaUrl(account, media.id);
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    actions.menu(media, e.clientX, e.clientY);
  };
  if ((media.kind === "image" || media.kind === "sticker") && src) {
    return (
      <img className={media.kind === "sticker" ? "msg-sticker" : "msg-image"} src={src} alt={media.name} loading="lazy"
        onClick={() => actions.view(media)} onContextMenu={onContextMenu} />
    );
  }
  if (media.kind === "video" && src) {
    return <video className="msg-video" src={mediaUrl(account, media.id, undefined, media.mime)} controls preload="metadata" onContextMenu={onContextMenu} />;
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
  return (
    <div className="menu context" style={{ left: x, top: y }} onClick={(e) => e.stopPropagation()}>
      {isImage && <button className="menu-item" onClick={() => { onView(); onClose(); }}>{t("media.view")}</button>}
      <button className="menu-item" onClick={() => { save(account, media, onNotice); onClose(); }}>{t("media.saveAs")}</button>
      <button className="menu-item" onClick={() => { backend.openMedia(account, media.id, media.name).catch((e) => onNotice(String(e))); onClose(); }}>{t("media.openDefault")}</button>
    </div>
  );
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
