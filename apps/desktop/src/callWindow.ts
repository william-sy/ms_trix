// The call as a window inside the app (Teams-like): it floats over the chats so messages stay
// within reach, can be moved by its header and resized from its corner, or fill the app.

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

const MODE = "trix.callFloating";
const SIZE = "trix.callSize";
const MARGIN = 16;

const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* not kept */ } };

function storedSize(): { w: number; h: number } {
  try {
    const s = JSON.parse(read(SIZE) ?? "");
    if (s.w > 0 && s.h > 0) return s;
  } catch { /* default */ }
  return { w: Math.min(720, Math.round(innerWidth * 0.55)), h: Math.min(480, Math.round(innerHeight * 0.6)) };
}

export function useCallWindow() {
  const [floating, setFloating] = useState(() => read(MODE) !== "0");
  const [size, setSize] = useState(storedSize);
  // Bottom right to start with, like Teams' call monitor.
  const [pos, setPos] = useState(() => ({ x: innerWidth - size.w - MARGIN, y: innerHeight - size.h - MARGIN }));
  const box = useRef<HTMLDivElement>(null);

  const clamp = (x: number, y: number, w = size.w, h = size.h) => ({
    x: Math.max(0, Math.min(x, innerWidth - Math.min(w, innerWidth))),
    y: Math.max(0, Math.min(y, innerHeight - Math.min(h, innerHeight))),
  });

  // Keep it inside the app when the app window shrinks.
  useEffect(() => {
    const onResize = () => setPos((p) => clamp(p.x, p.y));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  });

  // Resized from its corner (CSS resize): remember the size for the next call.
  useEffect(() => {
    const el = box.current;
    if (!el || !floating) return;
    const observer = new ResizeObserver(() => {
      const next = { w: Math.round(el.offsetWidth), h: Math.round(el.offsetHeight) };
      if (next.w === size.w && next.h === size.h) return;
      setSize(next);
      write(SIZE, JSON.stringify(next));
    });
    observer.observe(el);
    return () => observer.disconnect();
  });

  const toggle = () => setFloating((f) => { write(MODE, f ? "0" : "1"); return !f; });

  const onHeadPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (!floating || (e.target as HTMLElement).closest("button, .menu")) return;
    const start = { x: e.clientX - pos.x, y: e.clientY - pos.y };
    const head = e.currentTarget;
    head.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setPos(clamp(ev.clientX - start.x, ev.clientY - start.y));
    const up = () => { head.removeEventListener("pointermove", move); head.removeEventListener("pointerup", up); };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", up);
  };

  return {
    floating,
    toggle,
    ref: box,
    className: floating ? "floating" : "",
    style: floating ? { left: pos.x, top: pos.y, width: size.w, height: size.h } : undefined,
    onHeadPointerDown,
  };
}
