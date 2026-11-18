import { useMemo, useRef, useState } from "react";
import { PRESETS, currentEffect, customBackground, setCustomBackground, type CameraEffect } from "./cameraEffects";
import { t } from "./i18n";

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

/** Camera background choice: none, blur, built-in pictures or your own. */
export function BackgroundPicker({ onPick, value }: { onPick: (effect: CameraEffect) => void; value?: CameraEffect }) {
  const [selected, setSelected] = useState(value ?? currentEffect());
  const [custom, setCustom] = useState(customBackground);
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
        {custom && tile("custom", t("bg.custom"), <img src={custom} alt="" />)}
        <button type="button" className="bg-tile add" title={t("bg.upload")} onClick={() => file.current?.click()}>＋</button>
      </div>
      <input ref={file} type="file" accept="image/*" hidden onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = "";
        if (!f) return;
        setCustomBackground(f).then(() => { setCustom(customBackground()); pick("custom"); }).catch(() => setError(t("bg.uploadFailed")));
      }} />
      {error && <p className="error">{error}</p>}
    </div>
  );
}
