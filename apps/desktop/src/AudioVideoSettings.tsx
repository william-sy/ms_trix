import { useEffect, useRef, useState } from "react";
import { SpeakerPicker } from "./SpeakerPicker";
import { t } from "./i18n";
import type { Settings } from "./settings";
import { startMeter } from "./voice";
import { BackgroundPicker } from "./BackgroundPicker";
import { processCamera, switchEffect } from "./cameraEffects";

type Section = { settings: Settings; set: (patch: Partial<Settings>) => void };

/** Settings → Audio & video: pick microphone, speaker and camera, and test them. */
export function AudioVideoSettings({ settings, set }: Section) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Device names only show once access is granted. Asking starts up the audio system
  // (a brief freeze on macOS), so it only happens on request: a test or "Show device names".
  const refresh = async (ask: boolean) => {
    try {
      if (ask) (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((track) => track.stop());
      setDevices(await navigator.mediaDevices.enumerateDevices());
      setError(null);
    } catch (e) {
      setError(t("av.noAccess", { error: String(e) }));
      setDevices(await navigator.mediaDevices.enumerateDevices().catch(() => []));
    }
  };
  useEffect(() => {
    // List what's known at once; get the real names a moment later, after the tab has drawn.
    void refresh(false).then(() => window.setTimeout(() => void refresh(true), 300));
    const onChange = () => void refresh(false);
    navigator.mediaDevices.addEventListener("devicechange", onChange);
    return () => navigator.mediaDevices.removeEventListener("devicechange", onChange);
  }, []);

  // Before access, WebKit lists one nameless placeholder per kind instead of the real devices.
  const unnamed = devices.some((d) => (d.kind === "audioinput" || d.kind === "videoinput") && !d.label);
  const of = (kind: MediaDeviceKind) => devices.filter((d) => d.kind === kind && d.deviceId !== "default" && d.deviceId !== "communications");
  const canPickSpeaker = typeof (HTMLAudioElement.prototype as { setSinkId?: unknown }).setSinkId === "function";

  // The saved device, also when its id changed since (matched by name).
  const resolve = (kind: MediaDeviceKind, id: string | null) => {
    if (!id || of(kind).some((d) => d.deviceId === id)) return id;
    return of(kind).find((d) => d.label && d.label === settings.deviceLabels[kind])?.deviceId ?? id;
  };
  const pick = (kind: MediaDeviceKind, field: "micId" | "speakerId" | "cameraId") => (id: string | null) => {
    const label = devices.find((d) => d.deviceId === id)?.label;
    set({ [field]: id, deviceLabels: { ...settings.deviceLabels, [kind]: label ?? "" } });
  };
  const picker = (kind: MediaDeviceKind, value: string | null, onPick: (id: string | null) => void) => (
    <select value={resolve(kind, value) ?? ""} onChange={(e) => onPick(e.target.value || null)}>
      <option value="">{t("av.systemDefault")}</option>
      {of(kind).map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || t("av.unnamed", { n: i + 1 })}</option>)}
    </select>
  );

  return (
    <>
      {unnamed && (
        <p className="hint">{t("av.namesHidden")} <button className="link" onClick={() => void refresh(true)}>{t("av.showNames")}</button></p>
      )}
      <section>
        <h2>{t("av.microphone")}</h2>
        {picker("audioinput", settings.micId, pick("audioinput", "micId"))}
        <MicTest deviceId={resolve("audioinput", settings.micId)} onStarted={() => unnamed && void refresh(false)} />
      </section>
      <section>
        <h2>{t("av.speaker")}</h2>
        {canPickSpeaker ? picker("audiooutput", settings.speakerId, pick("audiooutput", "speakerId")) : <SpeakerPicker />}
        <SpeakerTest deviceId={canPickSpeaker ? settings.speakerId : null} />
      </section>
      <section>
        <h2>{t("av.camera")}</h2>
        {picker("videoinput", settings.cameraId, pick("videoinput", "cameraId"))}
        <CameraTest deviceId={resolve("videoinput", settings.cameraId)} effect={settings.cameraEffect} onStarted={() => unnamed && void refresh(false)} />
      </section>
      <section>
        <h2>{t("bg.title")}</h2>
        <BackgroundPicker value={settings.cameraEffect} onPick={(cameraEffect) => set({ cameraEffect })} />
        <p className="hint">{t("bg.settingsHint")}</p>
      </section>
      {error && <p className="error">{error}</p>}
      <p className="hint">{t("av.hint")}</p>
    </>
  );
}

function MicTest({ deviceId, onStarted }: { deviceId: string | null; onStarted: () => void }) {
  const [level, setLevel] = useState<number | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const end = () => { stop.current?.(); stop.current = null; setLevel(null); };
  const begin = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
      const meter = startMeter(stream, setLevel);
      stop.current = () => { meter(); stream.getTracks().forEach((track) => track.stop()); };
      onStarted(); // access is granted now, so the device names can be read
    } catch {
      setLevel(null);
    }
  };
  useEffect(() => end, [deviceId]); // switching devices ends a running test
  return (
    <div className="av-test">
      <button className="btn small" onClick={() => (level === null ? void begin() : end())}>{level === null ? t("av.testMic") : t("av.stopTest")}</button>
      {level !== null && (
        <span className="vu big" aria-label={t("av.level")}>
          {Array.from({ length: 20 }, (_, i) => <span key={i} className={level * 20 > i ? "on" : ""} />)}
        </span>
      )}
      {level !== null && <span className="hint">{t("av.speakNow")}</span>}
    </div>
  );
}

function SpeakerTest({ deviceId }: { deviceId: string | null }) {
  // A short two-tone chime, made on the fly so there's no sound file to ship.
  const play = async () => {
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    for (const [freq, at] of [[660, 0], [880, 0.18]] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.25, ctx.currentTime + at);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + at + 0.35);
      osc.connect(gain).connect(dest);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + 0.4);
    }
    const audio = new Audio();
    audio.srcObject = dest.stream;
    const sink = audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (deviceId && sink.setSinkId) await sink.setSinkId(deviceId).catch(() => {});
    await audio.play().catch(() => {});
    window.setTimeout(() => { audio.pause(); void ctx.close(); }, 900);
  };
  return <div className="av-test"><button className="btn small" onClick={() => void play()}>{t("av.testSpeaker")}</button></div>;
}

function CameraTest({ deviceId, effect, onStarted }: { deviceId: string | null; effect: string; onStarted: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [on, setOn] = useState(false);
  const stream = useRef<MediaStream | null>(null);
  const show = () => requestAnimationFrame(() => { if (video.current) video.current.srcObject = stream.current && new MediaStream(stream.current.getTracks()); });
  const stop = () => { stream.current?.getTracks().forEach((track) => track.stop()); stream.current = null; setOn(false); };
  const start = async () => {
    try {
      const cam = await navigator.mediaDevices.getUserMedia({ video: deviceId ? { deviceId: { exact: deviceId } } : true });
      // The preview shows the chosen background, as others will see it.
      stream.current = new MediaStream([await processCamera(cam.getVideoTracks()[0]!, effect)]);
      setOn(true);
      onStarted();
      show();
    } catch {
      stop();
    }
  };
  useEffect(() => stop, [deviceId]);
  useEffect(() => {
    if (stream.current) void switchEffect(stream.current, [], effect).then(show);
  }, [effect]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="av-test">
      <button className="btn small" onClick={() => (on ? stop() : void start())}>{on ? t("av.stopTest") : t("av.testCamera")}</button>
      {on && <video ref={video} className="camera-preview" autoPlay muted playsInline />}
    </div>
  );
}
