import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { backend } from "./backend";
import { t } from "./i18n";

// The windows shown while you share your screen (see screenShare.ts): the main entry point
// renders this instead of the app when the window was opened as #share-border, #share-bar
// (":draw" when drawing is possible) or #share-draw.

const [kind, option] = location.hash.slice(1).split(":");
export const isShareOverlay = kind === "share-border" || kind === "share-bar" || kind === "share-draw";

if (isShareOverlay) document.documentElement.classList.add("share-overlay");

type Tool = "pen" | "highlighter" | "arrow" | "laser";
interface DrawState { tool: Tool | null; color: string }

const COLORS = ["#e8394f", "#ffb900", "#2b88d8", "#13a10e", "#ffffff"];
const TOOLS: { id: Tool; icon: string; label: Parameters<typeof t>[0] }[] = [
  { id: "pen", icon: "✎", label: "draw.pen" },
  { id: "highlighter", icon: "▍", label: "draw.highlighter" },
  { id: "arrow", icon: "↗", label: "draw.arrow" },
  { id: "laser", icon: "●", label: "draw.laser" },
];

const setDraw = (tool: Tool | null, color: string) => void invoke("share_draw", { tool, color }).catch(() => {});

export function ShareOverlay() {
  if (kind === "share-border") return <div className="share-border" />;
  if (kind === "share-draw") return <DrawLayer />;
  return <ShareBar canDraw={option === "draw"} />;
}

function ShareBar({ canDraw }: { canDraw: boolean }) {
  const [draw, setState] = useState<DrawState>({ tool: null, color: COLORS[0]! });
  useEffect(() => {
    const off = listen<DrawState>("trix://draw", (e) => setState(e.payload));
    return () => void off.then((f) => f());
  }, []);
  // After a stroke the bar has the keyboard; Esc stops drawing from here too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && draw.tool) setDraw(null, draw.color); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draw]);
  const stop = <button className="btn small danger" onClick={() => { setDraw(null, draw.color); void backend.stopSharing().catch(() => {}); }}>{t("mxcall.stopShare")}</button>;

  if (draw.tool) {
    return (
      <div className="share-bar drawing" data-tauri-drag-region>
        {TOOLS.map((tool) => (
          <button key={tool.id} className={`draw-tool ${draw.tool === tool.id ? "on" : ""}`} title={t(tool.label)} onClick={() => setDraw(tool.id, draw.color)}>{tool.icon}</button>
        ))}
        <span className="draw-sep" />
        {COLORS.map((c) => (
          <button key={c} className={`draw-color ${draw.color === c ? "on" : ""}`} style={{ background: c }} title={c} onClick={() => setDraw(draw.tool, c)} />
        ))}
        <span className="draw-sep" />
        <button className="btn small" onClick={() => void invoke("share_draw_clear").catch(() => {})}>{t("draw.clear")}</button>
        <button className="btn small primary" onClick={() => setDraw(null, draw.color)}>{t("draw.done")}</button>
        {stop}
      </div>
    );
  }
  return (
    <div className="share-bar" data-tauri-drag-region>
      <span className="share-dot" />
      <span className="share-text" data-tauri-drag-region>{t("share.youreSharing")}</span>
      {canDraw && <button className="btn small" title={t("draw.hint")} onClick={() => setDraw("pen", draw.color)}>✎ {t("draw.start")}</button>}
      {stop}
    </div>
  );
}

interface Stroke {
  tool: Tool;
  color: string;
  points: [number, number][];
  /** When the pen was lifted (laser strokes fade from then on). */
  ended?: number;
}

const LASER_FADE = 1200;

/** The see-through layer you draw on; it's captured with the screen, so the others see it. */
function DrawLayer() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const state = useRef<DrawState>({ tool: null, color: COLORS[0]! });
  const strokes = useRef<Stroke[]>([]);
  const current = useRef<Stroke | null>(null);
  const frame = useRef(0);
  const [tool, setTool] = useState<Tool | null>(null);

  const render = () => {
    frame.current = 0;
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    const scale = window.devicePixelRatio || 1;
    if (c.width !== Math.round(innerWidth * scale)) { c.width = Math.round(innerWidth * scale); c.height = Math.round(innerHeight * scale); }
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    const now = performance.now();
    strokes.current = strokes.current.filter((s) => s.tool !== "laser" || !s.ended || now - s.ended < LASER_FADE);
    for (const s of strokes.current) paint(ctx, s, now);
    // Keep animating while a laser stroke is fading.
    if (strokes.current.some((s) => s.tool === "laser")) frame.current = requestAnimationFrame(render);
  };
  const redraw = () => { if (!frame.current) frame.current = requestAnimationFrame(render); };

  useEffect(() => {
    const offs = [
      listen<DrawState>("trix://draw", (e) => { state.current = e.payload; setTool(e.payload.tool); }),
      listen("trix://draw-clear", () => { strokes.current = []; redraw(); }),
    ];
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setDraw(null, state.current.color); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", redraw);
    return () => {
      offs.forEach((off) => void off.then((f) => f()));
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", redraw);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <canvas ref={canvas} className={`draw-layer ${tool ? "active" : ""}`}
      onPointerDown={(e) => {
        const { tool: active, color } = state.current;
        if (!active) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        current.current = { tool: active, color, points: [[e.clientX, e.clientY]] };
        strokes.current.push(current.current);
        redraw();
      }}
      onPointerMove={(e) => {
        const s = current.current;
        if (!s) return;
        if (s.tool === "arrow") s.points[1] = [e.clientX, e.clientY];
        else s.points.push([e.clientX, e.clientY]);
        redraw();
      }}
      onPointerUp={() => {
        if (current.current) current.current.ended = performance.now();
        current.current = null;
        redraw();
        void invoke("share_raise_bar").catch(() => {});
      }} />
  );
}

function paint(ctx: CanvasRenderingContext2D, s: Stroke, now: number) {
  if (!s.points.length) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = s.color;
  ctx.lineWidth = s.tool === "highlighter" ? 22 : s.tool === "laser" ? 5 : 4;
  if (s.tool === "highlighter") ctx.globalAlpha = 0.35;
  if (s.tool === "laser") {
    ctx.globalAlpha = s.ended ? Math.max(0, 1 - (now - s.ended) / LASER_FADE) : 1;
    ctx.shadowColor = s.color;
    ctx.shadowBlur = 14;
  }
  ctx.beginPath();
  ctx.moveTo(...s.points[0]!);
  for (const p of s.points.slice(1)) ctx.lineTo(...p);
  if (s.points.length === 1) ctx.lineTo(s.points[0]![0] + 0.1, s.points[0]![1]);
  ctx.stroke();
  if (s.tool === "arrow" && s.points[1]) {
    const [[x1, y1], [x2, y2]] = s.points as [[number, number], [number, number]];
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const head = 18;
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - head * Math.cos(angle - 0.45), y2 - head * Math.sin(angle - 0.45));
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - head * Math.cos(angle + 0.45), y2 - head * Math.sin(angle + 0.45));
    ctx.stroke();
  }
  ctx.restore();
}
