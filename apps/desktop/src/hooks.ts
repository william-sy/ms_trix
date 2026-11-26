// Small behaviours many dialogs and menus share.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DependencyList, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

/** Escape closes it. */
export function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
}

/** While `active`, a mouse press outside `ref` calls `onOutside` (closing a menu). */
export function useClickOutside(ref: RefObject<HTMLElement | null>, active: boolean, onOutside: () => void) {
  useEffect(() => {
    if (!active) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onOutside();
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * Keeps a scrolling list at its bottom while you're there: whatever grows (a reaction, a big
 * emoji, the sent tick, a picture or link preview loading) or makes the list shorter (the typing
 * line, a taller message box) keeps the newest in view. Scrolled up, nothing moves. When `deps`
 * change (another chat, the list shown again) it starts at the bottom. Returns `note`, to call
 * right after scrolling the list from code (a jump to a message), so it knows you left the bottom.
 */
export function useStickToBottom(ref: RefObject<HTMLElement | null>, deps: DependencyList) {
  const pinned = useRef(true);
  const lastTop = useRef(0);
  const atBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  const note = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    pinned.current = atBottom(el);
    lastTop.current = el.scrollTop;
  }, [ref]);
  // Before any scroll event of the newly shown list, so its position counts from its own bottom.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    pinned.current = true;
    const stick = () => {
      if (!pinned.current) return;
      el.scrollTop = el.scrollHeight;
      lastTop.current = el.scrollTop;
    };
    // Only moving up lets go: a scroll event can arrive after more has grown below (the jump to
    // the bottom of a chat just opened, before its pictures load), and that's still the bottom.
    const onScroll = () => {
      if (atBottom(el)) pinned.current = true;
      else if (el.scrollTop < lastTop.current - 1) pinned.current = false;
      lastTop.current = el.scrollTop;
    };
    // The list's own size, and each message in it (new ones too).
    const resize = new ResizeObserver(stick);
    resize.observe(el);
    for (const child of el.children) resize.observe(child);
    const added = new MutationObserver((records) => records.forEach((r) => r.addedNodes.forEach((n) => n instanceof Element && resize.observe(n))));
    added.observe(el, { childList: true });
    el.addEventListener("scroll", onScroll, { passive: true });
    stick();
    return () => { resize.disconnect(); added.disconnect(); el.removeEventListener("scroll", onScroll); };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return note;
}

/**
 * A side pane's width, set by dragging the handle on its left edge (the pane is the handle's
 * parent) and remembered on this device; double-clicking the handle goes back to the width from
 * the CSS (null). The pane next to it keeps `keep` pixels.
 */
export function usePaneWidth(key: string, min: number, keep: number) {
  const { size, handle } = usePaneSize(key, min, keep, "left");
  return { width: size, handle };
}

/**
 * A pane's size along one side, dragged by the handle on its `edge` (the pane is the handle's
 * parent, the area sharing the room its parent): the width for "left", the height for "top" and
 * "bottom". Remembered per `key` on this device; double-click: back to the CSS size (null).
 */
export function usePaneSize(key: string, min: number, keep: number, edge: "left" | "top" | "bottom") {
  const read = (k: string) => {
    try { const n = Number(localStorage.getItem(k)); return n >= min ? n : null; } catch { return null; }
  };
  const [state, setState] = useState(() => ({ key, size: read(key) }));
  // Another key (say, two rows instead of one): its own remembered size.
  if (state.key !== key) setState({ key, size: read(key) });
  const setSize = (size: number | null) => setState({ key, size });
  const store = (n: number | null) => {
    try { if (n) localStorage.setItem(key, String(n)); else localStorage.removeItem(key); } catch { /* not kept */ }
  };
  const vertical = edge !== "left";
  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    const handle = e.currentTarget;
    const pane = handle.parentElement;
    const area = pane?.parentElement;
    if (!pane || !area || e.button !== 0) return;
    e.preventDefault();
    const box = pane.getBoundingClientRect();
    const room = area.getBoundingClientRect();
    const max = Math.max(min, (vertical ? room.height : room.width) - keep);
    let last = vertical ? box.height : box.width;
    const move = (ev: PointerEvent) => {
      const wanted = edge === "left" ? box.right - ev.clientX : edge === "top" ? box.bottom - ev.clientY : ev.clientY - box.top;
      last = Math.round(Math.min(max, Math.max(min, wanted)));
      setSize(last);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      document.body.classList.remove("resizing", "resizing-rows");
      store(last);
    };
    handle.setPointerCapture(e.pointerId);
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
    document.body.classList.add("resizing");
    if (vertical) document.body.classList.add("resizing-rows");
  };
  const onDoubleClick = () => { setSize(null); store(null); };
  return { size: state.size, handle: { onPointerDown, onDoubleClick } };
}
