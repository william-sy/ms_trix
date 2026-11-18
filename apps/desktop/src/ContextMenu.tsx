import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

const MARGIN = 8;

/** A right-click menu at the pointer; opens upwards / leftwards where it wouldn't fit in the window. */
export function ContextMenu({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  // Measured before it's painted, so it never shows cut off first; and again when it grows
  // (an item that appears once the server has answered).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const { width, height } = el.getBoundingClientRect();
      setPos({
        left: x + width > innerWidth - MARGIN ? Math.max(MARGIN, x - width) : x,
        top: y + height > innerHeight - MARGIN ? Math.max(MARGIN, y - height) : y,
      });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [x, y]);
  return <div ref={ref} className="menu context" style={pos} onClick={(e) => e.stopPropagation()}>{children}</div>;
}
