import { RnnoiseWorkletNode, loadRnnoise } from "@sapphi-red/web-noise-suppressor";
import rnnoiseWorklet from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasm from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasm from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import deepFilterWasm from "../models/deepfilternet3.wasm?url";
import deepFilterWorklet from "./deepFilterWorklet.js?url";
import { currentSettings, updateSettings } from "./settings";

// Noise suppression for the microphone in calls, on this computer: the microphone goes through
// an audio worklet and only the cleaned sound is sent. Standard is RNNoise (light; steady noise
// such as fans and hum), High is DeepFilterNet 3 (keyboards, voices in the room, the street;
// about 4% of a CPU core). Like the camera background: the processed track remembers the
// microphone behind it, and stopping it stops both.

export type NoiseSuppression = "off" | "standard" | "high";
export const NOISE_LEVELS: NoiseSuppression[] = ["off", "standard", "high"];

export const currentNoise = (): NoiseSuppression => currentSettings().noiseSuppression ?? "off";

const binaries: Partial<Record<NoiseSuppression, Promise<ArrayBuffer>>> = {};

/** The level's WebAssembly, fetched once (from the app itself, nothing from the internet). */
function binary(level: "standard" | "high"): Promise<ArrayBuffer> {
  const loaded = binaries[level] ??= level === "high"
    ? fetch(deepFilterWasm).then((r) => r.arrayBuffer())
    : loadRnnoise({ url: rnnoiseWasm, simdUrl: rnnoiseSimdWasm });
  loaded.catch(() => { delete binaries[level]; });
  return loaded;
}

/** Loads the chosen level's model ahead of a call, so the microphone starts without a wait. */
export function warmUpNoise() {
  const level = currentNoise();
  if (level !== "off") void binary(level).catch(() => {});
}

// WebKit starts an audio engine paused on a page nobody has clicked yet (the call's own page):
// the cleaned microphone is silent until then. Resumed on the first click or key ("Join now").
const engines = new Set<AudioContext>();
const resume = () => engines.forEach((ctx) => { if (ctx.state === "suspended") void ctx.resume().catch(() => {}); });
for (const kind of ["pointerdown", "keydown"]) window.addEventListener(kind, resume, true);

interface Pipeline {
  raw: MediaStreamTrack;
  level: NoiseSuppression;
  stop: () => void;
}

const pipelines = new WeakMap<MediaStreamTrack, Pipeline>();

/** The microphone behind a track that may be cleaned. */
export const rawMic = (track: MediaStreamTrack): MediaStreamTrack => pipelines.get(track)?.raw ?? track;

/**
 * The microphone track to send for `raw` at `level`; the raw track itself when off, or when the
 * suppression can't run here (`onError` says why). `onError` also hears of a model that stops.
 */
export async function processMic(raw: MediaStreamTrack, level = currentNoise(), onError?: (why: string) => void): Promise<MediaStreamTrack> {
  if (level === "off") return raw;
  let ctx: AudioContext | undefined;
  try {
    // Both models work on 48 kHz.
    ctx = new AudioContext({ sampleRate: 48000 });
    if (ctx.sampleRate !== 48000) throw new Error(`the audio engine runs at ${ctx.sampleRate} Hz`);
    const [wasmBinary] = await Promise.all([binary(level), ctx.audioWorklet.addModule(level === "high" ? deepFilterWorklet : rnnoiseWorklet)]);
    const node = level === "high"
      ? new AudioWorkletNode(ctx, "trix-deepfilter", { processorOptions: { wasmBinary, attenLim: 100 }, outputChannelCount: [1] })
      : new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary });
    node.port.onmessage = (e) => { if (e.data?.error) onError?.(`noise suppression stopped: ${e.data.error}`); };
    // One channel in and out (a stereo microphone is mixed down first).
    const mono = ctx.createGain();
    mono.channelCount = 1;
    mono.channelCountMode = "explicit";
    const source = ctx.createMediaStreamSource(new MediaStream([raw]));
    const out = ctx.createMediaStreamDestination();
    out.channelCount = 1;
    out.channelCountMode = "explicit";
    source.connect(mono).connect(node).connect(out);
    engines.add(ctx);
    if (ctx.state !== "running") void ctx.resume().catch(() => {});
    const track = out.stream.getAudioTracks()[0]!;
    const engine = ctx;
    const nativeStop = track.stop.bind(track);
    const pipeline: Pipeline = {
      raw, level,
      stop: () => {
        source.disconnect();
        node.port.postMessage("free");
        engines.delete(engine);
        void engine.close().catch(() => {});
        nativeStop();
      },
    };
    // Stopping the cleaned track (hang up, leave) also releases the microphone.
    track.stop = () => { pipeline.stop(); raw.stop(); };
    pipelines.set(track, pipeline);
    return track;
  } catch (e) {
    void ctx?.close().catch(() => {});
    onError?.(`noise suppression unavailable: ${String(e)}`);
    return raw;
  }
}

/**
 * Switches the microphone in `stream` to `level` (and saves it as the setting): swaps the track
 * in the stream and in every connection sending it. Returns whether it changed.
 */
export async function switchNoise(stream: MediaStream | undefined, connections: (RTCPeerConnection | undefined)[], level: NoiseSuppression, onError?: (why: string) => void): Promise<boolean> {
  if (currentNoise() !== level) updateSettings({ noiseSuppression: level });
  const current = stream?.getAudioTracks()[0];
  if (!stream || !current) return false;
  const running = pipelines.get(current);
  if ((running?.level ?? "off") === level) return false;
  const next = await processMic(running?.raw ?? current, level, onError);
  if (next === current) return false;
  next.enabled = current.enabled;
  for (const pc of connections) {
    for (const sender of pc?.getSenders() ?? []) if (sender.track === current) await sender.replaceTrack(next).catch(() => {});
  }
  stream.removeTrack(current);
  stream.addTrack(next);
  // Ends the old pipeline but keeps the microphone itself running.
  running?.stop();
  return true;
}
