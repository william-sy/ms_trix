import { useEffect } from "react";
import { accents, type FontSize, type Settings, type ThemeChoice } from "./settings";
import { languages, t, t as tr } from "./i18n";

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
}

export function SettingsDialog({ settings, onChange, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });

  return (
    <div className="login-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="login-card settings">
        <button className="icon-btn close" onClick={onClose} title={t("common.closeEsc")}>✕</button>
        <h1>{t("settings.title")}</h1>

        <section>
          <h2>{t("settings.theme")}</h2>
          <div className="segmented" role="radiogroup">
            {(["system", "light", "dark"] as ThemeChoice[]).map((t) => (
              <button key={t} role="radio" aria-checked={settings.theme === t} className={settings.theme === t ? "on" : ""} onClick={() => set({ theme: t })}>
                {tr(`settings.theme.${t}`)}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h2>{t("settings.accent")}</h2>
          <div className="swatches">
            <button className={`swatch default ${settings.accent === null ? "on" : ""}`} title={t("settings.accentDefault")} onClick={() => set({ accent: null })}>A</button>
            {accents.map((a) => (
              <button key={a.color} className={`swatch ${settings.accent === a.color ? "on" : ""}`} title={t(a.name)} style={{ background: a.color }} onClick={() => set({ accent: a.color })} />
            ))}
            <label className="swatch custom" title={t("settings.accentCustom")}>
              <input type="color" value={settings.accent ?? "#5b5fc7"} onChange={(e) => set({ accent: e.target.value })} />
            </label>
          </div>
        </section>

        <section>
          <h2>{t("settings.textSize")}</h2>
          <div className="segmented" role="radiogroup">
            {(["small", "normal", "large"] as FontSize[]).map((f) => (
              <button key={f} role="radio" aria-checked={settings.fontSize === f} className={settings.fontSize === f ? "on" : ""} onClick={() => set({ fontSize: f })}>
                {t(`settings.size.${f}`)}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h2>{t("settings.language")}</h2>
          <select className="language" value={settings.language} onChange={(e) => set({ language: e.target.value })}>
            <option value="system">{t("settings.languageSystem")}</option>
            {languages.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
          </select>
        </section>

        <p className="hint">{t("settings.hint")}</p>
      </div>
    </div>
  );
}
