// Camera backgrounds for calls: blur or replace what's behind you. MediaPipe's selfie
// segmenter (WebAssembly, served locally under /mediapipe/) finds the person in each frame;
// the picture is redrawn on a canvas and that canvas is sent instead of the camera.
// Without an effect the camera track is used as is (no extra work, nothing to throttle).

import type { ImageSegmenter } from "@mediapipe/tasks-vision";
import { currentSettings, updateSettings } from "./settings";

/** "none", "blur", "blur-strong", "preset:<id>" or "custom" (your own picture). */
export type CameraEffect = string;

const CUSTOM = "trix.cameraBackground";
/** Person confidence where the edge starts and where you're fully visible. */
const EDGE_LOW = 0.45;
const EDGE_HIGH = 0.7;

/** Built-in backgrounds, drawn here so there are no image files to ship. */
export const PRESETS: { id: string; paint: (ctx: CanvasRenderingContext2D, w: number, h: number) => void }[] = [
  { id: "dusk", paint: (c, w, h) => gradient(c, w, h, ["#2b1055", "#7597de"]) },
  { id: "ocean", paint: (c, w, h) => gradient(c, w, h, ["#0f2027", "#2c5364", "#4ca1af"]) },
  { id: "forest", paint: (c, w, h) => gradient(c, w, h, ["#134e5e", "#71b280"]) },
  { id: "sunset", paint: (c, w, h) => gradient(c, w, h, ["#ee9ca7", "#ffdde1"]) },
  {
    id: "office",
    paint: (c, w, h) => {
      gradient(c, w, h, ["#d9d4cc", "#b9b2a7"]);
      // A window and a shelf, softly, so it reads as a room without distracting.
      c.fillStyle = "rgba(255,255,255,0.55)";
      c.fillRect(w * 0.08, h * 0.12, w * 0.3, h * 0.45);
      c.fillStyle = "rgba(120,100,80,0.35)";
      c.fillRect(w * 0.6, h * 0.35, w * 0.32, h * 0.03);
      c.fillRect(w * 0.6, h * 0.55, w * 0.32, h * 0.03);
    },
  },
];

function gradient(c: CanvasRenderingContext2D, w: number, h: number, stops: string[]) {
  const g = c.createLinearGradient(0, 0, w, h);
  stops.forEach((s, i) => g.addColorStop(i / (stops.length - 1), s));
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
}

export const customBackground = (): string | null => { try { return localStorage.getItem(CUSTOM); } catch { return null; } };

/** Stores your own background picture, scaled down so it fits in local storage. */
export async function setCustomBackground(file: File): Promise<void> {
  const img = await loadImage(URL.createObjectURL(file));
  const scale = Math.min(1, 1280 / img.width, 720 / img.height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(img.src);
  localStorage.setItem(CUSTOM, canvas.toDataURL("image/jpeg", 0.85));
}

const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = reject;
  img.src = src;
});

export const currentEffect = (): CameraEffect => currentSettings().cameraEffect ?? "none";

let segmenter: Promise<ImageSegmenter> | null = null;

function loadSegmenter(): Promise<ImageSegmenter> {
  segmenter ??= (async () => {
    const { FilesetResolver, ImageSegmenter } = await import("@mediapipe/tasks-vision");
    const files = await FilesetResolver.forVisionTasks("/mediapipe");
    const make = (delegate: "GPU" | "CPU") => ImageSegmenter.createFromOptions(files, {
      baseOptions: { modelAssetPath: "/mediapipe/selfie_segmenter.tflite", delegate },
      runningMode: "VIDEO",
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    });
    // The GPU is much faster; not every webview offers it to WebAssembly.
    return make("GPU").catch(() => make("CPU"));
  })();
  segmenter.catch(() => { segmenter = null; });
  return segmenter;
}

/** Loads the person detection ahead of a call when a background is chosen, so the camera starts fast. */
export function warmUpEffects() {
  if (currentEffect() !== "none") void loadSegmenter().catch(() => {});
}

/** Timers in a worker keep ticking when the window is in the background (page timers get throttled). */
function ticker(fps: number, tick: () => void): () => void {
  const url = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${Math.round(1000 / fps)});`], { type: "text/javascript" }));
  const worker = new Worker(url);
  worker.onmessage = tick;
  return () => { worker.terminate(); URL.revokeObjectURL(url); };
}

const filterSupported = (() => {
  try { return typeof document.createElement("canvas").getContext("2d")?.filter === "string"; } catch { return false; }
})();

interface Pipeline {
  raw: MediaStreamTrack;
  effect: CameraEffect;
  stop: () => void;
}

/** Processed tracks and where they come from. */
const pipelines = new WeakMap<MediaStreamTrack, Pipeline>();

/** The camera track to send for `raw` with the current (or given) effect. */
export async function processCamera(raw: MediaStreamTrack, effect: CameraEffect = currentEffect()): Promise<MediaStreamTrack> {
  if (effect === "none") return raw;
  let seg: ImageSegmenter;
  try {
    seg = await loadSegmenter();
  } catch (e) {
    console.warn("camera background unavailable", e);
    return raw;
  }
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([raw]);
  await video.play().catch(() => {});

  const out = document.createElement("canvas");
  const person = document.createElement("canvas");
  const mask = document.createElement("canvas");
  const soft = document.createElement("canvas");
  const small = document.createElement("canvas"); // blur fallback: shrink and stretch
  const ctx = out.getContext("2d")!;
  const pctx = person.getContext("2d")!;
  const mctx = mask.getContext("2d")!;
  const sofctx = soft.getContext("2d")!;
  const sctx = small.getContext("2d")!;
  const settings = raw.getSettings();
  out.width = settings.width ?? 1280;
  out.height = settings.height ?? 720;

  const pipeline: Pipeline = { raw, effect, stop: () => {} };
  let background: CanvasImageSource | null = null;
  let backgroundFor = "";
  let lastTime = -1;

  const prepareBackground = async (w: number, h: number) => {
    // A new picture of your own replaces the old one under the same effect name.
    const key = `${pipeline.effect}:${w}x${h}:${pipeline.effect === "custom" ? customBackground()?.length : ""}`;
    if (backgroundFor === key) return;
    backgroundFor = key;
    background = null;
    if (pipeline.effect.startsWith("preset:")) {
      const preset = PRESETS.find((p) => `preset:${p.id}` === pipeline.effect);
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      preset?.paint(c.getContext("2d")!, w, h);
      background = c;
    } else if (pipeline.effect === "custom") {
      const src = customBackground();
      if (src) background = await loadImage(src).catch(() => null);
    }
  };

  const drawCover = (img: CanvasImageSource & { width: number; height: number }, w: number, h: number) => {
    const scale = Math.max(w / img.width, h / img.height);
    const dw = img.width * scale, dh = img.height * scale;
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  };

  const frame = () => {
    if (video.readyState < 2 || raw.readyState === "ended") return;
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return;
    if (out.width !== w || out.height !== h) { out.width = person.width = w; out.height = person.height = h; }
    if (person.width !== w) { person.width = w; person.height = h; }
    // MediaPipe wants strictly increasing timestamps.
    const now = Math.max(performance.now(), lastTime + 1);
    lastTime = now;
    try {
      seg.segmentForVideo(video, now, (result) => {
        const m = result.confidenceMasks?.[0];
        if (!m) return;
        if (mask.width !== m.width || mask.height !== m.height) { mask.width = m.width; mask.height = m.height; }
        const conf = m.getAsFloat32Array();
        const pixels = mctx.createImageData(m.width, m.height);
        // A narrow edge band: a wide one lets the real background shine through around
        // your head (a halo). Scaling the small mask up smooths the edge enough.
        for (let i = 0; i < conf.length; i++) {
          const x = Math.min(1, Math.max(0, (conf[i]! - EDGE_LOW) / (EDGE_HIGH - EDGE_LOW)));
          pixels.data[i * 4 + 3] = x * x * (3 - 2 * x) * 255;
        }
        mctx.putImageData(pixels, 0, 0);
        // Soften the steps of the coarse mask at its own size (1 px there is a few on screen),
        // which rounds the edge without widening it into a halo.
        if (soft.width !== m.width || soft.height !== m.height) { soft.width = m.width; soft.height = m.height; }
        sofctx.clearRect(0, 0, m.width, m.height);
        if (filterSupported) sofctx.filter = "blur(1px)";
        sofctx.drawImage(mask, 0, 0);
        sofctx.filter = "none";
      });
    } catch { /* keep the previous mask */ }

    // You: the frame cut out by the (smoothly scaled) mask.
    pctx.globalCompositeOperation = "source-over";
    pctx.clearRect(0, 0, w, h);
    pctx.drawImage(video, 0, 0, w, h);
    pctx.globalCompositeOperation = "destination-in";
    pctx.imageSmoothingQuality = "high";
    pctx.drawImage(filterSupported ? soft : mask, 0, 0, w, h);

    // Behind you.
    if (pipeline.effect === "blur" || pipeline.effect === "blur-strong") {
      const strong = pipeline.effect === "blur-strong";
      if (filterSupported) {
        ctx.filter = `blur(${strong ? 18 : 9}px)`;
        ctx.drawImage(video, 0, 0, w, h);
        ctx.filter = "none";
      } else {
        const f = strong ? 24 : 12;
        small.width = Math.max(1, Math.round(w / f));
        small.height = Math.max(1, Math.round(h / f));
        sctx.drawImage(video, 0, 0, small.width, small.height);
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(small, 0, 0, w, h);
      }
    } else {
      void prepareBackground(w, h);
      if (background) drawCover(background as HTMLImageElement, w, h);
      else ctx.drawImage(video, 0, 0, w, h);
    }
    ctx.drawImage(person, 0, 0);
  };

  const stopTicker = ticker(30, frame);
  const track = out.captureStream(30).getVideoTracks()[0]!;
  const nativeStop = track.stop.bind(track);
  pipeline.stop = () => { stopTicker(); video.srcObject = null; nativeStop(); };
  // Stopping the processed track (hang up, leave) also releases the camera.
  track.stop = () => { pipeline.stop(); raw.stop(); };
  pipelines.set(track, pipeline);
  return track;
}

/**
 * Switches the camera in `stream` to `effect`: updates a running pipeline in place, or swaps
 * the track (in the stream and in every connection sending it). Returns whether it changed.
 */
export async function switchEffect(stream: MediaStream | undefined, connections: (RTCPeerConnection | undefined)[], effect: CameraEffect): Promise<boolean> {
  if (currentSettings().cameraEffect !== effect) updateSettings({ cameraEffect: effect });
  const current = stream?.getVideoTracks()[0];
  if (!stream || !current) return false;
  const running = pipelines.get(current);
  if (running && effect !== "none") {
    running.effect = effect;
    return false;
  }
  const raw = running?.raw ?? current;
  const next = effect === "none" ? raw : await processCamera(raw, effect);
  if (next === current) return false;
  next.enabled = current.enabled;
  for (const pc of connections) {
    for (const sender of pc?.getSenders() ?? []) if (sender.track === current) await sender.replaceTrack(next).catch(() => {});
  }
  stream.removeTrack(current);
  stream.addTrack(next);
  // Ends the old pipeline but keeps the camera itself running.
  running?.stop();
  return true;
}
