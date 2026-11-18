// Sharing your screen in a call: picks what to share and, while sharing, shows a red border
// around the shared screen plus a small "Stop sharing" bar (two native windows the host
// keeps out of the capture, so others don't see them).

import { listen } from "@tauri-apps/api/event";
import { backend, isLive } from "./backend";

let stopCurrent: (() => void) | null = null;

if (isLive) void listen("trix://stop-sharing", () => stopCurrent?.());

/** Asks what to share; `onStop` runs when the bar's Stop sharing is clicked. */
export async function pickScreen(onStop: () => void): Promise<MediaStream> {
  const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  const settings = screen.getVideoTracks()[0]?.getSettings() as MediaTrackSettings & { displaySurface?: string };
  stopCurrent = onStop;
  // A whole screen gets the border; for a window we can't know where it is, so only the bar.
  if (isLive) void backend.shareOverlay(settings?.displaySurface !== "window" && settings?.displaySurface !== "browser", settings?.width ?? 0, settings?.height ?? 0).catch(() => {});
  return screen;
}

/** Sharing ended (stopped, call over): removes the border and bar. */
export function screenStopped() {
  if (!stopCurrent) return;
  stopCurrent = null;
  if (isLive) void backend.hideShareOverlay().catch(() => {});
}
