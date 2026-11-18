import { useEffect, useRef, useState } from "react";
import { backend } from "./backend";
import { t } from "./i18n";

const VIEW = 280; // crop viewport, px
const OUT = 512; // uploaded picture, px

interface Props {
  title: string;
  /** Receives the cropped square as base64 PNG (no data: prefix). */
  onCrop: (png: string) => Promise<unknown>;
  onClose: () => void;
}

/** Picks a picture, then lets the user drag and zoom it into a square. */
export function ImageCropper({ title, onCrop, onClose }: Props) {
  const [src, setSrc] = useState<string | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  useEffect(() => {
    backend.pickImageFile().then((url) => (url ? setSrc(url) : onClose())).catch((e) => setError(String(e)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Cover the viewport at zoom 1; zoom scales from there.
  const scale = img ? (VIEW / Math.min(img.naturalWidth, img.naturalHeight)) * zoom : 1;
  const w = img ? img.naturalWidth * scale : VIEW;
  const h = img ? img.naturalHeight * scale : VIEW;
  const clamp = (p: { x: number; y: number }, cw = w, ch = h) => ({
    x: Math.min(0, Math.max(VIEW - cw, p.x)),
    y: Math.min(0, Math.max(VIEW - ch, p.y)),
  });

  const loaded = (el: HTMLImageElement) => {
    const s = VIEW / Math.min(el.naturalWidth, el.naturalHeight);
    setImg(el);
    setZoom(1);
    setPos({ x: (VIEW - el.naturalWidth * s) / 2, y: (VIEW - el.naturalHeight * s) / 2 });
  };

  // Zoom around the viewport centre so the subject stays put.
  const setZoomKeep = (z: number) => {
    if (!img) return;
    const next = Math.min(4, Math.max(1, z));
    const nextScale = (VIEW / Math.min(img.naturalWidth, img.naturalHeight)) * next;
    const cx = (VIEW / 2 - pos.x) / scale;
    const cy = (VIEW / 2 - pos.y) / scale;
    setZoom(next);
    setPos(clamp({ x: VIEW / 2 - cx * nextScale, y: VIEW / 2 - cy * nextScale }, img.naturalWidth * nextScale, img.naturalHeight * nextScale));
  };

  const save = async () => {
    if (!img) return;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = OUT;
    const side = VIEW / scale;
    canvas.getContext("2d")!.drawImage(img, -pos.x / scale, -pos.y / scale, side, side, 0, 0, OUT, OUT);
    setBusy(true);
    try {
      await onCrop(canvas.toDataURL("image/png").split(",")[1]);
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  if (!src && !error) return null; // the file picker is open
  return (
    <div className="login-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="login-card cropper">
        <button className="icon-btn close" onClick={onClose} title={t("common.closeEsc")}>✕</button>
        <h1>{title}</h1>
        {src && (
          <>
            <div
              className="crop-view"
              style={{ width: VIEW, height: VIEW }}
              onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y }; }}
              onPointerMove={(e) => { const d = drag.current; if (d) setPos(clamp({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y })); }}
              onPointerUp={() => (drag.current = null)}
              onWheel={(e) => setZoomKeep(zoom - e.deltaY / 400)}
            >
              <img src={src} alt="" draggable={false} onLoad={(e) => loaded(e.currentTarget)} style={{ width: w, height: h, transform: `translate(${pos.x}px, ${pos.y}px)` }} />
              <div className="crop-mask" />
            </div>
            <label className="crop-zoom">
              <span>{t("cropper.zoom")}</span>
              <input type="range" min={1} max={4} step={0.01} value={zoom} onChange={(e) => setZoomKeep(Number(e.target.value))} />
            </label>
            <p className="hint">{t("cropper.hint")}</p>
          </>
        )}
        {error && <p className="error">{error}</p>}
        <div className="edit-actions">
          <span className="muted" />
          <button className="btn small" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn primary small" disabled={!img || busy} onClick={save}>{busy ? t("common.loading") : t("common.save")}</button>
        </div>
      </div>
    </div>
  );
}
