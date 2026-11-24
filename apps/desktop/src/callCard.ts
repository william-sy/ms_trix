// The minimised call: a card in a corner of the app that you can drag to another corner. In its
// corner it stays clear of what you need while it's there: the headers at the top, the rail on
// the left, and the message box (with its Send button) at the bottom.

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { backend } from "./backend";

export type Corner = "tl" | "tr" | "bl" | "br";

const KEY = "trix.callCorner";
const MARGIN = 20;
const WIDTH = 300;

export function storedCorner(): Corner {
  try {
    const c = localStorage.getItem(KEY);
    if (c === "tl" || c === "tr" || c === "bl" || c === "br") return c;
  } catch { /* default */ }
  return "br";
}

export function storeCorner(corner: Corner) {
  try { localStorage.setItem(KEY, corner); } catch { /* not kept */ }
}

/** What the card keeps clear of, in the app window's coordinates. */
export interface CardInsets {
  /** Below the title bar and the headers of the panes. */
  top: number;
  /** Right of the rail. */
  left: number;
  /** Message boxes: [left, right, top] each. */
  boxes: [number, number, number][];
}

export function measureInsets(): CardInsets {
  const panes = document.querySelector(".panes")?.getBoundingClientRect();
  const paneTop = panes?.top ?? 0;
  const headers = [...document.querySelectorAll(".panes header")].map((h) => h.getBoundingClientRect()).filter((r) => Math.abs(r.top - paneTop) < 2);
  const top = Math.max(paneTop, ...headers.map((r) => r.bottom));
  const left = document.querySelector(".rail")?.getBoundingClientRect().right ?? 0;
  const boxes = [...document.querySelectorAll(".composer")].map((c) => c.getBoundingClientRect()).filter((r) => r.width > 0)
    .map((r) => [Math.round(r.left), Math.round(r.right), Math.round(r.top)] as [number, number, number]);
  return { top: Math.round(top), left: Math.round(left), boxes };
}

/** Measures the insets while `active` (they change with the view, the chat, a growing message), reporting changes. */
export function useCardInsets(active: boolean, onChange: (insets: CardInsets) => void) {
  const report = useRef(onChange);
  report.current = onChange;
  useEffect(() => {
    if (!active) return;
    let last = "";
    const check = () => {
      const insets = measureInsets();
      const key = JSON.stringify(insets);
      if (key !== last) { last = key; report.current(insets); }
    };
    check();
    const timer = window.setInterval(check, 400);
    window.addEventListener("resize", check);
    return () => { window.clearInterval(timer); window.removeEventListener("resize", check); };
  }, [active]);
}

/** Where the card goes in its corner (the same rule as the docked call's card in lib.rs `card_origin`). */
export function cardOrigin(corner: Corner, insets: CardInsets, width: number, height: number, card: number) {
  const right = corner === "tr" || corner === "br";
  const x = right ? width - WIDTH - MARGIN : insets.left + MARGIN;
  if (corner === "tl" || corner === "tr") return { x, y: insets.top + MARGIN };
  const floor = Math.min(height, ...insets.boxes.filter(([l, r]) => l < x + WIDTH && r > x).map(([, , top]) => top));
  return { x, y: Math.max(0, floor - card - MARGIN) };
}

/** The corner nearest to where a card was let go. */
export function nearestCorner(centerX: number, centerY: number, width: number, height: number): Corner {
  return `${centerY < height / 2 ? "t" : "b"}${centerX < width / 2 ? "l" : "r"}` as Corner;
}

/** Whether a press starts a drag: not on the card's buttons. */
export const draggable = (e: ReactPointerEvent) => e.button === 0 && !(e.target as Element).closest("button, input, select, a");

/**
 * The Matrix call's card, inside the app's own page: placed in its corner, dragged by the
 * pointer and let go into the nearest corner.
 */
export function useInPageCard(active: boolean) {
  const [corner, setCorner] = useState(storedCorner);
  const [insets, setInsets] = useState<CardInsets>({ top: 0, left: 0, boxes: [] });
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const [height, setHeight] = useState(0);
  const ref = useRef<HTMLDivElement | null>(null);
  const start = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  useCardInsets(active, setInsets);
  useEffect(() => {
    const card = ref.current;
    if (!active || !card) return;
    const observer = new ResizeObserver(() => setHeight(card.offsetHeight));
    observer.observe(card);
    return () => observer.disconnect();
  }, [active]);
  const origin = cardOrigin(corner, insets, innerWidth, innerHeight, height);
  const style: CSSProperties = {
    left: origin.x, top: origin.y, right: "auto", bottom: "auto",
    transform: drag ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined,
    transition: drag ? "none" : undefined,
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggable(e)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, y: e.clientY, moved: false };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (!s) return;
    const dx = e.clientX - s.x, dy = e.clientY - s.y;
    if (!s.moved && Math.hypot(dx, dy) < 4) return;
    s.moved = true;
    setDrag({ dx, dy });
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = start.current;
    start.current = null;
    if (!s?.moved || !drag) return setDrag(null);
    const card = e.currentTarget.getBoundingClientRect();
    const next = nearestCorner(card.left + card.width / 2, card.top + card.height / 2, innerWidth, innerHeight);
    setCorner(next);
    storeCorner(next);
    setDrag(null);
  };
  return { ref, style, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp } };
}

/**
 * The Talk call's card: a webview of its own docked in the app window, moved by the host (lib.rs
 * `drag_call_card`). Screen coordinates, since the card moves under the pointer.
 */
export function useDockedCardDrag() {
  const start = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const frame = useRef(0);
  // One move at a time, and the drop after the last move.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const then = <T,>(step: () => Promise<T>): Promise<T> => {
    const next = queue.current.catch(() => {}).then(step);
    queue.current = next;
    return next;
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggable(e)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.screenX, y: e.screenY, moved: false };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (!s) return;
    const dx = e.screenX - s.x, dy = e.screenY - s.y;
    if (!s.moved && Math.hypot(dx, dy) < 4) return;
    s.moved = true;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => void then(() => backend.dragCallCard(dx, dy)));
  };
  const onPointerUp = () => {
    const s = start.current;
    start.current = null;
    cancelAnimationFrame(frame.current);
    if (s?.moved) void then(() => backend.dropCallCard()).then(storeCorner, () => {});
  };
  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp };
}
