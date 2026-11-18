import { useEffect, useState } from "react";
import { backend, isLive } from "./backend";
import { t } from "./i18n";
import { currentSettings, isMac, onSettingsChanged, updateSettings } from "./settings";

/** The webview can send sound to a chosen device (Chromium, i.e. Windows); WebKit can't. */
export const canPickSpeaker = typeof (HTMLAudioElement.prototype as { setSinkId?: unknown }).setSinkId === "function";

interface MacOutput { id: number; name: string; current: boolean }

/**
 * Where call sound plays. With `setSinkId` the app's own choice (kept in Settings); on macOS,
 * where WebKit lacks it, the Mac's sound output (as in Control Centre); else the system's.
 */
export function SpeakerPicker() {
  const [speakerId, setSpeakerId] = useState(currentSettings().speakerId);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [mac, setMac] = useState<MacOutput[] | null>(null);
  const native = !canPickSpeaker && isMac && isLive;

  useEffect(() => onSettingsChanged((s) => setSpeakerId(s.speakerId)), []);
  useEffect(() => {
    const refresh = () => {
      if (canPickSpeaker) void navigator.mediaDevices.enumerateDevices().then((list) => setDevices(list.filter((d) => d.kind === "audiooutput" && d.deviceId !== "default" && d.deviceId !== "communications")));
      else if (native) void backend.audioOutputs().then(setMac).catch(() => setMac([]));
    };
    refresh();
    navigator.mediaDevices.addEventListener("devicechange", refresh);
    // Headphones connected or the output switched elsewhere: CoreAudio changes don't always reach the page.
    const timer = native ? window.setInterval(refresh, 5000) : 0;
    return () => { navigator.mediaDevices.removeEventListener("devicechange", refresh); window.clearInterval(timer); };
  }, [native]);

  if (canPickSpeaker) {
    return (
      <select value={speakerId ?? ""} onChange={(e) => {
        const id = e.target.value || null;
        const label = devices.find((d) => d.deviceId === id)?.label ?? "";
        updateSettings({ speakerId: id, deviceLabels: { ...currentSettings().deviceLabels, audiooutput: label } });
      }}>
        <option value="">{t("av.systemDefault")}</option>
        {devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || t("av.unnamed", { n: i + 1 })}</option>)}
      </select>
    );
  }
  if (native && mac?.length) {
    return (
      <span className="speaker-picker">
        <select value={String(mac.find((o) => o.current)?.id ?? "")} onChange={(e) => {
          const id = Number(e.target.value);
          void backend.setAudioOutput(id).then(() => setMac(mac.map((o) => ({ ...o, current: o.id === id })))).catch(() => {});
        }}>
          {mac.map((o) => <option key={o.id} value={String(o.id)}>{o.name}</option>)}
        </select>
        <small className="hint">{t("av.speakerMac")}</small>
      </span>
    );
  }
  return <p className="hint">{t("av.speakerSystem")}</p>;
}
