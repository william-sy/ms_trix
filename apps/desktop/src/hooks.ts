// Small behaviours many dialogs and menus share.
import { useCallback, useEffect, useRef, type DependencyList, type RefObject } from "react";

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
  const note = useCallback(() => {
    const el = ref.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }, [ref]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    pinned.current = true;
    const stick = () => { if (pinned.current) el.scrollTop = el.scrollHeight; };
    // The list's own size, and each message in it (new ones too).
    const resize = new ResizeObserver(stick);
    resize.observe(el);
    for (const child of el.children) resize.observe(child);
    const added = new MutationObserver((records) => records.forEach((r) => r.addedNodes.forEach((n) => n instanceof Element && resize.observe(n))));
    added.observe(el, { childList: true });
    el.addEventListener("scroll", note, { passive: true });
    return () => { resize.disconnect(); added.disconnect(); el.removeEventListener("scroll", note); };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return note;
}
