import { useEffect, useMemo, useRef, useState } from "react";
import { MOVING_MAX_MB, PRESETS, currentEffect, customBackground, customMoving, isMovingFile, movingUrl, setCustomBackground, setCustomMoving, type CameraEffect } from "./cameraEffects";
import { t } from "./i18n";
import { MOVING, type Painter } from "./movingBackgrounds";

/** Small previews of the built-in backgrounds. */
function presetThumbs(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of PRESETS) {
    const c = document.createElement("canvas");
    c.width = 96;
    c.height = 54;
    p.paint(c.getContext("2d")!, 96, 54);
    out[p.id] = c.toDataURL();
  }
  return out;
}

/** A moving background's thumbnail, playing (a little faster than in a call, so it shows). */
function MovingThumb({ make }: { make: (w: number, h: number) => Painter }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    const paint = make(canvas.width, canvas.height);
    const start = performance.now();
    let frame = 0;
    const tick = () => {
      paint(ctx, ((performance.now() - start) / 1000) * 3 + 5);
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [make]);
  return <canvas ref={ref} width={192} height={108} />;
}

/** Camera background choice: none, blur, built-in pictures (still and moving) or your own. */
export function BackgroundPicker({ onPick, value }: { onPick: (effect: CameraEffect) => void; value?: CameraEffect }) {
  const [selected, setSelected] = useState(value ?? currentEffect());
  const [custom, setCustom] = useState(customBackground);
  const [moving, setMoving] = useState(customMoving);
  const [movingSrc, setMovingSrc] = useState<string | null>(null);
  useEffect(() => void movingUrl().then(setMovingSrc), [moving?.at]);
  const [error, setError] = useState<string | null>(null);
  const thumbs = useMemo(presetThumbs, []);
  const file = useRef<HTMLInputElement>(null);
  const pick = (effect: CameraEffect) => { setSelected(effect); onPick(effect); };
  const tile = (effect: CameraEffect, label: string, content: React.ReactNode) => (
    <button type="button" key={effect} className={`bg-tile ${selected === effect ? "on" : ""}`} title={label} aria-pressed={selected === effect} onClick={() => pick(effect)}>
      {content}
    </button>
  );
  return (
    <div className="bg-picker">
      <div className="bg-grid">
        {tile("none", t("bg.none"), <span>⃠</span>)}
        {tile("blur", t("bg.blur"), <span className="bg-blur">◍</span>)}
        {tile("blur-strong", t("bg.blurStrong"), <span className="bg-blur strong">◍</span>)}
        {PRESETS.map((p) => tile(`preset:${p.id}`, t(`bg.preset.${p.id}` as Parameters<typeof t>[0]), <img src={thumbs[p.id]} alt="" />))}
        {MOVING.map((p) => tile(`preset:${p.id}`, t(`bg.preset.${p.id}` as Parameters<typeof t>[0]), <MovingThumb make={p.make} />))}
        {custom && tile("custom", t("bg.custom"), <img src={custom} alt="" />)}
        {moving && movingSrc && tile("custom-moving", t("bg.customMoving"),
          moving.type === "image/gif" ? <img src={movingSrc} alt="" /> : <video src={movingSrc} muted loop autoPlay playsInline />)}
        <button type="button" className="bg-tile add" title={t("bg.upload")} onClick={() => file.current?.click()}>＋</button>
      </div>
      <input ref={file} type="file" accept="image/*,video/*" hidden onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = "";
        if (!f) return;
        setError(null);
        const failed = (err: unknown) => setError(String(err).includes("too big") ? t("bg.tooBig", { mb: MOVING_MAX_MB }) : t("bg.uploadFailed"));
        if (isMovingFile(f)) setCustomMoving(f).then(() => { setMoving(customMoving()); pick("custom-moving"); }).catch(failed);
        else setCustomBackground(f).then(() => { setCustom(customBackground()); pick("custom"); }).catch(failed);
      }} />
      {error && <p className="error">{error}</p>}
    </div>
  );
}
