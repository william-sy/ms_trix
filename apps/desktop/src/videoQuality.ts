// The camera's quality in calls: chosen in the audio & video settings, or Automatic as Talk's
// web app does it (its SentVideoQualityThrottler, see _notes/talk-calls.md): full quality while
// you speak and in calls with fewer than 20 cameras, lower in very big calls. With a background
// effect Automatic stays at HD, since the effect is drawn on every frame.

import { currentSettings } from "./settings";

export type CameraQuality = "auto" | "high" | "hd" | "standard" | "low";
export type CameraLevel = Exclude<CameraQuality, "auto">;

const SIZES: Record<CameraLevel, { width: number; height: number }> = {
  high: { width: 1920, height: 1080 },
  hd: { width: 1280, height: 720 },
  standard: { width: 640, height: 480 },
  low: { width: 480, height: 360 },
};
const ORDER: CameraLevel[] = ["low", "standard", "hd", "high"];

export const CAMERA_QUALITIES: CameraQuality[] = ["auto", "high", "hd", "standard", "low"];

/** The quality to send now: the chosen one, or Automatic's pick for the call as it is. */
export function cameraLevel(call: { videos: number; audios: number; speaking: boolean; effect: boolean } = { videos: 0, audios: 0, speaking: false, effect: false }): CameraLevel {
  const chosen = currentSettings().cameraQuality;
  if (chosen !== "auto") return chosen;
  // Talk's thresholds: others with their camera on, or with their microphone on.
  const level: CameraLevel = call.speaking ? "high"
    : call.videos >= 120 || call.audios >= 200 ? "low"
    : call.videos >= 80 || call.audios >= 80 ? "standard"
    : call.videos >= 20 || call.audios >= 40 ? "hd"
    : "high";
  return call.effect && ORDER.indexOf(level) > ORDER.indexOf("hd") ? "hd" : level;
}

/** Camera constraints for a level (any size up to it; the camera picks its nearest). */
export function cameraConstraints(level: CameraLevel, deviceId?: ConstrainDOMString): MediaTrackConstraints {
  const { width, height } = SIZES[level];
  return { ...(deviceId ? { deviceId } : {}), width: { ideal: width, max: width }, height: { ideal: height, max: height }, frameRate: { ideal: 30, max: 30 } };
}

const applied = new WeakMap<MediaStreamTrack, CameraLevel>();
const pending = new WeakMap<MediaStreamTrack, Promise<void>>();

/**
 * Sets a camera (the raw track, not one with a background effect) to a level, one change at a
 * time; a camera that refuses the limits gets the size as a wish only. Returns the size it runs at.
 */
export function applyCameraLevel(camera: MediaStreamTrack, level: CameraLevel): Promise<string | null> {
  const before = pending.get(camera) ?? Promise.resolve();
  const next = before.then(async () => {
    if (applied.get(camera) === level || camera.readyState === "ended") return;
    try {
      await camera.applyConstraints(cameraConstraints(level));
    } catch {
      const { width, height } = SIZES[level];
      await camera.applyConstraints({ width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: 30 } }).catch(() => {});
    }
    applied.set(camera, level);
  });
  pending.set(camera, next);
  return next.then(() => {
    const s = camera.getSettings();
    return s.width && s.height ? `${s.width}×${s.height}${s.frameRate ? ` at ${Math.round(s.frameRate)} fps` : ""}` : null;
  });
}

/** A camera just opened with `level`'s constraints: no need to apply them again. */
export const openedAt = (camera: MediaStreamTrack | undefined, level: CameraLevel) => camera && applied.set(camera, level);
