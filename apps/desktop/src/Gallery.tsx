import { useEffect, useState } from "react";
import { backend, mediaUrl, pickedUrl } from "./backend";
import { t } from "./i18n";
import type { CloudFile } from "./types";
import { useEscape } from "./hooks";

// Pictures and videos from Nextcloud Files in the app's own viewer, with ‹ › (and the arrow
// keys) through the others in the list they were opened from.

export const isPicture = (f: CloudFile) => !f.dir && /^image\/(jpeg|png|gif|webp|heic|heif|bmp|tiff|avif)$/.test(f.mime ?? "");
export const isVideo = (f: CloudFile) => !f.dir && /^video\//.test(f.mime ?? "");
/** Shown in the gallery rather than opened in Nextcloud. */
export const inGallery = (f: CloudFile) => isPicture(f) || isVideo(f);

const media = (f: CloudFile) => `file:${f.fileId ?? ""}:${f.path}`;

export function Gallery({ account, files, start, onClose, onDownload, onOpenLocal, onOpenWeb }: {
  account: string;
  /** The pictures and videos of the list, in its order. */
  files: CloudFile[];
  start: number;
  onClose: () => void;
  onDownload: (f: CloudFile) => void;
  onOpenLocal: (f: CloudFile) => void;
  onOpenWeb: (f: CloudFile) => void;
}) {
  const [index, setIndex] = useState(start);
  const f = files[Math.min(index, files.length - 1)];
  useEscape(onClose);
  const step = (by: number) => setIndex((i) => Math.max(0, Math.min(files.length - 1, i + by)));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [files.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // The next and previous pictures load while this one is looked at.
  useEffect(() => {
    for (const n of [files[index + 1], files[index - 1]]) {
      if (n && isPicture(n)) new Image().src = mediaUrl(account, media(n), 2048) ?? "";
    }
  }, [index]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!f) return null;

  return (
    <div className="lightbox gallery" onClick={onClose}>
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span className="lightbox-name">{f.name}</span>
        {files.length > 1 && <span className="gallery-count">{t("gallery.count", { n: index + 1, total: files.length })}</span>}
        <button className="btn small" onClick={() => onDownload(f)}>{t("files.download")}</button>
        <button className="btn small" onClick={() => onOpenLocal(f)}>{t("files.openLocal")}</button>
        {f.fileId && <button className="btn small" onClick={() => onOpenWeb(f)}>{t("files.openWeb")}</button>}
        <button className="icon-btn" title={t("common.closeEsc")} onClick={onClose}>✕</button>
      </div>
      {index > 0 && <button className="gallery-nav prev" title={t("gallery.previous")} onClick={(e) => { e.stopPropagation(); step(-1); }}>‹</button>}
      {isPicture(f) ? <Picture key={f.path} account={account} file={f} /> : <Video key={f.path} account={account} file={f} onOpenLocal={() => onOpenLocal(f)} />}
      {index < files.length - 1 && <button className="gallery-nav next" title={t("gallery.next")} onClick={(e) => { e.stopPropagation(); step(1); }}>›</button>}
    </div>
  );
}

/** Nextcloud's large preview (quick, and HEIC or TIFF become something any system shows); the original if there's none, and for GIFs (which move). */
function Picture({ account, file }: { account: string; file: CloudFile }) {
  const [original, setOriginal] = useState(file.mime === "image/gif");
  return (
    <img src={original ? mediaUrl(account, media(file)) : mediaUrl(account, media(file), 2048)} alt={file.name}
      onClick={(e) => e.stopPropagation()} onError={() => !original && setOriginal(true)} />
  );
}

/** Downloaded once to the app's cache and played from there (the player asks for many parts). */
function Video({ account, file, onOpenLocal }: { account: string; file: CloudFile; onOpenLocal: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    backend.cloudViewFile(account, file.path).then((token) => live && setSrc(pickedUrl(token)), (e) => live && setFailed(String(e)));
    return () => { live = false; };
  }, [account, file.path]);
  if (failed) {
    return (
      <div className="gallery-message" onClick={(e) => e.stopPropagation()}>
        <p>{t("gallery.cantPlay")}</p>
        <button className="btn small" onClick={onOpenLocal}>{t("files.openLocal")}</button>
      </div>
    );
  }
  if (!src) return <div className="spinner" aria-label={t("common.loading")} />;
  return <video src={src} controls autoPlay onClick={(e) => e.stopPropagation()} onError={() => setFailed("unsupported")} />;
}
