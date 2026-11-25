// Voice message recording: microphone -> compressed audio + duration + waveform.
import { useEffect, useRef, useState } from "react";
import { currentSettings } from "./settings";

export interface Voice {
  mime: string;
  /** Base64 audio. */
  data: string;
  durationMs: number;
  /** 0..1 levels, ~1 per 100 ms (max 100), for the waveform. */
  waveform: number[];
}

// Opus where the engine records it (Element's format); Safari/WebKit records AAC in MP4.
const TYPES = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/mp4"];
const MAX_MS = 15 * 60 * 1000;

/** Below this (RMS of the loudest bar) the recording is taken as silence, e.g. no microphone access. */
const SILENCE = 0.003;

async function waveformOf(blob: Blob): Promise<{ waveform: number[]; durationMs: number; peak: number } | null> {
  try {
    const ctx = new AudioContext();
    const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
    void ctx.close();
    const samples = audio.getChannelData(0);
    const bars = Math.min(100, Math.max(10, Math.round(audio.duration * 10)));
    const size = Math.floor(samples.length / bars) || 1;
    const levels = Array.from({ length: bars }, (_, i) => {
      let sum = 0;
      for (let j = i * size; j < (i + 1) * size && j < samples.length; j++) sum += samples[j]! * samples[j]!;
      return Math.sqrt(sum / size);
    });
    const peak = Math.max(...levels, 0.0001);
    return { waveform: levels.map((l) => Math.round((l / peak) * 100) / 100), durationMs: Math.round(audio.duration * 1000), peak: Math.max(...levels, 0) };
  } catch {
    return null;
  }
}

const toBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

/** start() asks for the microphone; finish(true) hands the recording to `onDone`, finish(false) drops it.
 *  `level` (0..1) is the live input level for a meter; `onSilent` fires when nothing was picked up. */
export function useVoiceRecorder(onDone: (v: Voice) => void, onError: (message: string) => void, onSilent: () => void) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const rec = useRef<{ recorder: MediaRecorder; chunks: Blob[]; started: number; keep: boolean; timer: number; meter?: () => void } | null>(null);

  const finish = (keep: boolean) => {
    const r = rec.current;
    if (!r) return;
    r.keep = keep;
    window.clearInterval(r.timer);
    r.meter?.();
    if (r.recorder.state !== "inactive") r.recorder.stop();
  };

  const start = async () => {
    if (rec.current) return;
    try {
      const stream = await openMic();
      const mimeType = TYPES.find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const r = { recorder, chunks: [] as Blob[], started: Date.now(), keep: false, timer: 0, meter: undefined as (() => void) | undefined };
      rec.current = r;
      recorder.ondataavailable = (e) => e.data.size && r.chunks.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        rec.current = null;
        setRecording(false);
        if (!r.keep || !r.chunks.length) return;
        const blob = new Blob(r.chunks, { type: recorder.mimeType || mimeType || "audio/mp4" });
        const measured = await waveformOf(blob);
        if (measured && measured.peak < SILENCE) return onSilent();
        onDone({ mime: blob.type.split(";")[0] || "audio/mp4", data: await toBase64(blob), durationMs: measured?.durationMs ?? Date.now() - r.started, waveform: measured?.waveform ?? [] });
      };
      r.meter = startMeter(stream, setLevel);
      recorder.start(250);
      setElapsed(0);
      setRecording(true);
      r.timer = window.setInterval(() => {
        const ms = Date.now() - r.started;
        setElapsed(ms);
        if (ms >= MAX_MS) finish(true);
      }, 200);
    } catch (e) {
      rec.current = null;
      onError(String(e));
    }
  };

  // Leaving the chat mid-recording throws the recording away.
  useEffect(() => () => finish(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  return { recording, elapsed, level, start, finish };
}

/** Opens the microphone chosen in Settings: by id, or by name if the id changed, else the default. */
export async function openMic(): Promise<MediaStream> {
  const { micId, deviceLabels } = currentSettings();
  let stream = await navigator.mediaDevices.getUserMedia({ audio: micId ? { deviceId: { ideal: micId } } : true });
  const want = deviceLabels.audioinput;
  const got = stream.getAudioTracks()[0]?.label;
  if (micId && want && got !== want) {
    // Access is granted now, so names are readable: look the device up by name.
    const match = (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === "audioinput" && d.label === want);
    if (match) {
      stream.getTracks().forEach((track) => track.stop());
      stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: match.deviceId } } });
    }
  }
  return stream;
}

/** Feeds the live microphone level (RMS, scaled up for speech) to `onLevel`; returns a stop function. */
export function startMeter(stream: MediaStream, onLevel: (level: number) => void): () => void {
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let frame = 0;
  const tick = () => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const s of samples) sum += s * s;
    onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 4));
    frame = requestAnimationFrame(tick);
  };
  tick();
  return () => {
    cancelAnimationFrame(frame);
    onLevel(0);
    void ctx.close();
  };
}

/** 4:05, or 1:30:23 from an hour on. */
export const formatDuration = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const two = (n: number) => String(n).padStart(2, "0");
  return s < 3600 ? `${Math.floor(s / 60)}:${two(s % 60)}` : `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
};
