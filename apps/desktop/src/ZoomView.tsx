import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { t } from "./i18n";
import { isMac } from "./settings";

// A shared screen you can zoom into: pinch or ⌘/Ctrl + scroll zooms around the pointer, dragging
// (or scrolling, once zoomed) looks around, double-click zooms in there or back to fit, and
// − % + Fit show on hover. A new share (`resetKey`) starts at fit again.

const MAX = 8;
const STEP = 1.5;

interface View { z: number; x: number; y: number }
const FIT: View = { z: 1, x: 0, y: 0 };

/** WebKit's pinch events (other engines send a pinch as Ctrl + wheel). */
type GestureEvent = UIEvent & { scale: number; clientX: number; clientY: number };

export function ZoomView({ className, resetKey, children }: { className?: string; resetKey?: string; children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  const [view, setViewState] = useState<View>(FIT);
  const viewRef = useRef(view);
  const [dragging, setDragging] = useState(false);

  /** Keeps the picture in view: centred while it fits, its edges no further in than the frame's. */
  const clamp = (v: View): View => {
    const el = frame.current;
    const z = Math.min(MAX, Math.max(1, v.z));
    if (!el || z === 1) return FIT;
    const [W, H] = [el.clientWidth, el.clientHeight];
    // The picture inside the video element (object-fit: contain leaves bars).
    const video = el.querySelector("video");
    const [vw, vh] = [video?.videoWidth || W, video?.videoHeight || H];
    const fit = Math.min(W / vw, H / vh);
    const axis = (pos: number, frameSize: number, size: number) => {
      const offset = (frameSize - size) / 2;
      return z * size <= frameSize ? (frameSize - z * size) / 2 - z * offset : Math.min(-z * offset, Math.max(frameSize - z * (offset + size), pos));
    };
    return { z, x: axis(v.x, W, vw * fit), y: axis(v.y, H, vh * fit) };
  };
  const setView = (v: View) => {
    viewRef.current = clamp(v);
    setViewState(viewRef.current);
  };
  /** Zooms by `factor`, keeping the point (cx, cy) of the frame where it is. */
  const zoomAt = (factor: number, cx: number, cy: number) => {
    const v = viewRef.current;
    const z = Math.min(MAX, Math.max(1, v.z * factor));
    setView({ z, x: cx - ((cx - v.x) * z) / v.z, y: cy - ((cy - v.y) * z) / v.z });
  };
  const local = (e: { clientX: number; clientY: number }) => {
    const r = frame.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };
  const zoomCentre = (factor: number) => zoomAt(factor, frame.current!.clientWidth / 2, frame.current!.clientHeight / 2);

  useEffect(() => setView(FIT), [resetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    let pinching = false;
    let pinchFrom = 1;
    // Not passive: zooming and looking around mustn't scroll or zoom anything else.
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        if (pinching) return;
        // A trackpad pinch (Ctrl + small steps) follows the fingers; a wheel notch is a step.
        const delta = Math.max(-30, Math.min(30, e.deltaY * (e.deltaMode === 1 ? 33 : 1)));
        const [cx, cy] = local(e);
        zoomAt(Math.exp(-delta / 100), cx, cy);
      } else if (viewRef.current.z > 1) {
        e.preventDefault();
        const v = viewRef.current;
        setView({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY });
      }
    };
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      pinching = true;
      pinchFrom = viewRef.current.z;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as GestureEvent;
      const [cx, cy] = local(g);
      zoomAt((pinchFrom * g.scale) / viewRef.current.z, cx, cy);
    };
    const onGestureEnd = () => { pinching = false; };
    // A new size of the frame or of the shared picture: keep it in view. Media events don't
    // bubble, so the video's resize is caught on the way down.
    const refit = () => setView(viewRef.current);
    const observer = new ResizeObserver(refit);
    observer.observe(el);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    el.addEventListener("gestureend", onGestureEnd);
    el.addEventListener("resize", refit, true);
    return () => {
      observer.disconnect();
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      el.removeEventListener("gestureend", onGestureEnd);
      el.removeEventListener("resize", refit, true);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onControls = (e: { target: EventTarget }) => !!(e.target as HTMLElement).closest(".zoom-controls");
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || viewRef.current.z === 1 || onControls(e)) return;
    const el = e.currentTarget;
    let last = { x: e.clientX, y: e.clientY };
    const move = (ev: PointerEvent) => {
      const v = viewRef.current;
      setView({ ...v, x: v.x + ev.clientX - last.x, y: v.y + ev.clientY - last.y });
      last = { x: ev.clientX, y: ev.clientY };
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      setDragging(false);
    };
    el.setPointerCapture(e.pointerId);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    setDragging(true);
  };
  const onDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (onControls(e)) return;
    if (viewRef.current.z > 1) return setView(FIT);
    const [cx, cy] = local(e);
    zoomAt(2, cx, cy);
  };

  const zoomed = view.z > 1;
  return (
    <div ref={frame} className={`zoom-view ${className ?? ""} ${zoomed ? "zoomed" : ""} ${dragging ? "dragging" : ""}`} onPointerDown={onPointerDown} onDoubleClick={onDoubleClick}>
      <div className="zoom-content" style={zoomed ? { transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` } : undefined}>{children}</div>
      <div className="zoom-controls" title={t("zoom.hint", { key: isMac ? "⌘" : "Ctrl" })}>
        <button title={t("zoom.out")} disabled={!zoomed} onClick={() => zoomCentre(1 / STEP)}>−</button>
        <span className="zoom-level">{Math.round(view.z * 100)}%</span>
        <button title={t("zoom.in")} disabled={view.z >= MAX} onClick={() => zoomCentre(STEP)}>+</button>
        <button disabled={!zoomed} onClick={() => setView(FIT)}>{t("zoom.fit")}</button>
      </div>
    </div>
  );
}
